import os
import re
import time
import requests
import subprocess
import configparser
from concurrent.futures import ThreadPoolExecutor, as_completed
from thefuzz import fuzz

# --- CONFIGURATION (Loaded from config.ini) ---
config = configparser.ConfigParser()
# We assume the config file is in the same directory as the script
script_dir = os.path.dirname(os.path.realpath(__file__))
config_path = os.path.join(script_dir, 'config.ini')

try:
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"config.ini not found at {config_path}")

    config.read(config_path)

    # Load Paths from config.ini
    FFPROBE_PATH = config.get('Paths', 'ffprobe')
    M3U_LINKS_FILE = config.get('Paths', 'm3u_links_file')
    FINAL_OUTPUT_FILE = config.get('Paths', 'cleaned_playlist_file')

    # Load Settings from config.ini
    STREAM_CHECK_TIMEOUT = config.getint('Settings', 'stream_timeout')
    MAX_WORKERS = config.getint('Settings', 'max_workers')
    MATCH_THRESHOLD = config.getint('Settings', 'match_threshold')

except Exception as e:
    print(f"FATAL ERROR: Could not read 'config.ini'. Please ensure it exists and is correctly formatted.")
    print(f"Error details: {e}")
    input("Press Enter to exit...")
    exit()

# List of official reference playlists for ID cleaning.
REFERENCE_PLAYLIST_URLS = [
    "https://iptv-org.github.io/iptv/countries/us.m3u",
    "https://iptv-org.github.io/iptv/countries/gb.m3u",
    "https://iptv-org.github.io/iptv/countries/ca.m3u",
    "https://iptv-org.github.io/iptv/countries/au.m3u"
]


# --- SCRIPT LOGIC ---

class M3UChannel:
    """A class to represent and manipulate a channel from an M3U playlist."""

    def __init__(self, extinf_line, url):
        self.extinf = extinf_line
        self.url = url
        self.tvg_id = self._get_attr('tvg-id', '')
        self.name = self._get_name()
        self.call_sign = self._get_call_sign()

    def _get_attr(self, key, default=''):
        match = re.search(f'{key}="([^"]*)"', self.extinf)
        return match.group(1) if match else default

    def _get_name(self):
        try:
            return self.extinf.split(',')[-1].strip()
        except:
            return ''

    def _get_call_sign(self):
        match = re.search(r'\b([KW][A-Z]{2,3})\b', self.name, re.IGNORECASE)
        return match.group(1).upper() if match else None

    def _safe_print_name(self):
        """Encodes the name to safely print in any terminal."""
        return self.name.encode('ascii', 'ignore').decode('ascii')

    def set_tvg_id(self, new_id):
        if self.tvg_id and self.tvg_id != new_id:
            self.extinf = re.sub(f'tvg-id="{re.escape(self.tvg_id)}"', f'tvg-id="{new_id}"', self.extinf)
            self.tvg_id = new_id
            return True
        return False


# --- STAGE 1: Stream Checker Functions ---

def is_stream_working_ffmpeg(url):
    try:
        subprocess.run(
            [FFPROBE_PATH, "-v", "error", url],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=STREAM_CHECK_TIMEOUT
        )
        return True
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError):
        return False


def check_streams_concurrently(source_channels):
    print(f"\n--- STAGE 1: Checking {len(source_channels)} Streams ---")
    working_channels = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_channel = {executor.submit(is_stream_working_ffmpeg, ch.url): ch for ch in source_channels}

        count = 0
        total = len(source_channels)
        for future in as_completed(future_to_channel):
            count += 1
            channel = future_to_channel[future]
            safe_name = channel._safe_print_name()
            try:
                if future.result():
                    print(f"({count}/{total}) UP: {safe_name}")
                    working_channels.append(channel)
                else:
                    print(f"({count}/{total}) DOWN: {safe_name}")
            except Exception as e:
                print(f"({count}/{total}) ERROR checking {safe_name}: {e}")

    print(f"\nFound {len(working_channels)} working streams.")
    return working_channels


# --- STAGE 2: ID Cleaner Functions ---

def download_reference_data():
    print("\n--- STAGE 2: Cleaning TVG-IDs ---")
    print("Downloading reference playlists...")
    ref_channels = []
    with ThreadPoolExecutor() as executor:
        responses = executor.map(requests.get, REFERENCE_PLAYLIST_URLS)
        for response in responses:
            try:
                response.raise_for_status()
                print(f"   - Downloaded {response.url}")
                ref_channels.extend(parse_m3u_from_text(response.text))
            except requests.RequestException as e:
                print(f"   - FAILED to download {e.request.url}: {e}")

    ref_map = {ch.call_sign: ch for ch in ref_channels if ch.call_sign}
    return ref_channels, ref_map


