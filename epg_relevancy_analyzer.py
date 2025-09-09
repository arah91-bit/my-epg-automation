import os
import re
import configparser
from concurrent.futures import ThreadPoolExecutor

# --- CONFIGURATION (Loaded from config.ini) ---
config = configparser.ConfigParser()
# We assume the config file is in the same directory as the script
script_dir = os.path.dirname(os.path.realpath(__file__))
config_path = os.path.join(script_dir, 'config.ini')

try:
    if not os.path.exists(config_path):
        raise FileNotFoundError(f"config.ini not found at {config_path}")

    config.read(config_path)

    # Load Paths from [Paths] section
    PLAYLIST_FILE = config.get('Paths', 'cleaned_playlist_file')
    RECOMMENDED_SITES_OUTPUT_FILE = config.get('Paths', 'my_sites_file')

    # Load Paths from [AnalyzerSettings] section
    SITES_TO_ANALYZE_FILE = config.get('AnalyzerSettings', 'full_sites_list')
    EPG_SITES_DIR = config.get('AnalyzerSettings', 'epg_sites_directory')

    # Load Settings from [AnalyzerSettings] section
    RECOMMENDATION_THRESHOLD = config.getint('AnalyzerSettings', 'recommendation_threshold')

except Exception as e:
    print(f"FATAL ERROR: Could not read 'config.ini'. Please ensure it exists and has all required sections.")
    print(f"Error details: {e}")
    input("Press Enter to exit...")
    exit()


# --- SCRIPT LOGIC ---

def get_playlist_channel_ids(playlist_path: str) -> set:
    """Extracts all unique tvg-id values from an M3U playlist."""
    print(f"Reading playlist: {playlist_path}")
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
    print(f"Reading sites list: {sites_path}")
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
        return site, 0, 0

    match_count = 0
    total_channels_in_site = 0
    try:
        channel_file = os.path.join(site_dir, f"{site}.channels.xml")
        if os.path.exists(channel_file):
            with open(channel_file, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
                total_channels_in_site = len(re.findall(r'<channel .*id="', content))
                for channel_id in playlist_ids:
                    if channel_id in content:
                        match_count += 1
    except Exception as e:
        print(f"   Warning: Could not process {site}: {e}")
        return site, 0, 0
    return site, match_count, total_channels_in_site


def write_recommended_sites_file(results, output_path, threshold):
    """Filters the results and writes the recommended sites to a file."""
    recommended_sites = [site for site, match_count, _ in results if match_count >= threshold]

    if not recommended_sites:
        print(f"\nWarning: No sites met the recommendation threshold of {threshold}. The output file will be empty.")
        return

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(f"# Recommended EPG sites based on your playlist\n")
        f.write(f"# Generated automatically. Only includes sites with {threshold} or more channel matches.\n\n")
        for site in recommended_sites:
            f.write(site + '\n')

    print(f"\nSUCCESS! Recommended sites list saved to: {output_path}")


if __name__ == "__main__":
    print("--- EPG Site Relevancy Analyzer ---")

    playlist_ids = get_playlist_channel_ids(PLAYLIST_FILE)
    sites_to_check = load_sites_to_check(SITES_TO_ANALYZE_FILE)

    if not playlist_ids or not sites_to_check:
        print("\nCannot proceed without both a valid playlist and a list of sites. Exiting.")
        input("Press Enter to exit...")
        exit()

    if not os.path.isdir(EPG_SITES_DIR):
        print(f"\nERROR: The EPG Sites Directory was not found at '{EPG_SITES_DIR}'.")
        input("Press Enter to exit...")
        exit()

    print(f"\nAnalyzing {len(sites_to_check)} sites against {len(playlist_ids)} channels. This may take a moment...")
    tasks = [(site, playlist_ids, EPG_SITES_DIR) for site in sites_to_check]

    with ThreadPoolExecutor() as executor:
        results = list(executor.map(analyze_site_relevancy, tasks))

    results.sort(key=lambda x: x[1], reverse=True)

    print("\n--- Relevancy Report (Console) ---")
    print("Site                     | Your Channel Matches | Total Channels on Site")
    print("-------------------------|----------------------|-----------------------")
    for site, match_count, total_channels in results:
        site_str = site.ljust(24)
        match_str = str(match_count).rjust(20)
        total_str = str(total_channels).rjust(23)
        print(f"{site_str} | {match_str} | {total_str}")

    write_recommended_sites_file(results, RECOMMENDED_SITES_OUTPUT_FILE, RECOMMENDATION_THRESHOLD)

    print("\n--- Recommendations ---")
    print(
        f"1. A new file '{os.path.basename(RECOMMENDED_SITES_OUTPUT_FILE)}' has been created with the best sites for your playlist.")
    print("2. Your main grabber script is now ready to use this file.")
    print("\n--- Analysis Complete ---")
    input("Press Enter to exit...")