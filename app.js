// Doppelkopf web UI: local play vs bots, pass-and-play (several humans on one device), online play via PeerJS.
// The host's browser runs the game; online players only receive their own view (no hidden cards).
'use strict';
const $ = id => document.getElementById(id);
const E = Doko;

const BOT_TYPES = {
  dmc: { label: 'Bot: KI (selbst trainiert)', bot: 'dmc' },
  heuristic: { label: 'Bot: Einfach (Regeln)', bot: 'heuristic' },
  'uct-fast': { label: 'Bot: UCT schnell (5×300)', bot: 'uct', opts: { dets: 5, iters: 300 } },
  uct: { label: 'Bot: UCT Sievers (10×1000)', bot: 'uct', opts: { dets: 10, iters: 1000 } },
  'uct-strong': { label: 'Bot: UCT stark (30×3000)', bot: 'uct', opts: { dets: 30, iters: 3000 } },
  random: { label: 'Bot: Zufall', bot: 'random' },
};
const SEAT_TYPES = Object.assign({ human: 'Mensch (dieses Gerät)', remote: 'Online-Mitspieler' },
  Object.fromEntries(Object.entries(BOT_TYPES).map(([k, b]) => [k, b.label])));
const isBot = t => t in BOT_TYPES;

const store = {
  get(k, d) { try { const x = localStorage.getItem('doko.' + k); return x ? JSON.parse(x) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('doko.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
let cfg = store.get('cfg', null) || { names: ['Du', 'Anna', 'Ben', 'Clara'], seats: ['human', 'dmc', 'dmc', 'dmc'],
  ruleset: 'house', listGames: 24 };
if (!cfg.ruleset) { cfg.ruleset = 'house'; cfg.listGames = 24; delete cfg.rules; }   // configs from before the house rules
const rulesOf = c => Object.assign({}, c.ruleset === 'ddv' ? E.DEFAULT_RULES : E.HOUSE_RULES, { listGames: c.listGames || 24 });

// display prefs: design (skin) and bot speed (multiplier on the bots' minimum move time and the trick pause)
let speed = Math.max(1, store.get('speed', 1.6));   // 1 = fastest offered
let showQ = store.get('showQ', false);               // show the network's expected points next to my options
function setSkin(k) {
  document.documentElement.dataset.skin = k; store.set('skin', k);
  document.querySelectorAll('.skins button').forEach(b => b.setAttribute('aria-pressed', b.dataset.s === k));
}
setSkin(document.documentElement.dataset.skin || 'klar');
document.querySelectorAll('.skins button').forEach(b => { b.onclick = () => setSkin(b.dataset.s); });
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !$('ov').classList.contains('on') && G && G.waitAck) { e.preventDefault(); ackTrick(); } });
$('speed').value = String(speed);
$('speed').onchange = () => { speed = +$('speed').value; store.set('speed', speed); };
$('b-q').setAttribute('aria-pressed', showQ);
$('b-q').onclick = () => { showQ = !showQ; store.set('showQ', showQ); $('b-q').setAttribute('aria-pressed', showQ); refresh(); };

let mode = 'local';          // 'local' | 'host' | 'client'
let G = null;                // match state (local / host)
let viewSeat = 0, coverFor = -1, userDialog = false;
let client = { conn: null, seat: -1, v: null, meta: null };
let peer = null, roomCode = '', remote = [null, null, null, null];

// ---- bots (web worker, main-thread fallback) ------------------------------------------------------
let worker = null, botWaiting = null, botReq = 0;
try { worker = new Worker('worker.js?v=6'); worker.onmessage = e => ('q' in e.data ? gotQ(e.data) : botWaiting && botWaiting(e.data)); } catch (e) { worker = null; }
function askBot(seat, cb) {
  const t = BOT_TYPES[G.cfg.seats[seat]], view = E.view(G.state, seat), legal = E.legalActions(G.state);
  const seed = (Math.random() * 2 ** 32) >>> 0, id = ++botReq;
  if (worker) { botWaiting = d => { if (d.id === id) { botWaiting = null; cb(d.a); } };
    worker.postMessage({ id, view, legal, bot: t.bot, opts: t.opts || {}, seed }); }
  else setTimeout(() => cb((DokoBots.BOTS[t.bot] || DokoBots.BOTS.heuristic).make(t.opts || {})(view, legal, E.rng(seed))), 0);   // no worker: no network
}

// ---- the network's opinion on my options (expected points per legal action, asked from the worker) -----------
let qShown = { key: '', q: null }, qAsked = { id: 0, key: '' };
function wantQ(v, legal) {   // cached values for this decision, or null (then asks the worker and re-renders on reply)
  const key = JSON.stringify([v.seat, v.phase, v.hands[v.seat], v.trick, v.tricks.length, v.resv, v.povGiven, v.povBack, v.annBy, legal]);
  if (qShown.key === key) return qShown.q;
  if (worker && qAsked.key !== key) { qAsked = { id: ++botReq, key }; worker.postMessage({ id: qAsked.id, view: v, legal, q: true }); }
  return null;
}
function gotQ(d) {
  if (d.id !== qAsked.id) return;
  qShown = { key: qAsked.key, q: d.q };
  if (!d.q && !gotQ.warned) { gotQ.warned = true; toast('KI-Tipps gibt es nur mit den Hausregeln'); }
  refresh();
}
function qBadge(q, best) { return `<small class="qv${best ? ' best' : ''}" title="erwartete Punkte laut KI">${q > 0 ? '+' : ''}${q.toFixed(1)}</small>`; }

// ---- match controller (local + host) ------------------------------------------------------------
function startMatch() {
  G = { cfg: JSON.parse(JSON.stringify(cfg)), scores: [0, 0, 0, 0], history: [], gameNo: 0, dealer: 3, state: null,
    pauseUntil: 0, waitAck: false, recorded: false, thinking: false, sameDealer: false,
    duty: [true, true, true, true], listCount: 0 };   // Pflichtsolo: who still owes one; games counted in this list
  G.rules = rulesOf(G.cfg);
  const humans = humanSeats(); viewSeat = humans.length ? humans[0] : 0;
  nextGame();
}
function humanSeats() { return [0, 1, 2, 3].filter(q => G.cfg.seats[q] === 'human'); }
function nextGame() {
  G.gameNo++; if (!G.sameDealer) G.dealer = (G.dealer + 1) % 4;
  G.sameDealer = false;
  let duty = [false, false, false, false], forced = -1;
  if (G.rules.dutySolo) {
    if (G.listCount >= G.rules.listGames && !G.duty.some(x => x)) { G.listCount = 0; G.duty = [true, true, true, true]; }   // new list
    duty = G.duty.slice();
    // Vorführung: as many games left as players still owing → the first of them left of the dealer must play now
    const owing = [1, 2, 3, 4].map(i => (G.dealer + i) % 4).filter(q => G.duty[q]);
    if (owing.length && G.rules.listGames - G.listCount <= owing.length) forced = owing[0];
  }
  G.state = E.newGame({ dealer: G.dealer, rules: G.rules, duty, forced });
  G.recorded = false; G.pauseUntil = 0; G.waitAck = false;
  update();
}
function act(seat, a) {
  if (!G || G.state.phase === 'done' || seat !== G.state.turn || Date.now() < G.pauseUntil || G.waitAck) return;
  const legal = E.legalActions(G.state);
  if (!legal.includes(a)) {
    if (a >= 100) return;
    const same = legal.find(x => x < 100 && (x >> 1) === (a >> 1));   // other copy of the same card
    if (same === undefined || !G.state.hands[seat].includes(a)) return;
  }
  const nt = G.state.tricks.length;
  E.step(G.state, a);
  // a finished trick stays on the table: until a human confirms it (games with humans), else for a moment
  if (G.state.tricks.length > nt) { if (G.cfg.seats.some(t => t === 'human' || t === 'remote')) G.waitAck = true; else G.pauseUntil = Date.now() + 1300 * speed; }
  update();
}
function update() {
  const s = G.state;
  if (s.phase === 'done' && !G.recorded) {
    G.recorded = true;
    const r = s.result;
    // a Pflichtsolo and a thrown-in Armut don't use up a deal: the same dealer deals again
    if (r.redeal) G.sameDealer = true;
    else if (r.dutyGame) { G.duty[s.soloist] = false; G.sameDealer = true; }
    else G.listCount++;
    r.perSeat.forEach((x, q) => { G.scores[q] += x; });
    if (!r.redeal) G.history.push({ gameNo: G.gameNo, gameType: s.gameType, soloist: s.soloist, bride: s.bride,
      re: [0, 1, 2, 3].filter(q => s.team[q] === 1), duty: !!r.dutyGame, winner: r.winner, value: r.value, perSeat: r.perSeat, rePts: r.re });
  }
  const pause = Date.now() < G.pauseUntil || G.waitAck;
  // which seat does this screen show? (not switched while the finished trick waits for confirmation)
  const humans = humanSeats();
  if (!G.waitAck && s.phase !== 'done' && humans.includes(s.turn) && s.turn !== viewSeat) {
    if (humans.length > 1) coverFor = s.turn; else viewSeat = s.turn;
  }
  broadcast();
  renderLocal();
  if (G.waitAck) return;
  if (pause) { setTimeout(update, G.pauseUntil - Date.now() + 10); return; }
  if (s.phase === 'done') return;
  const t = G.cfg.seats[s.turn];
  if (isBot(t) && !G.thinking) {
    G.thinking = true;
    const t0 = Date.now(), g = G, st = s, n = s.log.length;
    askBot(s.turn, a => {
      const wait = Math.max(0, (st.phase === 'reserve' ? 350 : 550) * speed - (Date.now() - t0));
      setTimeout(() => { if (G !== g) return; g.thinking = false; if (g.state === st && st.log.length === n) act(st.turn, a); else update(); }, wait);
    });
  }
}
function ackTrick() {
  if (mode === 'client') { if (client.conn) client.conn.send({ t: 'ack' }); return; }
  if (G && G.waitAck) { G.waitAck = false; update(); }
}
function metaFor(seat) {
  return { names: G.cfg.names, seats: G.cfg.seats, scores: G.scores, history: G.history, gameNo: G.gameNo,
    pause: Date.now() < G.pauseUntil || G.waitAck, ack: G.waitAck, me: seat, host: mode !== 'client', thinking: G.thinking };
}
function renderLocal() {
  if (mode === 'client' || !G) return;
  render(E.view(G.state, viewSeat), metaFor(viewSeat));
}
function humanAct(a) {
  if (mode === 'client') { if (client.conn) client.conn.send({ t: 'act', a }); return; }
  if (G && G.cfg.seats[viewSeat] === 'human') act(viewSeat, a);
}

// ---- rendering ------------------------------------------------------------------------------------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function cardHTML(id, gt, extra = '', badge = '') {
  const t = id >> 1, su = (t / 6) | 0, rk = t % 6, red = su === E.H || su === E.D;
  const trump = E.TABLES[gt || 'normal'].cls[t] === 4;
  return `<div class="card s${su}${red ? ' red' : ''}${trump ? ' trump' : ''}${rk >= 2 && rk <= 4 ? ' court' : ''} ${extra}" data-id="${id}" title="${E.SUIT_DE[su]} ${E.RANK_DE[rk]}">` +
    `<div class="tl">${E.RANK_DE[rk]}<small>${E.SUIT_SYM[su]}</small></div><div class="ctr">${rk >= 2 && rk <= 4 ? E.RANK_DE[rk] : E.SUIT_SYM[su]}</div><div class="big">${E.SUIT_SYM[su]}</div>${badge}</div>`;
}
function partyBadges(v, q, meta) {
  const out = [];
  const known = v.phase === 'reserve' ? null : v.phase === 'done' ? v.team[q] : (q === meta.me ? v.team[q] : v.known[q]);
  if (v.soloist === q && v.phase !== 'reserve' && (v.gameType !== 'normal')) out.push('<span class="badge re">Solo</span>');
  else if (v.bride === q) out.push('<span class="badge re">Hochzeit</span>');
  else if (known === 1) out.push('<span class="badge re">Re</span>');
  else if (known === 0) out.push('<span class="badge ko">Kontra</span>');
  for (const a of v.annBy.filter(x => x.seat === q))
    out.push(`<span class="badge ann">${a.level === 1 ? (a.party ? 'Re' : 'Kontra') : E.ANN_DE[E.ANN[a.level]]}</span>`);
  if (v.schwein === q) out.push('<span class="badge ann">Schweinchen</span>');
  if (v.rules.dutySolo && v.duty[q] && v.phase === 'reserve') out.push('<span class="badge dealer">Pflichtsolo offen</span>');
  if (v.phase === 'reserve' && v.resv[q]) out.push(`<span class="badge">${v.resv[q] === 'healthy' ? 'gesund' : v.resv[q] === 'reserved' ? 'Vorbehalt' : E.RESV_DE[v.resv[q]]}</span>`);
  return out.join(' ');
}
const BOT_FACES = ['🦊', '🦉', '🐻', '🐸'];
function avatar(q, meta) {   // bots get an animal face, people their initial
  const t = meta.seats[q];
  return isBot(t) ? BOT_FACES[q] : esc((meta.names[q] || '?').trim().charAt(0).toUpperCase() || '?');
}
function seatHTML(v, q, meta) {
  const tricks = v.tricks.filter(t => t.winner === q).length, n = v.handCounts[q];
  const icon = meta.seats[q] === 'remote' ? ' 🌐' : '';
  return `<div class="av${isBot(meta.seats[q]) ? ' bot' : ''}">${avatar(q, meta)}</div><div class="nm">${esc(meta.names[q])}${icon}</div>` +
    `<div class="sub">${partyBadges(v, q, meta)}${v.dealer === q ? '<span class="badge dealer">Geber</span>' : ''}</div>` +
    `<div class="sub"><span>${tricks} Stich${tricks === 1 ? '' : 'e'}</span><span>${meta.scores[q] > 0 ? '+' : ''}${meta.scores[q]} P</span></div>` +
    `<div class="backs">${'<i></i>'.repeat(Math.min(n, 12))}</div>`;
}
function gameLabel(v, meta) {
  const nm = q => esc(meta.names[q]);
  if (v.phase === 'reserve') return 'Vorbehalte' + (v.forced >= 0 ? ` · Vorführung: ${nm(v.forced)}` : '');
  if (v.gameType === 'poverty') return `Armut von ${nm(v.poor)}` + (v.acceptor >= 0 ? ` · mitgenommen von ${nm(v.acceptor)}` + (v.povTrumps[1] >= 0 ? ` (${v.povTrumps[1]} Trumpf zurück)` : '') : '');
  if (v.gameType === 'wedding') return `Hochzeit von ${nm(v.bride)}` + (v.partner >= 0 ? ` · Partner: ${nm(v.partner)}` : v.soloist >= 0 ? ' · allein' : ' · Partner offen');
  if (v.gameType === 'silent') return 'Stille Hochzeit (du spielst allein)';
  if (v.gameType !== 'normal') return `${v.dutyGame ? 'Pflicht-' : ''}${E.RESV_DE[v.gameType]} von ${nm(v.soloist)}`;
  return 'Normalspiel';
}
function render(v, meta) {
  const me = meta.me, rel = q => (q - me + 4) % 4;
  const posEl = { 1: $('s-left'), 2: $('s-top'), 3: $('s-right') };
  for (let q = 0; q < 4; q++) if (q !== me) {
    const el = posEl[rel(q)];
    el.innerHTML = seatHTML(v, q, meta);
    el.classList.toggle('turn', v.phase !== 'done' && v.turn === q && !meta.pause);
  }
  $('me-av').innerHTML = avatar(me, meta); $('me-av').classList.toggle('turn', v.phase !== 'done' && v.turn === me && !meta.pause);
  $('me-name').textContent = meta.names[me] + (meta.scores[me] ? ` (${meta.scores[me] > 0 ? '+' : ''}${meta.scores[me]})` : '');
  $('me-badges').innerHTML = partyBadges(v, me, meta) + (v.dealer === me ? ' <span class="badge dealer">Geber</span>' : '');
  $('gameinfo').innerHTML = `Spiel ${meta.gameNo} · ${gameLabel(v, meta)}`;

  // trick in the middle (after a completed trick: show it for a moment with the winner highlighted)
  const showLast = meta.pause && v.tricks.length && !v.trick.length;
  const tr = showLast ? v.tricks[v.tricks.length - 1] : { leader: v.leader, cards: v.trick, winner: -1 };
  const off = [[-50, -8], [-118, -50], [-50, -92], [18, -50]];
  $('trick').innerHTML = tr.cards.map((id, i) => {
    const q = (tr.leader + i) % 4, [x, y] = off[rel(q)];
    return `<div class="trickcard${q === tr.winner ? ' win' : ''}" style="--tx:${x}%;--ty:${y}%;--rot:${(rel(q) - 1.5) * 3 + (id * 37 % 11 - 5)}deg">${cardHTML(id, v.gameType)}</div>`;
  }).join('');
  $('lasttrick').hidden = !v.tricks.length || v.phase === 'done';

  // status + actions
  const myTurn = v.phase !== 'done' && v.turn === me && !meta.pause && coverFor < 0 && meta.seats[me] !== 'remote' && !isBot(meta.seats[me]) || (mode === 'client' && v.phase !== 'done' && v.turn === me && !meta.pause);
  const legal = myTurn ? E.legalActions(v) : [];
  const qv = showQ && legal.length > 1 ? wantQ(v, legal) : null, qBest = qv ? Math.max(...qv) : 0;
  const qOf = a => { const i = legal.indexOf(a); return qv && i >= 0 ? qBadge(qv[i], qv[i] === qBest) : ''; };
  const qTxt = a => { const i = legal.indexOf(a); return qv && i >= 0 ? ` (${qv[i] > 0 ? '+' : ''}${qv[i].toFixed(1)})` : ''; };
  const qCard = {}; if (qv) legal.forEach((a, i) => { if (a < 100) qCard[a >> 1] = qBadge(qv[i], qv[i] === qBest); });
  let status = '';
  if (v.phase === 'done') status = 'Spiel vorbei';
  else if (meta.pause) status = `${esc(meta.names[v.tricks[v.tricks.length - 1].winner])} bekommt den Stich`;
  else if (myTurn) status = v.phase === 'reserve' ? (v.forced === me ? '<b>Vorführung:</b> <small>du musst jetzt dein Pflichtsolo spielen</small>' : '<b>Vorbehalt?</b> <small>Gesund = normales Spiel</small>')
    : v.phase === 'povGive' ? `<b>Armut:</b> <small>gib ${3 - v.povGiven.length} Karte(n) ab – alle Trümpfe zuerst</small>`
    : v.phase === 'povAsk' ? `<b>${esc(meta.names[v.poor])} hat Armut</b> <small>(${v.povTrumps[0]} Trumpf) – mitnehmen?</small>`
    : v.phase === 'povReturn' ? `<b>Armut:</b> <small>gib ${3 - v.povBack.length} Karte(n) zurück</small>`
    : `<b>Du bist dran</b>${v.trick.length ? '' : ' <small>– spiel aus</small>'}`;
  else status = `${esc(meta.names[v.turn])} ${isBot(meta.seats[v.turn]) ? 'überlegt…' : 'ist dran'}`;
  if (qv) { const b = qv.indexOf(qBest); status += ` <small class="qhint">KI würde: ${E.actionName(legal[b], v)} ${qBadge(qBest, true)}</small>`; }
  $('status').innerHTML = status;
  let acts = '';
  if (myTurn && v.phase === 'reserve') {
    for (const a of legal.filter(a => !E.isSoloResv(E.RESV[a - E.ACT_RES]))) acts += `<button class="btn" data-a="${a}">${E.actionName(a, v)}${qOf(a)}</button>`;
    const soli = legal.filter(a => E.isSoloResv(E.RESV[a - E.ACT_RES]));
    if (soli.length) acts += `<select id="solo-sel"><option value="">Solo…</option>${soli.map(a => `<option value="${a}">${E.actionName(a, v)}${qTxt(a)}</option>`).join('')}</select>`;
  } else if (myTurn && v.phase === 'povAsk') for (const a of legal) acts += `<button class="btn" data-a="${a}">${E.actionName(a, v)}${qOf(a)}</button>`;
  else if (myTurn && v.phase === 'play') for (const a of legal.filter(a => a >= E.ACT_ANN)) acts += `<button class="btn" data-a="${a}">${E.actionName(a, v)}${qOf(a)}</button>`;
  const canAck = meta.ack && (mode === 'client' || meta.seats[me] === 'human');
  if (canAck) acts = '<button class="btn primary" id="ack">Weiter</button>';
  $('actions').innerHTML = acts;
  $('mid').onclick = canAck ? ackTrick : null; $('mid').classList.toggle('ackable', canAck);
  $('actions').querySelectorAll('button').forEach(b => { b.onclick = () => humanAct(+b.dataset.a); });
  if (canAck) $('ack').onclick = ackTrick;
  const sel = $('solo-sel'); if (sel) sel.onchange = () => { if (sel.value && confirm(`${sel.options[sel.selectedIndex].text} spielen?`)) humanAct(+sel.value); else sel.value = ''; };

  // my hand
  const hand = E.sortHand(v.hands[me] || [], v.phase === 'play' || v.phase === 'done' ? v.gameType : 'normal');
  const cardPhase = v.phase === 'play' || v.phase === 'povGive' || v.phase === 'povReturn';
  const legalTypes = new Set(cardPhase ? legal.filter(a => a < 100).map(a => a >> 1) : []);
  const H = $('hand');
  H.className = (myTurn && cardPhase ? 'myturn' : '') + (coverFor >= 0 ? ' covered' : '');
  const w = Math.min(document.documentElement.clientWidth - 24, 760), cw = window.innerWidth <= 520 ? 50 : 62;
  const pad = parseFloat(getComputedStyle(H).paddingLeft) * 2 || 8;   // fanned designs keep room at the sides
  H.style.setProperty('--ov', Math.min(-4, Math.floor((w - 4 - pad - cw) / Math.max(1, hand.length - 1) - cw)) + 'px');
  H.innerHTML = hand.map(id => cardHTML(id, v.phase === 'reserve' ? 'normal' : v.gameType, legalTypes.has(id >> 1) ? 'legal' : '', legalTypes.has(id >> 1) && qCard[id >> 1] || '')).join('');
  H.style.setProperty('--n', hand.length); [...H.children].forEach((c, i) => c.style.setProperty('--i', i));
  H.querySelectorAll('.card.legal').forEach(c => { c.tabIndex = 0; c.onclick = () => humanAct(+c.dataset.id); });

  // overlays driven by the game (not over a dialog the user opened)
  if (userDialog) return;
  if (coverFor >= 0) return showCover(meta);
  if (v.phase === 'done' && !meta.pause) return showResult(v, meta);
  closeDialog();
}

