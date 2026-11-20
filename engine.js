// Doppelkopf engine — rules, state, legal moves, scoring. Runs in browser and node.
// Card id 0..47: two copies of 24 card types; type = id >> 1, suit = type / 6 | 0, rank = type % 6.
(function (root) {
'use strict';

const SUITS = ['C', 'S', 'H', 'D'];             // Kreuz, Pik, Herz, Karo
const SUIT_SYM = ['♣', '♠', '♥', '♦'];
const SUIT_DE = ['Kreuz', 'Pik', 'Herz', 'Karo'];
const RANKS = ['A', '10', 'K', 'Q', 'J', '9'];   // Ass, Zehn, König, Dame, Bube, Neun
const RANK_DE = ['A', '10', 'K', 'D', 'B', '9'];
const PTS = [11, 10, 4, 3, 2, 0];
const C = 0, S = 1, H = 2, D = 3;
const A = 0, TEN = 1, K = 2, Q = 3, J = 4, NINE = 5;
const T = (s, r) => s * 6 + r;
const typeOf = id => id >> 1, suitOf = id => (id >> 1) / 6 | 0, rankOf = id => (id >> 1) % 6;
const pointsOf = id => PTS[(id >> 1) % 6];
const CQ = T(C, Q), CJ = T(C, J), DA = T(D, A), H10 = T(H, TEN);

const ALL_SOLI = ['soloD', 'soloH', 'soloS', 'soloC', 'soloQ', 'soloJ', 'soloK', 'soloKQJ', 'soloF'];
const DDV_SOLI = ['soloD', 'soloH', 'soloS', 'soloC', 'soloQ', 'soloJ', 'soloF'];
// Rules. DEFAULT_RULES = DDV tournament rules (with nines); HOUSE_RULES = our house rules (docs/house-rules.md).
const DEFAULT_RULES = {
  withNines: true,          // 48 cards (12 each) vs 40 cards (10 each)
  dulle: 'first',           // two Herz-10 in one trick: 'first' wins (DDV) | 'second' | 'secondExceptLast'
  soli: DDV_SOLI,           // allowed solo types (true = DDV list, false = none)
  soloPriority: 'seat',     // several soli declared: 'seat' = first in seat order wins | 'rank' = higher solo wins
  soloLeads: 'always',      // 'always' = soloist leads | 'duty' = only in a Pflichtsolo, else the normal Vorhand
  dutySolo: false,          // Pflichtsolo: everyone owes one solo per list (tracked by the match, passed in as opts.duty)
  listGames: 24,
  wedding: true,
  weddingFind: ['any'],     // which foreign trick finds the partner: 'any' | 'fehl' (non-trump led) | 'trumpf'
  weddingTricks: 3,         // ...within the first N tricks, otherwise the bride plays alone
  poverty: false,           // Armut / Trumpfabgabe
  povertyMax: 3,            // ...with at most this many trumps
  schweinchen: false,       // both foxes in one hand = highest trumps
  schweinchenColourSolo: false,   // ...also the two trump aces in a Farbsolo (Herz/Pik/Kreuz)
  specialPoints: true,      // Sonderpunkte in normal games (never in solos)
  specials: { doppelkopf: true, fuchs: true, karlchen: true, karlchenGefangen: false, fuchsLetzter: false },
};
const HOUSE_RULES = Object.assign({}, DEFAULT_RULES, {
  withNines: false, dulle: 'second', soli: ALL_SOLI, soloPriority: 'rank', soloLeads: 'duty', dutySolo: true,
  weddingFind: ['any', 'fehl', 'trumpf'], poverty: true, schweinchen: true,
  specials: { doppelkopf: true, fuchs: true, karlchen: true, karlchenGefangen: true, fuchsLetzter: true },
});
function makeRules(r) {
  const out = Object.assign({}, DEFAULT_RULES, r || {});
  out.specials = Object.assign({}, DEFAULT_RULES.specials, (r && r.specials) || {});
  if (out.soli === true) out.soli = DDV_SOLI; else if (!out.soli) out.soli = [];
  return out;
}

// Reservations ("Vorbehalte")
const RESV = ['healthy', 'wedding', 'weddingFehl', 'weddingTrumpf', 'poverty', ...ALL_SOLI];
const RESV_DE = { healthy: 'Gesund', wedding: 'Hochzeit', weddingFehl: 'Hochzeit (erster Fehlstich)',
  weddingTrumpf: 'Hochzeit (erster Trumpfstich)', poverty: 'Armut',
  soloD: 'Karo-Solo', soloH: 'Herz-Solo', soloS: 'Pik-Solo', soloC: 'Kreuz-Solo', soloQ: 'Damen-Solo',
  soloJ: 'Buben-Solo', soloK: 'Königs-Solo', soloKQJ: 'Köhler', soloF: 'Fleischloser', normal: 'Normalspiel',
  silent: 'Stille Hochzeit' };
const WEDDING_FIND = { wedding: 'any', weddingFehl: 'fehl', weddingTrumpf: 'trumpf' };
const isSoloResv = r => !!r && r.startsWith('solo');
const isWeddingResv = r => r in WEDDING_FIND;
// solo ranking for soloPriority 'rank' (lower = higher). Farbsoli are equal → seat order decides.
const SOLO_RANK = { soloD: 0, soloKQJ: 1, soloQ: 2, soloJ: 3, soloK: 4, soloC: 5, soloS: 5, soloH: 5, soloF: 6 };
// Action encoding (small ints, cheap for search):
//   0..47 card (play it, or give/return it in an Armut) | 100+k announce level k | 200+i reservation i
//   300 decline / 301 accept an Armut
const ANN = ['', 're', 'no90', 'no60', 'no30', 'black'];
const ANN_DE = { re: 'Re', ko: 'Kontra', no90: 'Keine 90', no60: 'Keine 60', no30: 'Keine 30', black: 'Schwarz' };
const ACT_ANN = 100, ACT_RES = 200, ACT_POV = 300;

// ---- trump tables per game type --------------------------------------------------------------
// For every game type: power[type] (trumps 100+, plain cards by suit order) and cls[type] (4 = trump, else suit)
const TABLES = {};
function buildTable(gt) {
  let trumps = [];
  const queens = [T(C, Q), T(S, Q), T(H, Q), T(D, Q)], jacks = [T(C, J), T(S, J), T(H, J), T(D, J)];
  const kings = [T(C, K), T(S, K), T(H, K), T(D, K)];
  const colour = { normal: D, wedding: D, silent: D, poverty: D, soloD: D, soloH: H, soloS: S, soloC: C }[gt];
  if (colour !== undefined) {
    trumps = [H10, ...queens, ...jacks];
    for (const r of [A, TEN, K, NINE]) if (!(colour === H && r === TEN)) trumps.push(T(colour, r));
  } else if (gt === 'soloQ') trumps = queens;
  else if (gt === 'soloJ') trumps = jacks;
  else if (gt === 'soloK') trumps = kings;
  else if (gt === 'soloKQJ') trumps = [...kings, ...queens, ...jacks];
  const power = new Int16Array(24), cls = new Int8Array(24);
  for (let t = 0; t < 24; t++) {
    const i = trumps.indexOf(t);
    if (i >= 0) { power[t] = 200 - i; cls[t] = 4; }
    else { power[t] = 50 - (t % 6); cls[t] = (t / 6) | 0; }   // A > 10 > K > Q > J > 9 within a suit
  }
  return { power, cls, trumps };
}
for (const gt of ['normal', 'wedding', 'silent', 'poverty', ...ALL_SOLI])
  TABLES[gt] = buildTable(gt);
const isSolo = gt => gt.startsWith('solo') || gt === 'silent';
// The card that becomes a "Schweinchen" in this game type (both copies in one hand), or -1.
function pigType(rules, gt) {
  if (!rules.schweinchen) return -1;
  if (gt === 'normal' || gt === 'wedding' || gt === 'silent' || gt === 'poverty') return DA;   // only when no solo is played
  if (rules.schweinchenColourSolo && (gt === 'soloD' || gt === 'soloH' || gt === 'soloS' || gt === 'soloC')) return T({ soloD: D, soloH: H, soloS: S, soloC: C }[gt], A);
  return -1;
}
const nTrumpsNormal = h => { let n = 0; for (const id of h) if (TABLES.normal.cls[id >> 1] === 4) n++; return n; };

// ---- RNG ------------------------------------------------------------------------------------------
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) { const j = (rand() * (i + 1)) | 0; const x = arr[i]; arr[i] = arr[j]; arr[j] = x; }
  return arr;
}

