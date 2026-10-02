'use strict';
/** Pretends to be the Stream Deck app: launches the plugin, drives it, records output. */
const PLUGIN_DIR = require('node:path').join(__dirname, '..', 'com.danielbrooks.aiquota.sdPlugin');
const WebSocket = require(PLUGIN_DIR + '/node_modules/ws');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const NODE = os.homedir() + '/Library/Application Support/com.elgato.StreamDeck/NodeJS/20.20.0/node';
const OUT = process.argv[2] || '/tmp/mockdeck';
fs.mkdirSync(OUT, { recursive: true });

const INFO = {
  application: { font: '.AppleSystemUIFont', language: 'en', platform: 'mac', platformVersion: '26.6.2', version: '7.5.1.22901' },
  colors: {}, devicePixelRatio: 2,
  devices: [{ id: 'dev-plus', name: 'Stream Deck +', size: { columns: 4, rows: 2 }, type: 7 }],
  plugin: { uuid: 'com.danielbrooks.aiquota', version: '1.0.0.0' },
};

const received = [];
const feedbacks = new Map();   // context -> latest full-canvas uri
const layouts = new Map();
const settings = new Map();
let child = null;
let sock = null;

const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 }, () => {
  const port = server.address().port;
  console.log(`mock app listening on ${port}`);
  child = spawn(NODE, [PLUGIN_DIR + '/bin/plugin.js',
    '-port', String(port), '-pluginUUID', 'test-plugin-uuid',
    '-registerEvent', 'registerPlugin', '-info', JSON.stringify(INFO)],
    { cwd: PLUGIN_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => process.stdout.write('  plugin> ' + d.toString().replace(/\n(?=.)/g, '\n  plugin> ')));
  child.stderr.on('data', d => process.stdout.write('  plugin!> ' + d.toString()));
  child.on('exit', (c, s) => console.log(`  plugin exited code=${c} signal=${s}`));
});

const CONTEXTS = ['ctx-A', 'ctx-B', 'ctx-C'];

server.on('connection', (ws) => {
  sock = ws;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    received.push(m);
    if (m.event === 'setFeedback' && m.payload && m.payload['full-canvas']) {
      feedbacks.set(m.context, m.payload['full-canvas']);
    } else if (m.event === 'setFeedbackLayout') {
      layouts.set(m.context, m.payload.layout);
    } else if (m.event === 'setSettings') {
      settings.set(m.context, m.payload);
    } else if (m.event === 'logMessage') {
      console.log('  log>', m.payload.message);
    } else if (m.event === 'registerPlugin') {
      console.log(`  registered uuid=${m.uuid}`);
      CONTEXTS.forEach((ctx, i) => send({
        event: 'willAppear', action: 'com.danielbrooks.aiquota.quota', context: ctx, device: 'dev-plus',
        payload: { settings: {}, coordinates: { column: i, row: 0 }, controller: 'Encoder', isInMultiAction: false },
      }));
    }
  });
});

