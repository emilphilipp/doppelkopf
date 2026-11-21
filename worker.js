// Bot thinking off the main thread (the Rust engine via doko.js). Also answers 'q' requests: the trained network's
// expected points per legal action. Errors are reported back ({id, err}) so the page can fall back.
self.DOKO_VERSION = 9;
importScripts('doko.js?v=9');
let net = null;
const netReady = Doko.ready.then(() => Doko.loadNetUrl('models/bot', '?v=9')).then(id => { net = id; }, () => { net = null; });
const trained = v => net !== null && !v.rules.withNines;   // the network only knows the house rules (no nines)
const cache = {};
onmessage = async e => {
  const { id, view, legal, bot, opts, seed, q } = e.data;
  try {
    await Doko.ready; await netReady;
    if (q) { postMessage({ id, q: trained(view) ? Doko.qValues(view, legal, net) : null }); return; }
    const t0 = Date.now();
    const kind = bot === 'dmc' && !trained(view) ? 'heuristic' : bot;
    const key = kind + JSON.stringify(opts || {});
    const fn = cache[key] || (cache[key] = Doko.BOTS[kind].make(Object.assign({ net }, opts)));
    postMessage({ id, a: fn(view, legal, Doko.rng(seed)), ms: Date.now() - t0 });
  } catch (err) {
    postMessage(q ? { id, q: null, err: String(err) } : { id, err: String(err && err.stack || err) });
  }
};