// ---- state ----------------------------------------------------------------------------------------
function deck(rules) {
  const d = [];
  for (let id = 0; id < 48; id++) if (rules.withNines || rankOf(id) !== NINE) d.push(id);
  return d;
}

function newGame(opts) {
  const rules = makeRules(opts.rules);
  const rand = opts.rand || rng(opts.seed ?? (Math.random() * 2 ** 32));
  const dealer = opts.dealer ?? 0;
  let hands = opts.hands;
  if (!hands) {
    const d = shuffle(deck(rules), rand), n = d.length / 4;
    hands = [0, 1, 2, 3].map(p => d.slice(p * n, p * n + n));
  }
  const s = {
    rules, dealer, handSize: hands[0].length,
    hands: hands.map(h => h.slice()),
    phase: 'reserve',
    turn: (dealer + 1) % 4,
    resv: [null, null, null, null],
    gameType: 'normal', soloist: -1, bride: -1, partner: -1, clarify: -1,
    team: [0, 0, 0, 0],               // 1 = Re, 0 = Kontra (true teams; hidden info!)
    trick: [], leader: -1,            // current trick: card ids in play order, leader seat
    tricks: [],                       // completed: {leader, cards, winner, points}
    won: [0, 0, 0, 0],                // card points won per seat
    ann: [0, 0],                      // announcement level per party [kontra, re]: 0 none, 1 Re/Kontra, 2 keine 90, ... 5 schwarz
    annBy: [],                        // {seat, party, level, trick}
    playedCQ: [0, 0, 0, 0],
    duty: (opts.duty || [false, false, false, false]).slice(),   // who still owes a Pflichtsolo (public)
    forced: opts.forced ?? -1,        // seat that must play its solo now (Vorführung), or -1
    dutyGame: false,                  // this game is a Pflichtsolo
    weddingFind: 'any',
    poor: -1, acceptor: -1, povGiven: [], povBack: [], povTrumps: [-1, -1],   // Armut: cards given/returned, public trump counts
    schwein: -1, pigShown: false,     // seat holding both Schweinchen; revealed?
    log: [],                          // public action log {seat, a}
    result: null,
  };
  return s;
}