function send(msg) { if (sock && sock.readyState === 1) sock.send(JSON.stringify(msg)); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dec = (u) => decodeURIComponent(String(u).replace(/^data:image\/svg\+xml;charset=utf8,/, ''));
const summarise = (svg) => {
  const heads = [...svg.matchAll(/>([^<>]+)</g)].map(m => m[1]).filter(t => t.trim());
  return heads.join(' | ').slice(0, 110);
};

(async () => {
  await sleep(9000);   // registration, discovery, first poll

  console.log('\n=== after startup ===');
  let pass = true;
  for (const ctx of CONTEXTS) {
    const lay = layouts.get(ctx);
    const uri = feedbacks.get(ctx);
    const st = settings.get(ctx);
    console.log(`${ctx}: layout=${lay} source=${st && st.sourceId} painted=${uri ? 'yes' : 'NO'}`);
    if (lay !== 'layouts/quota.json') { console.log(`  FAIL: wrong layout`); pass = false; }
    if (!uri) { console.log('  FAIL: never painted'); pass = false; continue; }
    if (!uri.startsWith('data:image/svg+xml;charset=utf8,')) { console.log('  FAIL: bad data uri'); pass = false; }
    const svg = dec(uri);
    console.log(`  text: ${summarise(svg)}`);
    fs.writeFileSync(`${OUT}/${ctx}-view0.svg`, svg);
  }

  const decided = CONTEXTS.filter((ctx) => {
    const svg = dec(feedbacks.get(ctx) || '');
    // A segment with neither a percentage nor a stated reason was never polled.
    return /\d+%/.test(svg) || /rate limited|expired|not signed in|failed|HTTP/i.test(svg);
  });
  console.log(`\nevery segment polled at startup: ${decided.length}/${CONTEXTS.length}`);
  if (decided.length !== CONTEXTS.length) {
    console.log('  FAIL: some segments never got a reading or a reason');
    pass = false;
  } else {
    console.log('  OK: no segment left on "waiting for first reading"');
  }

  const assigned = CONTEXTS.map(c => settings.get(c) && settings.get(c).sourceId);
  const uniq = new Set(assigned.filter(Boolean));
  console.log(`\nauto-assignment: ${assigned.join(', ')}`);
  if (uniq.size !== 3) { console.log(`  FAIL: expected 3 distinct sources, got ${uniq.size}`); pass = false; }
  else console.log('  OK: three distinct accounts, no configuration needed');

  console.log(`\nstartup poll count: ${received.filter(m => m.event === 'logMessage' && /poll \(queued\)/.test(m.payload.message)).length} queued re-poll(s)`);

  console.log('\n=== cycling views on ctx-A ===');
  const seen = [];
  for (let i = 0; i < 5; i++) {
    send({ event: 'dialDown', action: 'com.danielbrooks.aiquota.quota', context: 'ctx-A', device: 'dev-plus',
           payload: { settings: settings.get('ctx-A') || {}, coordinates: { column: 0, row: 0 }, controller: 'Encoder' } });
    await sleep(450);
    const svg = dec(feedbacks.get('ctx-A'));
    const idx = (settings.get('ctx-A') || {}).viewIndex;
    seen.push(idx);
    console.log(`  press ${i + 1}: viewIndex=${idx}  ${summarise(svg).slice(0, 70)}`);
    fs.writeFileSync(`${OUT}/ctx-A-press${i + 1}.svg`, svg);
  }
  if (new Set(seen).size < 2) { console.log('  FAIL: view never changed'); pass = false; }
  else console.log('  OK: views cycle and wrap');

  console.log('\n=== rotate backwards ===');
  send({ event: 'dialRotate', action: 'com.danielbrooks.aiquota.quota', context: 'ctx-A', device: 'dev-plus',
         payload: { settings: settings.get('ctx-A') || {}, ticks: -1, pressed: false, controller: 'Encoder' } });
  await sleep(400);
  console.log(`  viewIndex now ${(settings.get('ctx-A') || {}).viewIndex}`);

  console.log('\n=== long touch forces a refresh ===');
  const before = received.filter(m => m.event === 'setFeedback').length;
  send({ event: 'touchTap', action: 'com.danielbrooks.aiquota.quota', context: 'ctx-B', device: 'dev-plus',
         payload: { settings: settings.get('ctx-B') || {}, hold: true, tapPos: [50, 50], controller: 'Encoder' } });
  await sleep(3500);
  const after = received.filter(m => m.event === 'setFeedback').length;
  console.log(`  setFeedback count ${before} -> ${after}`);
  if (after <= before) { console.log('  FAIL: no repaint after refresh'); pass = false; }
  else console.log('  OK');

  console.log('\n=== willDisappear then reappear ===');
  send({ event: 'willDisappear', action: 'com.danielbrooks.aiquota.quota', context: 'ctx-C', device: 'dev-plus',
         payload: { settings: settings.get('ctx-C') || {}, controller: 'Encoder' } });
  await sleep(300);
  send({ event: 'willAppear', action: 'com.danielbrooks.aiquota.quota', context: 'ctx-C', device: 'dev-plus',
         payload: { settings: settings.get('ctx-C') || {}, controller: 'Encoder' } });
  await sleep(1200);
  console.log(`  ctx-C repainted: ${feedbacks.has('ctx-C') ? 'yes' : 'NO'}`);

  console.log('\n=== property inspector handshake ===');
  const piBefore = received.filter(m => m.event === 'sendToPropertyInspector').length;
  send({ event: 'propertyInspectorDidAppear', action: 'com.danielbrooks.aiquota.quota', context: 'ctx-A', device: 'dev-plus' });
  await sleep(700);
  const piMsgs = received.filter(m => m.event === 'sendToPropertyInspector');
  if (piMsgs.length > piBefore) {
    const p = piMsgs[piMsgs.length - 1].payload;
    console.log(`  OK: sent ${p.sources.length} sources`);
    for (const s of p.sources) console.log(`     ${s.id}  ${s.label}  ${s.email || '(no email)'}`);
  } else { console.log('  FAIL: no source list sent'); pass = false; }

  console.log('\n=== token leak scan ===');
  const blob = JSON.stringify(received);
  const leaks = [];
  if (/sk-ant-/.test(blob)) leaks.push('sk-ant- token');
  if (/eyJ[A-Za-z0-9_-]{20,}/.test(blob)) leaks.push('JWT');
  if (/Bearer\s+[A-Za-z0-9]/.test(blob)) leaks.push('bearer header');
  if (/refreshToken|accessToken/.test(blob)) leaks.push('token field name');
  console.log(leaks.length ? `  FAIL: ${leaks.join(', ')}` : `  OK: nothing token-shaped in ${received.length} messages`);
  if (leaks.length) pass = false;

  console.log(`\n=== message tally ===`);
  const tally = {};
  for (const m of received) tally[m.event] = (tally[m.event] || 0) + 1;
  console.log('  ' + Object.entries(tally).map(([k, v]) => `${k}:${v}`).join('  '));

  console.log(`\nRESULT: ${pass ? 'PASS' : 'FAIL'}`);
  console.log(`SVGs written to ${OUT}`);
  if (child) child.kill();
  server.close();
  process.exit(pass ? 0 : 1);
})();
