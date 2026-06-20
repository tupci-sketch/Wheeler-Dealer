'use strict';

// State URL — reads from state branch
const STATE_URL = 'https://raw.githubusercontent.com/tupci-sketch/wheeler-dealer/state/state.json';
const REFRESH_INTERVAL = 30000; // 30s

const CASHOUT_KEY = 'wd_cashedout';

let currentState = null;
let refreshTimer = null;
let lastUpdated = null;

// --- Local cash-out override ---
function getCashedOut() {
  try { return JSON.parse(localStorage.getItem(CASHOUT_KEY) ?? '[]'); } catch { return []; }
}
function setCashedOut(ids) {
  localStorage.setItem(CASHOUT_KEY, JSON.stringify(ids));
}
function markCashedOut(betId) {
  const ids = getCashedOut();
  if (!ids.includes(betId)) ids.push(betId);
  setCashedOut(ids);
}

// --- Fetch state ---
async function loadState() {
  const url = STATE_URL + '?_=' + Date.now(); // cache-bust
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- Apply cash-out overrides ---
function applyOverrides(state) {
  const cashedOut = getCashedOut();
  const now = new Date().toISOString();
  for (const bet of state.bets) {
    if (cashedOut.includes(bet.id) && !['won','lost','cashed_out'].includes(bet.status)) {
      bet.status = 'cashed_out';
      bet.settled_at = bet.settled_at ?? now;
    }
  }
  return state;
}

// --- Refresh logic ---
async function refresh() {
  setRefreshing(true);
  try {
    const raw = await loadState();
    currentState = applyOverrides(raw);
    lastUpdated = new Date();
    render();
    updateUpdatedLabel();
  } catch (e) {
    console.warn('Refresh failed:', e.message);
    document.getElementById('updated-label').textContent = 'Update failed';
  } finally {
    setRefreshing(false);
  }
}

function setRefreshing(on) {
  const btn = document.getElementById('refresh-btn');
  btn.innerHTML = on ? '<span class="spinner"></span>' : '↻ Refresh';
  btn.disabled = on;
}

function updateUpdatedLabel() {
  if (!lastUpdated) return;
  const el = document.getElementById('updated-label');
  const secs = Math.round((Date.now() - lastUpdated) / 1000);
  el.textContent = secs < 5 ? 'Just updated' : `Updated ${secs}s ago`;
}

// --- Tab state ---
let activeTab = 'active';

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  render();
}

// --- Rendering ---
function render() {
  if (!currentState) return;

  const bets = currentState.bets ?? [];
  const cashedOut = getCashedOut();

  // Apply cash-out locally
  for (const b of bets) {
    if (cashedOut.includes(b.id) && !['won','lost','cashed_out'].includes(b.status)) {
      b.status = 'cashed_out';
    }
  }

  const isSettled = b => ['won','lost','void','cashed_out'].includes(b.status);
  const activeBets  = bets.filter(b => !isSettled(b));
  const settledBets = bets.filter(b => isSettled(b));

  const list = activeTab === 'active' ? activeBets : settledBets;

  const container = document.getElementById('bets-container');
  container.innerHTML = '';

  // Update tab badges
  document.querySelector('[data-tab="active"]').textContent =
    `Active${activeBets.length ? ` (${activeBets.length})` : ''}`;
  document.querySelector('[data-tab="settled"]').textContent =
    `Settled${settledBets.length ? ` (${settledBets.length})` : ''}`;

  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state"><span class="icon">${activeTab === 'active' ? '⏳' : '📋'}</span>${activeTab === 'active' ? 'No active bets' : 'No settled bets yet'}</div>`;
    return;
  }

  for (const bet of list) {
    container.appendChild(renderBetCard(bet, currentState.matches ?? {}));
  }
}

function renderBetCard(bet, matches) {
  const card = document.createElement('div');
  card.className = 'bet-card';

  // Find match for this bet
  const matchId = findMatchId(bet);
  const match = matchId ? matches[String(matchId)] : null;

  card.innerHTML = `
    ${renderBetHeader(bet)}
    ${match ? renderMatchInfo(match, bet) : ''}
    ${renderProgressBar(bet)}
    <div class="legs-list">${bet.legs.map(renderLeg).join('')}</div>
  `;

  // Wire cash-out button
  const coBtn = card.querySelector('.cash-out-btn');
  if (coBtn) {
    coBtn.addEventListener('click', () => {
      markCashedOut(bet.id);
      showToast(`${bet.name} marked as cashed out`);
      render();
    });
  }

  return card;
}

