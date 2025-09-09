# IPTV EPG Automation Suite

This project contains a collection of scripts designed to create a reliable, daily-updated Electronic Program Guide (EPG) for use with IPTV players like Plex, Jellyfin, or Emby.

The workflow is designed to solve common problems with public IPTV sources:
1.  **Filters Dead Streams:** It checks thousands of streams from a source playlist and keeps only the ones that are currently online.
2.  **Corrects Channel IDs:** It automatically corrects the `tvg-id` for channels to match standardized EPG provider formats, maximizing guide data coverage.
3.  **Finds Relevant EPG Sources:** It includes a tool to analyze your channel list and find the most valuable EPG sites.
4.  **Grabs EPG Data:** It runs the powerful `iptv-org/epg` grabber to fetch schedule data and create a final `guide.xml` file.

## Dependencies

Before you begin, you must have the following software installed and configured on your Windows machine.

* **[Python 3](https://www.python.org/downloads/):** The scripting language used for checking and cleaning.
* **[Node.js](https://nodejs.org/):** Required to run the main EPG grabber.
* **[Git](https://git-scm.com/):** Required for cloning the `iptv-org/epg` repository.
* **[FFmpeg](https://ffmpeg.org/):** The `ffprobe.exe` tool is essential for checking if video streams are active.

## Setup Instructions

Follow these steps carefully to set up your environment.

### 1. Set Up the Core EPG Grabber

This entire system is built around the `iptv-org/epg` project. You must clone their repository first.

```powershell
# Open PowerShell
cd C:\server
git clone [https://github.com/iptv-org/epg.git](https://github.com/iptv-org/epg.git)
cd epg
npm install
```
This will create a `C:\server\epg` folder and install all the necessary Node.js packages.

### 2. Add These Project Scripts

Copy the following files from this repository into your `C:\server\epg\` folder:

* `Run_Full_EPG_Update.ps1`
* `generate_cleaned_playlist.py`
* `epg_relevancy_analyzer.py` (Optional diagnostic tool)
* `epgsites.txt` (The full, un-curated list of all potential EPG sites)
* 'm3ulinks.txt' (Edit this with whatever m3ulinks you want the default is the eng IPTV-org list)

### 3. Configure the Python Script (`generate_cleaned_playlist.py`)

Open `generate_cleaned_playlist.py` in a text editor and **update the path to your `ffprobe.exe`**.

```python
# --- CONFIGURATION ---
...
# 3. Path to your ffprobe.exe
FFPROBE_PATH = "C:\\path\\to\\your\\ffmpeg\\bin\\ffprobe.exe"
...
```

### 4. Install Required Python Libraries

Open PowerShell and run the following commands to install the necessary Python packages:

```powershell
pip install requests
pip install thefuzz
pip install python-levenshtein
```

## The Automated Workflow

The project is designed to be run in a specific order to generate the best results.

### Step 1: Find Your Most Relevant EPG Sites (One-Time Task)

Before you start the daily process, you need to create a curated list of the best EPG sites for your channels.

1.  First, run the cleaner script to get a baseline playlist: `python generate_cleaned_playlist.py`.
2.  Next, run the relevancy analyzer. This script will read your newly generated `cleaned_playlist.m3u` and rank all the sites in `epgsites.txt` based on how many of your channels they cover.
    ```powershell
    python epg_relevancy_analyzer.py
    ```
3.  The script will output a ranked list. Create a new file named `mysites.txt` and copy the top 15-20 sites from the report into this file. This will be your primary list for grabbing EPG data.

### Step 2: Run the Master Automation Script (Daily Task)

Once you have your `mysites.txt` file, you can run the main automation script. This single script handles everything.

1.  Open the `Run_Full_EPG_Update.ps1` script in a text editor.
2.  Make sure the `$MySitesPath` variable points to your new `mysites.txt` file.
    ```powershell
    $MySitesPath = ".\mysites.txt"
    ```
3.  Execute the script from PowerShell:
    ```powershell
    C:\server\epg\Run_Full_EPG_Update.ps1
    ```

The script will now perform the full process:
* Download the latest source playlist.
* Check for working streams.
* Correct `tvg-id`s.
* Save the final `cleaned_playlist.m3u`.
* Run the Node.js grabber using your `mysites.txt` to generate the final `guide.xml`.

Your `guide.xml` and `cleaned_playlist.m3u` files are now ready to be used in your IPTV player.