function clone(s) {   // fast copy; completed tricks / log entries are immutable and shared
  return {
    rules: s.rules, dealer: s.dealer, handSize: s.handSize,
    hands: [s.hands[0].slice(), s.hands[1].slice(), s.hands[2].slice(), s.hands[3].slice()],
    phase: s.phase, turn: s.turn, resv: s.resv.slice(),
    gameType: s.gameType, soloist: s.soloist, bride: s.bride, partner: s.partner, clarify: s.clarify,
    team: s.team.slice(), trick: s.trick.slice(), leader: s.leader, tricks: s.tricks.slice(), won: s.won.slice(),
    ann: s.ann.slice(), annBy: s.annBy.slice(), playedCQ: s.playedCQ.slice(), log: s.log.slice(), result: s.result,
    duty: s.duty.slice(), forced: s.forced, dutyGame: s.dutyGame, weddingFind: s.weddingFind,
    poor: s.poor, acceptor: s.acceptor, povGiven: s.povGiven.slice(), povBack: s.povBack.slice(), povTrumps: s.povTrumps.slice(),
    schwein: s.schwein, pigShown: s.pigShown,
  };
}

const countCQ = h => { let n = 0; for (const id of h) if ((id >> 1) === CQ) n++; return n; };

// Which party does `seat` know it belongs to? (null = doesn't know yet, e.g. wedding before clarification)
function ownParty(s, seat) {
  if (s.gameType === 'wedding' && s.clarify < 0 && s.soloist < 0) return null;
  return s.team[seat];
}

