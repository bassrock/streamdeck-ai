'use strict';
/**
 * Drives the agent action the way the app does, plus the pure pieces underneath it.
 *
 * The protocol half exists because both bugs found while building this action were
 * invisible to a unit test: the quota back-fill handed accounts to agent keys, and
 * an agent key's missing pollSeconds turned the shared poll interval into NaN, so
 * setInterval fired as fast as the event loop allowed and rate limited both
 * providers within seconds. Neither is reachable without a real plugin process
 * holding both kinds of action at once.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PLUGIN_DIR = path.join(__dirname, '..', 'com.danielbrooks.aiquota.sdPlugin');
const WebSocket = require(PLUGIN_DIR + '/node_modules/ws');
const agents = require(PLUGIN_DIR + '/bin/agents.js');
const { HerdrLink, encodeCwd } = require(PLUGIN_DIR + '/bin/herdr.js');
const render = require(PLUGIN_DIR + '/bin/render.js');

const NODE = os.homedir() + '/Library/Application Support/com.elgato.StreamDeck/NodeJS/20.20.0/node';
const AGENT = 'com.danielbrooks.aiquota.agent';
const QUOTA = 'com.danielbrooks.aiquota.quota';

let failures = 0;
function ok(cond, label, detail) {
  console.log(`  ${cond ? 'OK  ' : 'FAIL'}: ${label}${detail && !cond ? `  (${detail})` : ''}`);
  if (!cond) failures += 1;
}

/* ------------------------------------------------------------ pure pieces */

function testClassify() {
  console.log('\n=== state machine ===');
  const mid = { lastRole: 'user', endTurn: false };
  const done = { lastRole: 'assistant', endTurn: true };
  const S = 1000;

  ok(agents.classify(mid, 5 * S) === 'working', 'a fresh tool result reads as working');
  ok(agents.classify(done, 5 * S) === 'waiting', 'a finished turn reads as your move');
  // The gap matters as much as the last line: a transcript mid-tool-call still
  // looks busy long after the process writing it has gone.
  ok(agents.classify(mid, 10 * 60 * S) === 'idle', 'a stalled mid-turn ages out of working');
  ok(agents.classify(done, 10 * 60 * S) === 'waiting', 'a finished turn stays your move for the hour');
  ok(agents.classify(done, 3 * 3600 * S) === 'idle', 'past the attention window it is merely idle');
  ok(agents.classify(done, 3 * 24 * 3600 * S) === 'dormant', 'past a day it is dormant');
}

function testTranscript() {
  console.log('\n=== transcript reading ===');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiquota-agents-'));
  const file = path.join(dir, 'session.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', cwd: '/tmp/old', gitBranch: 'old-branch', message: { role: 'user' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Stale title' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Current title' }),
    JSON.stringify({ type: 'user', cwd: '/tmp/new', gitBranch: 'new-branch', version: '2.1.0', message: { role: 'user' } }),
    // A subagent's turn must not decide whether the main thread is waiting.
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', stop_reason: 'end_turn' } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const t = agents.readTranscript(file);
  ok(t.title === 'Current title', 'the newest title wins', t.title);
  ok(t.branch === 'new-branch', 'the newest branch wins', t.branch);
  ok(t.cwd === '/tmp/new', 'the newest cwd wins', t.cwd);
  ok(t.lastRole === 'user', 'a sidechain turn is skipped', t.lastRole);

  // A tail read starts mid-file and its first line is usually a fragment.
  const big = path.join(dir, 'big.jsonl');
  const filler = JSON.stringify({ type: 'attachment', pad: 'x'.repeat(2000) });
  fs.writeFileSync(big, Array(80).fill(filler).join('\n') + '\n' + lines.join('\n') + '\n');
  const t2 = agents.readTranscript(big);
  ok(t2 && t2.title === 'Current title', 'a partial leading line does not derail the parse');

  ok(agents.readTranscript(path.join(dir, 'nope.jsonl')) === null, 'a missing file returns null');
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * A stand-in for the herdr binary. Returns a fixed agent list and records every
 * focus it is asked for, so the jump path can be exercised without moving the
 * real terminal's focus onto whatever the tests happen to pick.
 */
function makeStubHerdr(agentList) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiquota-herdr-'));
  const calls = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, `#!/bin/sh
echo "$@" >> ${JSON.stringify(calls)}
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
${JSON.stringify({ id: 'x', result: { type: 'agent_list', agents: agentList } })}
JSON
  exit 0
fi
exit 0
`);
  fs.chmodSync(bin, 0o755);
  return { dir, bin, calls, read: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '') };
}