function findMatchId(bet) {
  if (bet.match_id) return bet.match_id;
  // Infer from legs (player props bets all share one match)
  for (const l of bet.legs ?? []) if (l.match_id) return l.match_id;
  return null;
}

function renderBetHeader(bet) {
  const isActive = !['won','lost','void','cashed_out'].includes(bet.status);
  const coButton = isActive ? `<button class="cash-out-btn" title="Mark as cashed out">Cash out</button>` : '';
  const settledLine = bet.settled_at
    ? `<div class="settled-at">${formatDate(bet.settled_at)}</div>` : '';

  return `
    <div class="bet-header">
      <div class="bet-title-row">
        <div class="bet-name">${bet.name}</div>
        <div class="bet-meta">
          ${statusBadge(bet.status)}
          ${bet.stake?.free_bet ? '<span class="badge badge-free">Free Bet</span>' : ''}
        </div>
        ${settledLine}
      </div>
      <div class="bet-right">
        <div class="bet-return">£${bet.potential_return?.toFixed(2) ?? '—'}</div>
        <div class="bet-odds">${bet.odds_fractional ?? ''}</div>
        ${coButton}
      </div>
    </div>`;
}

function renderMatchInfo(match, bet) {
  const isLive = match.status === 'in_progress';
  const liveIndicator = isLive ? '<span class="live-dot"></span>' : '';
  const statusStr = match.status === 'completed' ? 'FT'
    : match.status === 'scheduled' ? 'KO soon'
    : match.clock ? `${match.clock}'` : 'Live';

  const hasScore = match.home_score != null && match.away_score != null;
  const score = hasScore
    ? `<span class="match-score">${match.home_score}–${match.away_score}</span>`
    : `<span class="match-score no-score">vs</span>`;

  return `
    <div class="match-info">
      <div class="match-teams">${match.home} vs ${match.away}</div>
      ${score}
      <div class="match-clock">${liveIndicator}${statusStr}</div>
    </div>`;
}

function renderProgressBar(bet) {
  const { total, won, lost, void: v, open } = bet.summary ?? {};
  const pct = total ? Math.round((won / total) * 100) : 0;
  const barColor = bet.status === 'lost' ? 'var(--red)'
    : bet.status === 'won' ? 'var(--green)'
    : 'var(--blue)';

  return `
    <div class="progress-bar-wrap">
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width:${pct}%;background:${barColor}"></div>
      </div>
      <div class="progress-label">
        <span class="won-count">${won}✓</span>
        ${lost ? `<span class="lost-count"> ${lost}✗</span>` : ''}
        ${v ? ` ${v}∅` : ''}
        <span style="color:var(--text-muted)">/${total}</span>
      </div>
    </div>`;
}

function renderLeg(leg) {
  const icon = { won: '✅', lost: '❌', void: '○', open: '○' }[leg.status] ?? '○';
  const labelClass = ['won','lost','void'].includes(leg.status) ? leg.status : '';

  // Mini dots for threshold legs
  let miniBar = '';
  if (leg.target >= 2 && leg.status !== 'void') {
    const dots = Array.from({ length: leg.target }, (_, i) =>
      `<div class="leg-mini-dot${i < (leg.current ?? 0) ? ' filled' : ''}"></div>`
    ).join('');
    miniBar = `<div class="leg-mini-bar">${dots}</div>`;
  }

  return `
    <div class="leg-row">
      <span class="leg-icon">${icon}</span>
      <span class="leg-label ${labelClass}">${leg.label ?? leg.id}</span>
      ${miniBar}
      <span class="leg-value ${leg.status}">${leg.value ?? '—'}</span>
    </div>`;
}

function statusBadge(status) {
  const map = {
    won: ['badge-won', '🏆 Won'],
    lost: ['badge-lost', '❌ Lost'],
    running: ['badge-running', '🔴 Live'],
    open: ['badge-open', '⏳ Pending'],
    void: ['badge-void', '∅ Void'],
    cashed_out: ['badge-cashed-out', '💰 Cashed Out'],
  };
  const [cls, label] = map[status] ?? ['badge-open', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

// --- Toast ---
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', () => {
    clearInterval(refreshTimer);
    refresh();
    startAutoRefresh();
  });

  // Load
  refresh();
  startAutoRefresh();

  // Update "Xm ago" label every 15s
  setInterval(updateUpdatedLabel, 15000);
});