// Minimum hand size required to make an announcement of level k (DDV: Re/Kontra before playing the 2nd card,
// each Absage one card later; a reply Re/Kontra to the other party's announcement one card later; wedding shifts
// all deadlines by the clarification trick).
function annDeadline(s, seat, party, k) {
  const shift = s.gameType === 'wedding' ? s.clarify + 1 : 0;
  let need = s.handSize - k - shift;
  if (k === 1 && s.ann[1 - party] >= 1) need -= 1;   // reply ("Erwiderung")
  return need;
}

function legalActions(s) {
  const p = s.turn, out = [];
  if (s.phase === 'reserve') {
    const R = s.rules, h = s.hands[p];
    if (s.forced >= 0) {   // Vorführung: the forced player must pick a solo, everyone else is healthy
      if (p === s.forced) { for (const r of R.soli) out.push(ACT_RES + RESV.indexOf(r)); }
      else out.push(ACT_RES);
      return out;
    }
    out.push(ACT_RES + 0);
    if (R.wedding && countCQ(h) === 2) for (const f of R.weddingFind) out.push(ACT_RES + RESV.indexOf({ any: 'wedding', fehl: 'weddingFehl', trumpf: 'weddingTrumpf' }[f]));
    if (R.poverty && nTrumpsNormal(h) <= R.povertyMax) out.push(ACT_RES + RESV.indexOf('poverty'));
    for (const r of R.soli) out.push(ACT_RES + RESV.indexOf(r));
    return out;
  }
  if (s.phase === 'povGive') {   // give all trumps first, then any cards, until 3 are given
    const h = s.hands[p];
    for (const id of h) if (TABLES.normal.cls[id >> 1] === 4) out.push(id);
    if (!out.length) for (const id of h) out.push(id);
    dedupe(out); return out;
  }
  if (s.phase === 'povAsk') return [ACT_POV, ACT_POV + 1];
  if (s.phase === 'povReturn') { for (const id of s.hands[p]) out.push(id); dedupe(out); return out; }
  if (s.phase !== 'play') return out;
  const hand = s.hands[p], tb = TABLES[s.gameType];
  if (s.trick.length === 0) { for (const id of hand) out.push(id); }
  else {
    const lc = tb.cls[s.trick[0] >> 1];
    for (const id of hand) if (tb.cls[id >> 1] === lc) out.push(id);
    if (out.length === 0) for (const id of hand) out.push(id);
  }
  dedupe(out);
  const party = ownParty(s, p);
  if (party !== null) {
    const k = s.ann[party] + 1;
    if (k <= 5 && hand.length >= annDeadline(s, p, party, k)) out.push(ACT_ANN + k);
  }
  return out;
}
function dedupe(out) {   // the two copies of a card are equivalent → keep the first only
  let w = 0; const seen = new Uint8Array(24);
  for (let i = 0; i < out.length; i++) { const t = out[i] >> 1; if (!seen[t]) { seen[t] = 1; out[w++] = out[i]; } }
  out.length = w;
}

