// Trained Deep-Monte-Carlo bot in JavaScript: observation encoder (port of rl/features.py, must stay identical —
// checked by rl/crosscheck_dmc.*) + Q-network forward pass. Works on views E.view(s, seat), browser and node.
(function (root) {
'use strict';
const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Doko;
const PHASES = ['reserve', 'povGive', 'povAsk', 'povReturn', 'play'];
const FINDS = ['any', 'fehl', 'trumpf'];
const GAME_TYPES = ['normal', 'wedding', 'silent', 'poverty', ...E.ALL_SOLI];
const N_RESV = E.RESV.length, N_ACT = 24 + 5 + N_RESV + 2;
const TRUMP_RANK = {};
for (const gt of GAME_TYPES) { const rk = new Array(24).fill(0); E.TABLES[gt].trumps.forEach((t, i) => { rk[t] = i + 1; }); TRUMP_RANK[gt] = rk; }

function actionIndex(a) {
  if (a < E.ACT_ANN) return a >> 1;
  if (a < E.ACT_RES) return 24 + (a - E.ACT_ANN - 1);
  if (a < E.ACT_POV) return 29 + (a - E.ACT_RES);
  return 29 + N_RESV + (a - E.ACT_POV);
}

// v = E.view(state, me). Returns a plain array of small ints (same order as rl/features.py BLOCKS).
function encode(v) {
  const me = v.seat, rel = q => (q >= 0 ? (q - me + 4) % 4 : -1), out = [];
  const onehot = (n, i) => { for (let k = 0; k < n; k++) out.push(k === i ? 1 : 0); };
  onehot(5, PHASES.indexOf(v.phase));
  const hand = new Array(24).fill(0); for (const c of v.hands[me]) hand[c >> 1]++;
  out.push(...hand);
  const played = new Array(96).fill(0), byTrick = v.tricks.concat(v.trick.length ? [{ leader: v.leader, cards: v.trick }] : []);
  for (const t of byTrick) t.cards.forEach((c, i) => { played[rel((t.leader + i) % 4) * 24 + (c >> 1)]++; });
  out.push(...played);
  const trick = new Array(96).fill(0); v.trick.forEach((c, i) => { trick[rel((v.leader + i) % 4) * 24 + (c >> 1)] = 1; });
  out.push(...trick);
  const unseen = []; for (let t = 0; t < 24; t++) unseen.push((v.rules.withNines || t % 6 !== 5 ? 2 : 0) - hand[t]);
  for (const t of byTrick) for (const c of t.cards) unseen[c >> 1]--;
  out.push(...unseen);
  onehot(13, v.tricks.length); onehot(4, v.trick.length);
  const inPlay = v.phase === 'play' || v.phase === 'done', gt = v.gameType;   // the view already hides a silent wedding
  onehot(GAME_TYPES.length, inPlay || v.phase.startsWith('pov') ? GAME_TYPES.indexOf(gt) : -1);
  for (const q of [v.soloist, v.bride, v.partner, v.poor, v.acceptor, v.dealer, v.forced]) onehot(4, rel(q));
  const duty = [0, 0, 0, 0]; for (let q = 0; q < 4; q++) duty[rel(q)] = v.duty[q] ? 1 : 0;
  out.push(...duty, v.dutyGame ? 1 : 0);
  onehot(3, gt === 'wedding' ? FINDS.indexOf(v.weddingFind) : -1);
  out.push(v.clarify >= 0 ? 1 : 0);
  const party = new Array(12).fill(0);
  for (let q = 0; q < 4; q++) {
    const k = q === me && inPlay ? v.team[q] : v.known[q];   // the view's team[me] is my own party when I know it
    party[rel(q) * 3 + (k === null || k === undefined ? 2 : k)] = 1;
  }
  out.push(...party);
  onehot(6, v.ann[1]); onehot(6, v.ann[0]);
  const ann = [0, 0, 0, 0]; for (const a of v.annBy) ann[rel(a.seat)] = 1; out.push(...ann);
  const rs = new Array(12).fill(0);
  for (let q = 0; q < 4; q++) { const r = v.resv[q]; rs[rel(q) * 3 + (r === null ? 0 : r === 'healthy' ? 1 : 2)] = 1; }
  out.push(...rs);
  onehot(N_RESV, v.resv[me] !== null ? E.RESV.indexOf(v.resv[me]) : -1);
  const vd = new Array(20).fill(0), cls = E.TABLES[gt].cls;
  for (const t of v.tricks.concat(v.trick.length > 1 ? [{ leader: v.leader, cards: v.trick }] : [])) {
    const lc = cls[t.cards[0] >> 1];
    for (let i = 1; i < t.cards.length; i++) if (cls[t.cards[i] >> 1] !== lc) vd[rel((t.leader + i) % 4) * 5 + lc] = 1;
  }
  out.push(...vd);
  onehot(4, rel(v.schwein));   // the view hides an unrevealed Schweinchen
  onehot(4, v.povTrumps[0]); onehot(4, v.povTrumps[1]);
  const g = new Array(24).fill(0), b = new Array(24).fill(0);
  for (const c of v.povGiven) g[c >> 1]++; for (const c of v.povBack) b[c >> 1]++;   // empty unless I'm poor/taker
  out.push(...g, ...b);
  const tgt = inPlay ? gt : 'normal', tb = E.TABLES[tgt];
  for (let t = 0; t < 24; t++) out.push(tb.cls[t] === 4 ? 1 : 0);
  out.push(...TRUMP_RANK[tgt]);
  const won = [0, 0, 0, 0]; for (const t of v.tricks) won[rel(t.winner)] += t.points; out.push(...won);
  out.push(v.hands[me].length);
  return out;
}

// ---- network ------------------------------------------------------------------------------------------
function halfToFloat(h) {   // IEEE float16 bits → number
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
}
function loadModel(meta, buffer) {   // meta = <name>.json, buffer = ArrayBuffer of <name>.bin (float32 or float16)
  const f = meta.dtype === 'f16' ? Float32Array.from(new Uint16Array(buffer), halfToFloat) : new Float32Array(buffer), P = {};
  for (const l of meta.layout) P[l.name] = { shape: l.shape, data: f.subarray(l.offset, l.offset + l.shape.reduce((a, b) => a * b, 1)) };
  return { meta, P };
}
function linear(W, b, x, out) {   // W: [n_out, n_in] row-major
  const [no, ni] = W.shape, w = W.data;
  for (let o = 0; o < no; o++) { let s = b.data[o]; const r = o * ni; for (let i = 0; i < ni; i++) s += w[r + i] * x[i]; out[o] = s; }
  return out;
}
function qValues(model, obs, acts) {   // Q for each legal action index
  const { P, meta } = model, H = meta.hidden;
  const x = new Float32Array(obs.length), sc = P.scale.data;
  for (let i = 0; i < obs.length; i++) x[i] = obs[i] * sc[i];
  if (meta.arch === 'multi') {   // one pass over the observation → Q for all N_ACT actions, pick the legal ones
    let h = x;
    for (let L = 0; L < meta.bodyLayers; L++) {
      const W = P['w' + L], out = linear(W, P['b' + L], h, new Float32Array(W.shape[0]));
      if (L < meta.bodyLayers - 1) for (let k = 0; k < out.length; k++) if (out[k] < 0) out[k] = 0;
      h = out;
    }
    return acts.map(ai => h[ai]);
  }
  const h0 = linear(P.obs_w, P.obs_b, x, new Float32Array(H));
  let a = new Float32Array(H), b = new Float32Array(H);
  return acts.map(ai => {
    for (let k = 0; k < H; k++) { const z = h0[k] + P.act_w.data[ai * H + k]; a[k] = z > 0 ? z : 0; }
    for (let L = 0; L < meta.bodyLayers; L++) {
      const W = P['w' + L], last = L === meta.bodyLayers - 1;
      const out = last ? new Float32Array(1) : b;
      linear(W, P['b' + L], a, out);
      if (last) return out[0];
      for (let k = 0; k < H; k++) if (b[k] < 0) b[k] = 0;
      const t = a; a = b; b = t;
    }
  });
}
function dmcBot(model) {
  return function (v, legal) {
    if (legal.length === 1) return legal[0];
    const q = qValues(model, encode(v), legal.map(actionIndex));
    let best = 0; for (let i = 1; i < q.length; i++) if (q[i] > q[best]) best = i;
    return legal[best];
  };
}
async function loadModelUrl(base, query = '') {   // browser / worker: base = URL without .json/.bin, query e.g. '?v=6'
  const meta = await (await fetch(base + '.json' + query)).json();
  return loadModel(meta, await (await fetch(base + '.bin' + query)).arrayBuffer());
}
function loadModelFile(path) {   // node only
  const fs = require('fs');
  const meta = JSON.parse(fs.readFileSync(path + '.json', 'utf8')), buf = fs.readFileSync(path + '.bin');
  return loadModel(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const api = { encode, actionIndex, loadModel, loadModelUrl, loadModelFile, qValues, dmcBot, N_ACT, GAME_TYPES };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DokoDMC = api;
})(typeof self !== 'undefined' ? self : this);
