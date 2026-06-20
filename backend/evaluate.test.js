'use strict';

const { evaluate } = require('./evaluate');
const resolved = require('../config/bets.resolved.json');

// ---- test harness ----
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch(e) { console.error(`  ❌ ${name}: ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'assertion failed'); }
function eq(a, b) { assert(a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ---- fixtures ----
const completedMatchData = {
  "28": { id:28, home_team:{id:1,name:"Mexico"}, away_team:{id:3,name:"South Korea"}, status:"completed", home_score:1, away_score:0 },
  "29": { id:29, home_team:{id:13,name:"USA"}, away_team:{id:15,name:"Australia"}, status:"completed", home_score:2, away_score:0 },
  "30": { id:30, home_team:{id:12,name:"Scotland"}, away_team:{id:10,name:"Morocco"}, status:"completed", home_score:0, away_score:1 },
  "31": { id:31, home_team:{id:9,name:"Brazil"}, away_team:{id:11,name:"Haiti"}, status:"completed", home_score:4, away_score:0 },
  "32": { id:32, home_team:{id:16,name:"Türkiye"}, away_team:{id:14,name:"Paraguay"}, status:"completed", home_score:2, away_score:1 },
};

const brazilPlayerStats = [
  { match_id:31, player_id:9227,  goals:2, assists:1, shots_on_target:3, tackles_won:0, fouls_committed:1, minutes_played:90 },
  { match_id:31, player_id:29607, goals:1, assists:1, shots_on_target:2, tackles_won:0, fouls_committed:0, minutes_played:90 },
  { match_id:31, player_id:30001, goals:0, assists:0, shots_on_target:0, tackles_won:1, fouls_committed:3, minutes_played:90 },
  { match_id:31, player_id:9245,  goals:0, assists:0, shots_on_target:0, tackles_won:3, fouls_committed:2, minutes_played:90 },
  { match_id:31, player_id:29625, goals:0, assists:0, shots_on_target:0, tackles_won:2, fouls_committed:0, minutes_played:90 },
  { match_id:31, player_id:9224,  goals:0, assists:0, shots_on_target:0, tackles_won:2, fouls_committed:0, minutes_played:90 },
  { match_id:31, player_id:304,   goals:0, assists:0, shots_on_target:0, tackles_won:2, fouls_committed:1, minutes_played:90 },
];

const fullLineup = [
  {player_id:9227,  team_id:9,  is_starter:true},
  {player_id:29607, team_id:9,  is_starter:true},
  {player_id:30001, team_id:11, is_starter:true},
  {player_id:9245,  team_id:9,  is_starter:true},
  {player_id:29625, team_id:9,  is_starter:true},
  {player_id:9224,  team_id:9,  is_starter:true},
  {player_id:304,   team_id:9,  is_starter:true},
];

const noStats  = { "31": [], "28": [], "29": [], "30": [], "32": [] };
const goodStats = { "31": brazilPlayerStats, "28": [], "29": [], "30": [], "32": [] };
const lineups  = { "31": fullLineup };

// ---- tests ----

console.log('\n--- Match result legs ---');

test('Mexico win → f1 won', () => {
  const state = evaluate(resolved, completedMatchData, noStats, lineups);
  const bet = state.bets.find(b => b.id === 'fourfold-match-result');
  const leg = bet.legs.find(l => l.id === 'f1');
  eq(leg.status, 'won');
});

test('USA win → f2 won', () => {
  const state = evaluate(resolved, completedMatchData, noStats, lineups);
  const bet = state.bets.find(b => b.id === 'fourfold-match-result');
  eq(bet.legs.find(l => l.id === 'f2').status, 'won');
});

test('Morocco (away) win → f3 won', () => {
  const state = evaluate(resolved, completedMatchData, noStats, lineups);
  const bet = state.bets.find(b => b.id === 'fourfold-match-result');
  eq(bet.legs.find(l => l.id === 'f3').status, 'won');
});

test('Turkey (Türkiye home) win → f4 won', () => {
  const state = evaluate(resolved, completedMatchData, noStats, lineups);
  const bet = state.bets.find(b => b.id === 'fourfold-match-result');
  eq(bet.legs.find(l => l.id === 'f4').status, 'won');
});

test('fourfold all won → bet won', () => {
  const state = evaluate(resolved, completedMatchData, noStats, lineups);
  const bet = state.bets.find(b => b.id === 'fourfold-match-result');
  eq(bet.status, 'won');
});

test('Turkey lose → f4 lost', () => {
  const loseData = { ...completedMatchData, "32": { id:32, home_team:{id:16,name:"Türkiye"}, away_team:{id:14,name:"Paraguay"}, status:"completed", home_score:0, away_score:2 } };
  const state = evaluate(resolved, loseData, noStats, lineups);
  const bet = state.bets.find(b => b.id === 'fourfold-match-result');
  eq(bet.legs.find(l => l.id === 'f4').status, 'lost');
  eq(bet.status, 'lost');
});

console.log('\n--- Player prop legs ---');

test('Cunha goal → s2 won (goal_or_assist)', () => {
  const state = evaluate(resolved, completedMatchData, goodStats, lineups);
  const bet = state.bets.find(b => b.id === 'sevenfold-brazil-haiti');
  eq(bet.legs.find(l => l.id === 's2').status, 'won');
});

test('Vini 2 SoT → s3 won', () => {
  const state = evaluate(resolved, completedMatchData, goodStats, lineups);
  const bet = state.bets.find(b => b.id === 'sevenfold-brazil-haiti');
  eq(bet.legs.find(l => l.id === 's3').status, 'won');
});

test('Bellegarde 3 fouls → s5 won', () => {
  const state = evaluate(resolved, completedMatchData, goodStats, lineups);
  const bet = state.bets.find(b => b.id === 'sevenfold-brazil-haiti');
  eq(bet.legs.find(l => l.id === 's5').status, 'won');
});

test('Bruno 3 tackles_won → s6 won', () => {
  const state = evaluate(resolved, completedMatchData, goodStats, lineups);
  const bet = state.bets.find(b => b.id === 'sevenfold-brazil-haiti');
  eq(bet.legs.find(l => l.id === 's6').status, 'won');
});

test('Douglas Santos 2 tackles_won → s7 won', () => {
  const state = evaluate(resolved, completedMatchData, goodStats, lineups);
  const bet = state.bets.find(b => b.id === 'sevenfold-brazil-haiti');
  eq(bet.legs.find(l => l.id === 's7').status, 'won');
});

test('sevenfold all met → bet won', () => {
  const state = evaluate(resolved, completedMatchData, goodStats, lineups);
  const bet = state.bets.find(b => b.id === 'sevenfold-brazil-haiti');
  eq(bet.status, 'won');
});

test('tenfold all met → bet won', () => {
  const state = evaluate(resolved, completedMatchData, goodStats, lineups);
  const bet = state.bets.find(b => b.id === 'tenfold-brazil-haiti');
  eq(bet.status, 'won');
});

console.log('\n--- Void / lost ---');

test('player DNP (not in lineup) → void after match in_progress', () => {
  const inProgressData = { ...completedMatchData, "31": { ...completedMatchData["31"], status:"in_progress" } };
  const emptyLineup = { "31": [] }; // no one in lineup
  const state = evaluate(resolved, inProgressData, goodStats, emptyLineup);
  const bet = state.bets.find(b => b.id === 'sevenfold-brazil-haiti');
  // All player legs should be void since no one is in lineup
  const viniGoal = bet.legs.find(l => l.id === 's1');
  eq(viniGoal.status, 'void');
});

test('goal threshold not met → lost after completed', () => {
  const zeroStats = { "31": [
    { match_id:31, player_id:9227, goals:0, assists:0, shots_on_target:1, tackles_won:0, fouls_committed:0, minutes_played:90 },
    { match_id:31, player_id:29607, goals:0, assists:0, shots_on_target:0, tackles_won:0, fouls_committed:0, minutes_played:90 },
    { match_id:31, player_id:30001, goals:0, assists:0, shots_on_target:0, tackles_won:0, fouls_committed:1, minutes_played:90 },
    { match_id:31, player_id:9245, goals:0, assists:0, shots_on_target:0, tackles_won:1, fouls_committed:0, minutes_played:90 },
    { match_id:31, player_id:29625, goals:0, assists:0, shots_on_target:0, tackles_won:1, fouls_committed:0, minutes_played:90 },
    { match_id:31, player_id:9224, goals:0, assists:0, shots_on_target:0, tackles_won:1, fouls_committed:0, minutes_played:90 },
    { match_id:31, player_id:304, goals:0, assists:0, shots_on_target:0, tackles_won:1, fouls_committed:0, minutes_played:90 },
  ], "28":[], "29":[], "30":[], "32":[] };
  const state = evaluate(resolved, completedMatchData, zeroStats, lineups);
  const bet = state.bets.find(b => b.id === 'sevenfold-brazil-haiti');
  // s1: Vini goal_or_assist → 0 goals+assists → lost
  eq(bet.legs.find(l => l.id === 's1').status, 'lost');
  eq(bet.status, 'lost');
});

console.log('\n--- Latching ---');

test('won leg stays won on next evaluation (latch)', () => {
  // Build a prev state where s1 was won
  const prevState = {
    bets: [{
      id: 'sevenfold-brazil-haiti',
      status: 'running',
      settled_at: null,
      _legMap: { s1: { id:'s1', status:'won', current:1, value:'1 goal', target:1 } },
      legs: [{ id:'s1', status:'won', current:1, value:'1 goal', target:1 }],
    }]
  };
  // Current stats say Vini has 0 goals (data lag scenario)
  const lagStats = { "31": [
    { match_id:31, player_id:9227, goals:0, assists:0, shots_on_target:0, tackles_won:0, fouls_committed:0, minutes_played:70 },
    { match_id:31, player_id:29607, goals:0, assists:0, shots_on_target:0, tackles_won:0, fouls_committed:0, minutes_played:70 },
    { match_id:31, player_id:30001, goals:0, assists:0, shots_on_target:0, tackles_won:0, fouls_committed:0, minutes_played:70 },
    { match_id:31, player_id:9245, goals:0, assists:0, shots_on_target:0, tackles_won:0, fouls_committed:0, minutes_played:70 },
    { match_id:31, player_id:29625, goals:0, assists:0, shots_on_target:0, tackles_won:0, fouls_committed:0, minutes_played:70 },
    { match_id:31, player_id:9224, goals:0, assists:0, shots_on_target:0, tackles_won:0, fouls_committed:0, minutes_played:70 },
    { match_id:31, player_id:304, goals:0, assists:0, shots_on_target:0, tackles_won:0, fouls_committed:0, minutes_played:70 },
  ], "28":[], "29":[], "30":[], "32":[] };
  const inProgressMatch = { ...completedMatchData, "31": { ...completedMatchData["31"], status:"in_progress" } };
  const state = evaluate(resolved, inProgressMatch, lagStats, lineups, prevState);
  const bet = state.bets.find(b => b.id === 'sevenfold-brazil-haiti');
  // s1 must still be won (latched)
  eq(bet.legs.find(l => l.id === 's1').status, 'won');
});

// ---- summary ----
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
