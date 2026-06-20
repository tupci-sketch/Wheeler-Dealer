'use strict';

/**
 * Pure evaluation engine — no I/O, no network.
 * evaluate(resolvedBets, matchData, playerStats, lineups, prevState?) → state
 *
 * matchData:   { [match_id]: { home, away, status, home_score, away_score, clock_display } }
 * playerStats: { [match_id]: [ { player_id, goals, assists, shots_on_target, tackles_won, fouls_committed, minutes_played, ... } ] }
 * lineups:     { [match_id]: [ { player_id, team_id, is_starter } ] }
 * prevState:   last state.json (for latching won legs; pass null on first run)
 */
function evaluate(resolvedBets, matchData, playerStats, lineups, prevState = null) {
  const now = new Date().toISOString();
  const prevBets = {};
  if (prevState && prevState.bets) {
    for (const b of prevState.bets) {
      prevBets[b.id] = b;
      b._legMap = {};
      for (const l of b.legs) b._legMap[l.id] = l;
    }
  }

  const stateMatches = {};
  for (const [id, m] of Object.entries(matchData)) {
    stateMatches[id] = {
      home: m.home_team?.name ?? m.home,
      away: m.away_team?.name ?? m.away,
      status: m.status,
      clock: m.clock_display ?? m.clock ?? null,
      home_score: m.home_score ?? null,
      away_score: m.away_score ?? null,
    };
  }

  const stateBets = [];
  for (const bet of resolvedBets.bets) {
    const prev = prevBets[bet.id] ?? null;
    const evaluatedLegs = bet.legs.map(leg =>
      evaluateLeg(leg, bet, matchData, playerStats, lineups, prev)
    );

    const summary = { total: evaluatedLegs.length, won: 0, lost: 0, void: 0, open: 0 };
    for (const l of evaluatedLegs) summary[l.status === 'open' ? 'open' : l.status]++;

    const betStatus = deriveBetStatus(evaluatedLegs, matchData, bet);

    const prevBetEntry = prev;
    const settledNow = isSettled(betStatus);
    const wasSettled = prevBetEntry ? isSettled(prevBetEntry.status) : false;
    const settledAt = settledNow
      ? (wasSettled && prevBetEntry.settled_at ? prevBetEntry.settled_at : now)
      : null;

    stateBets.push({
      id: bet.id,
      name: bet.name,
      status: betStatus,
      potential_return: bet.potential_return,
      currency: bet.stake.currency,
      odds_fractional: bet.odds_fractional,
      stake: bet.stake,
      settled_at: settledAt,
      summary,
      legs: evaluatedLegs,
    });
  }

  return {
    generated_at: now,
    matches: stateMatches,
    bets: stateBets,
  };
}

function evaluateLeg(leg, bet, matchData, playerStats, lineups, prevBet) {
  const prevLeg = prevBet?._legMap?.[leg.id] ?? null;

  // Latch: once won, stays won
  if (prevLeg?.status === 'won') {
    return { ...buildLegBase(leg), status: 'won', current: prevLeg.current, value: prevLeg.value, target: prevLeg.target };
  }

  if (leg.market === 'match_result') {
    return evalMatchResult(leg, bet, matchData, prevLeg);
  }

  // Player prop legs — need match context
  const matchId = String(bet.match?.match_id ?? leg.match_id);
  const match = matchData[matchId];
  if (!match) {
    return { ...buildLegBase(leg), status: 'open', current: 0, value: '—', target: legTarget(leg) };
  }

  const matchStatus = match.status;
  const stats = (playerStats[matchId] ?? []).find(s => s.player_id === leg.player_id);
  const lineupEntries = lineups[matchId] ?? [];

  // Void check: player not in squad or didn't play
  const inSquad = lineupEntries.some(e => e.player_id === leg.player_id);
  if (!inSquad && (matchStatus === 'in_progress' || matchStatus === 'completed')) {
    return { ...buildLegBase(leg), status: 'void', current: 0, value: 'DNP — not in squad', target: legTarget(leg) };
  }
  if (stats && (stats.minutes_played === 0) && matchStatus !== 'scheduled') {
    return { ...buildLegBase(leg), status: 'void', current: 0, value: 'DNP — 0 minutes', target: legTarget(leg) };
  }

  switch (leg.market) {
    case 'goal_or_assist': return evalGoalOrAssist(leg, stats, match, prevLeg);
    case 'shots_on_target': return evalThreshold(leg, stats, 'shots_on_target', match, prevLeg);
    case 'tackles_won':    return evalThreshold(leg, stats, 'tackles_won', match, prevLeg);
    case 'fouls_committed': return evalThreshold(leg, stats, 'fouls_committed', match, prevLeg);
    default:
      return { ...buildLegBase(leg), status: 'open', current: 0, value: '—', target: legTarget(leg) };
  }
}

