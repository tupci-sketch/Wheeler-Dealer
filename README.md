# ⚽ Wheeler Dealer — WC 2026 Bet Tracker

Live accumulator tracker for the 2026 FIFA World Cup. Reads from the [BallDontLie](https://balldontlie.io) public API and publishes a `state.json` that the web app and Scriptable widget both read.

> ⚠️ **Unofficial indicator.** Data comes from BALLDONTLIE, not Betway's settlement source. **Betway's settlement is final.** Tackles won and other borderline stats may differ between providers. Cash-out values can't be replicated.

## Live App

👉 **https://tupci-sketch.github.io/wheeler-dealer/**

Auto-refreshes every 30 seconds. Installable as a PWA (Add to Home Screen on iOS Safari).

---

## How it works

```
BallDontLie API
    │
    ▼
GitHub Actions (live-poller.yml) — loops every 45s during match window
    │  evaluates legs → latch wins → compute bet status
    ▼
state branch → state.json (raw.githubusercontent.com)
    │
    ├─▶ Web app (GitHub Pages) — polls every 30s
    └─▶ Scriptable widget — refreshes every ~15min
```

The API key **never** reaches the browser or widget. Only `state.json` (a public JSON file) is read client-side.

---

## Secrets to add (GitHub → Settings → Secrets and variables → Actions)

| Secret | Value |
|--------|-------|
| `BDL_API_KEY` | Your BallDontLie GOAT API key |
| `NTFY_TOPIC` | An unguessable string, e.g. `worldcup-bets-f7k2m9` |

---

## Notifications — ntfy.sh

1. Install the free **[ntfy](https://ntfy.sh)** iOS/Android app.
2. Subscribe to your `NTFY_TOPIC` string.
3. You'll receive push notifications on: kickoff, goals, leg won/lost/void, bet won/lost.

No accounts needed. Anyone who knows your topic can read it — keep it unguessable.

---

## Running the poller (matchday)

1. Go to **GitHub → Actions → Live Poller → Run workflow**.
2. Dispatch it at kickoff. It runs for 3 hours, polling every 45 seconds.
3. Re-dispatch for each matchday.

For the **Brazil vs Haiti** and **Türkiye vs Paraguay** matches (20 June 2026), dispatch the workflow before kickoff.

---

## Resolving IDs after squad changes

If lineups change before a match:

```
GitHub → Actions → Resolve IDs → Run workflow
```

This re-runs `backend/resolve_ids.js` and commits an updated `config/bets.resolved.json`.

---

## Scriptable widget (iOS lock screen)

1. Install **[Scriptable](https://apps.apple.com/app/scriptable/id1405459188)** (free).
2. Create a new script, paste the contents of `widget/scriptable-widget.js`.
3. Long-press your home screen → + → scroll to Scriptable → choose size:
   - **Lock screen:** `accessoryRectangular`
   - **Home screen:** `medium`
4. Tap the widget → select your script.

The widget reads the same `state.json` from the `state` branch. iOS throttles widget refresh to ~15 minutes, so timely alerts come from ntfy, not the widget.

---

## Adding new bets

1. Append a bet object to `config/bets.json` (follow the existing shape).
2. Run **Resolve IDs** workflow.
3. Dispatch the **Live Poller** before kickoff.

No code changes needed for markets already in the mapping (match result, goal/assist, SoT, tackles won, fouls committed).

---

## Repo structure

```
index.html  app.js  styles.css  manifest.json  sw.js   ← GitHub Pages frontend
icons/                          ← PWA icons
config/
  bets.json                     ← bet definitions (edit to add bets)
  bets.resolved.json            ← generated (team/player/match IDs)
backend/
  evaluate.js                   ← pure evaluation engine
  evaluate.test.js              ← unit tests (node backend/evaluate.test.js)
  poller.js                     ← fetch → evaluate → write state → notify
  resolve_ids.js                ← name → ID resolution
  ntfy.js                       ← ntfy.sh notification sender
  fixtures/                     ← saved API responses for offline testing
.github/workflows/
  resolve-ids.yml               ← manual: resolve team/player/match IDs
  live-poller.yml               ← manual: run polling loop during match
widget/
  scriptable-widget.js          ← iOS Scriptable widget (lock + home screen)
```

---

## Accuracy & limitations

- **Tackles won** definitions vary between data providers — occasional disagreement with Betway is expected.
- **Player stat latency:** `/player_match_stats` updates live mid-match (verified). If a stat field is `null`, it may not yet be tracked for that player.
- **Void detection:** a player-prop leg is voided if the player isn't in the lineup squad or has 0 minutes played. Betway re-prices the accumulator; we can't compute the new odds — read them from Betway.
- **Cash-out values** are bookmaker-internal; use the "Cash out" button to mark a bet manually.
- Data source: [BALLDONTLIE FIFA World Cup API](https://fifa.balldontlie.io/) (GOAT tier, 600 req/min).
