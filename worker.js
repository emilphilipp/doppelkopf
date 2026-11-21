// Bot thinking off the main thread. Also answers 'q' requests: the trained network's expected points per legal action.
// Errors are reported back ({id, err}) so the page can fall back instead of waiting forever.
importScripts('engine.js?v=8', 'bots.js?v=8', 'dmc.js?v=8');
const cache = {};
const REWARD_SCALE = 4;   // the network was trained on points / 4
let model = null;
const modelReady = DokoDMC.loadModelUrl('models/bot', '?v=8').then(m => { model = m; }, () => { model = null; });
const trained = v => model && !v.rules.withNines;   // the network only knows the house rules (no nines)
onmessage = async e => {
  const { id, view, legal, bot, opts, seed, q } = e.data;
  try {
    if (q || bot === 'dmc') await modelReady;
    if (q) {
      const vals = trained(view) ? DokoDMC.qValues(model, DokoDMC.encode(view), legal.map(DokoDMC.actionIndex)).map(x => x * REWARD_SCALE) : null;
      postMessage({ id, q: vals, model: model && model.meta.source });
      return;
    }
    const t0 = Date.now();
    let a;
    if (bot === 'dmc') a = trained(view) ? DokoDMC.dmcBot(model)(view, legal) : DokoBots.heuristicBot(view, legal, Doko.rng(seed));
    else {
      const key = bot + JSON.stringify(opts || {});
      const fn = cache[key] || (cache[key] = DokoBots.BOTS[bot].make(opts || {}));
      a = fn(view, legal, Doko.rng(seed));
    }
    postMessage({ id, a, ms: Date.now() - t0 });
  } catch (err) {
    postMessage(q ? { id, q: null, err: String(err) } : { id, err: String(err && err.stack || err) });
  }
};
