import os
import re
import time
import requests
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from thefuzz import fuzz

# --- CONFIGURATION ---

# 1. Source M3U playlist URL. You can use your curated master list or the main iptv-org list.
M3U_SOURCE_URL = "C:\\server\\epg\\m3ulinks.txt"

# 2. Final output file with working streams and corrected tvg-ids.
FINAL_OUTPUT_FILE = "C:\\server\\epg\\cleaned_playlist.m3u"

# 3. Path to your ffprobe.exe
FFPROBE_PATH = "C:\\ffmpeg\\ffmpeg-2025-09-04-git-2611874a50-full_build\\bin\\ffprobe.exe"

# 4. List of official reference playlists for ID cleaning.
REFERENCE_PLAYLIST_URLS = [
    "https://iptv-org.github.io/iptv/countries/us.m3u",
    "https://iptv-org.github.io/iptv/countries/gb.m3u",
    "https://iptv-org.github.io/iptv/countries/ca.m3u",
    "https://iptv-org.github.io/iptv/countries/au.m3u"
]

# 5. Technical settings
STREAM_CHECK_TIMEOUT = 15
MAX_WORKERS = 20
MATCH_THRESHOLD = 85


# --- SCRIPT LOGIC ---

class M3UChannel:
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
        """NEW FUNCTION: Encodes the name to safely print in any terminal."""
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

            # Use the new safe printing method
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


# --- MAIN EXECUTION ---

if __name__ == "__main__":
    start_time = time.time()

    print(f"Downloading source playlist from {M3U_SOURCE_URL}...")
    try:
        source_response = requests.get(M3U_SOURCE_URL)
        source_response.raise_for_status()
        source_channels = parse_m3u_from_text(source_response.text)
    except requests.RequestException as e:
        print(f"FATAL ERROR: Could not download source playlist. Exiting. Error: {e}")
        exit()

    working_channels = check_streams_concurrently(source_channels)

    if not working_channels:
        print("\nNo working streams found. Exiting.")
        exit()

    ref_channels, ref_map_by_call_sign = download_reference_data()
    cleaned_channels = clean_channel_ids(working_channels, ref_channels, ref_map_by_call_sign)

    print(f"\nWriting final cleaned playlist to: {FINAL_OUTPUT_FILE}")
    with open(FINAL_OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write("#EXTM3U\n")
        for channel in cleaned_channels:
            f.write(channel.extinf + '\n')