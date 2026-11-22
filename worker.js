// Bot thinking off the main thread (the Rust engine via doko.js). Also answers 'q' requests: the trained network's
// expected points per legal action (a policy network: the chance it picks each one, in %). Errors are reported back
// ({id, err}) so the page can fall back.
self.DOKO_VERSION = 11;
importScripts('doko.js?v=11');
let net = null, netName = null, policy = false;
const netReady = Doko.ready.then(() => fetch('models/bot.json?v=11')).then(r => r.json()).then(m => { netName = m.source; policy = m.kind === 'policy'; })
  .then(() => Doko.loadNetUrl('models/bot', '?v=11')).then(id => { net = id; }, () => { net = null; });
const trained = v => net !== null && !v.rules.withNines;   // the network only knows the house rules (no nines)
// a policy network's outputs are preferences (logits × 4 from qValues), not points: softmax → %
const shown = q => { if (!policy) return q; const m = Math.max(...q), e = q.map(x => Math.exp((x - m) / 4)), t = e.reduce((a, b) => a + b, 0); return e.map(x => 100 * x / t); };
const cache = {};
onmessage = async e => {
  const { id, view, legal, bot, opts, seed, q } = e.data;
  try {
    await Doko.ready; await netReady;
    if (q) { postMessage({ id, q: trained(view) ? shown(Doko.qValues(view, legal, net)) : null, pct: policy }); return; }
    const t0 = Date.now();
    const kind = bot === 'dmc' && !trained(view) ? 'heuristic' : bot;
    if (kind === 'dmc') {   // also report the values, so a game log shows what the KI thought
      const q = Doko.qValues(view, legal, net); let b = 0; for (let i = 1; i < q.length; i++) if (q[i] > q[b]) b = i;
      postMessage({ id, a: legal[b], vals: q, model: netName, ms: Date.now() - t0 }); return;
    }
    const key = kind + JSON.stringify(opts || {});
    const fn = cache[key] || (cache[key] = Doko.BOTS[kind].make(Object.assign({ net }, opts)));
    postMessage({ id, a: fn(view, legal, Doko.rng(seed)), ms: Date.now() - t0 });
  } catch (err) {
    postMessage(q ? { id, q: null, err: String(err) } : { id, err: String(err && err.stack || err) });
  }
};