function step(s, a) {   // mutates s
  const p = s.turn;
  s.log.push({ seat: p, a });
  if (a >= ACT_POV) { povAsk(s, p, a === ACT_POV + 1); return s; }
  if (a >= ACT_RES) { reserve(s, p, RESV[a - ACT_RES]); return s; }
  if (s.phase === 'povGive' || s.phase === 'povReturn') { povCard(s, p, a); return s; }
  if (a >= ACT_ANN) {
    const party = s.team[p], k = a - ACT_ANN;
    s.ann[party] = k; s.annBy.push({ seat: p, party, level: k, trick: s.tricks.length });
    return s;
  }
  // play card
  const hand = s.hands[p], i = hand.indexOf(a);
  if (i < 0) throw new Error('card not in hand');
  hand.splice(i, 1);
  if ((a >> 1) === CQ) s.playedCQ[p]++;
  if (p === s.schwein && (a >> 1) === pigType(s.rules, s.gameType)) s.pigShown = true;   // "Schweinchen!" when played
  if (s.trick.length === 0) s.leader = p;
  s.trick.push(a);
  if (s.trick.length < 4) { s.turn = (p + 1) % 4; return s; }
  // trick complete
  const w = (s.leader + trickWinnerIdx(s, s.trick, s.tricks.length === s.handSize - 1)) % 4;
  let pts = 0; for (const id of s.trick) pts += PTS[(id >> 1) % 6];
  s.tricks.push({ leader: s.leader, cards: s.trick, winner: w, points: pts });
  s.won[w] += pts; s.trick = []; s.turn = w;
  if (s.gameType === 'wedding' && s.clarify < 0 && s.soloist < 0) {
    const ti = s.tricks.length - 1, trumpLed = TABLES.wedding.cls[s.tricks[ti].cards[0] >> 1] === 4;
    const counts = s.weddingFind === 'any' || (s.weddingFind === 'fehl' ? !trumpLed : trumpLed);
    if (w !== s.bride && counts) { s.partner = w; s.clarify = ti; s.team[w] = 1; }
    else if (ti + 1 >= s.rules.weddingTricks) { s.soloist = s.bride; s.clarify = ti; }   // no partner → solo
  }
  if (s.tricks.length === s.handSize) { s.phase = 'done'; s.result = score(s); }
  return s;
}

function trickWinnerIdx(s, cards, isLast) {
  const tb = TABLES[s.gameType], lc = tb.cls[cards[0] >> 1];
  const pig = s.schwein >= 0 ? pigType(s.rules, s.gameType) : -1;   // Schweinchen beat everything
  const pow = t => t === pig ? 5000 : tb.power[t] + (tb.cls[t] === 4 ? 1000 : 0);
  let best = 0, bp = pow(cards[0] >> 1);
  for (let i = 1; i < cards.length; i++) {
    const t = cards[i] >> 1, c = tb.cls[t];
    if (c !== 4 && c !== lc) continue;
    const pw = pow(t);
    const secondDulle = t === H10 && c === 4 && (cards[best] >> 1) === H10 &&
      (s.rules.dulle === 'second' || (s.rules.dulle === 'secondExceptLast' && !isLast));
    if (pw > bp || secondDulle) { best = i; bp = pw; }
  }
  return best;
}