function evalMatchResult(leg, bet, matchData, prevLeg) {
  const matchId = String(leg.match_id);
  const match = matchData[matchId];
  if (!match) {
    return { ...buildLegBase(leg), status: 'open', current: null, value: '—', target: null };
  }

  const { status, home_score, away_score } = match;
  const isHome = isTeamHome(leg, match);
  const teamScore = isHome ? home_score : away_score;
  const oppScore  = isHome ? away_score : home_score;

  const base = buildLegBase(leg);
  const scoreStr = (home_score != null && away_score != null) ? `${home_score}–${away_score}` : '—';

  if (status === 'completed') {
    if (teamScore != null && oppScore != null && teamScore > oppScore) {
      return { ...base, status: 'won', value: `Won ${scoreStr}`, current: teamScore, target: null };
    }
    return { ...base, status: 'lost', value: `Lost ${scoreStr}`, current: teamScore, target: null };
  }

  const displayValue = status === 'scheduled' ? 'Scheduled'
    : scoreStr !== '—' ? scoreStr
    : 'Pending';
  return { ...base, status: 'open', value: displayValue, current: teamScore, target: null };
}

function isTeamHome(leg, match) {
  // Prefer team_id comparison (handles Türkiye vs Turkey name mismatch)
  if (leg.team_id && match.home_team?.id) {
    return match.home_team.id === leg.team_id;
  }
  const homeTeam = (match.home_team?.name ?? match.home ?? '').toLowerCase();
  const selTeam = (leg.selection_team ?? '').toLowerCase();
  return homeTeam.includes(selTeam) || selTeam.includes(homeTeam.split(' ')[0]);
}

function evalGoalOrAssist(leg, stats, match, prevLeg) {
  const base = buildLegBase(leg);
  const goals   = stats?.goals   ?? 0;
  const assists = stats?.assists ?? 0;
  const current = goals + assists;
  const won = current >= 1;

  if (won) return { ...base, status: 'won', current, value: formatGA(goals, assists), target: 1 };
  if (match.status === 'completed') {
    return { ...base, status: 'lost', current, value: formatGA(goals, assists), target: 1 };
  }
  return { ...base, status: 'open', current, value: current === 0 ? '0 yet' : formatGA(goals, assists), target: 1 };
}

function evalThreshold(leg, stats, field, match, prevLeg) {
  const base = buildLegBase(leg);
  const threshold = leg.threshold ?? 2;
  const current = stats?.[field] ?? 0;
  const won = current >= threshold;

  const valueStr = `${current} of ${threshold}`;
  if (won) return { ...base, status: 'won', current, value: valueStr, target: threshold };
  if (match.status === 'completed') {
    return { ...base, status: 'lost', current, value: valueStr, target: threshold };
  }
  return { ...base, status: 'open', current, value: valueStr, target: threshold };
}

function deriveBetStatus(legs, matchData, bet) {
  if (legs.some(l => l.status === 'lost')) return 'lost';

  const activeLeg = legs.find(l => {
    if (l.status !== 'open') return false;
    // Check if any tracked match is in_progress for this leg
    const matchId = String(bet.match?.match_id ?? l.match_id ?? '');
    const m = matchData[matchId];
    return m?.status === 'in_progress';
  });
  const allDone = legs.every(l => l.status === 'won' || l.status === 'void');
  const anyWon  = legs.some(l => l.status === 'won');

  if (allDone && anyWon) {
    // For match_result legs, must be completed
    const blockingOpen = legs.some(l => {
      if (l.status !== 'open') return false;
      return true;
    });
    if (!blockingOpen) return 'won';
  }

  // Check if any match is live
  const matchIds = getMatchIds(bet, legs);
  const anyLive = matchIds.some(id => matchData[String(id)]?.status === 'in_progress');
  if (anyLive) return 'running';

  return 'open';
}

function getMatchIds(bet, legs) {
  const ids = new Set();
  if (bet.match?.match_id) ids.add(bet.match.match_id);
  for (const l of legs) if (l.match_id) ids.add(l.match_id);
  // for player prop bets, match_id is on the bet level
  return [...ids];
}

function isSettled(status) {
  return ['won','lost','void','cashed_out'].includes(status);
}

function buildLegBase(leg) {
  return { id: leg.id, label: leg.label ?? leg.player ?? leg.selection_team ?? leg.id };
}

function legTarget(leg) {
  return leg.threshold ?? (leg.market === 'goal_or_assist' ? 1 : null);
}

function formatGA(goals, assists) {
  const parts = [];
  if (goals)   parts.push(`${goals} goal${goals > 1 ? 's' : ''}`);
  if (assists) parts.push(`${assists} assist${assists > 1 ? 's' : ''}`);
  return parts.join(', ') || '0 yet';
}

module.exports = { evaluate };
