#!/usr/bin/env node
'use strict';

/**
 * Resolve team/player/match IDs from the BallDontLie API.
 * Reads config/bets.json, writes config/bets.resolved.json.
 * Run via: BDL_API_KEY=<key> node backend/resolve_ids.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY  = process.env.BDL_API_KEY;
const BASE_URL = 'https://api.balldontlie.io/fifa/worldcup/v1';

if (!API_KEY) {
  console.error('ERROR: BDL_API_KEY environment variable is required');
  process.exit(1);
}

function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${endpoint}`;
    const req = https.get(url, { headers: { Authorization: API_KEY } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}: ${body.slice(0, 200)}`));
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
    const url = cursor ? `${endpoint}${sep}cursor=${cursor}&per_page=100` : `${endpoint}${sep}per_page=100`;
    const data = await apiGet(url);
    results.push(...(data.data ?? []));
    cursor = data.meta?.next_cursor ?? null;
    if (cursor) await new Promise(r => setTimeout(r, 500));
  } while (cursor);
  return results;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const betsPath = path.join(__dirname, '..', 'config', 'bets.json');
  const outPath  = path.join(__dirname, '..', 'config', 'bets.resolved.json');
  const bets = JSON.parse(fs.readFileSync(betsPath, 'utf8'));

  console.log('Fetching teams…');
  const teams = await getAllPages('/teams');
  await sleep(300);

  const teamMap = {};
  for (const t of teams) teamMap[t.name] = t;

  // Resolve team IDs needed
  const teamNames = ['Mexico','South Korea','USA','Australia','Scotland','Morocco','Paraguay','Türkiye','Brazil','Haiti'];
  const resolvedTeams = {};
  for (const name of teamNames) {
    const t = teams.find(x => x.name === name || x.abbreviation === name);
    if (t) resolvedTeams[name] = { id: t.id, abbreviation: t.abbreviation };
    else console.warn(`WARNING: team not found: ${name}`);
  }
  resolvedTeams['Turkey'] = resolvedTeams['Türkiye'];

  // Resolve matches by team pairs
  console.log('Fetching matches…');
  const teamIds = Object.values(resolvedTeams).map(t => t?.id).filter(Boolean);
  const uniqueIds = [...new Set(teamIds)];
  const qstring = uniqueIds.map(id => `team_ids[]=${id}`).join('&');
  const allMatches = await getAllPages(`/matches?${qstring}`);
  await sleep(300);

  const fixtures = [
    { home: 'Mexico', away: 'South Korea' },
    { home: 'USA', away: 'Australia' },
    { home: 'Scotland', away: 'Morocco' },
    { home: 'Türkiye', away: 'Paraguay' },
    { home: 'Brazil', away: 'Haiti' },
  ];

  const resolvedMatches = {};
  for (const fix of fixtures) {
    const homeId = resolvedTeams[fix.home]?.id;
    const awayId = resolvedTeams[fix.away]?.id;
    const m = allMatches.find(match => {
      const hid = match.home_team?.id ?? match.home_team_id;
      const aid = match.away_team?.id ?? match.away_team_id;
      return (hid === homeId && aid === awayId) || (hid === awayId && aid === homeId);
    });
    if (m) {
      resolvedMatches[`${fix.home} vs ${fix.away}`] = {
        id: m.id, home: m.home_team?.name, away: m.away_team?.name,
        status: m.status, datetime: m.datetime,
        home_score: m.home_score, away_score: m.away_score,
      };
    } else {
      console.warn(`WARNING: match not found: ${fix.home} vs ${fix.away}`);
    }
  }

  // Resolve players via lineups (more reliable than /players search)
  const brazilHaitiMatch = resolvedMatches['Brazil vs Haiti'];
  let resolvedPlayers = {};
  if (brazilHaitiMatch) {
    console.log(`Fetching lineups for match ${brazilHaitiMatch.id}…`);
    await sleep(300);
    const lineupData = await apiGet(`/match_lineups?match_ids[]=${brazilHaitiMatch.id}&per_page=100`);
    const lineup = lineupData.data ?? [];

    const playerSearches = [
      { key: 'Vinicius Junior', patterns: ['vinícius júnior', 'vinicius junior', 'vinicius'], team_id: resolvedTeams['Brazil']?.id },
      { key: 'Matheus Cunha', patterns: ['matheus cunha'], team_id: resolvedTeams['Brazil']?.id },
      { key: 'Jean-Ricner Bellegarde', patterns: ['bellegarde'], team_id: resolvedTeams['Haiti']?.id },
      { key: 'Bruno Guimaraes', patterns: ['bruno guimarães', 'bruno guimaraes'], team_id: resolvedTeams['Brazil']?.id },
      { key: 'Douglas Santos', patterns: ['douglas santos'], team_id: resolvedTeams['Brazil']?.id },
      { key: 'Lucas Paqueta', patterns: ['lucas paquetá', 'paqueta'], team_id: resolvedTeams['Brazil']?.id },
      { key: 'Danilo da Silva', patterns: ['danilo'], team_id: resolvedTeams['Brazil']?.id, note: 'Resolves to Danilo (id=304), the Brazil defender. Exclude Danilo Santos (id=29617).' },
    ];

    for (const ps of playerSearches) {
      const match = lineup.find(e => {
        if (e.team_id !== ps.team_id) return false;
        const n = (e.player?.name ?? '').toLowerCase();
        return ps.patterns.some(pat => n.includes(pat));
      });
      if (match) {
        resolvedPlayers[ps.key] = {
          id: match.player.id,
          api_name: match.player.name,
          team_id: match.team_id,
          is_starter: match.is_starter,
          position: match.player.position,
        };
      } else {
        console.warn(`WARNING: player not found in lineup: ${ps.key}`);
      }
    }
    // Fix: Danilo Santos (sub, id=29617) vs Danilo (starter, id=304) — keep only id=304
    if (resolvedPlayers['Danilo da Silva']?.api_name?.toLowerCase().includes('santos')) {
      // Wrong Danilo — try to find the correct one explicitly
      const danilo = lineup.find(e => e.team_id === resolvedTeams['Brazil']?.id &&
        e.player?.name?.toLowerCase() === 'danilo');
      if (danilo) resolvedPlayers['Danilo da Silva'] = {
        id: danilo.player.id, api_name: danilo.player.name,
        team_id: danilo.team_id, is_starter: danilo.is_starter,
      };
    }
  }

  // Build resolved bets
  const resolvedBets = JSON.parse(JSON.stringify(bets));
  const turkiyeMatchId = resolvedMatches['Türkiye vs Paraguay']?.id ?? resolvedMatches['Paraguay vs Türkiye']?.id;
  const brazilMatchId  = resolvedMatches['Brazil vs Haiti']?.id;

  for (const bet of resolvedBets.bets) {
    if (bet.id === 'fourfold-match-result') {
      const legMatchMap = {
        f1: { key: 'Mexico vs South Korea', team: 'Mexico' },
        f2: { key: 'USA vs Australia', team: 'USA' },
        f3: { key: 'Scotland vs Morocco', team: 'Morocco' },
        f4: { key: 'Türkiye vs Paraguay', team: 'Turkey' },
      };
      for (const leg of bet.legs) {
        const info = legMatchMap[leg.id];
        if (!info) continue;
        const m = resolvedMatches[info.key];
        leg.match_id = m?.id ?? null;
        leg.team_id  = resolvedTeams[info.team]?.id ?? null;
      }
    } else if (bet.match) {
      bet.match.match_id = brazilMatchId ?? null;
      for (const leg of bet.legs) {
        leg.player_id = resolvedPlayers[leg.player]?.id ?? null;
        leg.label = leg.label ?? `${leg.player} — ${marketLabel(leg)}`;
      }
    }
  }

  const output = {
    _resolved_at: new Date().toISOString(),
    teams: resolvedTeams,
    players: resolvedPlayers,
    matches: resolvedMatches,
    bets: resolvedBets.bets,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
  console.log('Resolved teams:', Object.keys(resolvedTeams).join(', '));
  console.log('Resolved players:', Object.keys(resolvedPlayers).join(', '));
  console.log('Resolved matches:', Object.keys(resolvedMatches).join(', '));
}

function marketLabel(leg) {
  switch (leg.market) {
    case 'goal_or_assist': return 'Anytime Goal or Assist';
    case 'shots_on_target': return `Shots on Target ${leg.threshold}+`;
    case 'tackles_won': return `Tackles Won ${leg.threshold}+`;
    case 'fouls_committed': return `Fouls Committed ${leg.threshold}+`;
    default: return leg.market;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
