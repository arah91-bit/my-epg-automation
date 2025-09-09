# ===================================================================
#          MASTER EPG AUTOMATION SCRIPT (CONFIG-DRIVEN)
# ===================================================================
# This script reads all settings from 'config.ini' to run the
# full EPG generation process.
# ===================================================================

# --- SCRIPT START ---
Clear-Host

# Set the working directory to where the script is located
$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDirectory

# --- HELPER FUNCTION TO READ CONFIG.INI ---
function Get-IniContent {
    param($FilePath)
    $ini = @{}
    Get-Content $FilePath | ForEach-Object {
        $_.Trim() | Where-Object {$_ -notmatch "^#" -and $_ -notmatch "^\s*$" } | ForEach-Object {
            if ($_ -match "\[.*\]") {
                $section = $_.Trim("[]")
                $ini[$section] = @{}
            } else {
                $key, $value = $_.Split("=", 2)
                $ini[$section][$key.Trim()] = $value.Trim()
            }
        }
    }
    return $ini
}

# --- LOAD CONFIGURATION ---
Write-Host "Loading settings from config.ini..." -ForegroundColor Cyan
$ConfigPath = ".\config.ini"
if (-not (Test-Path $ConfigPath)) {
    Write-Host "FATAL ERROR: config.ini not found in the script directory. Aborting." -ForegroundColor Red
    pause
    exit 1
}
$Config = Get-IniContent -FilePath $ConfigPath
Write-Host "Configuration loaded successfully." -ForegroundColor Green

# --- STAGE 1: Generate the Cleaned M3U Playlist ---
Write-Host "`n--- STAGE 1: Running Python script to generate cleaned playlist... ---" -ForegroundColor Yellow

try {
    # Execute the Python script using the path from the config file
    python $Config.Paths.python_script
    
    if ($LASTEXITCODE -ne 0) {
        throw "Python script failed with exit code $LASTEXITCODE."
    }
    
    Write-Host "Stage 1 complete. Cleaned playlist generated successfully." -ForegroundColor Green
}
catch {
    Write-Host "FATAL ERROR in Stage 1. The Python script failed. Aborting." -ForegroundColor Red
    pause
    exit 1
}


# --- STAGE 2: Grab the EPG Data ---
Write-Host "`n--- STAGE 2: Running Node.js script to grab EPG data... ---" -ForegroundColor Yellow

try {
    # Run the Node.js script using settings from the config file
    node .\run-sites-and-merge.js `
       --sites $Config.Paths.my_sites_file `
       --out $Config.Paths.epg_output_file `
       --days $Config.GrabberSettings.days `
       --maxConnections $Config.GrabberSettings.max_connections `
       --siteConcurrency $Config.GrabberSettings.site_concurrency `
       --retries $Config.GrabberSettings.retries `
       --playlist $Config.Paths.cleaned_playlist_file `
       --preferSites $Config.GrabberSettings.prefer_sites `
       --timeout $Config.GrabberSettings.timeout `
       --delay $Config.GrabberSettings.delay `
       --siteWallClockSec $Config.GrabberSettings.site_wall_clock_sec `
       --resume `
       --fuzzySec 90 `
       --minProg 5 `
       --backoff `
       --backoffFile .\.skip-sites.txt `
       --progressSec 30

    if ($LASTEXITCODE -ne 0) {
        throw "Node.js grabber failed with exit code $LASTEXITCODE."
    }
    
    Write-Host "Stage 2 complete. EPG guide.xml generated successfully." -ForegroundColor Green
}
catch {
    Write-Host "FATAL ERROR in Stage 2. The Node.js EPG grabber failed. Check the output above for errors." -ForegroundColor Red
    pause
    exit 1
}