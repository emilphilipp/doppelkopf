// Doppelkopf bots: random, heuristic, and a port of Sievers & Helmert's ensemble-UCT (KI 2015).
// Every bot gets only the observation view(state, seat) — never the hidden cards.
(function (root) {
'use strict';
const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Doko;
const { TABLES, PTS, ACT_ANN, ACT_RES, ACT_POV, RESV, CQ, DA, H10 } = E;

// ---- helpers --------------------------------------------------------------------------------------
const power = (gt, id) => { const tb = TABLES[gt]; return tb.power[id >> 1] + (tb.cls[id >> 1] === 4 ? 1000 : 0); };
const isTrump = (gt, id) => TABLES[gt].cls[id >> 1] === 4;
const pts = id => PTS[(id >> 1) % 6];

function currentWinner(v) {   // seat currently winning the open trick (or -1)
  if (!v.trick.length) return -1;
  return (v.leader + E.trickWinnerIdx(v, v.trick, false)) % 4;
}
function beats(v, id) {   // would `id` win the current trick if played now (ignoring later players)?
  return E.trickWinnerIdx(v, v.trick.concat([id]), false) === v.trick.length;
}

// ---- random ---------------------------------------------------------------------------------------
function randomBot(v, legal, rand) {
  const cards = legal.filter(a => a < ACT_ANN);
  if (v.phase === 'reserve') return legal.includes(ACT_RES) ? ACT_RES : legal[(rand() * legal.length) | 0];   // stay healthy (as in Sievers' baseline)
  if (v.phase === 'povAsk') return ACT_POV;            // never takes an Armut
  return cards[(rand() * cards.length) | 0];
}

// ---- heuristic ------------------------------------------------------------------------------------
// Reservation: a solo only with an overwhelming hand (≥ 80 % trumps incl. the top four, or fleischlos with aces
// galore); a lower bar when the player still owes a Pflichtsolo; forced (Vorführung) → the best solo available.
// Otherwise wedding with both Kreuz-Damen, Armut with ≤ 3 trumps.
function soloScore(hand, gt) {
  const n = hand.length, tb = TABLES[gt];
  if (gt === 'soloF') { const aces = hand.filter(id => (id >> 1) % 6 === 0).length; return aces >= n / 2 ? 5 : aces - n / 2; }
  const tr = hand.filter(id => tb.cls[id >> 1] === 4);
  const top = tr.filter(id => tb.trumps.slice(0, 4).includes(id >> 1)).length;
  return tr.length + top - 0.75 * n - (tr.length >= 0.8 * n && top >= 4 ? 0 : 4);
}
function heuristicReserve(v, legal) {
  const hand = v.hands[v.seat];
  const solos = legal.filter(a => E.isSoloResv(RESV[a - ACT_RES]));
  let best = null, bestScore = -Infinity;
  for (const a of solos) { const sc = soloScore(hand, RESV[a - ACT_RES]); if (sc > bestScore) { bestScore = sc; best = a; } }
  if (!legal.includes(ACT_RES)) return best;                       // forced
  if (best !== null && bestScore >= (v.duty && v.duty[v.seat] ? 1 : 3)) return best;
  const wed = legal.find(a => E.isWeddingResv(RESV[a - ACT_RES]));
  if (wed !== undefined) return wed;
  const pov = legal.find(a => RESV[a - ACT_RES] === 'poverty');
  if (pov !== undefined) return pov;
  return ACT_RES;
}
// Armut: give high-value cards (they go to the partner), take it with a trump-rich hand, return low plain cards.
function heuristicPoverty(v, legal) {
  const hand = v.hands[v.seat], isT = id => TABLES.normal.cls[id >> 1] === 4;
  if (v.phase === 'povAsk') return hand.filter(isT).length >= 0.6 * hand.length ? ACT_POV + 1 : ACT_POV;
  if (v.phase === 'povGive') return legal.slice().sort((a, b) => pts(b) - pts(a))[0];
  return legal.slice().sort((a, b) => (isT(a) - isT(b)) || (pts(a) - pts(b)) || (power('normal', a) - power('normal', b)))[0];
}

function heuristicBot(v, legal, rand) {
  const me = v.seat, hand = v.hands[me], gt = v.gameType;
  if (v.phase === 'reserve') return heuristicReserve(v, legal);
  if (v.phase !== 'play') return heuristicPoverty(v, legal);
  const cards = legal.filter(a => a < ACT_ANN), ann = legal.find(a => a >= ACT_ANN && a < ACT_RES);
  // announce Re/Kontra with a strong hand at the first opportunity (never Absagen)
  if (ann === ACT_ANN + 1) {
    const tr = hand.filter(id => isTrump(gt, id));
    const high = tr.filter(id => power(gt, id) >= 1000 + 197).length;   // Dulle, Kreuz-/Pik-Dame
    const aces = hand.filter(id => !isTrump(gt, id) && (id >> 1) % 6 === 0).length;
    if (tr.length >= hand.length * 0.6 && high >= 2 && tr.length + aces >= hand.length * 0.75) return ann;
  }
  if (cards.length === 1) return cards[0];
  const myTeam = v.team[me];
  const byLow = (a, b) => (pts(a) - pts(b)) || (power(gt, a) - power(gt, b));
  if (v.trick.length === 0) {
    // lead: an ace of a suit nobody has led yet, else a low trump, else the lowest card
    const led = new Set(v.tricks.map(t => TABLES[gt].cls[t.cards[0] >> 1]));
    const ace = cards.find(id => !isTrump(gt, id) && (id >> 1) % 6 === 0 && !led.has(TABLES[gt].cls[id >> 1]));
    if (ace !== undefined) return ace;
    const tr = cards.filter(id => isTrump(gt, id) && (id >> 1) !== DA).sort(byLow);
    if (tr.length >= 3) return tr[0];
    return cards.slice().sort(byLow)[0];
  }
  const w = currentWinner(v), last = v.trick.length === 3;
  const partnerWins = myTeam !== null && myTeam !== undefined && v.team[w] === myTeam && w !== me;
  const trickPts = v.trick.reduce((a, id) => a + pts(id), 0);
  if (partnerWins) {
    const strong = power(gt, v.trick[(w - v.leader + 4) % 4]) >= 1000 + 196;
    if (last || strong) return cards.slice().sort((a, b) => pts(b) - pts(a) || power(gt, a) - power(gt, b))[0];   // smear
    return cards.slice().sort(byLow)[0];
  }
  const winning = cards.filter(id => beats(v, id)).sort((a, b) => power(gt, a) - power(gt, b));
  if (winning.length && (last || trickPts >= 10)) {
    if (last) return winning.sort(byLow)[0];
    const safe = winning.filter(id => power(gt, id) >= 1000 + 192);   // at least a Dame when others still follow
    return (safe.length ? safe : winning)[0];
  }
  return cards.slice().sort(byLow)[0];
}

// ---- card assignment problem (consistent random deals) -----------------------------------------
// Distribute all unseen cards to the other players respecting hand sizes, revealed voids and Kreuz-Dame knowledge.
function constraints(v) {
  const gt = v.gameType, tb = TABLES[gt];
  const void_ = [0, 1, 2, 3].map(() => new Uint8Array(5));
  const scan = (leader, cards) => {
    const lc = tb.cls[cards[0] >> 1];
    for (let i = 1; i < cards.length; i++) if (tb.cls[cards[i] >> 1] !== lc) void_[(leader + i) % 4][lc] = 1;
  };
  for (const t of v.tricks) scan(t.leader, t.cards);
  if (v.trick.length > 1) scan(v.leader, v.trick);
  const mustCQ = [0, 0, 0, 0], noCQ = [0, 0, 0, 0];
  if (v.phase === 'play') {
    if (gt === 'wedding') { mustCQ[v.bride] = 2 - v.playedCQ[v.bride]; for (let q = 0; q < 4; q++) if (q !== v.bride) noCQ[q] = 1; }
    else if (gt === 'normal') for (let q = 0; q < 4; q++) {
      if (v.known[q] === 0) noCQ[q] = 1;
      else if (v.known[q] === 1 && v.playedCQ[q] === 0) mustCQ[q] = 1;
    }
  }
  // cards known to be in someone's hand: Armut exchange (only the two partners know), the other Schweinchen
  const seen = new Set(); for (const t of v.tricks) for (const id of t.cards) seen.add(id); for (const id of v.trick) seen.add(id);
  const mustHave = [[], [], [], []];
  if (v.gameType === 'poverty' && v.acceptor >= 0) {
    if (v.seat === v.poor) for (const id of v.povGiven) if (!v.povBack.includes(id) && !seen.has(id)) mustHave[v.acceptor].push(id);
    if (v.seat === v.acceptor) for (const id of v.povBack) if (!seen.has(id)) mustHave[v.poor].push(id);
  }
  const pig = E.pigType(v.rules, gt);
  if (v.schwein >= 0 && v.schwein !== v.seat && pig >= 0)
    for (const id of [pig * 2, pig * 2 + 1]) if (!seen.has(id)) mustHave[v.schwein].push(id);
  return { void_, mustCQ, noCQ, mustHave };
}

function sampleDeal(v, rand, tries = 60) {
  const me = v.seat, seen = new Uint8Array(48);
  for (const id of v.hands[me]) seen[id] = 1;
  for (const t of v.tricks) for (const id of t.cards) seen[id] = 1;
  for (const id of v.trick) seen[id] = 1;
  const unknown = E.deck(v.rules).filter(id => !seen[id]);
  const { void_, mustCQ, noCQ, mustHave } = constraints(v), tb = TABLES[v.gameType];
  for (let attempt = 0; attempt < tries; attempt++) {
    const relax = attempt >= tries - 5;               // last resort: ignore voids
    const cap = v.handCounts.slice(); cap[me] = 0;
    const hands = [[], [], [], []]; hands[me] = v.hands[me].slice();
    let pool = E.shuffle(unknown.slice(), rand), ok = true;
    for (let q = 0; q < 4 && ok; q++) if (q !== me) for (const id of mustHave[q]) {
      const i = pool.indexOf(id);
      if (i < 0 || cap[q] <= 0) { ok = false; break; }
      hands[q].push(id); cap[q]--; pool.splice(i, 1);
    }
    for (let q = 0; q < 4 && ok; q++) for (let k = 0; k < (q === me ? 0 : mustCQ[q]); k++) {
      const i = pool.findIndex(id => (id >> 1) === CQ);
      if (i < 0 || cap[q] <= 0) { ok = false; break; }
      hands[q].push(pool[i]); cap[q]--; pool.splice(i, 1);
    }
    while (ok && pool.length) {
      // most constrained card first
      let bi = -1, bel = null;
      for (let i = 0; i < pool.length; i++) {
        const id = pool[i], c = tb.cls[id >> 1], el = [];
        for (let q = 0; q < 4; q++) if (cap[q] > 0 && (relax || !void_[q][c]) && !((id >> 1) === CQ && noCQ[q])) el.push(q);
        if (bel === null || el.length < bel.length) { bi = i; bel = el; if (el.length <= 1) break; }
      }
      if (!bel.length) { ok = false; break; }
      let tot = 0; for (const q of bel) tot += cap[q];
      let r = rand() * tot, pick = bel[0];
      for (const q of bel) { r -= cap[q]; if (r < 0) { pick = q; break; } }
      hands[pick].push(pool[bi]); cap[pick]--; pool.splice(bi, 1);
    }
    if (ok) return hands;
  }
  return null;
}

// Full (hypothetical) game state from an observation + a sampled deal.
function determinize(v, rand) {
  const hands = sampleDeal(v, rand);
  if (!hands) return null;
  const s = E.clone(v);
  s.hands = hands;
  s.resv = v.resv.map(r => (r === 'reserved' ? null : r));
  s.team = v.team.map(x => (x === 1 ? 1 : 0));
  if (v.phase === 'play' && (v.gameType === 'normal' || v.gameType === 'silent')) {
    const cq = [0, 1, 2, 3].map(q => v.playedCQ[q] + E.countCQ(hands[q]));
    s.team = cq.map(n => (n > 0 ? 1 : 0));
    const both = cq.indexOf(2);
    if (both >= 0) { s.gameType = 'silent'; s.soloist = both; } else { s.gameType = 'normal'; s.soloist = -1; }
  }
  if (v.phase === 'play') {   // who holds both Schweinchen in this sampled deal (cards still in hand + played)
    const pig = E.pigType(v.rules, s.gameType), cnt = [0, 0, 0, 0];
    if (pig >= 0) {
      for (let q = 0; q < 4; q++) for (const id of hands[q]) if ((id >> 1) === pig) cnt[q]++;
      for (const t of v.tricks.concat([{ leader: v.leader, cards: v.trick }])) t.cards.forEach((id, i) => { if ((id >> 1) === pig) cnt[(t.leader + i) % 4]++; });
    }
    s.schwein = cnt.indexOf(2);
  }
  return s;
}

// ---- ensemble UCT (Sievers & Helmert 2015) -------------------------------------------------------
// For each of `dets` sampled deals: build a UCT tree with `iters` rollouts on that perfect-information deal
// (every state of a rollout is added to the tree — the paper's best "no MC simulation" variant).
// Final choice: the root action with the best reward averaged over all trees.
function uctBot(opts = {}) {
  const dets = opts.dets ?? 10, iters = opts.iters ?? 1000, Cexp = opts.c ?? 6;
  // searchReserve=false: solo/wedding decision by the heuristic. Searching it on sampled deals (as in the paper)
  // makes the bot see everyone's cards → solos look safe → far too many solos (strategy fusion).
  const searchReserve = opts.searchReserve ?? false;
  return function (v, legal, rand) {
    if (legal.length === 1) return legal[0];
    if (v.phase !== 'play' && !searchReserve) return heuristicBot(v, legal, rand);
    const me = v.seat, sum = new Map(), cnt = new Map();
    for (let d = 0; d < dets; d++) {
      const det = determinize(v, rand);
      if (!det) continue;
      const rootNode = { n: 0, w: new Float64Array(4), acts: null, kids: null };
      for (let it = 0; it < iters; it++) iterate(det, rootNode, me, Cexp, rand);
      rootNode.acts.forEach((a, i) => {
        const k = rootNode.kids[i]; if (!k || !k.n) return;
        sum.set(a, (sum.get(a) || 0) + k.w[me] / k.n); cnt.set(a, (cnt.get(a) || 0) + 1);
      });
    }
    let best = legal[0], bv = -Infinity;
    for (const a of legal) if (cnt.get(a)) { const x = sum.get(a) / cnt.get(a); if (x > bv) { bv = x; best = a; } }
    return bv === -Infinity ? heuristicBot(v, legal, rand) : best;
  };
}

function searchActions(s, me) {
  // other players' reservations inside the search follow the heuristic (random solos would be absurd)
  if (s.phase !== 'play' && (s.turn !== me || s.phase !== 'reserve')) return [heuristicBot(E.view(s, s.turn), E.legalActions(s), Math.random)];
  return E.legalActions(s);
}

function iterate(root, rootNode, me, Cexp, rand) {
  const s = E.clone(root), path = [rootNode];
  let node = rootNode;
  while (s.phase !== 'done') {
    if (!node.acts) { node.acts = searchActions(s, me); node.kids = new Array(node.acts.length).fill(null); }
    const n = node.acts.length, p = s.turn;
    let pick = -1;
    // unvisited children first (random order), then UCB1 from the acting player's perspective
    let unv = 0; for (let i = 0; i < n; i++) if (!node.kids[i]) unv++;
    if (unv) { let r = (rand() * unv) | 0; for (let i = 0; i < n; i++) if (!node.kids[i] && r-- === 0) { pick = i; break; } }
    else {
      const ln = Math.log(node.n); let bv = -Infinity;
      for (let i = 0; i < n; i++) {
        const k = node.kids[i], x = k.w[p] / k.n + Cexp * Math.sqrt(ln / k.n);
        if (x > bv) { bv = x; pick = i; }
      }
    }
    E.step(s, node.acts[pick]);
    if (!node.kids[pick]) node.kids[pick] = { n: 0, w: new Float64Array(4), acts: null, kids: null };
    node = node.kids[pick]; path.push(node);
  }
  const r = s.result.perSeat;
  for (const nd of path) { nd.n++; for (let q = 0; q < 4; q++) nd.w[q] += r[q]; }
}

const BOTS = {
  random: { name: 'Zufall', make: () => randomBot },
  heuristic: { name: 'Einfach', make: () => heuristicBot },
  uct: { name: 'UCT (Sievers)', make: o => uctBot(o) },
};
const api = { BOTS, randomBot, heuristicBot, heuristicReserve, heuristicPoverty, soloScore, uctBot, sampleDeal, determinize, constraints };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DokoBots = api;
})(typeof self !== 'undefined' ? self : this);