function testHerdrMatching() {
  console.log('\n=== herdr matching ===');
  // Claude Code encodes a cwd by replacing every / and . with -. Decoding is
  // ambiguous, so matching has to go in this direction.
  ok(encodeCwd('/Users/daniel/StreamDeck') === '-Users-daniel-StreamDeck',
    'a plain path encodes to a project directory name');
  ok(encodeCwd('/Users/daniel/.herdr/worktrees/repo/fix')
    === '-Users-daniel--herdr-worktrees-repo-fix',
    'a dotted path encodes its dot as a second dash');

  const stub = makeStubHerdr([
    { pane_id: 'w1:p1', workspace_id: 'w1', cwd: '/Users/daniel/StreamDeck', agent_status: 'working',
      terminal_title_stripped: 'Some work', focused: false },
    { pane_id: 'w2:p1', workspace_id: 'w2', cwd: '/Users/daniel/.herdr/worktrees/repo/fix',
      agent_status: 'blocked', terminal_title_stripped: 'Blocked one', focused: true },
    // Missing a pane id: must be skipped rather than indexed as undefined.
    { cwd: '/Users/daniel/nope', agent_status: 'idle' },
  ]);
  process.env.AIQUOTA_HERDR_BIN = stub.bin;
  const link = new HerdrLink();
  ok(link.available, 'the stub binary is discovered through the override');

  return link.refresh().then(async () => {
    ok(link.count === 2, 'agents without a pane id are skipped', `count=${link.count}`);
    ok(link.get('-Users-daniel-StreamDeck').paneId === 'w1:p1', 'a session matches its pane');
    ok(link.get('-Users-daniel--herdr-worktrees-repo-fix').status === 'blocked',
      'the live status comes through');
    ok(link.get('-Users-daniel-nowhere') === null, 'an unknown project matches nothing');

    // herdr's view of a pane beats anything inferred from file timestamps.
    const old = 30 * 60 * 1000;
    ok(agents.classify({ lastRole: 'assistant', endTurn: true }, old, 'working') === 'working',
      'herdr working overrides a stale transcript');
    ok(agents.classify({ lastRole: 'user' }, 1000, 'blocked') === 'blocked',
      'blocked wins over everything');
    ok(agents.classify({ lastRole: 'user' }, 1000, 'idle') === 'waiting',
      'herdr idle means ready for you');
    // ...but a pane parked at a prompt for a week is not news.
    ok(agents.classify({ lastRole: 'user' }, 3 * 24 * 3600 * 1000, 'idle') === 'dormant',
      'age still retires a long-parked pane');
    ok(agents.classify({ lastRole: 'user' }, 1000, 'unknown') === 'working',
      'an unclassifiable agent falls back to the transcript');

    ok(link.get('-Users-daniel--herdr-worktrees-repo-fix').workspaceId === 'w2',
      'the workspace id is carried alongside the pane');

    const r = await link.focus('w2:p1', 'w2');
    ok(r.ok, 'focus reports success');
    ok(/agent focus w2:p1/.test(stub.read()), 'focus selects the pane', stub.read().trim());
    // The bug this guards: `agent focus` alone re-titles the window and reports
    // success, but the TUI keeps rendering whatever workspace it was already on.
    // Only `workspace focus` moves the view.
    ok(/workspace focus w2/.test(stub.read()),
      'focus also switches the workspace, which is what actually moves the view',
      stub.read().trim());
    ok(r.switched === true, 'the result says the view was switched');

    delete process.env.AIQUOTA_HERDR_BIN;
    fs.rmSync(stub.dir, { recursive: true, force: true });

    process.env.AIQUOTA_HERDR_BIN = path.join(os.tmpdir(), 'definitely-not-here');
    const missing = new HerdrLink();
    // The override is ignored when it is not executable, so this only proves the
    // constructor survives; a machine without herdr is covered by `available`.
    ok(typeof missing.available === 'boolean', 'a missing binary does not throw');
    delete process.env.AIQUOTA_HERDR_BIN;
  });
}