def clean_name(name):
    name = name.lower()
    noise = ['hd', 'fhd', 'sd', '4k', 'uhd', 'channel', 'tv', 'east', 'west']
    for n in noise:
        name = name.replace(n, '')
    name = re.sub(r'[\(\[].*?[\)\]]', '', name)
    name = re.sub(r'[^a-z0-9 ]', '', name)
    return ' '.join(name.split())


def clean_channel_ids(channels_to_clean, ref_channels, ref_map_by_call_sign):
    print(f"\nProcessing {len(channels_to_clean)} working channels for ID correction...")
    corrections_count = 0

    for channel in channels_to_clean:
        best_match_ref = None
        if channel.call_sign and channel.call_sign in ref_map_by_call_sign:
            best_match_ref = ref_map_by_call_sign[channel.call_sign]
        else:
            cleaned_input_name = clean_name(channel.name)
            if not cleaned_input_name: continue

            best_score = 0
            for ref_ch in ref_channels:
                score = fuzz.token_set_ratio(cleaned_input_name, clean_name(ref_ch.name))
                if score > best_score:
                    best_score = score
                    best_match_ref = ref_ch

            if best_score < MATCH_THRESHOLD:
                best_match_ref = None

        if best_match_ref and channel.set_tvg_id(best_match_ref.tvg_id):
            print(f'   - Corrected "{channel._safe_print_name()}" -> new id: {best_match_ref.tvg_id}')
            corrections_count += 1

    print(f"\nCorrected {corrections_count} tvg-ids.")
    return channels_to_clean


# --- UTILITY Functions ---

def parse_m3u_from_text(content):
    lines = content.splitlines()
    channels = []
    for i, line in enumerate(lines):
        if line.startswith('#EXTINF:'):
            if i + 1 < len(lines) and lines[i + 1].startswith('http'):
                channels.append(M3UChannel(line.strip(), lines[i + 1].strip()))
    return channels


def download_playlist_content(url):
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        print(f"Downloaded source playlist from {url}")
        return response.text.splitlines()
    except requests.RequestException as e:
        print(f"Failed to download {url}: {e}")
        return None


def load_and_combine_playlists(links_file_path):
    print("--- Loading and Combining Source Playlists ---")
    try:
        with open(links_file_path, 'r', encoding='utf-8') as f:
            urls = [line.strip() for line in f if line.strip() and not line.startswith('#')]
    except FileNotFoundError:
        print(f"FATAL ERROR: The links file was not found at '{links_file_path}'")
        return []

    if not urls:
        print("FATAL ERROR: The links file is empty.")
        return []

    print(f"Found {len(urls)} M3U links to process.")

    all_lines = []
    is_first_playlist = True

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_url = {executor.submit(download_playlist_content, url): url for url in urls}
        for future in as_completed(future_to_url):
            lines = future.result()
            if lines:
                if is_first_playlist and lines[0].startswith('#EXTM3U'):
                    all_lines.append(lines[0])
                    is_first_playlist = False

                for line in lines[1:]:
                    all_lines.append(line)

    return all_lines


# --- MAIN EXECUTION ---

if __name__ == "__main__":
    start_time = time.time()

    source_lines = load_and_combine_playlists(M3U_LINKS_FILE)
    if not source_lines:
        print("\nCould not load any source playlists. Exiting.")
        input("Press Enter to exit...")
        exit()

    source_channels = parse_m3u_from_text("\n".join(source_lines))
    working_channels = check_streams_concurrently(source_channels)

    if not working_channels:
        print("\nNo working streams found. Exiting.")
        input("Press Enter to exit...")
        exit()

    ref_channels, ref_map_by_call_sign = download_reference_data()
    cleaned_channels = clean_channel_ids(working_channels, ref_channels, ref_map_by_call_sign)

    print(f"\nWriting final cleaned playlist to: {FINAL_OUTPUT_FILE}")
    with open(FINAL_OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write("#EXTM3U\n")
        for channel in cleaned_channels:
            f.write(channel.extinf + '\n')
            f.write(channel.url + '\n')

    print("\n--- Summary ---")
    print(f"Total Source Channels:  {len(source_channels)}")
    print(f"Working Streams Found:  {len(working_channels)}")
    print(f"Final Cleaned Channels: {len(cleaned_channels)}")
    print(f"\nCompleted in {round(time.time() - start_time, 2)} seconds.")