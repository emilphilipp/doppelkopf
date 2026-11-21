// Doppelkopf for the browser and node: the Rust engine (dokors.wasm — rules, bots, UCT, trained network) behind the
// small API the UI uses. States and views are plain JSON objects (same shape as always); every call hands them to
// Rust and back. Only presentation (names, symbols, sorting) and dealing live here.
// Browser / worker: await Doko.ready before the first call. Node: ready on require.
(function (root) {
'use strict';
const isNode = typeof module !== 'undefined' && module.exports;

// ---- cards and actions (ids: card id = type * 2 + copy, type = suit * 6 + rank) ---------------------------------
const SUITS = ['C', 'S', 'H', 'D'], SUIT_SYM = ['♣', '♠', '♥', '♦'], SUIT_DE = ['Kreuz', 'Pik', 'Herz', 'Karo'];
const RANKS = ['A', '10', 'K', 'Q', 'J', '9'], RANK_DE = ['A', '10', 'K', 'D', 'B', '9'], PTS = [11, 10, 4, 3, 2, 0];
const C = 0, S = 1, H = 2, D = 3, A = 0, TEN = 1, K = 2, Q = 3, J = 4, NINE = 5;
const T = (s, r) => s * 6 + r;
const ALL_SOLI = ['soloD', 'soloH', 'soloS', 'soloC', 'soloQ', 'soloJ', 'soloK', 'soloKQJ', 'soloF'];
const RESV = ['healthy', 'wedding', 'weddingFehl', 'weddingTrumpf', 'poverty', ...ALL_SOLI];
const RESV_DE = { healthy: 'Gesund', wedding: 'Hochzeit', weddingFehl: 'Hochzeit (erster Fehlstich)',
  weddingTrumpf: 'Hochzeit (erster Trumpfstich)', poverty: 'Armut',
  soloD: 'Karo-Solo', soloH: 'Herz-Solo', soloS: 'Pik-Solo', soloC: 'Kreuz-Solo', soloQ: 'Damen-Solo',
  soloJ: 'Buben-Solo', soloK: 'Königs-Solo', soloKQJ: 'Köhler', soloF: 'Fleischloser', normal: 'Normalspiel',
  silent: 'Stille Hochzeit' };
const ANN = ['', 're', 'no90', 'no60', 'no30', 'black'];
const ANN_DE = { re: 'Re', ko: 'Kontra', no90: 'Keine 90', no60: 'Keine 60', no30: 'Keine 30', black: 'Schwarz' };
const ACT_ANN = 100, ACT_RES = 200, ACT_POV = 300;
const isSoloResv = r => !!r && r.startsWith('solo');
const isWeddingResv = r => r === 'wedding' || r === 'weddingFehl' || r === 'weddingTrumpf';

function cardName(id) { const t = id >> 1; return SUIT_SYM[(t / 6) | 0] + RANK_DE[t % 6]; }
function actionName(a, s) {
  if (a >= ACT_POV) return a === ACT_POV ? 'Nicht mitnehmen' : 'Armut mitnehmen';
  if (a >= ACT_RES) return RESV_DE[RESV[a - ACT_RES]];
  if (a >= ACT_ANN) { const k = a - ACT_ANN; return k === 1 ? (s && s.team[s.turn] === 0 ? 'Kontra' : 'Re') : ANN_DE[ANN[k]]; }
  return cardName(a);
}
function sortHand(hand, gameType) {   // trumps first (high → low), then the suits in order ♣ ♠ ♥ ♦
  const tb = api.TABLES[gameType || 'normal'];
  const key = id => { const t = id >> 1; return tb.cls[t] === 4 ? 10000 - tb.power[t] : 20000 + tb.cls[t] * 100 - tb.power[t]; };
  return hand.slice().sort((a, b) => key(a) - key(b) || a - b);
}

// ---- dealing --------------------------------------------------------------------------------------------------
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
function deck(rules) { const d = []; for (let id = 0; id < 48; id++) if (rules.withNines !== false || (id >> 1) % 6 !== NINE) d.push(id); return d; }

// ---- the Rust side --------------------------------------------------------------------------------------------
let X = null;
const enc = new TextEncoder(), dec = new TextDecoder();
function put(bytes) { const p = X.io_in(bytes.length); new Uint8Array(X.memory.buffer, p, bytes.length).set(bytes); }   // io_in may grow memory
function result(n) { const r = JSON.parse(dec.decode(new Uint8Array(X.memory.buffer, X.io_out(), n))); if ('err' in r) throw new Error('dokors: ' + r.err); return r.ok; }
function call(op, args) { put(enc.encode(JSON.stringify(Object.assign({ op }, args)))); return result(X.call()); }
const bare = s => { const { log, ...rest } = s; return rest; };   // the action log stays on the JS side

function boot(module) {
  X = new WebAssembly.Instance(module, {}).exports;
  api.TABLES = call('tables');
  const p = call('presets'); api.HOUSE_RULES = p.house; api.DEFAULT_RULES = p.ddv;
}

function newGame(opts = {}) {
  const rules = opts.rules || api.DEFAULT_RULES;
  let hands = opts.hands;
  if (!hands) {
    const d = shuffle(deck(rules), opts.rand || rng(opts.seed ?? (Math.random() * 2 ** 32))), n = d.length / 4;
    hands = [0, 1, 2, 3].map(p => d.slice(p * n, p * n + n));
  }
  const s = call('newGame', { rules, dealer: opts.dealer ?? 0, hands, duty: opts.duty || [false, false, false, false], forced: opts.forced ?? -1 });
  s.log = [];
  return s;
}
function step(s, a) {   // mutates s (the UI keeps references to its state object)
  const n = call('step', { s: bare(s), a });
  n.log = s.log || []; n.log.push({ seat: s.turn, a });
  return Object.assign(s, n);
}
const legalActions = s => call('legal', { s: bare(s) });
function view(s, seat) { const v = call('view', { s: bare(s), seat }); v.log = (s.log || []).slice(); return v; }
const score = s => call('score', { s: bare(s) });
const trickWinnerIdx = (s, cards, isLast) => call('trickWinnerIdx', { s: bare(s), cards, isLast });
const clone = s => JSON.parse(JSON.stringify(s));

// ---- bots and the network (they only ever get a view) ---------------------------------------------------------
const bot = (kind, opts = {}) => (v, legal, rand) =>
  call('bot', { v: bare(v), legal, bot: kind, opts, net: opts.net || 0, seed: rand ? (rand() * 2 ** 32) >>> 0 : 1 });
const BOTS = {
  random: { name: 'Zufall', make: o => bot('random', o) },
  heuristic: { name: 'Einfach', make: o => bot('heuristic', o) },
  uct: { name: 'UCT (Sievers)', make: o => bot('uct', o) },
  dmc: { name: 'KI', make: o => bot('dmc', o) },
};
function loadNet(meta, buffer) {   // → network id for opts.net / qValues
  const m = enc.encode(JSON.stringify(meta)), w = new Uint8Array(buffer), all = new Uint8Array(m.length + w.length);
  all.set(m); all.set(w, m.length); put(all);
  return result(X.net_load(m.length));
}
async function loadNetUrl(base, query = '') {
  const meta = await (await fetch(base + '.json' + query)).json();
  return loadNet(meta, await (await fetch(base + '.bin' + query)).arrayBuffer());
}
function loadNetFile(path) { const fs = require('fs'); return loadNet(JSON.parse(fs.readFileSync(path + '.json', 'utf8')), fs.readFileSync(path + '.bin')); }
const qValues = (v, legal, net = 0) => call('q', { v: bare(v), legal, net });   // expected points per legal action
const sampleDeal = (v, seed) => call('sampleDeal', { v: bare(v), seed });

const api = { SUITS, SUIT_SYM, SUIT_DE, RANKS, RANK_DE, PTS, C, S, H, D, A, TEN, K, Q, J, NINE, T, ALL_SOLI, RESV, RESV_DE, ANN, ANN_DE,
  ACT_ANN, ACT_RES, ACT_POV, isSoloResv, isWeddingResv, cardName, actionName, sortHand, rng, shuffle, deck,
  newGame, step, legalActions, view, score, trickWinnerIdx, clone, BOTS, bot,
  randomBot: bot('random'), heuristicBot: bot('heuristic'), uctBot: o => bot('uct', o),
  loadNet, loadNetUrl, loadNetFile, qValues, sampleDeal, TABLES: null, HOUSE_RULES: null, DEFAULT_RULES: null };

if (isNode) {
  boot(new WebAssembly.Module(require('fs').readFileSync(require('path').join(__dirname, 'dokors.wasm'))));
  api.ready = Promise.resolve(api);
  module.exports = api;
} else {
  const url = 'dokors.wasm' + (root.DOKO_VERSION ? '?v=' + root.DOKO_VERSION : '');
  api.ready = (WebAssembly.compileStreaming ? WebAssembly.compileStreaming(fetch(url)).catch(() => fetch(url).then(r => r.arrayBuffer()).then(b => WebAssembly.compile(b)))
    : fetch(url).then(r => r.arrayBuffer()).then(b => WebAssembly.compile(b))).then(m => { boot(m); return api; });
  root.Doko = api;
}
})(typeof self !== 'undefined' ? self : this);