function testRendering() {
  console.log('\n=== rendering ===');
  const base = { state: 'working', account: 'work', label: 'x', ageMs: 1000, sessions: 1 };
  for (const state of ['working', 'waiting', 'idle', 'dormant']) {
    const svg = decodeURIComponent(render.renderAgent({ ...base, state }, {})
      .replace(/^data:image\/svg\+xml;charset=utf8,/, ''));
    ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), `${state} renders a closed svg`);
  }
  const blocked = decodeURIComponent(render.renderAgent({ ...base, state: 'blocked' }, {}));
  ok(/BLOCKED/.test(blocked), 'a blocked agent says so');
  ok(blocked.includes('#f87171'), 'blocked is drawn in the red reserved for it');

  // The left edge is the affordance that says pressing will take you somewhere.
  const linkedKey = decodeURIComponent(render.renderAgent({ ...base, pane: 'w1:p1' }, {}));
  const looseKey = decodeURIComponent(render.renderAgent({ ...base, pane: null }, {}));
  const edge = (svg) => /<rect x="0" y="5" width="3"/.test(svg);
  ok(edge(linkedKey), 'a key with a pane is marked as jumpable');
  ok(!edge(looseKey), 'a key with no pane is not');
  ok(/w1:p1/.test(decodeURIComponent(
    render.renderAgent({ ...base, pane: 'w1:p1' }, { viewIndex: 1 }))),
    'the detail view names the pane it would jump to');

  ok(/no Claude session/.test(decodeURIComponent(render.renderAgent(null, {}))),
    'an unbound key says so rather than drawing nothing');
  ok(/AGENTS/.test(decodeURIComponent(render.renderAgent(null, { mode: 'summary' }, { counts: {}, total: 0 }))),
    'the summary key renders without any sessions');

  // A branch name is one long token; truncating it loses the half that identifies it.
  const long = decodeURIComponent(render.renderAgent(
    { ...base, label: 'deduplicate-seed-retry' }, {}));
  ok(long.includes('deduplicate-') && long.includes('retry'),
    'a hyphenated label wraps instead of truncating');

  // The account has to be readable at arm's length and must not be mistakable for
  // a state: a green WORK chip beside a green WORKING bar reads as one fact twice.
  const STATE_GREEN = '#4ade80';
  const STATE_AMBER = '#fbbf24';
  const chipOf = (account) => decodeURIComponent(render.renderAgent(
    { ...base, account }, {}));
  const mainKey = chipOf('main');
  const workKey = chipOf('work');
  ok(/MAIN/.test(mainKey) && /WORK/.test(workKey), 'the account is named on the key');
  // Only the chip's own text fill. The footer age deliberately carries the state
  // colour, so anything broader than this matches it and fails for the wrong reason.
  const chipFill = (svg, word) => {
    const m = svg.match(new RegExp(`<text[^>]*fill="(#[0-9a-f]{6})"[^>]*>${word}</text>`, 'i'));
    return m ? m[1].toLowerCase() : null;
  };
  const workFill = chipFill(workKey, 'WORK');
  const mainFill = chipFill(mainKey, 'MAIN');
  ok(workFill && mainFill, 'the chip text carries an explicit colour',
    `work=${workFill} main=${mainFill}`);
  ok(workFill !== STATE_GREEN.toLowerCase() && workFill !== STATE_AMBER.toLowerCase()
    && mainFill !== STATE_GREEN.toLowerCase() && mainFill !== STATE_AMBER.toLowerCase(),
    'the account chip avoids the colours that mean a state');
  ok(workFill !== mainFill, 'two accounts are told apart by colour, not only by text');
  ok(/UNKNOWNACC|UNKNOWN/.test(chipOf('unknownacct')),
    'an account beyond main and work still gets a chip');

  // Markup in a title must not reach the SVG intact.
  const nasty = decodeURIComponent(render.renderAgent(
    { ...base, label: '<script>alert(1)</script>' }, {}));
  ok(!nasty.includes('<script>'), 'a title containing markup is escaped');
}

