// Bot thinking off the main thread. Also answers 'q' requests: the trained network's expected points per legal action.
importScripts('engine.js?v=6', 'bots.js?v=6', 'dmc.js?v=6');
const cache = {};
const REWARD_SCALE = 4;   // the network was trained on points / 4
let model = null;
const modelReady = DokoDMC.loadModelUrl('models/bot', '?v=6').then(m => { model = m; }, () => { model = null; });
const trained = v => model && !v.rules.withNines;   // the network only knows the house rules (no nines)
onmessage = async e => {
  const { id, view, legal, bot, opts, seed, q } = e.data;
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
};
