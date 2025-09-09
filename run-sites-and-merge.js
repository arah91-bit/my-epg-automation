#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const url = require('url');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// --- 0) Constants & Configuration ---

const TMP_DIR = '.tmp';
const DEFAULT_SITES_FILE = 'epgsites.txt';
const DEFAULT_BACKOFF_FILE = '.skip-sites.txt';
const DEFAULT_OUTPUT_FILE = 'guide.xml';

const ENRICHMENT_CATEGORIES = {
    'Sports': [/nfl|nba|mlb|nhl|premier league|world cup|vs|grand prix|ufc|pga|tennis|golf|boxing|mma/i],
    'News': [/news|breaking|headline|cnn|bbc news|fox news|al jazeera|sky news/i],
    'Movie': [/movie|film|feature presentation/i],
    'Kids': [/kids|children|cartoon|animation|nickelodeon|disney junior|cartoon network/i],
    'Documentary': [/documentary|docuseries|nature|wildlife|history channel|nat geo|national geographic/i],
    'Series': [/season \d+|episode \d+|s\d+e\d+/i],
    'Music': [/concert|live session|music video|mtv/i]
};

// --- 1) Main Execution Logic ---

async function main() {
    const argv = parseCliArgs();
    log('--- EPG Batch & Merge Script ---');

    // --- A) Preparation ---
    validateExecutionDirectory();
    
    const sites = loadSitesList(argv.sites, argv.backoff, argv.backoffFile, argv.force);
    if (!sites.length) {
        log('No sites to process. Exiting.');
        return;
    }
    
    const playlistTvgIds = await loadPlaylistIds(argv.playlist);
    if (argv.playlist) {
        log(`Loaded ${playlistTvgIds ? playlistTvgIds.size : 0} tvg-id's from playlist for filtering.`);
    }

    fs.mkdirSync(TMP_DIR, { recursive: true });
    
    // --- B) Batch Fetching ---
    const { successfulSites, skippedSites } = await runBatchFetch(sites, argv);

    // --- C) Merge, Enrich, and Write ---
    if (successfulSites.length > 0) {
        log(`\nMerging results from ${successfulSites.length} successful sites...`);
        const stats = await mergeAndProcess(successfulSites, argv, playlistTvgIds);
        printFinalStats(stats);
    } else {
        log('\nNo sites succeeded. Final guide will not be generated.');
    }

    log('--- Script Finished ---');
}