function showCover(meta) {
  openDialog(`<h2>Gerät weitergeben</h2><p><b>${esc(meta.names[coverFor])}</b> ist dran. Die anderen bitte wegschauen.</p>
    <button class="btn primary" id="uncover">Ich bin ${esc(meta.names[coverFor])}</button>`);
  $('uncover').onclick = () => { if (coverFor < 0) return; viewSeat = coverFor; coverFor = -1; closeDialog(); renderLocal(); };
}
function showResult(v, meta) {  // stays open until the next game starts
  const r = v.result, nm = q => esc(meta.names[q]);
  if (r.redeal) {
    openDialog(`<h2>Neu geben</h2><p>Niemand hat die Armut von ${nm(v.poor)} mitgenommen.</p><div class="row" style="justify-content:flex-end">
      ${meta.host ? '<button class="btn primary" id="r-next">Nächstes Spiel</button>' : '<span class="hint">Warte auf den Gastgeber…</span>'}</div>`);
    if (meta.host && $('r-next')) $('r-next').onclick = () => { closeDialog(); nextGame(); };
    return;
  }
  const re = [0, 1, 2, 3].filter(q => v.team[q] === 1), ko = [0, 1, 2, 3].filter(q => v.team[q] === 0);
  const wtxt = r.winner === 1 ? `Re gewinnt (${re.map(nm).join(' & ')})` : r.winner === 0 ? `Kontra gewinnt (${ko.map(nm).join(' & ')})` : 'Keine Partei gewinnt';
  const lines = r.lines.map(([l, p]) => `<tr><td>${esc(l)}</td><td class="${p > 0 ? 'pos' : 'neg'}">${p > 0 ? 'Re' : 'Kontra'} +${Math.abs(p)}</td></tr>`).join('');
  const seats = [0, 1, 2, 3].map(q => `<tr><td>${nm(q)} <span class="badge ${v.team[q] ? 're' : 'ko'}">${v.team[q] ? 'Re' : 'Kontra'}</span></td><td class="${r.perSeat[q] >= 0 ? 'pos' : 'neg'}">${r.perSeat[q] > 0 ? '+' : ''}${r.perSeat[q]}</td></tr>`).join('');
  openDialog(`<h2>${wtxt}</h2><p class="hint">${gameLabel(v, meta)} · Augen: Re ${r.re} – Kontra ${r.ko}</p>
    <table class="res">${lines}</table><h3>Punkte</h3><table class="res">${seats}</table>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" id="r-look">Stiche ansehen</button>
    ${meta.host ? '<button class="btn primary" id="r-next">Nächstes Spiel</button>' : '<span class="hint">Warte auf den Gastgeber…</span>'}</div>`);
  $('r-look').onclick = () => showTricks(v, meta);
  if (meta.host) $('r-next').onclick = () => { closeDialog(); nextGame(); };
}
function showTricks(v, meta) {
  userDialog = true;
  const rows = v.tricks.map((t, i) => `<div class="row"><span class="hint" style="width:22px">${i + 1}</span>` +
    t.cards.map((id, j) => `<div style="text-align:center;font-size:11px">${cardHTML(id, v.gameType)}${esc(meta.names[(t.leader + j) % 4]).slice(0, 6)}</div>`).join('') +
    `<span class="hint">→ ${esc(meta.names[t.winner])} (${t.points})</span></div>`).join('');
  openDialog(`<h2>Stiche</h2><div style="--cardw:44px;--cardh:64px">${rows}</div><button class="btn primary" id="t-close">Zurück</button>`);
  $('t-close').onclick = () => { userDialog = false; closeDialog(); refresh(); };
}

