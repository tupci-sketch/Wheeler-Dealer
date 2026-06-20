'use strict';

const https = require('https');

const NTFY_BASE = 'https://ntfy.sh';

/**
 * Send a notification to the ntfy topic.
 * topic: string (from NTFY_TOPIC env var)
 * title: string
 * message: string
 * priority: 'default' | 'high' | 'urgent' (default: 'default')
 */
async function notify(topic, title, message, priority = 'default') {
  if (!topic) return;

  const body = message;
  return new Promise((resolve, reject) => {
    const url = `${NTFY_BASE}/${encodeURIComponent(topic)}`;
    const payload = Buffer.from(body, 'utf8');
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Title': title,
        'Priority': priority,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': payload.length,
        'Markdown': 'yes',
      },
    }, res => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', err => {
      console.warn(`ntfy failed: ${err.message}`);
      resolve(); // non-fatal
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Diff previous state vs new state and send notifications for transitions.
 * Returns updated lastSentState to persist.
 */
async function notifyTransitions(topic, prevState, newState) {
  if (!topic) return;

  const prevMatches = prevState?.matches ?? {};
  const newMatches  = newState?.matches  ?? {};

  // Kickoff notifications
  for (const [matchId, match] of Object.entries(newMatches)) {
    const prev = prevMatches[matchId];
    if (prev?.status !== 'in_progress' && match.status === 'in_progress') {
      await notify(topic,
        `⚽ Kickoff — ${match.home} vs ${match.away}`,
        `Match underway! Tracking bets on this fixture.`,
        'high'
      );
    }
    // Goal notification
    if (prev?.status === 'in_progress' && match.status === 'in_progress') {
      const prevHome = prev.home_score ?? 0;
      const prevAway = prev.away_score ?? 0;
      const newHome  = match.home_score ?? 0;
      const newAway  = match.away_score ?? 0;
      if (newHome > prevHome || newAway > prevAway) {
        await notify(topic,
          `⚽ GOAL — ${match.home} ${newHome}–${newAway} ${match.away}`,
          `Score update at ${match.clock ?? '?'}'`,
          'high'
        );
      }
    }
    // Match completed
    if (prev?.status === 'in_progress' && match.status === 'completed') {
      await notify(topic,
        `🏁 Full time — ${match.home} ${match.home_score}–${match.away_score} ${match.away}`,
        `Match completed.`,
        'default'
      );
    }
  }

  // Bet/leg transition notifications
  const prevBetsMap = {};
  for (const b of (prevState?.bets ?? [])) prevBetsMap[b.id] = b;

  for (const bet of (newState?.bets ?? [])) {
    const prev = prevBetsMap[bet.id];

    // Bet-level transitions
    if (prev?.status !== 'won' && bet.status === 'won') {
      await notify(topic,
        `🎉 BET WON — ${bet.name}!`,
        `All legs settled! Potential return: £${bet.potential_return}`,
        'urgent'
      );
    } else if (prev?.status !== 'lost' && bet.status === 'lost') {
      await notify(topic,
        `❌ Bet lost — ${bet.name}`,
        `A leg has failed. Better luck next time.`,
        'high'
      );
    }

    if (!prev) continue;

    const prevLegMap = {};
    for (const l of (prev.legs ?? [])) prevLegMap[l.id] = l;

    for (const leg of (bet.legs ?? [])) {
      const prevLeg = prevLegMap[leg.id];
      if (!prevLeg) continue;

      if (prevLeg.status !== 'won' && leg.status === 'won') {
        await notify(topic,
          `✅ Leg won — ${bet.name}`,
          `${leg.label}: ${leg.value}\n${bet.summary.won}/${bet.summary.total} legs won`,
          'high'
        );
      } else if (prevLeg.status !== 'lost' && leg.status === 'lost') {
        await notify(topic,
          `❌ Leg lost — ${bet.name}`,
          `${leg.label}: ${leg.value}`,
          'high'
        );
      } else if (prevLeg.status !== 'void' && leg.status === 'void') {
        await notify(topic,
          `⚠️ Leg voided — ${bet.name}`,
          `${leg.label}: ${leg.value}\nBetway will re-price the accumulator.`,
          'high'
        );
      }
    }
  }
}

module.exports = { notify, notifyTransitions };
