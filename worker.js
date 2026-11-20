// Bot thinking off the main thread.
importScripts('engine.js?v=5', 'bots.js?v=5');
const cache = {};
onmessage = e => {
  const { id, view, legal, bot, opts, seed } = e.data;
  const key = bot + JSON.stringify(opts || {});
  const fn = cache[key] || (cache[key] = DokoBots.BOTS[bot].make(opts || {}));
  const t0 = Date.now();
  const a = fn(view, legal, Doko.rng(seed));
  postMessage({ id, a, ms: Date.now() - t0 });
};