function reserve(s, p, r) {
  s.resv[p] = r;
  const first = (s.dealer + 1) % 4, next = (p + 1) % 4;
  if (next !== first) { s.turn = next; return; }
  // everyone has declared → resolve: solo > Armut > Hochzeit > normal
  const R = s.rules, order = [0, 1, 2, 3].map(i => (first + i) % 4);
  const solos = order.filter(q => isSoloResv(s.resv[q]));
  const povSeat = order.find(q => s.resv[q] === 'poverty');
  const wedSeat = order.find(q => isWeddingResv(s.resv[q]));
  s.team = [0, 0, 0, 0];
  if (solos.length) {
    // Pflichtsolo before Lustsolo (DDV); then by solo rank (house rule) or seat order
    const key = q => (s.duty[q] || q === s.forced ? 0 : 100) + (R.soloPriority === 'rank' ? SOLO_RANK[s.resv[q]] * 10 : 0) + order.indexOf(q);
    const q = solos.reduce((a, b) => (key(b) < key(a) ? b : a));
    s.gameType = s.resv[q]; s.soloist = q; s.team[q] = 1;
    s.dutyGame = R.dutySolo && (s.duty[q] || q === s.forced);
    s.turn = R.soloLeads === 'always' || s.dutyGame ? q : first;
    startPlay(s);
  } else if (povSeat !== undefined) {
    s.gameType = 'poverty'; s.poor = povSeat; s.phase = 'povGive'; s.turn = povSeat;
  } else if (wedSeat !== undefined) {
    s.gameType = 'wedding'; s.bride = wedSeat; s.team[wedSeat] = 1; s.weddingFind = WEDDING_FIND[s.resv[wedSeat]];
    s.turn = first; startPlay(s);
  } else {
    s.team = s.hands.map(h => countCQ(h) > 0 ? 1 : 0);
    const both = s.hands.findIndex(h => countCQ(h) === 2);
    if (both >= 0) { s.gameType = 'silent'; s.soloist = both; }
    s.turn = first; startPlay(s);
  }
}
function startPlay(s) {
  s.phase = 'play';
  const pig = pigType(s.rules, s.gameType);
  s.schwein = pig < 0 ? -1 : s.hands.findIndex(h => h.filter(id => (id >> 1) === pig).length === 2);
}
// Armut: the poor player gives 3 cards (all trumps first), the others are asked in turn, the taker returns 3.
function povCard(s, p, id) {
  const h = s.hands[p], i = h.indexOf(id);
  if (i < 0) throw new Error('card not in hand');
  h.splice(i, 1);
  if (s.phase === 'povGive') {
    s.povGiven.push(id);
    if (s.povGiven.length === 3) {
      s.povTrumps[0] = s.povGiven.filter(c => TABLES.normal.cls[c >> 1] === 4).length;
      s.phase = 'povAsk'; s.turn = (s.poor + 1) % 4;
    }
  } else {
    s.povBack.push(id); s.hands[s.poor].push(id);
    if (s.povBack.length === 3) {
      s.povTrumps[1] = s.povBack.filter(c => TABLES.normal.cls[c >> 1] === 4).length;
      s.team = [0, 0, 0, 0]; s.team[s.poor] = 1; s.team[s.acceptor] = 1;
      s.turn = (s.dealer + 1) % 4; startPlay(s);
    }
  }
}
function povAsk(s, p, accept) {
  if (accept) {
    s.acceptor = p; s.hands[p].push(...s.povGiven); s.phase = 'povReturn'; s.turn = p;
    return;
  }
  const next = (p + 1) % 4;
  if (next !== s.poor) { s.turn = next; return; }
  // nobody takes the Armut → the hand is thrown in and dealt again
  s.phase = 'done';
  s.result = { winner: -1, re: 0, ko: 0, reTricks: 0, value: 0, lines: [['Armut nicht mitgenommen – neu geben', 0]],
    perSeat: [0, 0, 0, 0], solo: false, redeal: true };
}

