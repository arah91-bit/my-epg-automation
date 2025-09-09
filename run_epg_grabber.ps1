# ===================================================================
#          MASTER EPG AUTOMATION SCRIPT
# ===================================================================
# This script performs a two-stage update:
# 1. Runs the Python script to check for working streams and clean tvg-ids.
# 2. Runs the Node.js script to grab EPG data using the cleaned playlist.
# ===================================================================

# --- CONFIGURATION ---
$EpgDirectory = "C:\server\epg"
# IMPORTANT: Make sure this path points to your combined Python script
$PythonScriptPath = "C:\server\epg\m3uCheckAndClean.py" 
$CleanedPlaylistPath = "C:\server\epg\cleaned_playlist.m3u"
$MySitesPath = "epgsites.clean.txt" # Using your optimized list

# --- SCRIPT START ---
Clear-Host
Write-Host "Starting the Full EPG Update Process..." -ForegroundColor Green
Set-Location $EpgDirectory

# --- STAGE 1: Generate the Cleaned M3U Playlist ---
Write-Host "`n--- STAGE 1: Running Python script to generate cleaned playlist... ---" -ForegroundColor Yellow

try {
    # Execute the Python script
    python $PythonScriptPath
    
    # Check if the Python script was successful before proceeding
    if ($LASTEXITCODE -ne 0) {
        throw "Python script failed with exit code $LASTEXITCODE."
    }
    
    Write-Host "✅ Stage 1 complete. Cleaned playlist generated successfully." -ForegroundColor Green
}
catch {
    Write-Host "❌ FATAL ERROR in Stage 1. The Python script failed. Aborting." -ForegroundColor Red
    # Exit the script so the grabber does not run
    exit 1
}

# --- STAGE 2: Grab the EPG Data ---
Write-Host "`n--- STAGE 2: Running Node.js script to grab EPG data... ---" -ForegroundColor Yellow

# Set environment variables for the grabber process
$env:TIMEOUT = 15000   # 15s per HTTP request
$env:DELAY   = 1000    # 1s between requests

try {
    # Run the Node.js batch and merge script
    # Note: This now uses your curated mysites.txt and the cleaned_playlist.m3u from Stage 1
    node .\run-sites-and-merge.js `
       --sites $MySitesPath `
       --out .\guide.xml `
       --days 5 `
       --maxConnections 4 `
       --siteConcurrency 5 `
       --retries 3 `
       --resume `
       --playlist $CleanedPlaylistPath `
       --fuzzySec 90 `
       --preferSites "tvtv.us,tvpassport.com,directv.com" `
       --siteWallClockSec 5400 `
       --minProg 5 `
       --backoff `
       --backoffFile .\.skip-sites.txt `
       --progressSec 30

    if ($LASTEXITCODE -ne 0) {
        throw "Node.js grabber failed with exit code $LASTEXITCODE."
    }
    
    Write-Host "✅ Stage 2 complete. EPG guide.xml generated successfully." -ForegroundColor Green
}
catch {
    Write-Host "❌ FATAL ERROR in Stage 2. The Node.js EPG grabber failed. Check the output above for errors." -ForegroundColor Red
    exit 1
}

Write-Host "`n🎉 EPG Automation Complete! 🎉" -ForegroundColor Green