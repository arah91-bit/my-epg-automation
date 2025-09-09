import os
import re
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict

# --- CONFIGURATION ---
# Please update these paths to match your system's setup.

# 1. Your M3U playlist of working streams.
PLAYLIST_FILE = "C:\server\epg\cleaned_playlist.m3u"

# 2. Your list of "working" EPG sites you want to analyze.
SITES_TO_ANALYZE_FILE = "C:\\server\\epg\\epgsites.clean.txt"

# 3. The path to the 'sites' directory within your local iptv-org/epg repository.
EPG_SITES_DIR = "C:\\server\\epg\\sites"


# --- SCRIPT LOGIC ---

def get_playlist_channel_ids(playlist_path: str) -> set:
    """Extracts all unique tvg-id values from an M3U playlist."""
    print(f"📄 Reading playlist: {playlist_path}")
    try:
        with open(playlist_path, 'r', encoding='utf-8') as f:
            content = f.read()
        ids = re.findall(r'tvg-id="([^"]+)"', content)
        if not ids:
            print("   WARNING: No 'tvg-id' tags found in the playlist.")
            return set()
        print(f"   Found {len(set(ids))} unique channel IDs in playlist.")
        return set(ids)
    except FileNotFoundError:
        print(f"   ERROR: Playlist file not found at '{playlist_path}'")
        return set()


def load_sites_to_check(sites_path: str) -> list:
    """Loads the list of sites to analyze from a text file."""
    print(f"📄 Reading sites list: {sites_path}")
    try:
        with open(sites_path, 'r', encoding='utf-8') as f:
            sites = [line.strip() for line in f if line.strip() and not line.startswith('#')]
        print(f"   Found {len(sites)} sites to analyze.")
        return sites
    except FileNotFoundError:
        print(f"   ERROR: Sites file not found at '{sites_path}'")
        return []


def analyze_site_relevancy(args):
    """Checks a single site's channel files for matches against the playlist IDs."""
    site, playlist_ids, epg_sites_dir = args
    site_dir = os.path.join(epg_sites_dir, site)
    if not os.path.isdir(site_dir):
        return site, 0, 0  # Return 0 score if directory doesn't exist

    match_count = 0
    total_channels_in_site = 0

    try:
        # We only need to check the .channels.xml file for each site
        channel_file = os.path.join(site_dir, f"{site}.channels.xml")
        if os.path.exists(channel_file):
            with open(channel_file, 'r', encoding='utf-8') as f:
                content = f.read()
                # A simple count of channel entries in the source file
                total_channels_in_site = len(re.findall(r'<channel .*id="', content))

                # Check which of our playlist channels are supported by this site
                for channel_id in playlist_ids:
                    if channel_id in content:
                        match_count += 1
    except Exception as e:
        # Could fail on read permissions or encoding issues
        print(f"   Warning: Could not process {site}: {e}")
        return site, 0, 0

    return site, match_count, total_channels_in_site


if __name__ == "__main__":
    print("--- EPG Site Relevancy Analyzer ---")

    playlist_ids = get_playlist_channel_ids(PLAYLIST_FILE)
    sites_to_check = load_sites_to_check(SITES_TO_ANALYZE_FILE)

    if not playlist_ids or not sites_to_check:
        print("\nCannot proceed without both a valid playlist and a list of sites. Exiting.")
        exit()

    if not os.path.isdir(EPG_SITES_DIR):
        print(f"\nERROR: The EPG Sites Directory was not found at '{EPG_SITES_DIR}'. Please check the path.")
        exit()

    print(f"\n🔬 Analyzing {len(sites_to_check)} sites against {len(playlist_ids)} channels. This may take a moment...")

    tasks = [(site, playlist_ids, EPG_SITES_DIR) for site in sites_to_check]
    results = []

    with ThreadPoolExecutor() as executor:
        # Use list() to ensure all tasks are completed before moving on
        results = list(executor.map(analyze_site_relevancy, tasks))

    # Sort results by the number of matches, descending
    results.sort(key=lambda x: x[1], reverse=True)

    print("\n--- Relevancy Report ---")
    print("Site                     | Your Channel Matches | Total Channels on Site")
    print("-------------------------|----------------------|-----------------------")

    for site, match_count, total_channels in results:
        # Formatting for clean columns
        site_str = site.ljust(24)
        match_str = str(match_count).rjust(20)
        total_str = str(total_channels).rjust(23)
        print(f"{site_str} | {match_str} | {total_str}")

    print("\n--- Recommendations ---")
    print("1. Use this ranked list to build your powerful 'mysites.txt' file.")
    print("2. Prioritize the sites at the top of the list with the most matches.")
    print(
        "3. You can likely ignore sites at the bottom with 0 or very few matches, as they are not relevant to your playlist.")
    print("\n--- Analysis Complete ---")