// ---- scoring (DDV 7.x) ----------------------------------------------------------------------------
const LEVEL_NEED = [0, 0, 151, 181, 211, 240];   // card points a party needs after its own Absage level k
const FAIL_BAR = [0, 0, 90, 60, 30, 1];          // ...and the other party wins with this many if it fails
function score(s) {
  const reSeats = [0, 1, 2, 3].filter(q => s.team[q] === 1);
  let re = 0; for (const q of reSeats) re += s.won[q];
  const ko = 240 - re;
  const reTricks = s.tricks.filter(t => s.team[t.winner] === 1).length, koTricks = s.handSize - reTricks;
  const [koL, reL] = [s.ann[0], s.ann[1]];
  const solo = s.soloist >= 0;
  // own targets
  const reBase = (koL >= 1 && reL === 0) ? 120 : 121, koBase = (koL >= 1 && reL === 0) ? 121 : 120;
  const reOwn = reL >= 2 ? LEVEL_NEED[reL] : reBase, koOwn = koL >= 2 ? LEVEL_NEED[koL] : koBase;
  const reachedBy = (pts, tricks, need) => need === 240 ? tricks === s.handSize : pts >= need;
  let reWin = reachedBy(re, reTricks, reOwn) || (koL >= 2 && reL < 2 && (koL === 5 ? reTricks > 0 : re >= FAIL_BAR[koL]));
  let koWin = reachedBy(ko, koTricks, koOwn) || (reL >= 2 && koL < 2 && (reL === 5 ? koTricks > 0 : ko >= FAIL_BAR[reL]));
  if (reWin && koWin) koWin = false;   // cannot both hold; defensive
  const winner = reWin ? 1 : koWin ? 0 : -1;
  const lines = [];   // [label, points for Re]
  if (winner >= 0) {
    const sg = winner === 1 ? 1 : -1, losePts = winner === 1 ? ko : re, loseTricks = winner === 1 ? koTricks : reTricks;
    const winPts = 240 - losePts, loseL = s.ann[1 - winner];
    lines.push(['Gewonnen', sg]);
    if (winner === 0 && !solo) lines.push(['Gegen die Alten', sg]);
    if (losePts < 90) lines.push(['Unter 90', sg]);
    if (losePts < 60) lines.push(['Unter 60', sg]);
    if (losePts < 30) lines.push(['Unter 30', sg]);
    if (loseTricks === 0) lines.push(['Schwarz', sg]);
    if (reL >= 1) lines.push(['Re angesagt', 2 * sg]);
    if (koL >= 1) lines.push(['Kontra angesagt', 2 * sg]);
    for (let k = 2; k <= 5; k++) for (const L of [reL, koL]) if (L >= k) lines.push([ANN_DE[ANN[k]] + ' abgesagt', sg]);
    const against = [[2, 120, '120 gegen Keine 90'], [3, 90, '90 gegen Keine 60'], [4, 60, '60 gegen Keine 30'], [5, 30, '30 gegen Schwarz']];
    for (const [k, need, label] of against) if (loseL >= k && winPts >= need) lines.push([label, sg]);
  }
  if (!solo && s.rules.specialPoints) {
    const sp = s.rules.specials;
    s.tricks.forEach((t, ti) => {
      const wt = s.team[t.winner], sg = wt === 1 ? 1 : -1;
      if (sp.doppelkopf && t.points >= 40) lines.push(['Doppelkopf', sg]);
      t.cards.forEach((id, i) => {
        const by = (t.leader + i) % 4;
        if (sp.fuchs && (id >> 1) === DA && s.team[by] !== wt) lines.push(['Fuchs gefangen', sg]);
      });
      if (ti === s.handSize - 1) {
        const wi = (t.winner - t.leader + 4) % 4, wt0 = t.cards[wi] >> 1;
        if (sp.karlchen && wt0 === CJ) lines.push(['Karlchen', sg]);
        if (sp.fuchsLetzter && wt0 === DA) lines.push(['Fuchs macht letzten Stich', sg]);
        if (sp.karlchenGefangen) t.cards.forEach((id, i) => {
          if (i !== wi && (id >> 1) === CJ && s.team[(t.leader + i) % 4] !== wt) lines.push(['Karlchen gefangen', sg]);
        });
      }
    });
  }
  const value = lines.reduce((a, l) => a + l[1], 0);   // game value for each Re player (normal game)
  const perSeat = [0, 1, 2, 3].map(q => {
    if (solo) return q === s.soloist ? 3 * value : -value;
    return s.team[q] === 1 ? value : -value;
  });
  return { winner, re, ko, reTricks, value, lines, perSeat, solo, dutyGame: s.dutyGame };
}

