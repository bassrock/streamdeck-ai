'use strict';
// The usage cache shared with the Claude Usage menu bar app: a fresh response is
// reused with no request, a 429 cooldown and another reader's attempt hold off,
// and what is written carries the response but never a token.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiquota-shared-'));
process.env.AI_USAGE_SHARED_DIR = dir;
const P = path.join(__dirname, '..', 'com.danielbrooks.aiquota.sdPlugin', 'bin');
const { decideShared, fetchShared, sharedFile } = require(P + '/sources.js');

let failed = 0;
const check = (ok, name) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}`); if (!ok) failed += 1; };

(async () => {
  const now = 1_800_000_000_000;
  check(decideShared(null, now) === 'fetch', 'no entry: fetch');
  check(decideShared({ body: {}, fetchedAt: now - 60e3 }, now) === 'use', 'fresh body: use');
  check(decideShared({ body: {}, fetchedAt: now - 200e3 }, now) === 'fetch', 'old body: fetch');
  check(decideShared({ fetchedAt: now - 600e3, cooldownUntil: now + 60e3 }, now) === 'cooldown', 'cooldown: wait');
  check(decideShared({ fetchedAt: now - 600e3, attemptAt: now - 5e3 }, now) === 'hold', 'in-flight attempt: hold');
  check(decideShared({ fetchedAt: now - 600e3, attemptAt: now - 60e3 }, now) === 'fetch', 'abandoned attempt: fetch');

  // A fresh file written by the other app is used without any request.
  const account = { id: 'codex', kind: 'codex', label: 'codex', authPath: '/nonexistent/.codex/auth.json' };
  const file = sharedFile(account);
  check(path.basename(file) === 'codex-.codex.json', 'file named like the Swift side');
  fs.writeFileSync(file, JSON.stringify({
    provider: 'codex', fetchedAt: Date.now() - 10e3, writer: 'ClaudeUsage',
    body: { plan_type: 'team', rate_limit: { primary_window: { used_percent: 7, reset_at: 1 } },
            rate_limit_reset_credits: { available_count: 4, applicable_available_count: 0 } },
  }));
  const realRequest = https.request;
  let requests = 0;
  https.request = () => { requests += 1; throw new Error('should not be called'); };
  const got = await fetchShared(account);
  https.request = realRequest;
  check(requests === 0, 'no request when the shared response is fresh');
  check(got.data.fiveHour.percent === 7, 'shared response parsed');
  check(got.data.resetCredits === 4 && got.data.resetCreditsUsable === 0, 'Codex reset credits parsed');

  // A cooldown written by the other app is honoured.
  fs.writeFileSync(file, JSON.stringify({ provider: 'codex', fetchedAt: Date.now() - 600e3, cooldownUntil: Date.now() + 120e3, body: null }));
  let waited = null;
  try { await fetchShared(account); } catch (e) { waited = e.sharedWait; }
  check(waited && waited.rateLimited === true, 'shared cooldown holds off');

  check(!/eyJ|Bearer|access_token/.test(fs.readFileSync(file, 'utf8')), 'nothing token-shaped on disk');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'}`);
  process.exit(failed ? 1 : 0);
})();