// ---- dialogs --------------------------------------------------------------------------------------
function openDialog(html) { $('dlg').innerHTML = html; $('ov').classList.add('on'); }
function closeDialog() { $('ov').classList.remove('on'); $('dlg').innerHTML = ''; }
function refresh() { if (mode === 'client') { if (client.v) render(client.v, client.meta); } else renderLocal(); }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 3500); }
function userOpen(html) { userDialog = true; openDialog(html + '<div class="row" style="justify-content:flex-end"><button class="btn" id="d-close">Schließen</button></div>'); $('d-close').onclick = userClose; }
function userClose() { userDialog = false; closeDialog(); refresh(); }

$('b-scores').onclick = () => {
  const meta = mode === 'client' ? client.meta : G && metaFor(viewSeat);
  if (!meta) return;
  const nm = q => esc(meta.names[q]);
  let cum = [0, 0, 0, 0];
  const rows = meta.history.map(h => { h.perSeat.forEach((x, q) => { cum[q] += x; });
    const type = h.soloist >= 0 && h.gameType !== 'wedding' ? `${h.duty ? 'Pflicht-' : ''}${E.RESV_DE[h.gameType]} ${nm(h.soloist)}`
      : h.gameType === 'wedding' ? 'Hochzeit' : h.gameType === 'poverty' ? 'Armut' : 'Normal';
    return `<tr><td>${h.gameNo}</td><td>${type}</td>${cum.map((c, q) => `<td class="${h.perSeat[q] > 0 ? 'pos' : 'neg'}">${c}</td>`).join('')}</tr>`; }).join('');
  userOpen(`<h2>Spielliste</h2><table class="res"><tr><td></td><td></td>${[0, 1, 2, 3].map(q => `<td><b>${nm(q)}</b></td>`).join('')}</tr>${rows || '<tr><td colspan=6 class="hint">Noch keine Spiele.</td></tr>'}</table>`);
};
$('b-rules').onclick = () => userOpen(cfg.ruleset === 'ddv' ? `<h2>DDV-Turnierregeln (vereinfacht)</h2>
  <h3>Trumpf</h3><p>♥10 (Dulle) · ♣D ♠D ♥D ♦D · ♣B ♠B ♥B ♦B · ♦A ♦10 ♦K ♦9. Fehlfarben: A 10 K 9 (♥: A K 9). Gleiche Karten: die erste sticht.</p>
  <h3>Parteien</h3><p>Kreuz-Dame = <b>Re</b> (121 Augen nötig), sonst <b>Kontra</b> (120). Beide Kreuz-Damen: Hochzeit oder stille Hochzeit.</p>
  <h3>Wertung</h3><p>Gewonnen · gegen die Alten · unter 90/60/30/schwarz · Re/Kontra je 2 · Absagen · Doppelkopf, Fuchs, Karlchen. Solo ×3.</p>
  <h3>Soli</h3><p>Damen, Buben, Fleischlos, Farbsoli. Der Solist spielt aus.</p>` : `<h2>Unsere Hausregeln</h2>
  <h3>Blatt</h3><p><b>Ohne Neunen</b> (40 Karten, je 10). Trumpf: ♥10 · ♣D ♠D ♥D ♦D · ♣B ♠B ♥B ♦B · ♦A ♦10 ♦K. <b>Die zweite Dulle sticht die erste</b> (auch im letzten Stich).</p>
  <h3>Schweinchen</h3><p>Wer beide ♦A hat, hat die höchsten Trümpfe – angesagt erst beim Ausspielen. Nur wenn kein Solo gespielt wird.</p>
  <h3>Vorbehalte</h3><p>Solo vor Armut vor Hochzeit.
  <b>Hochzeit:</b> Partner ist, wer den ersten fremden Stich macht – oder, wenn so angesagt, den ersten fremden Fehl- bzw. Trumpfstich (in den ersten 3 Stichen, sonst allein).
  <b>Armut</b> bei höchstens 3 Trümpfen: 3 Karten inkl. aller Trümpfe abgeben, wer mitnimmt, gibt 3 beliebige zurück; nimmt keiner mit, wird neu gegeben.</p>
  <h3>Soli</h3><p>Karo (Trumpfsolo), Kreuz, Pik, Herz, Damen, Buben, <b>Königs-Solo</b> (nur Könige Trumpf), <b>Köhler</b> (Könige > Damen > Buben), Fleischloser.
  Mehrere Soli: Trumpfsolo > Köhler > Damen > Buben > Könige > Farbsolo > Fleischlos. <b>Pflichtsolo:</b> jeder muss pro Liste ein Solo spielen;
  Pflichtsolo geht vor Lustsolo, der Solist spielt aus und der Geber gibt noch einmal. Beim Lustsolo spielt die normale Vorhand aus.
  Am Ende der Liste müssen die Übrigen vorführen.</p>
  <h3>Wertung</h3><p>Wie DDV: gewonnen · gegen die Alten · unter 90/60/30/schwarz · Re/Kontra je 2 · Absagen. Sonderpunkte (nicht im Solo):
  Doppelkopf, Fuchs gefangen, Karlchen, <b>Karlchen gefangen</b>, <b>Fuchs macht letzten Stich</b>. Solo zählt dreifach.</p>
  <h3>KI-Bot und KI-Tipps</h3><p>„Bot: KI“ ist ein selbst trainiertes neuronales Netz (627 Mio. Übungsspiele gegen sich selbst, nur Hausregeln).
  Mit <b>KI-Tipps</b> zeigt es bei jeder deiner Entscheidungen, wie viele Punkte es für dich erwartet; grün = was es selbst wählen würde.
  Achtung: es spielt noch viel zu gern Solo.</p>`);