function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_INTERVAL);
}

// Service Worker registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ─── Admin / Bet Builder ───────────────────────────────────────────────────

const ADMIN_PIN   = '1644';
const GH_REPO     = 'tupci-sketch/wheeler-dealer';
const GH_FILE     = 'config/bets.resolved.json';
const PAT_KEY     = 'wd_gh_pat';

const KNOWN_PLAYERS = [
  { id: 9227,  name: 'Vinícius Júnior',       team_id: 9,  team: 'Brazil' },
  { id: 29607, name: 'Matheus Cunha',           team_id: 9,  team: 'Brazil' },
  { id: 9245,  name: 'Bruno Guimarães',          team_id: 9,  team: 'Brazil' },
  { id: 29625, name: 'Douglas Santos',           team_id: 9,  team: 'Brazil' },
  { id: 9224,  name: 'Lucas Paquetá',            team_id: 9,  team: 'Brazil' },
  { id: 304,   name: 'Danilo',                   team_id: 9,  team: 'Brazil' },
  { id: 30001, name: 'Jean-Ricner Bellegarde',   team_id: 11, team: 'Haiti'  },
];

const KNOWN_TEAMS = [
  { id: 1,  name: 'Mexico' },    { id: 3,  name: 'South Korea' },
  { id: 9,  name: 'Brazil' },    { id: 10, name: 'Morocco' },
  { id: 11, name: 'Haiti' },     { id: 12, name: 'Scotland' },
  { id: 13, name: 'USA' },       { id: 14, name: 'Paraguay' },
  { id: 15, name: 'Australia' }, { id: 16, name: 'Türkiye' },
];

let adminUnlocked = sessionStorage.getItem('wd_admin') === '1';
let builderLegs = [];

// --- PIN modal ---

