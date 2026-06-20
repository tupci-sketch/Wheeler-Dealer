// ============================================================
// Wheeler Dealer — Bet Tracker Widget for Scriptable
// ============================================================
// Setup:
//   1. Install the free "Scriptable" app from the App Store.
//   2. Paste this entire file as a new script.
//   3. Add as a lock-screen (accessoryRectangular) or home-screen widget.
//   4. No API key needed — reads public state.json only.
// ============================================================

const STATE_URL = "https://raw.githubusercontent.com/tupci-sketch/wheeler-dealer/state/state.json";

// ---- Fetch state ----
async function fetchState() {
  const req = new Request(STATE_URL);
  req.timeoutInterval = 10;
  try {
    const data = await req.loadJSON();
    return data;
  } catch (e) {
    return null;
  }
}

// ---- Helpers ----
function isSettled(status) {
  return ["won", "lost", "void", "cashed_out"].includes(status);
}

function statusEmoji(status) {
  return { won: "🏆", lost: "❌", running: "🔴", open: "⏳", void: "○", cashed_out: "💰" }[status] ?? "?";
}

function statusColor(status) {
  return {
    won: new Color("#00e676"),
    lost: new Color("#ff5252"),
    running: new Color("#448aff"),
    open: new Color("#8890b0"),
    void: new Color("#555"),
    cashed_out: new Color("#ffab40"),
  }[status] ?? Color.white();
}

function shortMatch(match) {
  if (!match) return "";
  const hs = match.home_score;
  const as = match.away_score;
  if (hs != null && as != null) return `${hs}–${as}`;
  return "vs";
}

// ---- Lock-screen widget (accessoryRectangular) ----
function buildLockScreen(widget, bets, matches) {
  widget.setPadding(4, 6, 4, 6);
  const activeBets = bets.filter(b => !isSettled(b.status));

  if (activeBets.length === 0) {
    const settled = bets.filter(b => isSettled(b.status));
    const lastWon = settled.find(b => b.status === "won");
    const t = widget.addText(lastWon ? `🏆 ${lastWon.name} WON!` : "All bets settled");
    t.font = Font.boldSystemFont(12);
    t.textColor = lastWon ? new Color("#00e676") : Color.gray();
    return;
  }

  // Show the most at-risk bet (fewest open legs won, most legs still to go)
  const priority = activeBets.sort((a, b) => {
    const aRemain = (a.summary?.total ?? 0) - (a.summary?.won ?? 0);
    const bRemain = (b.summary?.total ?? 0) - (b.summary?.won ?? 0);
    return bRemain - aRemain;
  })[0];

  // Line 1: bet name + status
  const row1 = widget.addStack();
  row1.layoutHorizontally();
  row1.centerAlignContent();
  const nameText = row1.addText(`${statusEmoji(priority.status)} ${priority.name}`);
  nameText.font = Font.boldSystemFont(13);
  nameText.textColor = Color.white();
  row1.addSpacer();

  // Find match
  const matchId = priority.legs?.[0]?.match_id ?? priority.match?.match_id ?? null;
  const matchInfo = matchId ? matches[String(matchId)] : null;
  if (matchInfo) {
    const scoreText = row1.addText(shortMatch(matchInfo));
    scoreText.font = Font.boldSystemFont(13);
    scoreText.textColor = statusColor(priority.status);
  }

  widget.addSpacer(2);

  // Line 2: won/total + pending leg
  const { won, total, lost } = priority.summary ?? {};
  const row2 = widget.addStack();
  row2.layoutHorizontally();

  const progressText = row2.addText(`${won}/${total} ✓`);
  progressText.font = Font.systemFont(11);
  progressText.textColor = new Color("#00e676");

  if (lost) {
    row2.addSpacer(4);
    const lostText = row2.addText(`${lost} ✗`);
    lostText.font = Font.systemFont(11);
    lostText.textColor = new Color("#ff5252");
  }

  // Show the most interesting pending leg
  const openLegs = priority.legs?.filter(l => l.status === "open") ?? [];
  if (openLegs.length) {
    const topLeg = openLegs[0];
    row2.addSpacer();
    const legStr = `· ${(topLeg.label ?? "").split("—")[1]?.trim() ?? "Pending"}: ${topLeg.value ?? "?"}`;
    const legText = row2.addText(legStr.slice(0, 28));
    legText.font = Font.systemFont(11);
    legText.textColor = new Color("#8890b0");
  }

  // Line 3: if multiple bets, show count
  if (activeBets.length > 1) {
    widget.addSpacer(2);
    const moreText = widget.addText(`+ ${activeBets.length - 1} more active`);
    moreText.font = Font.systemFont(10);
    moreText.textColor = new Color("#555");
  }
}

// ---- Home-screen widget (medium) ----
function buildHomeScreen(widget, bets, matches) {
  widget.setPadding(12, 14, 12, 14);

  const title = widget.addText("⚽ Bet Tracker");
  title.font = Font.boldSystemFont(14);
  title.textColor = new Color("#00e676");

  widget.addSpacer(8);

  for (const bet of bets.slice(0, 3)) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();

    const icon = row.addText(statusEmoji(bet.status));
    icon.font = Font.boldSystemFont(13);

    row.addSpacer(6);

    const nameText = row.addText(bet.name);
    nameText.font = Font.semiboldSystemFont(12);
    nameText.textColor = Color.white();

    row.addSpacer();

    const { won, total } = bet.summary ?? {};
    const progressText = row.addText(`${won}/${total}`);
    progressText.font = Font.boldSystemFont(12);
    progressText.textColor = statusColor(bet.status);

    widget.addSpacer(4);
  }

  widget.addSpacer();

  const footer = widget.addText("Betway's settlement is final");
  footer.font = Font.systemFont(9);
  footer.textColor = new Color("#555");
}

// ---- Main ----
async function main() {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#0f1117");
  widget.url = "https://tupci-sketch.github.io/wheeler-dealer/";
  widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000); // 15 min

  const state = await fetchState();
  if (!state) {
    const err = widget.addText("⚠️ Could not load state");
    err.font = Font.systemFont(12);
    err.textColor = Color.red();
  } else {
    const bets = state.bets ?? [];
    const matches = state.matches ?? {};
    const family = config.widgetFamily ?? "medium";

    if (family === "accessoryRectangular" || family === "accessoryInline") {
      buildLockScreen(widget, bets, matches);
    } else {
      buildHomeScreen(widget, bets, matches);
    }
  }

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    // Preview in app
    const family = config.widgetFamily ?? "medium";
    if (family === "accessoryRectangular") {
      widget.presentAccessoryRectangular();
    } else {
      widget.presentMedium();
    }
  }

  Script.complete();
}

await main();
