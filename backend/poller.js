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
          reject(new Error('Rate limited (429)'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        resolve(JSON.parse(body));
      });
    });
    req.on('error', reject);
  });
}

async function getAllPages(endpoint) {
  const results = [];
  let cursor = null;
  do {
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = cursor
      ? `${BASE_URL}${endpoint}${sep}cursor=${cursor}&per_page=100`
      : `${BASE_URL}${endpoint}${sep}per_page=100`;
    const data = await apiGet(url);
    results.push(...(data.data ?? []));
    cursor = data.meta?.next_cursor ?? null;
    if (cursor) await sleep(200);
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

async function fetchMatchData(matchIds) {
  const qstring = matchIds.map(id => `ids[]=${id}`).join('&');
  const rows = await getAllPages(`/matches?${qstring}`);
  const result = {};
  for (const m of rows) result[String(m.id)] = m;
  return result;
}

async function fetchPlayerStats(matchIds) {
  const qstring = matchIds.map(id => `match_ids[]=${id}`).join('&');
  const rows = await getAllPages(`/player_match_stats?${qstring}`);
  const result = {};
  for (const s of rows) {
    const mid = String(s.match_id);
    if (!result[mid]) result[mid] = [];
    result[mid].push(s);
  }
  return result;
}

async function fetchLineups(matchIds) {
  const qstring = matchIds.map(id => `match_ids[]=${id}`).join('&');
  const rows = await getAllPages(`/match_lineups?${qstring}`);
  const result = {};
  for (const e of rows) {
    const mid = String(e.match_id);
    if (!result[mid]) result[mid] = [];
    result[mid].push({ player_id: e.player?.id ?? e.player_id, team_id: e.team_id, is_starter: e.is_starter });
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
    execSync(`git config user.email "github-actions@github.com"`, { stdio: 'pipe' });
    execSync(`git config user.name "GitHub Actions"`, { stdio: 'pipe' });

    // Ensure state branch exists
    try {
      execSync(`git fetch origin state --depth 1`, { stdio: 'pipe' });
    } catch (_) {
      execSync(`git checkout --orphan state-tmp 2>/dev/null || true`, { stdio: 'pipe' });
    }

    // Write state to a temp worktree approach: create/reset state branch from scratch
    execSync(`git stash --include-untracked -m "poller-stash" 2>/dev/null || true`, { stdio: 'pipe' });
    execSync(`git fetch origin state 2>/dev/null || true`, { stdio: 'pipe' });

    // Use low-level git to push state.json to state branch without checkout
    const content = fs.readFileSync(STATE_PATH, 'utf8');
    const blobHash = execSync(`echo ${JSON.stringify(content)} | git hash-object -w --stdin`, { stdio: 'pipe' }).toString().trim();

    // Build a tree with just state.json
    const treeHash = execSync(
      `printf '100644 blob %s\tstate.json\n' "${blobHash}" | git mktree`,
      { stdio: 'pipe', shell: true }
    ).toString().trim();

    // Create a commit
    const now = new Date().toISOString();
    const commitHash = execSync(
      `git commit-tree ${treeHash} -m "state: ${now}"`,
      { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Actions', GIT_AUTHOR_EMAIL: 'actions@github.com', GIT_COMMITTER_NAME: 'Actions', GIT_COMMITTER_EMAIL: 'actions@github.com' } }
    ).toString().trim();

    execSync(`git push "${remote}" ${commitHash}:refs/heads/state --force`, { stdio: 'pipe' });
    console.log(`[state] Pushed state.json to state branch (commit ${commitHash.slice(0,7)})`);
  } catch (err) {
    console.warn(`[state] Failed to push: ${err.message}`);
  }
}

async function poll(resolved, prevState) {
  const matchIds = getActiveMatchIds(resolved);
  console.log(`[poll] Fetching data for matches: ${matchIds.join(', ')}`);

  const [matchData, playerStats, lineups] = await Promise.all([
    fetchMatchData(matchIds),
    fetchPlayerStats(matchIds),
    fetchLineups(matchIds),
  ]);

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
      // On rate limit, wait longer
      if (err.message.includes('429')) await sleep(60000);
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
