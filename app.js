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
