'use strict';
const fs = require('node:fs');
const path = require('node:path');
const P = require('node:path').join(__dirname, '..', 'com.danielbrooks.aiquota.sdPlugin', 'bin');
const { Registry } = require(path.join(P, 'sources.js'));
const render = require(path.join(P, 'render.js'));

const OUT = process.argv[2] || require('node:path').join(require('node:os').tmpdir(), 'aiquota-preview.html');

function decode(uri) {
  return decodeURIComponent(uri.replace(/^data:image\/svg\+xml;charset=utf8,/, ''));
}

(async () => {
  const reg = new Registry();
  await reg.discover();
  await reg.refresh();

  const cells = [];
  for (const acct of reg.list()) {
    const entry = reg.get(acct.id);
    const views = render.availableViews(render.toState(entry, {}));
    for (let i = 0; i < views.length; i++) {
      cells.push({
        caption: `${acct.label} — ${views[i]}`,
        svg: decode(render.renderStrip(entry, { viewIndex: i })),
        kind: 'strip',
      });
    }
    cells.push({ caption: `${acct.label} — key`, svg: decode(render.renderKey(entry, {})), kind: 'key' });
  }

  // Synthetic edge cases: never-fetched, stale, and the three threshold bands.
  const acct = { account: reg.list()[0], data: null, fetchedAt: 0, ok: false, error: 'token expired, run a Claude session to renew' };
  cells.push({ caption: 'no data yet', svg: decode(render.renderStrip(acct, {})), kind: 'strip' });

  const staleEntry = {
    account: reg.list()[0],
    data: reg.get(reg.list()[0].id).data,
    fetchedAt: Date.now() - 22 * 60 * 1000,
    ok: false,
    error: 'HTTP 503',
  };
  cells.push({ caption: 'stale (22m old)', svg: decode(render.renderStrip(staleEntry, {})), kind: 'strip' });

  for (const [name, five, seven] of [['low', 12, 8], ['warn band', 72, 64], ['critical', 96, 91], ['full', 100, 100]]) {
    const fake = {
      account: { kind: 'claude', label: name.replace(' band', '') },
      data: {
        fiveHour: { percent: five, resetsAt: Date.now() + 41 * 60000, windowMinutes: 300 },
        sevenDay: { percent: seven, resetsAt: Date.now() + 3.2 * 86400000, windowMinutes: 10080 },
        extra: { enabled: false, percent: null, used: null, limit: null },
      },
      fetchedAt: Date.now(), ok: true, error: null,
    };
    cells.push({ caption: `threshold: ${name}`, svg: decode(render.renderStrip(fake, {})), kind: 'strip' });
  }

  const html = `<!doctype html><meta charset="utf-8"><title>AI Quota preview</title>
<style>
 body{background:#0b0b0d;color:#9ca3af;font:13px -apple-system,Helvetica,sans-serif;margin:0;padding:24px}
 h2{color:#e5e5e5;font-size:15px;font-weight:600;margin:28px 0 12px}
 .grid{display:flex;flex-wrap:wrap;gap:20px}
 .cell{background:#000;border:1px solid #26262b;border-radius:6px;padding:0;overflow:hidden}
 .cap{padding:5px 8px;font-size:10px;color:#6b7280;border-top:1px solid #26262b;background:#121215}
 .strip{width:200px;height:100px}
 .strip2x{width:400px;height:200px}
 .key{width:144px;height:144px}
 .note{color:#6b7280;font-size:11px;margin-bottom:4px}
</style>
<h2>Touch strip segments — actual size (200&times;100)</h2>
<div class="note">This is how each segment appears on the strip. Four of these sit side by side.</div>
<div class="grid">
${cells.filter(c => c.kind === 'strip').map(c => `<div class="cell"><div class="strip">${c.svg}</div><div class="cap">${c.caption}</div></div>`).join('\n')}
</div>
<h2>Touch strip segments — 2&times; for detail</h2>
<div class="grid">
${cells.filter(c => c.kind === 'strip').slice(0, 8).map(c => `<div class="cell"><div class="strip2x">${c.svg.replace('width="200" height="100"', 'width="400" height="200"')}</div><div class="cap">${c.caption}</div></div>`).join('\n')}
</div>
<h2>Key variant (144&times;144)</h2>
<div class="grid">
${cells.filter(c => c.kind === 'key').map(c => `<div class="cell"><div class="key">${c.svg}</div><div class="cap">${c.caption}</div></div>`).join('\n')}
</div>
<h2>All four segments as they would actually sit on the strip</h2>
<div class="note">800&times;100 total, the real strip dimensions.</div>
<div class="cell" style="display:flex;width:800px">
${cells.filter(c => c.kind === 'strip').slice(0, 3).map(c => `<div class="strip">${c.svg}</div>`).join('')}
<div class="strip" style="background:#000"></div>
</div>
`;
  fs.writeFileSync(OUT, html);
  console.log(`wrote ${OUT} (${cells.length} cells)`);
})().catch((e) => { console.error('preview failed:', e.message); process.exit(1); });
