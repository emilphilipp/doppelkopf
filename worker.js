// Bot thinking off the main thread (the Rust engine via doko.js). Also answers 'q' requests: the trained network's
// expected points per legal action (a policy network: the chance it picks each one, in %). Errors are reported back
// ({id, err}) so the page can fall back.
// Card decisions of the KI use search at play time when a critic is deployed (off since 23 Nov: without the
// reservation leak it gained nothing, -0.05 ± 0.07 vs the plain network): sampled deals that fit the bot's own view
// (never the real hidden cards), every card tried, the actor plays on, the critic judges. The number of sampled deals
// adapts to the device: about BUDGET ms per decision, at most 60; a device too slow for MIN_DETS plays without search.
self.DOKO_VERSION = 24;
importScripts('doko.js?v=24');
let net = null, critic = null, coach = null, netName = null, policy = false;
let withCritic = false;   // bot.json "critic": true → models/critic is deployed too (search at play time)
const netReady = Doko.ready.then(() => fetch('models/bot.json?v=24')).then(r => r.json()).then(m => { netName = m.source; policy = m.kind === 'policy'; withCritic = !!m.critic; })
  .then(() => Doko.loadNetUrl('models/bot', '?v=24')).then(id => { net = id; }, () => { net = null; })
  .then(() => withCritic ? Doko.loadNetUrl('models/critic', '?v=24').then(id => { critic = id; }, () => { critic = null; }) : null);
// Coach (since 24 Nov): a separate network, trained on what each card is worth from the player's own view (taught on
// real deals, so it averages over the hidden cards honestly); loaded on first use. Its outputs are points × 4 (qValues).
// Its values count this game plus the rest of the Pflichtsolo list (for Vorbehalte since 25 Nov: this game's points +
// a table of what the resulting list situation is worth, from simulated lists); coach_game counts this game only — the
// two differ for Vorbehalte (a solo now uses up the Pflichtsolo), so both are shown there.
let coachReady = null, coachGame = null, predNet = null;   // predNet: the prediction heads (rl/predict_heads.py; logits → %)
const loadNet = name => Doko.loadNetUrl('models/' + name, '?v=24').then(id => id, () => null);
const loadCoach = () => coachReady || (coachReady = Promise.all([loadNet('coach'), loadNet('coach_game'), loadNet('predict')]).then(([a, b, c]) => { coach = a; coachGame = b; predNet = c; }));
const coachOf = (v, legal) => ({ vals: Doko.qValues(v, legal, coach).map(x => x / 4),
  game: v.phase === 'reserve' && coachGame !== null ? Doko.qValues(v, legal, coachGame).map(x => x / 4) : null,
  pred: v.phase === 'play' && predNet !== null ? Doko.netOut(v, predNet).map(z => 1 / (1 + Math.exp(-z))) : null });
const trained = v => net !== null && !v.rules.withNines;   // the network only knows the house rules (no nines)
// a policy network's outputs are preferences (logits × 4 from qValues), not points: softmax → %
const shown = q => { if (!policy) return q; const m = Math.max(...q), e = q.map(x => Math.exp((x - m) / 4)), t = e.reduce((a, b) => a + b, 0); return e.map(x => 100 * x / t); };
const BUDGET = 600, MAX_DETS = 60, MIN_DETS = 20;
let msPerDetCard = null;   // measured: ms per sampled deal and legal card
const cache = {};
onmessage = async e => {
  const { id, view, legal, bot, opts, seed, q, coachQ, items } = e.data;
  try {
    await Doko.ready; await netReady;
    if (coachQ) {   // per legal action: the coach's value in points and the bot's preference (logits)
      await loadCoach();
      const ok = trained(view) && coach !== null;
      if (items) { postMessage({ id, review: ok ? items.map(it => coachOf(it.view, it.legal)) : null }); return; }   // a whole game at once
      postMessage({ id, coach: ok ? Object.assign(coachOf(view, legal), { pref: Doko.qValues(view, legal, net) }) : null }); return;
    }
    if (q) { postMessage({ id, q: trained(view) ? shown(Doko.qValues(view, legal, net)) : null, pct: policy }); return; }
    const t0 = Date.now();
    const kind = bot === 'dmc' && !trained(view) ? 'heuristic' : bot;
    if (kind === 'dmc') {   // also report the values, so a game log shows what the KI thought
      const q = Doko.qValues(view, legal, net); let b = 0; for (let i = 1; i < q.length; i++) if (q[i] > q[b]) b = i;
      let a = legal[b], dets = 0;
      const cards = legal.filter(x => x < Doko.ACT_ANN).length;
      if (critic !== null && view.phase === 'play' && cards > 1 && a < Doko.ACT_ANN) {
        dets = msPerDetCard === null ? MIN_DETS : Math.min(MAX_DETS, Math.floor(BUDGET / (msPerDetCard * cards)));
        if (dets >= MIN_DETS) {
          const t1 = Date.now();
          a = Doko.bot('search', { net, critic, dets, lam: 0.05 })(view, legal, Doko.rng(seed));
          const per = (Date.now() - t1) / (dets * cards);
          msPerDetCard = msPerDetCard === null ? per : 0.7 * msPerDetCard + 0.3 * per;
        } else dets = 0;
      }
      postMessage({ id, a, vals: q, model: netName + (dets ? ` + Suche (${dets})` : ''), ms: Date.now() - t0 }); return;
    }
    const key = kind + JSON.stringify(opts || {});
    const fn = cache[key] || (cache[key] = Doko.BOTS[kind].make(Object.assign({ net }, opts)));
    postMessage({ id, a: fn(view, legal, Doko.rng(seed)), ms: Date.now() - t0 });
  } catch (err) {
    postMessage(q || coachQ ? { id, q: null, coach: null, review: null, err: String(err && err.stack || err) } : { id, err: String(err && err.stack || err) });
  }
};