main().catch(err => {
    console.error(`\nFATAL ERROR: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});


// --- 2) Core Functions (as per Spec) ---

/**
 * Parses command-line arguments using yargs.
 */
function parseCliArgs() {
    return yargs(hideBin(process.argv))
        .usage('Usage: $0 [options]')
        .option('sites', { type: 'string', default: DEFAULT_SITES_FILE, describe: 'Path to site list file' })
        .option('out', { type: 'string', default: DEFAULT_OUTPUT_FILE, describe: 'Path for final merged XMLTV file' })
        .option('days', { type: 'number', describe: 'Number of days to grab (passed to grabber)' })
        .option('maxConnections', { type: 'number', default: 10, describe: 'Concurrent connections per site (passed to grabber)' })
        .option('siteConcurrency', { type: 'number', default: 3, describe: 'Number of sites to process in parallel' })
        .option('timeout', { type: 'number', describe: 'Request timeout in ms (passed via env)' })
        .option('delay', { type: 'number', describe: 'Delay between requests in ms (passed via env)' })
        .option('retries', { type: 'number', default: 1, describe: 'Number of retries for failing sites with safer settings' })
        .option('resume', { type: 'boolean', default: false, describe: 'Reuse existing .tmp/*.xml files' })
        .option('playlist', { type: 'string', describe: 'URL or path to M3U playlist for filtering final guide' })
        .option('fuzzySec', { type: 'number', default: 90, describe: 'Fuzzy matching window in seconds for deduplication' })
        .option('preferSites', { type: 'string', default: '', describe: 'Comma-separated list of sites for merge tie-breaking' })
        .option('siteWallClockSec', { type: 'number', default: 1800, describe: 'Hard wall-clock timeout per site process' })
        .option('minProg', { type: 'number', default: 5, describe: 'Minimum <programme> entries for a site output to be valid' })
        .option('backoff', { type: 'boolean', default: false, describe: 'Enable backoff list for failing sites' })
        .option('backoffFile', { type: 'string', default: DEFAULT_BACKOFF_FILE, describe: 'Path to the backoff/skip file' })
        .option('force', { type: 'boolean', default: false, describe: 'Force processing of sites in the backoff list' })
        .option('progressSec', { type: 'number', default: 30, describe: 'Print progress meter every N seconds (0 to disable)' })
        .help().alias('h', 'help')
        .argv;
}

/**
 * Ensures the script is run from the correct directory.
 */
function validateExecutionDirectory() {
    const pkgPath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(pkgPath)) {
        throw new Error('Script must be run from the root of the iptv-org/epg repository.');
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath));
    if (!pkg.scripts || !pkg.scripts.grab) {
        throw new Error('`package.json` does not contain a "grab" script.');
    }
}

/**
 * Reads and validates the list of site slugs to process.
 */
function loadSitesList(filePath, useBackoff, backoffFile, force) {
    if (!fs.existsSync(filePath)) {
        log(`Warning: Sites file not found at '${filePath}'. Trying to generate from ./sites directory.`);
        const siteDirs = fs.readdirSync('./sites', { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
        log(`Found ${siteDirs.length} potential sites.`);
        return siteDirs;
    }

    const sites = fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('#'))
        .filter(s => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s));

    if (!useBackoff || force) {
        log(`Loaded ${sites.length} sites from '${filePath}'.`);
        return sites;
    }
    
    if (fs.existsSync(backoffFile)) {
        const skipSites = new Set(fs.readFileSync(backoffFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
        const filteredSites = sites.filter(s => !skipSites.has(s));
        log(`Loaded ${sites.length} sites, skipping ${skipSites.size} from backoff file. Processing ${filteredSites.length}.`);
        return filteredSites;
    }

    log(`Loaded ${sites.length} sites from '${filePath}'.`);
    return sites;
}

/**
 * Fetches an M3U playlist and extracts all tvg-id values.
 */
async function loadPlaylistIds(playlistPathOrUrl) {
    if (!playlistPathOrUrl) return null;

    let content;
    try {
        if (playlistPathOrUrl.startsWith('http')) {
            content = await new Promise((resolve, reject) => {
                https.get(playlistPathOrUrl, res => {
                    if (res.statusCode !== 200) return reject(new Error(`HTTP Error: ${res.statusCode}`));
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
                }).on('error', reject);
            });
        } else {
            content = fs.readFileSync(playlistPathOrUrl, 'utf8');
        }
    } catch (error) {
        log(`Warning: Could not load playlist from '${playlistPathOrUrl}': ${error.message}`);
        return null;
    }

    const ids = new Set();
    const regex = /tvg-id="([^"]+)"/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        ids.add(match[1]);
    }
    return ids.size > 0 ? ids : null;
}

/**
 * Manages the concurrent execution of site grabbers.
 */
async function runBatchFetch(sites, argv) {
    const totalSites = sites.length;
    const successfulSites = [];
    const skippedSites = [];
    const runningProcesses = new Set();
    let siteIndex = 0;
    const startTime = Date.now();

    const progressMeter = argv.progressSec > 0 ? setInterval(() => {
        log(`Progress: ${successfulSites.length} done, ${skippedSites.length} failed/skipped, ${runningProcesses.size} running, ${totalSites - siteIndex} queued | ${Math.round((Date.now() - startTime) / 1000)}s elapsed`);
    }, argv.progressSec * 1000) : null;

    const worker = async () => {
        while (siteIndex < totalSites) {
            const currentIndex = siteIndex++;
            const site = sites[currentIndex];
            const outPath = path.join(TMP_DIR, `${site}.xml`);
            
            runningProcesses.add(site);
            
            if (argv.resume && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
                log(`[${site}] Resuming with existing file.`);
                successfulSites.push(site);
            } else {
                const success = await runGrabWithRetry(site, outPath, argv, argv.retries);
                if (success) {
                    successfulSites.push(site);
                } else {
                    skippedSites.push(site);
                }
            }
            runningProcesses.delete(site);
        }
    };

    const workers = Array(argv.siteConcurrency).fill(null).map(worker);
    await Promise.all(workers);

    if (progressMeter) clearInterval(progressMeter);
    log(`Batch fetch complete. Success: ${successfulSites.length}, Failed/Skipped: ${skippedSites.length}`);
    return { successfulSites, skippedSites };
}

/**
 * Invokes the grabber process for a single site with retry logic.
 */
async function runGrabWithRetry(site, outPath, argv, retriesLeft) {
    const success = await grabOnce(site, outPath, argv);
    if (success) return true;

    if (retriesLeft > 0) {
        log(`[${site}] Grab failed. Retrying with safer settings... (${retriesLeft} retries left)`);
        const retryArgv = {
            ...argv,
            maxConnections: Math.min(5, argv.maxConnections),
            delay: 1000,
            siteWallClockSec: Math.min(600, argv.siteWallClockSec),
        };
        return await runGrabWithRetry(site, outPath, retryArgv, retriesLeft - 1);
    }
    
    log(`[${site}] Grab failed after all retries.`);
    if (argv.backoff && !argv.force) {
        try {
            fs.appendFileSync(argv.backoffFile, `${site}\n`);
            log(`[${site}] Added to backoff file: ${argv.backoffFile}`);
        } catch (err) {
            log(`[${site}] Warning: Could not write to backoff file: ${err.message}`);
        }
    }
    return false;
}

/**
 * Spawns a single grabber process with a wall-clock timeout.
 */
function grabOnce(site, outPath, argv) {
    return new Promise((resolve) => {
        const args = ['run', 'grab', '---', '--site', site, '--output', outPath];
        if (argv.days) args.push('--days', argv.days);
        if (argv.maxConnections) args.push('--maxConnections', argv.maxConnections);
        if (argv.delay) args.push('--delay', argv.delay);
        if (argv.timeout) args.push('--timeout', argv.timeout);

        const env = { ...process.env };
        if (argv.timeout) env.TIMEOUT = argv.timeout;
        if (argv.delay) env.DELAY = argv.delay;
        
        log(`[${site}] Starting grab...`);
        const child = spawn('npm', args, { shell: true, env });
        
        const wallClockTimeout = setTimeout(() => {
            log(`[${site}] Error: Exceeded wall-clock timeout of ${argv.siteWallClockSec}s. Killing process.`);
            child.kill('SIGKILL');
            resolve(false);
        }, argv.siteWallClockSec * 1000);

        child.on('error', (err) => {
            clearTimeout(wallClockTimeout);
            log(`[${site}] Error: Failed to start subprocess: ${err.message}`);
            resolve(false);
        });
        
        child.on('exit', (code) => {
            clearTimeout(wallClockTimeout);
            if (code !== 0) {
                log(`[${site}] Exited with non-zero code: ${code}.`);
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
                return resolve(false);
            }
            
            if (!fs.existsSync(outPath)) {
                 log(`[${site}] Exited successfully but output file is missing.`);
                 return resolve(false);
            }

            const programmeCount = countProgrammes(outPath);
            if (programmeCount < argv.minProg) {
                log(`[${site}] Output is invalid (found ${programmeCount} programmes, minimum is ${argv.minProg}). Deleting.`);
                fs.unlinkSync(outPath);
                return resolve(false);
            }

            log(`[${site}] Success! Found ${programmeCount} programmes.`);
            resolve(true);
        });
    });
}

/**
 * Efficiently counts <programme> tags in an XML file.
 */
function countProgrammes(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const matches = content.match(/<programme\s/g);
        return matches ? matches.length : 0;
    } catch {
        return 0;
    }
}


/**
 * Main merging, enrichment, and file writing orchestrator.
 */
async function mergeAndProcess(sites, argv, playlistTvgIds) {
    const preferSitesOrder = argv.preferSites ? argv.preferSites.split(',').map(s => s.trim()) : [];
    
    // Process preferred sites last so they can overwrite
    sites.sort((a, b) => {
        const aIdx = preferSitesOrder.indexOf(a);
        const bIdx = preferSitesOrder.indexOf(b);
        if (aIdx === -1 && bIdx === -1) return 0;
        if (aIdx === -1) return -1;
        if (bIdx === -1) return 1;
        return aIdx - bIdx;
    });

    let mergedChannels = new Map();
    let mergedProgrammes = new Map(); // Map<channelId, programme[]>

    for (const site of sites) {
        const xmlPath = path.join(TMP_DIR, `${site}.xml`);
        if (!fs.existsSync(xmlPath)) continue;

        log(` - Processing ${site}...`);
        const content = fs.readFileSync(xmlPath, 'utf8');
        
        const { channels, programmes } = parseXmltv(content);

        // Merge channels
        for (const [id, channel] of channels.entries()) {
            if (!mergedChannels.has(id) || scoreChannel(channel) > scoreChannel(mergedChannels.get(id))) {
                mergedChannels.set(id, { ...channel, sourceSite: site });
            }
        }

        // Merge programmes
        for (const [channelId, progList] of programmes.entries()) {
            if (!mergedProgrammes.has(channelId)) {
                mergedProgrammes.set(channelId, []);
            }
            const existingProgs = mergedProgrammes.get(channelId);

            for (const newProg of progList) {
                let merged = false;
                for (let i = 0; i < existingProgs.length; i++) {
                    const existingProg = existingProgs[i];
                    if (areProgrammesFuzzyEqual(newProg, existingProg, argv.fuzzySec)) {
                        existingProgs[i] = mergeTwoProgrammes(existingProg, newProg, preferSitesOrder);
                        merged = true;
                        break;
                    }
                }
                if (!merged) {
                    existingProgs.push({ ...newProg, sourceSite: site });
                }
            }
        }
    }

    // Playlist filtering
    if (playlistTvgIds) {
        mergedChannels = new Map([...mergedChannels].filter(([id]) => playlistTvgIds.has(id)));
        mergedProgrammes = new Map([...mergedProgrammes].filter(([id]) => playlistTvgIds.has(id)));
        log(`Filtered guide to ${mergedChannels.size} channels based on playlist.`);
    }

    // Enrichment and stats collection
    const stats = {
        totalChannels: 0,
        totalProgrammes: 0,
        enrichmentAdded: 0,
        categoryCounts: new Map()
    };
    
    for (const [channelId, progList] of mergedProgrammes.entries()) {
        const enrichedList = [];
        for (const prog of progList) {
            const { enrichedProg, newCats } = enrichProgramme(prog);
            stats.enrichmentAdded += newCats;
            enrichedProg.categories.forEach(cat => {
                stats.categoryCounts.set(cat, (stats.categoryCounts.get(cat) || 0) + 1);
            });
            enrichedList.push(enrichedProg);
        }
        mergedProgrammes.set(channelId, enrichedList);
    }
    
    stats.totalChannels = mergedChannels.size;
    stats.totalProgrammes = [...mergedProgrammes.values()].reduce((sum, progs) => sum + progs.length, 0);

    // Write final file
    writeFinalXml(argv.out, mergedChannels, mergedProgrammes);

    return stats;
}


// --- 3) Merging & XML Helper Functions ---

function parseXmltv(content) {
    const channels = new Map();
    const programmes = new Map();

    const channelRegex = /<channel id="([^"]+)">([\s\S]*?)<\/channel>/g;
    let match;
    while ((match = channelRegex.exec(content)) !== null) {
        const id = match[1];
        const body = match[2];
        channels.set(id, {
            id: id,
            displayName: getTagContent(body, 'display-name'),
            icon: getTagAttribute(body, 'icon', 'src'),
            url: getTagContent(body, 'url'),
            raw: match[0]
        });
    }

    const programmeRegex = /<programme start="([^"]+)" stop="([^"]+)" channel="([^"]+)">([\s\S]*?)<\/programme>/g;
    while ((match = programmeRegex.exec(content)) !== null) {
        const [_, start, stop, channel, body] = match;
        const prog = {
            start: parseXmltvTime(start),
            stop: parseXmltvTime(stop),
            channel,
            titles: getTagContents(body, 'title'),
            subTitles: getTagContents(body, 'sub-title'),
            descs: getTagContents(body, 'desc'),
            credits: parseCredits(body),
            categories: getTagContents(body, 'category').map(c => c.text),
            episodeNums: getTagContents(body, 'episode-num'),
            icons: getTagAttributes(body, 'icon', 'src'),
            ratings: getTagContents(body, 'rating').map(r => getTagContent(r.text, 'value')),
        };

        if (!prog.start || !prog.stop) continue; // Skip invalid entries

        if (!programmes.has(channel)) {
            programmes.set(channel, []);
        }
        programmes.get(channel).push(prog);
    }
    return { channels, programmes };
}

function parseXmltvTime(timeStr) {
    if (!timeStr) return null;
    const match = timeStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})$/);
    if (!match) return null;
    const [_, Y, M, D, h, m, s, sign, oh, om] = match;
    const dateStr = `${Y}-${M}-${D}T${h}:${m}:${s}${sign}${oh}:${om}`;
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : date.getTime();
}

function areProgrammesFuzzyEqual(progA, progB, fuzzySec) {
    if (!progA.start || !progB.start || !progA.stop || !progB.stop) return false;
    const fuzzyMs = fuzzySec * 1000;
    // Overlap check
    if (progA.start < progB.stop && progA.stop > progB.start) return true;
    // Fuzzy start/stop check
    if (Math.abs(progA.start - progB.start) <= fuzzyMs && Math.abs(progA.stop - progB.stop) <= fuzzyMs) return true;
    
    return false;
}

function mergeTwoProgrammes(progA, progB, preferSitesOrder) {
    const scoreA = scoreProgramme(progA);
    const scoreB = scoreProgramme(progB);

    if (scoreB > scoreA) return mergeFields(progB, progA);
    if (scoreA > scoreB) return mergeFields(progA, progB);

    // Tie-break with preferSites
    const aIdx = preferSitesOrder.indexOf(progA.sourceSite);
    const bIdx = preferSitesOrder.indexOf(progB.sourceSite);

    if (aIdx !== -1 && (aIdx < bIdx || bIdx === -1)) return mergeFields(progA, progB);
    if (bIdx !== -1 && (bIdx < aIdx || aIdx === -1)) return mergeFields(progB, progA);

    // Default to A if no preference
    return mergeFields(progA, progB);
}

function mergeFields(winner, loser) {
    const union = (arrA, arrB) => [...new Set([...arrA, ...arrB])];
    const unionBy = (arrA, arrB, key) => {
        const map = new Map();
        arrA.forEach(item => map.set(key(item), item));
        arrB.forEach(item => map.set(key(item), item));
        return Array.from(map.values());
    };

    return {
        start: Math.min(winner.start, loser.start),
        stop: Math.max(winner.stop, loser.stop),
        channel: winner.channel,
        titles: unionBy(winner.titles, loser.titles, t => `${t.lang || ''}:${t.text}`),
        subTitles: unionBy(winner.subTitles, loser.subTitles, t => `${t.lang || ''}:${t.text}`),
        descs: (winner.descs[0]?.text.length > loser.descs[0]?.text.length) ? winner.descs : loser.descs,
        credits: {
            director: union(winner.credits.director, loser.credits.director),
            actor: union(winner.credits.actor, loser.credits.actor),
            writer: union(winner.credits.writer, loser.credits.writer),
            producer: union(winner.credits.producer, loser.credits.producer),
            presenter: union(winner.credits.presenter, loser.credits.presenter)
        },
        categories: union(winner.categories, loser.categories),
        episodeNums: unionBy(winner.episodeNums, loser.episodeNums, e => e.text),
        icons: union(winner.icons, loser.icons),
        ratings: union(winner.ratings, loser.ratings),
        sourceSite: winner.sourceSite // Keep winner's source
    };
}

function enrichProgramme(prog) {
    const newCategories = new Set(prog.categories);
    let addedCount = 0;
    const textToScan = [
        ...prog.titles.map(t => t.text),
        ...prog.descs.map(d => d.text)
    ].join(' ').toLowerCase();

    for (const [category, regexes] of Object.entries(ENRICHMENT_CATEGORIES)) {
        for (const regex of regexes) {
            if (regex.test(textToScan) && !newCategories.has(category)) {
                newCategories.add(category);
                addedCount++;
            }
        }
    }
    prog.categories = Array.from(newCategories);
    return { enrichedProg: prog, newCats: addedCount };
}

function writeFinalXml(outPath, channels, programmes) {
    log(`Writing final guide to ${outPath}...`);
    const stream = fs.createWriteStream(outPath);
    
    stream.write('<?xml version="1.0" encoding="UTF-8"?>\n');
    stream.write('<tv generator-info-name="iptv-org-merge-rich">\n');

    for (const channel of channels.values()) {
        stream.write(`  ${channel.raw}\n`);
    }

    const allProgs = [...programmes.values()].flat();
    allProgs.sort((a,b) => a.start - b.start); // Sort by start time for cleaner output

    for (const prog of allProgs) {
        const startStr = formatXmltvTime(prog.start);
        const stopStr = formatXmltvTime(prog.stop);
        stream.write(`  <programme start="${startStr}" stop="${stopStr}" channel="${prog.channel}">\n`);
        prog.titles.forEach(t => stream.write(`    <title lang="${t.lang || 'en'}">${escapeXml(t.text)}</title>\n`));
        prog.subTitles.forEach(st => stream.write(`    <sub-title lang="${st.lang || 'en'}">${escapeXml(st.text)}</sub-title>\n`));
        prog.descs.forEach(d => stream.write(`    <desc lang="${d.lang || 'en'}">${escapeXml(d.text)}</desc>\n`));
        if (prog.credits) {
            const creditsXml = formatCreditsXml(prog.credits);
            if (creditsXml) stream.write(creditsXml);
        }
        prog.categories.forEach(c => stream.write(`    <category>${escapeXml(c)}</category>\n`));
        prog.episodeNums.forEach(e => stream.write(`    <episode-num system="${e.system || ''}">${escapeXml(e.text)}</episode-num>\n`));
        prog.icons.forEach(i => stream.write(`    <icon src="${escapeXml(i)}" />\n`));
        prog.ratings.forEach(r => stream.write(`    <rating system=""><value>${escapeXml(r)}</value></rating>\n`));
        stream.write('  </programme>\n');
    }

    stream.write('</tv>\n');
    stream.end();
}

function printFinalStats(stats) {
    log('\n--- Final Statistics ---');
    log(`Total Channels Written: ${stats.totalChannels}`);
    log(`Total Programmes Written: ${stats.totalProgrammes}`);
    log(`Categories Added by Enrichment: ${stats.enrichmentAdded}`);
    
    const topCategories = [...stats.categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
        
    log('\nTop 10 Categories:');
    topCategories.forEach(([cat, count]) => {
        log(` - ${cat}: ${count}`);
    });
}


// --- 4) Scoring & Formatting Utilities ---

function scoreChannel(channel) {
    let score = 0;
    if (channel.icon) score += 3;
    if (channel.url) score += 2;
    if (channel.displayName) score += Math.min(10, Math.floor(channel.displayName.length / 6));
    return score;
}

function scoreProgramme(prog) {
    let score = 0;
    if (prog.descs && prog.descs[0]) score += Math.min(10, Math.floor(prog.descs[0].text.length / 50));
    if (prog.categories) score += 2 * prog.categories.length;
    if (prog.subTitles && prog.subTitles.length > 0) score += 3;
    if (prog.episodeNums && prog.episodeNums.length > 0) score += 5;
    if (prog.icons && prog.icons.length > 0) score += 1;
    if (prog.ratings && prog.ratings.length > 0) score += 1;
    return score;
}

function formatXmltvTime(epochMs) {
    const d = new Date(epochMs);
    const pad = (n) => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
           `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`;
}

function formatCreditsXml(credits) {
    let xml = '';
    const createCreditTags = (role, names) => {
        if (names && names.length) {
            names.forEach(name => xml += `      <${role}>${escapeXml(name)}</${role}>\n`);
        }
    };
    xml += '    <credits>\n';
    createCreditTags('director', credits.director);
    createCreditTags('actor', credits.actor);
    createCreditTags('writer', credits.writer);
    createCreditTags('producer', credits.producer);
    createCreditTags('presenter', credits.presenter);
    xml += '    </credits>\n';
    return xml.includes('</') ? xml : ''; // Only return if credits were added
}

function parseCredits(body) {
    const credits = { director: [], actor: [], writer: [], producer: [], presenter: [] };
    const creditsBlock = getTagContent(body, 'credits');
    if (!creditsBlock) return credits;
    credits.director = getTagContents(creditsBlock, 'director').map(t => t.text);
    credits.actor = getTagContents(creditsBlock, 'actor').map(t => t.text);
    credits.writer = getTagContents(creditsBlock, 'writer').map(t => t.text);
    credits.producer = getTagContents(creditsBlock, 'producer').map(t => t.text);
    credits.presenter = getTagContents(creditsBlock, 'presenter').map(t => t.text);
    return credits;
}

// --- 5) Low-level XML & String Utilities ---

const escapeXml = (unsafe) => unsafe.replace(/[<>&'"]/g, c => {
    switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
    }
});

function getTagContent(xml, tagName) {
    const match = xml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`));
    return match ? match[1].trim() : '';
}

function getTagContents(xml, tagName) {
    const regex = new RegExp(`<${tagName}(?:\\s+lang="([^"]+)")?>([\\s\\S]*?)<\\/${tagName}>`, 'g');
    const results = [];
    let match;
    while ((match = regex.exec(xml)) !== null) {
        results.push({ lang: match[1], text: match[2].trim() });
    }
    return results;
}

function getTagAttribute(xml, tagName, attrName) {
    const match = xml.match(new RegExp(`<${tagName}[^>]*\\s${attrName}="([^"]+)"`));
    return match ? match[1] : '';
}

function getTagAttributes(xml, tagName, attrName) {
    const regex = new RegExp(`<${tagName}[^>]*\\s${attrName}="([^"]+)"`, 'g');
    const results = [];
    let match;
    while ((match = regex.exec(xml)) !== null) {
        results.push(match[1]);
    }
    return results;
}

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}