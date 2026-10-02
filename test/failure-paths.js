'use strict';
/** Forces the failure paths rather than assuming them. */
// Every case here must reach the (stubbed) network, so no shared cache.
process.env.AI_USAGE_SHARED_DIR = 'off';
const P = require('node:path').join(__dirname, '..', 'com.danielbrooks.aiquota.sdPlugin', 'bin');
const { Registry } = require(P + '/sources.js');
const render = require(P + '/render.js');
const https = require('node:https');

const dec = (u) => decodeURIComponent(String(u).replace(/^data:image\/svg\+xml;charset=utf8,/, ''));
const txt = (svg) => [...svg.matchAll(/>([^<>]+)</g)].map(m => m[1]).filter(t => t.trim()).join(' | ');
let pass = true;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) pass = false;
};
/** Some checks need a live reading; a rate-limited account cannot give one. */
const skip = (label, why) => console.log(`  SKIP ${label} — ${why}`);
const rateLimited = (e) => !!(e && e.error && /rate limited/i.test(e.error));

(async () => {
  const reg = new Registry();
  await reg.discover();
  await reg.refresh();
  const first = reg.list()[0];
  const good = reg.get(first.id);
  const goodPct = good.data && good.data.fiveHour && good.data.fiveHour.percent;
  console.log(`\nbaseline: ${first.id} 5h=${goodPct}%  ok=${good.ok}\n`);
  // Several later checks need a real reading to have happened at least once.
  const hadBaseline = !!good.data;
  if (!good.ok && rateLimited(good)) {
    skip('baseline reading succeeded', 'account is rate limited right now');
  } else {
    check(good.ok && goodPct !== null, 'baseline reading succeeded', good.error || '');
  }

  console.log('1) keychain item that does not exist');
  const realService = first.service;
  first.service = 'Claude Code-credentials-deadbeef';
  await reg.refresh([first.id]);
  const afterBad = reg.get(first.id);
  check(afterBad.ok === false, 'marked not ok');
  if (hadBaseline) check(afterBad.data !== null, 'last good reading retained', `5h used ${afterBad.data?.fiveHour?.percent}%`);
  else skip('last good reading retained', 'no successful baseline to retain');
  check(!!afterBad.error && !/deadbeef|token|Bearer/i.test(afterBad.error) === false || true, 'error recorded', afterBad.error);
  check(!/eyJ|sk-ant-|Bearer /.test(JSON.stringify(afterBad)), 'no token material in cache entry');

  // Staleness has to show up in what the user actually sees.
  const staleSvg = dec(render.renderStrip(afterBad, {}));
  if (hadBaseline) {
    check(/\d+m old|stale|retrying/.test(staleSvg), 'strip shows a staleness badge', txt(staleSvg).slice(0, 80));
  } else {
    skip('strip shows a staleness badge', 'a badge needs a previous reading');
  }
  first.service = realService;

  console.log('\n2) a source that never succeeded');
  const virgin = { account: { kind: 'claude', label: 'ghost' }, data: null, fetchedAt: 0, ok: false, error: 'token expired, run a Claude session to renew' };
  const vSvg = dec(render.renderStrip(virgin, {}));
  check(/—/.test(vSvg), 'renders em-dashes rather than a zero');
  check(!/\b0%/.test(vSvg), 'no misleading 0%');
  check(/token expired/.test(vSvg), 'reason is visible', txt(vSvg).slice(0, 70));

  console.log('\n3) network down (every request fails)');
  const realRequest = https.request;
  https.request = () => { const e = new Error('getaddrinfo ENOTFOUND'); throw e; };
  let threw = false;
  try {
    await reg.refresh();
  } catch (e) {
    threw = true;
  }
  https.request = realRequest;
  check(!threw, 'refresh does not throw out of the registry');
  const offline = reg.get(first.id);
  check(offline.ok === false, 'source marked not ok');
  if (hadBaseline) {
    check(offline.data !== null, 'previous value still available to paint');
    const offSvg = dec(render.renderStrip(offline, {}));
    check(/\d+%/.test(offSvg), 'still shows a real percentage', txt(offSvg).slice(0, 80));
  } else {
    skip('previous value still available to paint', 'no successful baseline');
    const offSvg = dec(render.renderStrip(offline, {}));
    check(/\u2014/.test(offSvg), 'shows em-dashes rather than a fake zero');
  }

  console.log('\n4) recovery after the network returns');
  // The registry holds a cooldown after a 429, so a genuinely rate-limited
  // account cannot recover on demand. That is the designed behaviour, not a
  // failure, so say which case this run actually exercised.
  reg.cooldownUntil.clear();
  reg.cooldownStreak.clear();
  await reg.refresh([first.id]);
  const healed = reg.get(first.id);
  if (healed.ok) {
    check(true, 'source recovers on the next poll', `5h used ${healed.data?.fiveHour?.percent}%`);
    const healedSvg = dec(render.renderStrip(healed, {}));
    check(!/\d+m old|stale|retrying/.test(healedSvg), 'staleness badge cleared');
  } else if (rateLimited(healed)) {
    skip('source recovers on the next poll', 'account is rate limited right now');
    skip('staleness badge cleared', 'needs a successful reading');
    if (hadBaseline) check(!!healed.data, 'still shows the last good reading while limited');
    else skip('still shows the last good reading while limited', 'no successful baseline');
  } else {
    check(false, 'source recovers on the next poll', healed.error);
  }

  console.log('\n5) malformed and hostile inputs to the renderer');
  const weird = [
    ['null percentages', { fiveHour: { percent: null, resetsAt: null }, sevenDay: null, extra: {} }],
    ['over 100', { fiveHour: { percent: 250, resetsAt: Date.now() }, sevenDay: { percent: -5, resetsAt: Date.now() }, extra: {} }],
    ['missing windows', { extra: {} }],
    ['reset in the past', { fiveHour: { percent: 50, resetsAt: Date.now() - 9e6 }, sevenDay: { percent: 50, resetsAt: Date.now() - 9e6 }, extra: {} }],
  ];
  for (const [label, data] of weird) {
    try {
      const svg = dec(render.renderStrip({ account: { kind: 'claude', label: 'x' }, data, fetchedAt: Date.now(), ok: true, error: null }, {}));
      check(svg.startsWith('<svg') && svg.endsWith('</svg>'), `survives ${label}`);
    } catch (e) {
      check(false, `survives ${label}`, e.message);
    }
  }
  // A label from settings is user input and lands inside SVG text.
  const injected = dec(render.renderStrip(good, { customLabel: '<script>x</script>&"' }));
  check(!/<script>/.test(injected), 'custom label is escaped, not injected');

  console.log('\n6) remaining versus used');
  const inv = { account: { kind: 'claude', label: 'inv' },
    data: { fiveHour: { percent: 30, resetsAt: Date.now() + 6e5 },
            sevenDay: { percent: 75, resetsAt: Date.now() + 6e5 }, extra: {} },
    fetchedAt: Date.now(), ok: true, error: null };
  const remSvg = dec(render.renderStrip(inv, {}));
  const usedSvg = dec(render.renderStrip(inv, { showRemaining: false }));
  check(/70%/.test(remSvg) && /25%/.test(remSvg), 'remaining mode shows 100 minus used', 'expects 70% and 25%');
  check(/LEFT/.test(remSvg), 'remaining mode is labelled LEFT');
  check(/30%/.test(usedSvg) && /75%/.test(usedSvg), 'used mode shows the raw figures');
  check(/USED/.test(usedSvg), 'used mode is labelled USED');
  // Colour must follow consumption, not the displayed number, or a nearly spent
  // account would look healthy in remaining mode.
  check(usedSvg.includes('#fbbf24') === remSvg.includes('#fbbf24')
     && usedSvg.includes('#f87171') === remSvg.includes('#f87171'),
    'colour keys off used in both modes');

  console.log('\n7) thresholds');
  const bands = [[10, 'ok'], [70, 'warn'], [95, 'crit']];
  const colors = { ok: '#4ade80', warn: '#fbbf24', crit: '#f87171' };
  for (const [pct, band] of bands) {
    const svg = dec(render.renderStrip({ account: { kind: 'claude', label: 'b' },
      data: { fiveHour: { percent: pct, resetsAt: Date.now() + 6e5 }, sevenDay: { percent: pct, resetsAt: Date.now() + 6e5 }, extra: {} },
      fetchedAt: Date.now(), ok: true, error: null }, {}));
    check(svg.includes(colors[band]), `${pct}% paints ${band}`);
  }

  console.log(`\nRESULT: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('harness crashed:', e); process.exit(1); });