function showPinModal() {
  document.getElementById('pin-input').value = '';
  document.getElementById('pin-error').classList.add('hidden');
  document.getElementById('pin-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('pin-input').focus(), 50);
}

function closePinModal() {
  document.getElementById('pin-modal').classList.add('hidden');
}

function submitPin() {
  const val = document.getElementById('pin-input').value.trim();
  if (val === ADMIN_PIN) {
    adminUnlocked = true;
    sessionStorage.setItem('wd_admin', '1');
    closePinModal();
    document.getElementById('admin-btn').textContent = '🔓';
    document.getElementById('add-bet-btn').classList.remove('hidden');
    showToast('Admin mode on');
  } else {
    document.getElementById('pin-error').classList.remove('hidden');
    document.getElementById('pin-input').value = '';
    document.getElementById('pin-input').focus();
  }
}

// --- Bet Builder modal ---

function openBuilder() {
  builderLegs = [];
  // Pre-fill saved PAT
  const savedPat = localStorage.getItem(PAT_KEY) ?? '';
  document.getElementById('b-pat').value = savedPat;
  // Populate match dropdown from current state
  populateMatchDropdown();
  // Populate player dropdown
  populatePlayerDropdown();
  renderBuilderLegs();
  updateReturn();
  onMarketChange();
  document.getElementById('builder-modal').classList.remove('hidden');
}

function closeBuilder() {
  document.getElementById('builder-modal').classList.add('hidden');
  builderLegs = [];
}

function populateMatchDropdown() {
  const sel = document.getElementById('leg-match');
  // Remove existing state-derived options (keep blank + custom)
  while (sel.options.length > 2) sel.remove(1);
  const matches = currentState?.matches ?? {};
  const sorted = Object.entries(matches).sort((a, b) => {
    const order = { in_progress: 0, scheduled: 1, completed: 2 };
    return (order[a[1].status] ?? 3) - (order[b[1].status] ?? 3);
  });
  for (const [id, m] of sorted) {
    const opt = new Option(`${m.home} vs ${m.away} (${m.status === 'completed' ? 'FT' : m.status === 'in_progress' ? 'LIVE' : 'Soon'})`, id);
    sel.insertBefore(opt, sel.options[sel.options.length - 1]);
  }
}

function populatePlayerDropdown() {
  const sel = document.getElementById('leg-player');
  sel.innerHTML = '<option value="">— select player —</option>';
  for (const p of KNOWN_PLAYERS) {
    sel.add(new Option(`${p.name} (${p.team})`, String(p.id)));
  }
  sel.add(new Option('Custom player…', 'custom'));
}

// --- Match / market change handlers ---

function onMatchChange() {
  const val = document.getElementById('leg-match').value;
  const isCustom = val === 'custom';
  document.getElementById('custom-match-row').classList.toggle('hidden', !isCustom);

  const teamSel = document.getElementById('leg-team');
  teamSel.innerHTML = '';
  if (!isCustom && val && currentState?.matches?.[val]) {
    const m = currentState.matches[val];
    teamSel.add(new Option(`${m.home} (Home)`, 'home'));
    teamSel.add(new Option(`${m.away} (Away)`, 'away'));
  } else if (isCustom) {
    teamSel.add(new Option('Home team', 'home'));
    teamSel.add(new Option('Away team', 'away'));
  } else {
    teamSel.add(new Option('— pick match first —', ''));
  }
}

function onMarketChange() {
  const market = document.getElementById('leg-market').value;
  const isMatchResult = market === 'match_result';
  const needsThreshold = ['shots_on_target', 'tackles_won', 'fouls_committed'].includes(market);
  document.getElementById('match-result-sel').classList.toggle('hidden', !isMatchResult);
  document.getElementById('player-prop-sel').classList.toggle('hidden', isMatchResult);
  document.getElementById('threshold-row').classList.toggle('hidden', !needsThreshold);
}

function onPlayerChange() {
  const val = document.getElementById('leg-player').value;
  document.getElementById('custom-player-row').classList.toggle('hidden', val !== 'custom');
}

// --- Return calculator ---

function updateReturn() {
  const stake    = parseFloat(document.getElementById('b-stake').value) || 0;
  const oddsStr  = document.getElementById('b-odds').value.trim();
  const freeBet  = document.getElementById('b-frebet').checked;
  const parts    = oddsStr.split('/').map(Number);
  const el       = document.getElementById('b-return');
  if (parts.length === 2 && parts[1]) {
    const winnings = stake * (parts[0] / parts[1]);
    el.textContent = (freeBet ? winnings : winnings + stake).toFixed(2);
  } else {
    el.textContent = '—';
  }
}

// --- Leg management ---

function addLeg() {
  const market   = document.getElementById('leg-market').value;
  const matchSel = document.getElementById('leg-match').value;

  let matchId, home, away;
  if (matchSel === 'custom') {
    matchId = parseInt(document.getElementById('leg-match-id').value) || 0;
    home    = document.getElementById('leg-home').value.trim();
    away    = document.getElementById('leg-away').value.trim();
    if (!matchId || !home || !away) { showToast('Fill in match ID, home and away team'); return; }
  } else if (matchSel) {
    matchId = parseInt(matchSel);
    const m = currentState?.matches?.[matchSel] ?? {};
    home = m.home ?? ''; away = m.away ?? '';
  } else {
    showToast('Pick a match first'); return;
  }

  const legId = 'u' + (builderLegs.length + 1);
  const leg   = { id: legId, match_id: matchId };

  if (market === 'match_result') {
    const side     = document.getElementById('leg-team').value; // 'home' | 'away'
    if (!side) { showToast('Pick a team selection'); return; }
    const teamName = side === 'home' ? home : away;
    const known    = KNOWN_TEAMS.find(t => t.name.toLowerCase() === teamName.toLowerCase());
    leg.market         = 'match_result';
    leg.selection_team = teamName;
    leg.match          = { home, away };
    if (known) leg.team_id = known.id;
    leg.label = `${teamName} to Win`;
  } else {
    const playerSel = document.getElementById('leg-player').value;
    let playerId, playerName;
    if (playerSel === 'custom') {
      playerId   = parseInt(document.getElementById('leg-player-id').value) || 0;
      playerName = document.getElementById('leg-player-name').value.trim();
      if (!playerId || !playerName) { showToast('Enter player ID and name'); return; }
    } else if (playerSel) {
      const p  = KNOWN_PLAYERS.find(p => String(p.id) === playerSel);
      playerId   = p?.id;
      playerName = p?.name ?? '';
    } else {
      showToast('Pick a player'); return;
    }
    leg.market    = market;
    leg.player_id = playerId;
    leg.player    = playerName;
    if (market === 'goal_or_assist') {
      leg.label = `${playerName} — Goal or Assist`;
    } else {
      const threshold = parseInt(document.getElementById('leg-threshold').value) || 2;
      leg.threshold   = threshold;
      const mLabel = { shots_on_target: 'Shots on Target', tackles_won: 'Tackles Won', fouls_committed: 'Fouls Committed' }[market] ?? market;
      leg.label = `${playerName} — ${mLabel} ${threshold}+`;
    }
  }

  builderLegs.push(leg);
  renderBuilderLegs();
}

function removeLeg(idx) {
  builderLegs.splice(idx, 1);
  builderLegs.forEach((l, i) => l.id = 'u' + (i + 1));
  renderBuilderLegs();
}

function renderBuilderLegs() {
  const el = document.getElementById('legs-preview');
  document.getElementById('leg-count').textContent = builderLegs.length;
  if (!builderLegs.length) {
    el.innerHTML = '<p class="no-legs">No legs yet</p>';
    return;
  }
  el.innerHTML = builderLegs.map((l, i) => `
    <div class="builder-leg">
      <span class="builder-leg-label">${l.label}</span>
      <button class="builder-leg-remove" onclick="removeLeg(${i})">✕</button>
    </div>
  `).join('');
}

// --- GitHub API save ---

async function saveBet() {
  if (builderLegs.length === 0) { showToast('Add at least one leg'); return; }

  const name    = document.getElementById('b-name').value.trim() || 'My Bet';
  const stake   = parseFloat(document.getElementById('b-stake').value) || 10;
  const freeBet = document.getElementById('b-frebet').checked;
  const oddsStr = document.getElementById('b-odds').value.trim();
  const [num, den] = oddsStr.split('/').map(Number);
  const potReturn  = (num && den) ? +(stake * (freeBet ? num / den : 1 + num / den)).toFixed(2) : 0;
  const pat = document.getElementById('b-pat').value.trim();
  if (!pat) { showToast('Enter a GitHub PAT to save'); return; }
  localStorage.setItem(PAT_KEY, pat);

  const newBet = {
    id: 'user-' + Date.now(),
    name,
    type: 'accumulator',
    stake: { amount: stake, currency: 'GBP', free_bet: freeBet },
    odds_fractional: oddsStr,
    potential_return: potReturn,
    return_excludes_stake: freeBet,
    legs: builderLegs,
  };

  const btn = document.getElementById('save-bet-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const headers = {
      Authorization: `token ${pat}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
    const getRes = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${GH_FILE}`, { headers });
    if (!getRes.ok) throw new Error(`GitHub ${getRes.status}: check your PAT and repo access`);
    const file = await getRes.json();
    const current = JSON.parse(atob(file.content.replace(/\s/g, '')));
    current.bets.push(newBet);
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(current, null, 2))));
    const putRes  = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${GH_FILE}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ message: `Add bet: ${name}`, content: encoded, sha: file.sha }),
    });
    if (!putRes.ok) {
      const err = await putRes.json().catch(() => ({}));
      throw new Error(err.message ?? `GitHub ${putRes.status}`);
    }
    showToast(`"${name}" saved — poller picks it up on next cycle`);
    closeBuilder();
  } catch (e) {
    showToast(`Error: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Bet';
  }
}

// --- Admin init ---

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('admin-btn').addEventListener('click', () => {
    if (adminUnlocked) {
      adminUnlocked = false;
      sessionStorage.removeItem('wd_admin');
      document.getElementById('admin-btn').textContent = '🔒';
      document.getElementById('add-bet-btn').classList.add('hidden');
      showToast('Admin mode off');
    } else {
      showPinModal();
    }
  });
  document.getElementById('add-bet-btn').addEventListener('click', openBuilder);

  // Restore admin state across soft refreshes
  if (adminUnlocked) {
    document.getElementById('admin-btn').textContent = '🔓';
    document.getElementById('add-bet-btn').classList.remove('hidden');
  }

  // PIN input: auto-submit on 4 digits
  document.getElementById('pin-input').addEventListener('input', e => {
    if (e.target.value.length === 4) submitPin();
  });
}, { once: true });