// ---- public knowledge -----------------------------------------------------------------------------
// Which seats' parties are publicly known? (played a Kreuz-Dame, announced, solo/wedding resolved, or deducible)
function publicTeams(s) {
  const known = [null, null, null, null];
  if (s.phase !== 'play' && s.phase !== 'done') return known;
  if (s.gameType === 'poverty') { for (let q = 0; q < 4; q++) known[q] = s.team[q]; return known; }
  if (s.soloist >= 0 && s.gameType !== 'silent') { for (let q = 0; q < 4; q++) known[q] = s.team[q]; return known; }
  if (s.gameType === 'wedding') {
    known[s.bride] = 1;
    if (s.clarify >= 0) for (let q = 0; q < 4; q++) known[q] = s.team[q];
    return known;
  }
  for (let q = 0; q < 4; q++) if (s.playedCQ[q] > 0) known[q] = 1;
  for (const a of s.annBy) known[a.seat] = a.party;
  const cqPlayed = s.playedCQ.reduce((x, y) => x + y, 0);
  const nRe = known.filter(x => x === 1).length, nKo = known.filter(x => x === 0).length;
  const silentDone = s.gameType === 'silent' && s.playedCQ[s.soloist] === 2;
  if ((cqPlayed === 2 && s.gameType === 'normal') || nKo >= 2 || (nRe >= 2) || silentDone)
    for (let q = 0; q < 4; q++) known[q] = s.team[q];
  return known;
}

// Observation of `seat`: everything public + own hand. Other hands → only counts. Used by bots, UI and network play.
function view(s, seat) {
  const v = clone(s);
  v.seat = seat;
  v.handCounts = s.hands.map(h => h.length);
  v.hands = s.hands.map((h, q) => q === seat || s.phase === 'done' ? h.slice() : []);
  v.known = publicTeams(s);
  if (s.phase !== 'done') {
    const own = ownParty(s, seat);
    v.team = v.known.slice();
    if (own !== null) v.team[seat] = own;
    if (s.gameType === 'silent' && seat !== s.soloist) { v.gameType = 'normal'; v.soloist = -1; }
    v.playedCQ = s.playedCQ.slice();
    // reservations: during the reservation round only "healthy"/"Vorbehalt" is public
    if (s.phase === 'reserve') v.resv = s.resv.map((r, q) => r === null || q === seat ? r : (r === 'healthy' ? 'healthy' : 'reserved'));
    if (seat !== s.poor && seat !== s.acceptor) { v.povGiven = []; v.povBack = []; }
    if (!s.pigShown && seat !== s.schwein) v.schwein = -1;
  }
  v.hidden = true;
  return v;
}

function cardName(id) { const t = id >> 1; return SUIT_SYM[(t / 6) | 0] + RANK_DE[t % 6]; }
function actionName(a, s) {
  if (a >= ACT_POV) return a === ACT_POV ? 'Nicht mitnehmen' : 'Armut mitnehmen';
  if (a >= ACT_RES) return RESV_DE[RESV[a - ACT_RES]];
  if (a >= ACT_ANN) { const k = a - ACT_ANN; return k === 1 ? (s && s.team[s.turn] === 0 ? 'Kontra' : 'Re') : ANN_DE[ANN[k]]; }
  return cardName(a);
}

// sort key for displaying a hand: trumps first (high → low), then suits
function sortHand(hand, gameType) {
  const tb = TABLES[gameType || 'normal'];
  const key = id => { const t = id >> 1; return tb.cls[t] === 4 ? 10000 - tb.power[t] : 20000 + [C, S, H, D].indexOf(tb.cls[t]) * 100 - tb.power[t]; };
  return hand.slice().sort((a, b) => key(a) - key(b) || a - b);
}

const api = { SUITS, SUIT_SYM, SUIT_DE, RANKS, RANK_DE, PTS, RESV, RESV_DE, ANN, ANN_DE, ACT_ANN, ACT_RES, ACT_POV, TABLES,
  DEFAULT_RULES, HOUSE_RULES, ALL_SOLI, DDV_SOLI, SOLO_RANK, makeRules, isSoloResv, isWeddingResv, pigType, nTrumpsNormal, C, S, H, D, A, TEN, K, Q, J, NINE, T, CQ, CJ, DA, H10,
  typeOf, suitOf, rankOf, pointsOf, isSolo, rng, shuffle, deck, newGame, clone, legalActions, step, score,
  trickWinnerIdx, publicTeams, view, ownParty, countCQ, cardName, actionName, sortHand, annDeadline };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Doko = api;
})(typeof self !== 'undefined' ? self : this);
