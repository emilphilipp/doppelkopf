// Rules of thumb from strategy guides for the coach (port of the confirmed rules in rl/rules_check.py; measured in
// docs/rules-check.md). check(v, legal) → [{id, G, B}] for a normal game: G = moves that follow the rule, B = moves that
// break it (both non-empty). v = the player's view (doko.js view, with facts), legal = that player's legal actions.
(function (root) {
  const ACT_ANN = 100, PTS = [11, 10, 4, 3, 2, 0], C = 0, S = 1, H = 2, D = 3, A = 0, TEN = 1, K = 2, Q = 3, J = 4;
  const t = (s, r) => s * 6 + r;
  const DULLE = t(H, TEN), CQ = t(C, Q), SQ = t(S, Q), FOX = t(D, A), D10 = t(D, TEN);
  const QUEENS = [0, 1, 2, 3].map(s => t(s, Q)), TOP = [DULLE, CQ, SQ], HIGH = [DULLE, ...QUEENS];

  function ctx(v, legal) {
    const f = v.facts, p = v.turn, cls = f.cls, cards = legal.filter(a => a < ACT_ANN), anns = legal.filter(a => a > ACT_ANN);
    const ask = v.annAsk.length > 0 && !cards.length, trick = ask ? [] : v.trick, tv = f.team, party = tv[p];
    let partner = null; for (let q = 0; q < 4; q++) if (q !== p && tv[q] !== null && tv[q] === party) { partner = q; break; }
    const leader = v.leader >= 0 ? v.leader : v.annAsk.length ? v.annReturn : v.turn;   // −1 before the first card
    const seats = [0, 1, 2, 3].map(i => (leader + i) % 4), hand = v.hands[p];
    const played = []; for (const tr of v.tricks) tr.cards.forEach((c, i) => { if ((tr.leader + i) % 4 === p) played.push(c); });
    const k = seats.indexOf(p), orig = hand.concat(played, k < v.trick.length ? [v.trick[k]] : []);
    const c = { v, f, p, cls, order: f.trumps, cards, anns, ask, trick, pos: trick.length + 1, seats, hand, tricks: v.tricks,
      party, partner, leader, unclear: partner === null, led: v.tricks.map(tr => cls[tr.cards[0] >> 1]), orig, legal };
    c.trump = x => cls[x] === 4;
    c.by = pred => cards.filter(a => pred(a >> 1));
    c.power = (x, lc) => cls[x] === 4 ? 1000 + c.order.length - c.order.indexOf(x) : cls[x] === lc ? [6, 5, 4, 3, 2, 1][x % 6] : -1;
    c.winner = cs => { const lc = cls[cs[0] >> 1]; let best = 0, bp = c.power(cs[0] >> 1, lc);
      for (let i = 1; i < cs.length; i++) { const x = cs[i] >> 1, pw = c.power(x, lc);
        if (pw > bp || (x === DULLE && cs[best] >> 1 === DULLE && v.rules.dulle === 'second')) { best = i; bp = pw; } }
      return best; };
    c.runnableAces = () => cards.filter(a => (a >> 1) % 6 === A && !c.trump(a >> 1) && !c.led.includes(cls[a >> 1]));
    c.estimate = () => {   // Dokoschule checklist for a first announcement (own Augen), adapted to the deck without nines
      const ts = orig.map(x => x >> 1), n = su => ts.filter(x => cls[x] === su).length; let e = 0;
      for (const su of [C, S]) { if (n(su) === 0) e += 40; else if (ts.includes(t(su, A)) && n(su) <= 2) e += 25; else if (n(su) === 1) e += 15; }
      if (n(H) === 0) e += 15; else if (ts.includes(t(H, A)) && n(H) === 1) e += 15;
      const nd = ts.filter(x => x === DULLE).length; e += [0, 25, 40][nd] + 15 * ts.filter(x => x === CQ || x === SQ).length;
      if (ts.filter(c.trump).length > 7) e += 15;
      return e;
    };
    return c;
  }
  const gb = (G, B) => G.length && B.length ? { G, B } : null;
  const split = (cards, bad) => gb(cards.filter(a => !bad.includes(a >> 1)), cards.filter(a => bad.includes(a >> 1)));
  const trumpLed = c => !c.ask && c.pos > 1 && c.trump(c.trick[0] >> 1);
  const partnerStands = c => {   // my partner led a Fehl card that still wins, no higher card of the suit is out, I can't follow
    const l0 = c.trick[0] >> 1, lc = c.cls[l0];
    if (lc === 4 || c.winner(c.trick) !== 0 || c.cards.some(a => c.cls[a >> 1] === lc)) return false;
    for (let x = 0; x < 24; x++) if (c.cls[x] === lc && c.power(x, lc) > c.power(l0, lc) && c.f.unseen[x] > 0) return false;
    return true;
  };
  const annRule = (c, level, last) => {   // own turn at the last chance for this level (hand = 10 − level), or earlier chances
    const a = c.anns.filter(x => x === ACT_ANN + level); if (!a.length) return null;
    if (level === 2 && !c.v.annBy.some(x => x.party === c.party && x.seat !== c.p)) return null;
    if ((!c.ask && c.hand.length === 10 - level) !== last) return null;
    return { a, passes: c.ask ? [ACT_ANN] : c.cards };
  };
  const RULES = {
    D1a: c => { if (c.ask || c.pos !== 1 || c.tricks.length > 3 || c.runnableAces().length) return null;
      const tr = c.orig.map(x => x >> 1).filter(c.trump);
      if (tr.length >= 7 || (tr.length >= 6 && tr.filter(x => x === DULLE || x === CQ).length >= 2)) return null;
      return gb(c.by(x => !c.trump(x)), c.by(c.trump)); },
    S1a: c => { if (c.ask || c.pos !== 1 || c.tricks.length) return null;
      const ts = c.orig.map(x => x >> 1);
      if (ts.filter(c.trump).length >= 8 || [C, S, H].some(su => !ts.some(x => c.cls[x] === su))) return null;
      return gb(c.by(x => !c.trump(x)), c.by(c.trump)); },
    S2: c => { if (c.ask || c.pos !== 1) return null;
      const ra = c.runnableAces(); if (new Set(ra.map(a => c.cls[a >> 1])).size < 2) return null;
      const ln = a => c.hand.filter(x => c.cls[x >> 1] === c.cls[a >> 1]).length * 2 + (c.cls[a >> 1] === H ? 1 : 0);
      const m = Math.min(...ra.map(ln)); return gb(ra.filter(a => ln(a) === m), ra.filter(a => ln(a) !== m)); },
    D5: c => { if (!(trumpLed(c) && c.pos === 2 && c.unclear)) return null;
      if ([FOX, D10].includes(c.trick[0] >> 1) && c.v.annBy.some(x => x.seat === c.seats[0] && x.party === 1)) return null;
      return split(c.by(c.trump), QUEENS); },
    D6: c => c.ask || c.party !== 1 || ![2, 3].includes(c.pos) || !c.unclear ? null : split(c.cards, [SQ]),
    D7: c => { if (c.ask || c.pos !== 4) return null;
      if (c.seats[c.winner(c.trick)] === c.partner) return null;
      const pts = c.trick.reduce((s, x) => s + PTS[(x >> 1) % 6], 0) + 10;
      if (pts >= 30 || c.trick.some((x, i) => (x >> 1 === CQ || x >> 1 === SQ) && c.seats[i] !== c.partner)) return null;
      return split(c.cards, [DULLE]); },
    D13: c => c.ask || c.pos !== 1 || c.partner === null || (c.partner - c.p + 4) % 4 === 3 ? null : split(c.cards, [FOX, D10]),
    D15: c => { if (c.ask || c.pos !== 1 || c.partner === null) return null;
      if (!c.f.holders[DULLE].includes(c.partner) && !c.f.holders[CQ].includes(c.partner)) return null;
      return split(c.cards, TOP); },
    F1: c => c.ask || c.pos === 1 || c.partner === null || c.seats[0] !== c.partner || !partnerStands(c) ? null
      : gb(c.by(x => !c.trump(x)), c.by(x => x === FOX || x === D10)),
    S8: c => c.ask || c.party !== 0 || !c.unclear || c.v.ann[0] > 0 ? null : split(c.cards, [FOX, D10]),
    S9: c => c.ask || !c.unclear || c.hand.some(a => a >> 1 === CQ) ? null : split(c.cards, [DULLE]),
    S11: c => c.ask || c.party !== 1 || !c.unclear || c.pos > 2 ? null : split(c.cards, [CQ]),
    S13: c => { if (c.ask || c.pos === 1 || c.partner === null || !c.seats.slice(0, c.pos - 1).includes(c.partner)) return null;
      if (c.seats[c.winner(c.trick)] !== c.partner) return null;
      const takes = c.cards.filter(a => c.winner(c.trick.concat([a])) === c.trick.length);
      return gb(c.cards.filter(a => !takes.includes(a)), takes); },
    S16: c => !(trumpLed(c) && c.pos === 2) ? null : split(c.by(c.trump), HIGH),
    S20: c => { if (c.ask || c.pos === 1) return null;
      const lc = c.cls[c.trick[0] >> 1];
      if (lc === 4 || c.led.filter(x => x === lc).length !== 1 || c.cards.some(a => c.cls[a >> 1] === lc)) return null;
      const first = c.tricks.find(tr => c.cls[tr.cards[0] >> 1] === lc);
      if (first.cards.some(x => c.cls[x >> 1] !== lc)) return null;
      return split(c.cards, TOP); },
    D16b: c => { const r = annRule(c, 1, true); if (!r || c.estimate() >= (c.party === 1 ? 75 : 85)) return null; return gb(r.passes, r.a); },
    D17: c => { const r = annRule(c, 1, false); return r ? gb(r.passes, r.a) : null; },
    D18b: c => { const r = annRule(c, 2, true); if (!r || c.estimate() >= (c.party === 1 ? 78 : 68)) return null; return gb(r.passes, r.a); },
    S18: c => { if (c.tricks.length || c.leader === c.p || c.orig.filter(x => x >> 1 === DULLE).length === 2) return null;
      const a = c.anns.filter(x => x === ACT_ANN + 1); return a.length ? gb(c.ask ? [ACT_ANN] : c.cards, a) : null; },
  };
  // what the coach shows: the guide's words, the source, and what our test measured (docs/rules-check.md; Δ = points per
  // game for the best rule-following move vs the best rule-breaking move, by coach / search; bot = how often the bot follows)
  const DOKO = 'Kleine Dokoschule', STONI = 'Stonis „20 goldene Regeln“, Fuchstreff-Forum, sinngemäß';
  const INFO = {
    D1a: { src: DOKO, text: 'Das Trumpfausspiel empfiehlt sich eher bei ausgesprochen guten Blättern.', bot: 79, d: [0.14, 0.47] },
    S1a: { src: STONI, text: 'Spiel zuerst Fehl aus – Trumpf nur mit sehr starkem Blatt (8 Trumpf oder eine Farbe frei).', bot: 93, d: [0.74, 1.76] },
    S2: { src: STONI, text: 'Von mehreren Assen zuerst das der Farbe, von der du am wenigsten hast (Schwarz vor Herz).', bot: 73, d: [0.23, 0.50] },
    D5: { src: DOKO, text: 'Bei ungeklärter Partnerschaft hat eine Dame an Position 2 nichts auf dem Stich zu suchen!', bot: 70, d: [0.15, 0.14] },
    D6: { src: DOKO, text: 'Bei ungeklärter Partnerschaft ist eine Blaue an Position 2 oder 3 immer Kontra! – als Re legst du dort keine ♠D.', bot: 74, d: [0.29, 0.59] },
    D7: { src: DOKO, text: 'Die Dulle sollte 30 Augen bringen oder eine schwarze Dame des Gegners übertrumpfen.', bot: 80, d: [0.44, 0.40] },
    D13: { src: DOKO, text: 'Ich zwinge meinen Partner möglichst nicht zu einem hohen Trumpf – kein ♦A/♦10 vorspielen, wenn er nicht hinten sitzt.', bot: 88, d: [0.30, 0.55] },
    D15: { src: DOKO, text: 'Solange ich bei meinem Partner hohe Trümpfe weiß oder vermute, ziehe ich nicht von oben!', bot: 83, d: [0.41, 0.91] },
    F1: { src: DOKO, text: 'Auf Standkarte des Partners abwerfen – Spielgewinn geht vor Sonderpunkten (nicht den Fuchs um jeden Preis retten).', bot: 49, d: [0.14, 0.55] },
    S8: { src: STONI, text: 'Als Kontra kein ♦A/♦10, solange die Parteien unklar sind – das gilt als Re-Zeichen.', bot: 74, d: [0.25, 0.54] },
    S9: { src: STONI, text: 'Eine Dulle zeigt die ♣D – spiel sie (bei unklaren Parteien) nur, wenn du die Alte hast.', bot: 91, d: [0.99, 1.18] },
    S11: { src: STONI, text: 'Als Re die Alte nicht früh zeigen: nicht ausspielen, nicht an Position 2.', bot: 93, d: [0.39, 1.28] },
    S13: { src: STONI, text: 'Nimm deinem Partner keinen Stich ab.', bot: 82, d: [0.73, null], note: 'gilt vor allem an Position 4; an Position 2 ist Übernehmen oft besser' },
    S16: { src: STONI, text: 'An Position 2 bei Trumpf klein bleiben – keine Dulle oder Dame vor den Partner.', bot: 66, d: [0.18, 0.17] },
    S20: { src: STONI, text: 'Lief die erste Runde einer Fehlfarbe normal, sticht man die zweite nicht mit Dulle, Alter oder Blauer.', bot: 69, d: [0.26, 0.45] },
    D16b: { src: DOKO, text: 'Erst ab voraussichtlich 75 eigenen Augen (Re) bzw. 85 (Kontra) hast du eine Ansage.', bot: 92, d: [0.84, null] },
    D17: { src: DOKO, text: 'Eine Ansage erfolgt zum letztmöglichen Zeitpunkt.', bot: 98, d: [0.69, null] },
    D18b: { src: DOKO, text: 'Für „keine 90“ solltest du als Re eigene 75–80, als Kontra 65–70 Augen zusätzlich zur Ansage deines Partners mitbringen.', bot: 98, d: [3.29, null] },
    S18: { src: STONI, text: 'Ohne Ausspiel vor dem ersten Stich nur mit beiden Dullen ansagen.', bot: 98, d: [0.44, null] },
  };
  const MIN_POS = { S13: 3 };   // refinement from the test: S13 only after both opponents (position 3–4)

  function check(v, legal) {
    if (!v.facts || v.gameType !== 'normal' || v.phase !== 'play' || v.rules.withNines) return [];
    const c = ctx(v, legal), out = [];
    for (const id in RULES) {
      let r = null; try { r = RULES[id](c); } catch (e) { r = null; }
      if (r && !(MIN_POS[id] && c.pos < MIN_POS[id])) out.push({ id, G: r.G, B: r.B, est: ['D16b', 'D18b'].includes(id) ? c.estimate() : null });
    }
    return out;
  }
  const api = { check, INFO, RULES, ctx };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DokoRules = api;
})(typeof self !== 'undefined' ? self : this);