/* -------------------------------------------------------------- protocol */

function testPlugin() {
  return new Promise((resolve) => {
    console.log('\n=== plugin protocol ===');
    const INFO = {
      application: { platform: 'mac', version: '7.5.1.22901' },
      colors: {}, devicePixelRatio: 2,
      devices: [{ id: 'dev-plus', name: 'Stream Deck +', size: { columns: 4, rows: 2 }, type: 7 }],
      plugin: { uuid: 'com.danielbrooks.aiquota', version: '1.1.0.0' },
    };

    // Real cwds, so keys actually match panes, but every call lands on the stub.
    // Nothing in this test can move the real terminal's focus.
    let live = [];
    try {
      live = JSON.parse(require('node:child_process').execFileSync(
        os.homedir() + '/.local/bin/herdr', ['agent', 'list'],
        { env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' }, timeout: 4000 },
      ).toString()).result.agents;
    } catch { /* herdr not running: the jump assertions below are skipped */ }
    const stub = makeStubHerdr(live);

    const images = new Map();     // context -> latest setImage uri
    const feedbacks = new Set();  // contexts that received setFeedback
    const saved = new Map();      // context -> latest setSettings payload
    const logs = [];
    let sock = null;
    let child = null;

    // The real profile shape: agent keys on the keypad, quota on the dials.
    const AGENT_KEYS = [
      { ctx: 'a0', column: 0, row: 0 },
      { ctx: 'a1', column: 1, row: 0 },
      { ctx: 'a2', column: 2, row: 0 },
      { ctx: 'a3', column: 0, row: 1 },
    ];
    const SUMMARY = { ctx: 'asum', column: 3, row: 1 };

    const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 }, () => {
      const port = server.address().port;
      child = spawn(NODE, [PLUGIN_DIR + '/bin/plugin.js',
        '-port', String(port), '-pluginUUID', 'test-uuid',
        '-registerEvent', 'registerPlugin', '-info', JSON.stringify(INFO)],
        { cwd: PLUGIN_DIR,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, AIQUOTA_HERDR_BIN: stub.bin, AIQUOTA_NO_RAISE: '1' } });
      child.stderr.on('data', (d) => process.stdout.write('  plugin!> ' + d));
    });

    const send = (m) => { if (sock && sock.readyState === 1) sock.send(JSON.stringify(m)); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    server.on('connection', (ws) => {
      sock = ws;
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.event === 'setImage') images.set(m.context, m.payload.image);
        else if (m.event === 'setFeedback') feedbacks.add(m.context);
        else if (m.event === 'setSettings') saved.set(m.context, m.payload);
        else if (m.event === 'logMessage') logs.push(m.payload.message);
        else if (m.event === 'registerPlugin') {
          for (const k of [...AGENT_KEYS, SUMMARY]) {
            send({
              event: 'willAppear', action: AGENT, context: k.ctx, device: 'dev-plus',
              payload: {
                settings: k === SUMMARY ? { mode: 'summary' } : {},
                coordinates: { column: k.column, row: k.row },
                controller: 'Keypad', isInMultiAction: false,
              },
            });
          }
          // One quota dial alongside them: the two kinds must not interfere.
          send({
            event: 'willAppear', action: QUOTA, context: 'q0', device: 'dev-plus',
            payload: { settings: {}, coordinates: { column: 0, row: 0 }, controller: 'Encoder', isInMultiAction: false },
          });
          run();
        }
      });
    });

    async function run() {
      await sleep(2500);

      const painted = AGENT_KEYS.filter((k) => images.has(k.ctx)).length;
      ok(painted === AGENT_KEYS.length, `every agent key painted (${painted}/${AGENT_KEYS.length})`);
      ok(images.has(SUMMARY.ctx), 'the summary key painted');
      ok(!AGENT_KEYS.some((k) => feedbacks.has(k.ctx)),
        'agent keys draw with setImage, never the encoder canvas');

      // The back-fill that hands accounts to quota segments must not touch these.
      const polluted = [...AGENT_KEYS, SUMMARY]
        .filter((k) => saved.get(k.ctx) && saved.get(k.ctx).sourceId);
      ok(polluted.length === 0, 'no agent key was assigned a quota account',
        polluted.map((k) => k.ctx).join(','));

      // With a sane interval there is no timer poll at all this early; with the
      // NaN interval there were seven in eight seconds.
      const timerPolls = logs.filter((l) => /poll \(timer\)/.test(l)).length;
      ok(timerPolls === 0, 'the shared poll interval stayed sane', `${timerPolls} timer polls`);

      // Unbound keys share out distinct sessions rather than all showing the newest.
      const bodies = AGENT_KEYS.map((k) => decodeURIComponent(images.get(k.ctx) || ''));
      const distinct = new Set(bodies).size;
      ok(distinct === bodies.length || distinct >= Math.min(3, bodies.length),
        `unbound keys took different slots (${distinct} distinct of ${bodies.length})`);

      ok(/AGENTS/.test(decodeURIComponent(images.get(SUMMARY.ctx) || '')),
        'the summary key drew the roll-up, not a session');

      // A quick press jumps; a held press cycles the view. Both arrive as the same
      // pair of events and are told apart only by how long they are held.
      const tap = (ctx, holdMs, coords) => {
        send({ event: 'keyDown', action: AGENT, context: ctx, device: 'dev-plus', payload: { settings: {}, coordinates: coords } });
        return sleep(holdMs).then(() => send({
          event: 'keyUp', action: AGENT, context: ctx, device: 'dev-plus', payload: { settings: {}, coordinates: coords },
        }));
      };

      if (live.length) {
        const beforeCalls = stub.read();
        await tap('a0', 80, { column: 0, row: 0 });
        await sleep(900);
        const added = stub.read().slice(beforeCalls.length);
        ok(/agent focus \w+:\w+/.test(added), 'a quick press selects the pane', added.trim());
        ok(/workspace focus \w+/.test(added),
          'a quick press switches the workspace too', added.trim());
      } else {
        console.log('  SKIP: herdr is not running, so the jump path cannot be checked');
      }

      // Held: cycles the view and must not jump.
      const beforeHold = stub.read();
      const beforeImg = images.get('a0');
      await tap('a0', 800, { column: 0, row: 0 });
      await sleep(500);
      const afterImg = decodeURIComponent(images.get('a0') || '');
      ok(images.get('a0') !== beforeImg && /WHERE|nothing bound/.test(afterImg),
        'holding cycles the view');
      ok(!/agent focus/.test(stub.read().slice(beforeHold.length)),
        'holding does not jump');

      // The summary key has no views to cycle, so holding it must change nothing.
      // Tapping it jumps to whichever agent is most stuck.
      const sumBefore = images.get(SUMMARY.ctx);
      const sumCalls = stub.read();
      await tap(SUMMARY.ctx, 800, { column: 3, row: 1 });
      await sleep(400);
      ok(images.get(SUMMARY.ctx) === sumBefore, 'holding the summary key changes nothing');

      if (live.length) {
        await tap(SUMMARY.ctx, 80, { column: 3, row: 1 });
        await sleep(900);
        ok(/agent focus \w+:\w+/.test(stub.read().slice(sumCalls.length)),
          'tapping the summary key jumps to the most urgent agent');
      }

      // Nothing here should ever be able to carry a token.
      const all = [...images.values()].join(' ') + logs.join(' ');
      ok(!/sk-ant|Bearer\s|eyJ[A-Za-z0-9_-]{10}/.test(all), 'nothing token-shaped was emitted');

      try { child.kill(); } catch { /* already gone */ }
      try { fs.rmSync(stub.dir, { recursive: true, force: true }); } catch { /* fine */ }
      server.close();
      resolve();
    }
  });
}

/* ------------------------------------------------------------------ main */

(async () => {
  testClassify();
  testTranscript();
  await testHerdrMatching();
  testRendering();
  await testPlugin();

  console.log(`\nRESULT: ${failures ? `FAIL (${failures})` : 'PASS'}`);
  process.exit(failures ? 1 : 0);
})();
