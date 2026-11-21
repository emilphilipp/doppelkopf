// Bot thinking off the main thread (the Rust engine via doko.js). Also answers 'q' requests: the trained network's
// expected points per legal action. Errors are reported back ({id, err}) so the page can fall back.
self.DOKO_VERSION = 10;
importScripts('doko.js?v=10');
let net = null, netName = null;
const netReady = Doko.ready.then(() => fetch('models/bot.json?v=10')).then(r => r.json()).then(m => { netName = m.source; })
  .then(() => Doko.loadNetUrl('models/bot', '?v=10')).then(id => { net = id; }, () => { net = null; });
const trained = v => net !== null && !v.rules.withNines;   // the network only knows the house rules (no nines)
const cache = {};
onmessage = async e => {
  const { id, view, legal, bot, opts, seed, q } = e.data;
  try {
    await Doko.ready; await netReady;
    if (q) { postMessage({ id, q: trained(view) ? Doko.qValues(view, legal, net) : null }); return; }
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