function setupHTML() {
  const seatRows = [0, 1, 2, 3].map(q => `<div class="row"><input type="text" id="n${q}" value="${esc(cfg.names[q])}" maxlength="12">
    <select id="t${q}">${Object.entries(SEAT_TYPES).map(([k, l]) => `<option value="${k}"${cfg.seats[q] === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`).join('');
  return `<h2>Neues Spiel</h2>
    <h3>Plätze (in Spielreihenfolge)</h3>${seatRows}
    <p class="hint">Mehrere „Mensch“-Plätze = Gerät herumreichen. „Online-Mitspieler“ treten über einen Raum-Code bei.</p>
    <h3>Regeln</h3>
    <div class="row"><select id="rset"><option value="house"${cfg.ruleset !== 'ddv' ? ' selected' : ''}>Unsere Hausregeln</option>
      <option value="ddv"${cfg.ruleset === 'ddv' ? ' selected' : ''}>DDV-Turnierregeln</option></select>
      <label>Liste</label><input type="text" id="rlist" value="${cfg.listGames || 24}" style="width:52px" inputmode="numeric"><span class="hint">Spiele (Pflichtsolo)</span></div>
    <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn primary" id="go">Spielen</button></div>
    <h3>Online</h3>
    <div id="online">${onlineHTML()}</div>
    <div class="row" style="justify-content:flex-end"><button class="btn" id="d-close">Schließen</button></div>`;
}
function onlineHTML() {
  if (mode === 'host') {
    const link = location.href.split('?')[0] + '?join=' + roomCode;
    const seats = [0, 1, 2, 3].filter(q => cfg.seats[q] === 'remote');
    return `<p>Raum-Code: <span class="code">${roomCode}</span></p><div class="row"><input type="text" readonly value="${esc(link)}" style="flex:1;width:auto" id="link"><button class="btn small" id="copy">Link kopieren</button></div>
      <ul class="lobby">${seats.map(q => `<li>Platz ${q + 1}: ${remote[q] && remote[q].open ? '✅ ' + esc(cfg.names[q]) : '⏳ wartet…'}</li>`).join('') || '<li class="hint">Stell oben mindestens einen Platz auf „Online-Mitspieler“.</li>'}</ul>`;
  }
  if (mode === 'client') return `<p>Verbunden mit Raum <span class="code">${roomCode}</span> als Platz ${client.seat + 1}.</p>`;
  return `<div class="row"><button class="btn" id="host">Raum eröffnen</button><span class="hint">oder beitreten:</span>
      <input type="text" id="jcode" placeholder="Code" maxlength="5" style="width:80px;text-transform:uppercase"><input type="text" id="jname" placeholder="Dein Name" maxlength="12">
      <button class="btn" id="join">Beitreten</button></div><p class="hint">Peer-to-peer über PeerJS – kein eigener Server nötig. In manchen Mobilfunk-/Firmennetzen klappt die Verbindung nicht.</p>`;
}
function readSetup() {
  cfg = { names: [0, 1, 2, 3].map(q => $('n' + q).value.trim() || 'Spieler ' + (q + 1)), seats: [0, 1, 2, 3].map(q => $('t' + q).value),
    ruleset: $('rset').value, listGames: Math.max(4, Math.min(200, parseInt($('rlist').value, 10) || 24)) };
  store.set('cfg', cfg);
}
function openSetup(prefillJoin) {
  userDialog = true; openDialog(setupHTML());
  $('d-close').onclick = userClose;
  $('go').onclick = () => {
    readSetup();
    if (mode === 'client') return toast('Du bist Gast – der Gastgeber startet das Spiel.');
    userDialog = false; closeDialog(); startMatch();
  };
  wireOnline();
  if (prefillJoin) { $('jcode').value = prefillJoin; $('jname').focus(); }
}
function wireOnline() {
  if ($('host')) $('host').onclick = () => { readSetup(); hostRoom(); };
  if ($('join')) $('join').onclick = () => { const c = $('jcode').value.trim().toUpperCase(), n = $('jname').value.trim(); if (c && n) joinRoom(c, n); else toast('Code und Name eingeben'); };
  if ($('copy')) $('copy').onclick = () => { $('link').select(); try { navigator.clipboard.writeText($('link').value); toast('Link kopiert'); } catch (e) { document.execCommand('copy'); } };
  ['t0', 't1', 't2', 't3'].forEach(id => { if ($(id)) $(id).onchange = () => { readSetup(); if (mode === 'host') $('online').innerHTML = onlineHTML(), wireOnline(); }; });
}
function refreshLobby() { if (userDialog && $('online')) { $('online').innerHTML = onlineHTML(); wireOnline(); } }
$('b-setup').onclick = () => openSetup();
$('lasttrick').onclick = () => {
  const v = mode === 'client' ? client.v : G && E.view(G.state, viewSeat), meta = mode === 'client' ? client.meta : metaFor(viewSeat);
  if (!v || !v.tricks.length) return;
  const t = v.tricks[v.tricks.length - 1];
  userOpen(`<h2>Letzter Stich</h2><div class="row">${t.cards.map((id, j) => `<div style="text-align:center;font-size:12px">${cardHTML(id, v.gameType)}${esc(meta.names[(t.leader + j) % 4])}</div>`).join('')}</div><p>→ ${esc(meta.names[t.winner])} (${t.points} Augen)</p>`);
};
window.addEventListener('resize', refresh);

// ---- online (PeerJS) ------------------------------------------------------------------------------
const PEER_PREFIX = 'dokorl-';
function loadPeer(cb) {
  if (window.Peer) return cb();
  const sc = document.createElement('script');
  sc.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
  sc.onload = cb; sc.onerror = () => toast('PeerJS konnte nicht geladen werden');
  document.head.appendChild(sc);
}
function hostRoom() {
  loadPeer(() => {
    roomCode = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[(Math.random() * 24) | 0]).join('');
    peer = new Peer(PEER_PREFIX + roomCode.toLowerCase());
    peer.on('open', () => { mode = 'host'; refreshLobby(); toast('Raum ' + roomCode + ' offen'); });
    peer.on('error', e => { toast('Online-Fehler: ' + e.type); if (e.type === 'unavailable-id') hostRoom(); });
    peer.on('connection', c => {
      c.on('data', d => hostMsg(c, d));
      c.on('close', () => { refreshLobby(); toast('Ein Mitspieler hat die Verbindung verloren'); });
    });
  });
}
function hostMsg(c, d) {
  if (d.t === 'hello') {
    const free = [0, 1, 2, 3].filter(q => cfg.seats[q] === 'remote' && !(remote[q] && remote[q].open));
    const seat = free.find(q => cfg.names[q] === d.name) ?? free[0];
    if (seat === undefined) { c.send({ t: 'full' }); return; }
    remote[seat] = c; cfg.names[seat] = String(d.name).slice(0, 12); store.set('cfg', cfg);
    if (G) G.cfg.names[seat] = cfg.names[seat];
    c.send({ t: 'seat', seat, code: roomCode });
    refreshLobby(); toast(cfg.names[seat] + ' ist beigetreten');
    if (G) { broadcast(); renderLocal(); } else c.send({ t: 'lobby' });
  } else if (d.t === 'ack') {
    if (remote.includes(c)) ackTrick();
  } else if (d.t === 'act') {
    const seat = remote.indexOf(c);
    if (seat >= 0 && G && G.cfg.seats[seat] === 'remote') act(seat, d.a);
  }
}
function broadcast() {
  if (mode !== 'host' || !G) return;
  for (let q = 0; q < 4; q++) if (remote[q] && remote[q].open && G.cfg.seats[q] === 'remote')
    remote[q].send({ t: 'state', v: E.view(G.state, q), meta: Object.assign(metaFor(q), { host: false }) });
}
function joinRoom(code, name) {
  loadPeer(() => {
    peer = new Peer();
    peer.on('error', e => toast('Online-Fehler: ' + e.type));
    peer.on('open', () => {
      const c = peer.connect(PEER_PREFIX + code.toLowerCase(), { reliable: true });
      c.on('open', () => { c.send({ t: 'hello', name }); });
      c.on('data', d => {
        if (d.t === 'seat') { mode = 'client'; roomCode = code; client.conn = c; client.seat = d.seat; G = null; userDialog = false; closeDialog(); toast('Verbunden – Platz ' + (d.seat + 1)); $('status').textContent = 'Warte auf den Gastgeber…'; }
        else if (d.t === 'full') toast('Raum ist voll');
        else if (d.t === 'state') { client.v = d.v; client.meta = d.meta; render(d.v, d.meta); }
      });
      c.on('close', () => toast('Verbindung zum Gastgeber getrennt'));
    });
  });
}

// ---- boot -----------------------------------------------------------------------------------------
const params = new URLSearchParams(location.search), joinCode = params.get('join');
if (params.has('demo')) cfg = Object.assign({}, cfg, { seats: ['uct-fast', 'heuristic', 'uct-fast', 'heuristic'] });   // watch bots play
if (joinCode) openSetup(joinCode.toUpperCase());
else startMatch();
