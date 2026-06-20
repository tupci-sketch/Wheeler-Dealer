#!/usr/bin/env node
'use strict';

/**
 * Live poller — runs as a loop for ~3 hours, fetching API data every 45s.
 * Writes state.json to the state branch via git force-push.
 *
 * Env vars required:
 *   BDL_API_KEY       — BallDontLie API key
 *   NTFY_TOPIC        — ntfy.sh topic string
 *   GITHUB_TOKEN      — for pushing to state branch (auto-provided in Actions)
 *   GITHUB_REPOSITORY — e.g. tupci-sketch/wheeler-dealer
 *   POLL_INTERVAL_MS  — optional, default 45000
 *   MAX_RUNTIME_MS    — optional, default 10800000 (3h)
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

const { evaluate }          = require('./evaluate');
const { notifyTransitions } = require('./ntfy');

const API_KEY   = process.env.BDL_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? '';
const POLL_MS   = parseInt(process.env.POLL_INTERVAL_MS ?? '45000', 10);
const MAX_MS    = parseInt(process.env.MAX_RUNTIME_MS ?? '10800000', 10);
const BASE_URL  = 'https://api.balldontlie.io/fifa/worldcup/v1';

const RESOLVED_PATH = path.join(__dirname, '..', 'config', 'bets.resolved.json');
const STATE_PATH    = path.join(__dirname, '..', 'state.json');

if (!API_KEY) { console.error('BDL_API_KEY is required'); process.exit(1); }

function apiGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: API_KEY } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 429) {
          const retryAfterSec = parseInt(res.headers['retry-after'] ?? '60', 10);
          const retryMs = retryAfterSec * 1000;
          console.warn(`[api] 429 from ${url.replace(API_KEY, '***')}`);
          console.warn(`[api] Retry-After: ${retryAfterSec}s  body: ${body.slice(0, 300)}`);
          const err = new Error(`Rate limited (429) — retry after ${retryAfterSec}s`);
          err.retryMs = retryMs;
          reject(err);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
  });
}

async function getAllPages(endpoint) {
  const results = [];
  let cursor = null;
  let page = 0;
  do {
    if (++page > 20) { console.warn(`[api] Safety: >20 pages for ${endpoint}`); break; }
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = cursor
      ? `${BASE_URL}${endpoint}${sep}cursor=${cursor}&per_page=100`
      : `${BASE_URL}${endpoint}${sep}per_page=100`;
    const data = await apiGet(url);
    const items = data.data ?? [];
    results.push(...items);
    // Use || so that empty-string / 0 / false all terminate pagination
    cursor = data.meta?.next_cursor || null;
    if (cursor) await sleep(1000);
  } while (cursor);
  return results;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadResolved() {
  return JSON.parse(fs.readFileSync(RESOLVED_PATH, 'utf8'));
}

function getActiveMatchIds(resolved) {
  const ids = new Set();
  for (const bet of resolved.bets) {
    if (bet.match?.match_id) ids.add(bet.match.match_id);
    for (const leg of bet.legs) {
      if (leg.match_id) ids.add(leg.match_id);
    }
  }
  return [...ids];
}

// Only matches that have at least one non-match_result leg need player stats + lineups
function getPlayerPropMatchIds(resolved) {
  const ids = new Set();
  for (const bet of resolved.bets) {
    if (!bet.legs.some(l => l.market !== 'match_result')) continue;
    if (bet.match?.match_id) ids.add(bet.match.match_id);
    for (const leg of bet.legs) {
      if (leg.match_id && leg.market !== 'match_result') ids.add(leg.match_id);
    }
  }
  return [...ids];
}

// Single-page fetch — our datasets (5 matches, ~30 players per match) always fit in 100.
// Never follow the cursor: BallDontLie returns a cursor even when filtering by IDs,
// and following it pages through the entire WC dataset, burning rate-limit quota.
async function fetchOnePage(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${BASE_URL}${endpoint}${sep}per_page=100`;
  const data = await apiGet(url);
  return data.data ?? [];
}

async function fetchMatchData(matchIds) {
  const qstring = matchIds.map(id => `ids[]=${id}`).join('&');
  const rows = await fetchOnePage(`/matches?${qstring}`);
  const result = {};
  for (const m of rows) result[String(m.id)] = m;
  return result;
}

async function fetchPlayerStats(matchIds) {
  const result = {};
  for (const id of matchIds) {
    result[String(id)] = await fetchOnePage(`/player_match_stats?match_ids[]=${id}`);
    if (id !== matchIds[matchIds.length - 1]) await sleep(1000);
  }
  return result;
}

async function fetchLineups(matchIds) {
  const result = {};
  for (const id of matchIds) {
    const rows = await fetchOnePage(`/match_lineups?match_ids[]=${id}`);
    result[String(id)] = rows.map(e => ({
      player_id: e.player?.id ?? e.player_id,
      team_id: e.team_id,
      is_starter: e.is_starter,
    }));
    if (id !== matchIds[matchIds.length - 1]) await sleep(1000);
  }
  return result;
}

async function writeStateToBranch(stateJson) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(stateJson, null, 2));

  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    console.log('[state] No GITHUB_REPOSITORY/GITHUB_TOKEN — skipping push');
    return;
  }

  try {
    const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
    execSync('git config user.email "github-actions@github.com"', { stdio: 'pipe' });
    execSync('git config user.name "GitHub Actions"', { stdio: 'pipe' });

    // Hash the file from disk — avoids all shell-escaping issues with JSON content
    const blobHash = execSync(`git hash-object -w -- "${STATE_PATH}"`, { stdio: 'pipe' }).toString().trim();

    // Build a minimal tree with just state.json, passing descriptor via Node stdin
    const treeHash = execSync('git mktree', {
      input: `100644 blob ${blobHash}\tstate.json\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();

    // Create a root commit (no parent — history doesn't matter for state branch)
    const now = new Date().toISOString();
    const commitHash = execSync(`git commit-tree ${treeHash} -m "state: ${now}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Actions',
        GIT_AUTHOR_EMAIL: 'actions@github.com',
        GIT_COMMITTER_NAME: 'Actions',
        GIT_COMMITTER_EMAIL: 'actions@github.com',
      },
    }).toString().trim();

    execSync(`git push "${remote}" ${commitHash}:refs/heads/state --force`, { stdio: 'pipe' });
    console.log(`[state] Pushed state.json (commit ${commitHash.slice(0, 7)})`);
  } catch (err) {
    console.warn(`[state] Failed to push: ${err.message}`);
  }
}

async function poll(resolved, prevState) {
  const allMatchIds      = getActiveMatchIds(resolved);
  const propMatchIds     = getPlayerPropMatchIds(resolved); // only matches with player prop legs
  const prevMatches      = prevState?.matches ?? {};

  // Step 1: fetch all match statuses (one request covers all five matches)
  const matchData = await fetchMatchData(allMatchIds);

  // Step 2: fetch player stats + lineups only for player-prop matches that are active.
  // Skip if already completed in prevState — latching in the evaluate engine handles those legs.
  const needsStats = propMatchIds.filter(id => {
    const cur  = matchData[String(id)];
    const prev = prevMatches[String(id)];
    return cur?.status === 'in_progress' ||
           (cur?.status === 'completed' && prev?.status !== 'completed');
  });

  console.log(`[poll] all=${allMatchIds.join(',')}  prop=${propMatchIds.join(',')}  fetching=${needsStats.join(',') || 'none'}`);

  const playerStats = needsStats.length ? await fetchPlayerStats(needsStats) : {};
  const lineups     = needsStats.length ? await fetchLineups(needsStats)     : {};

  const newState = evaluate(resolved, matchData, playerStats, lineups, prevState);

  await writeStateToBranch(newState);
  await notifyTransitions(NTFY_TOPIC, prevState, newState);

  // Log summary
  for (const bet of newState.bets) {
    console.log(`[${bet.name}] status=${bet.status} legs=${bet.summary.won}W/${bet.summary.lost}L/${bet.summary.void}V/${bet.summary.open}O`);
  }

  return newState;
}

async function main() {
  console.log(`Poller starting — interval=${POLL_MS}ms max_runtime=${MAX_MS}ms`);
  const resolved = loadResolved();
  const start = Date.now();

  let prevState = null;
  // Load previous state if available
  if (fs.existsSync(STATE_PATH)) {
    try { prevState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (_) {}
  }

  let iteration = 0;
  while (Date.now() - start < MAX_MS) {
    iteration++;
    console.log(`\n--- Poll #${iteration} at ${new Date().toISOString()} ---`);
    try {
      prevState = await poll(resolved, prevState);
    } catch (err) {
      console.error(`[poll] Error: ${err.message}`);
      if (err.message.includes('429')) {
        const backoff = err.retryMs ?? 60000;
        console.log(`[poll] Rate-limit backoff: ${backoff / 1000}s`);
        await sleep(backoff);
      }
    }

    const elapsed = Date.now() - start;
    const remaining = MAX_MS - elapsed;
    if (remaining <= 0) break;
    const wait = Math.min(POLL_MS, remaining);
    console.log(`[poll] Sleeping ${wait / 1000}s…`);
    await sleep(wait);
  }

  console.log('Poller finished.');
}

main().catch(e => { console.error(e); process.exit(1); });
