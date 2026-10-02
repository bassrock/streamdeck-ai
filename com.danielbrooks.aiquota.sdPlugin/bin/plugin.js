'use strict';
/**
 * plugin.js — entry point. Owns the Stream Deck connection, the set of visible
 * actions, and the two timers that drive polling and repainting.
 *
 * One shared poll timer serves every visible action. Sources are deduplicated, so
 * three segments showing three different accounts cost three requests per cycle,
 * and three segments showing the same account cost one.
 */

const fs = require('node:fs');
const path = require('node:path');
const { StreamDeck, parseArgs } = require('./streamdeck.js');
const { Registry, redact } = require('./sources.js');
const { SessionRegistry } = require('./agents.js');
const { HerdrLink } = require('./herdr.js');
const render = require('./render.js');

const ACTION_UUID = 'com.danielbrooks.aiquota.quota';
const AGENT_UUID = 'com.danielbrooks.aiquota.agent';
const LAYOUT = 'layouts/quota.json';

const MIN_POLL_MS = 60 * 1000;
const DEFAULT_POLL_MS = 180 * 1000;
const REPAINT_MS = 10 * 1000;

/**
 * Agent keys are on their own clock. A quota poll is an HTTPS request against a
 * rate-limited endpoint measured in hours, so it runs every few minutes; a session
 * scan is a few stats and a bounded tail read off the local disk, so it can run
 * often enough that "working" actually means working.
 */
const SCAN_MS = 4 * 1000;

/**
 * Held longer than this and a press means "show me the other view" instead of
 * "take me there". Jumping is the common case, so it gets the short press.
 */
const LONG_PRESS_MS = 550;

const args = parseArgs();
const sd = new StreamDeck(args);
const registry = new Registry();
const sessions = new SessionRegistry();
const herdr = new HerdrLink();

/** context -> { context, controller, settings, device } */
const actions = new Map();

let pollTimer = null;
let repaintTimer = null;
let pollInFlight = false;
let pollQueued = false;
let backfillTimer = null;
let currentIntervalMs = 0;
let rotateSaveTimer = null;
let scanTimer = null;
let lastAgentLine = '';
let agentScanTimer = null;
let scanInFlight = false;
/** context -> ms, so keyUp can tell a tap from a hold. */
const pressedAt = new Map();

/** One character per state, so a whole row of keys fits in a 200-character log line. */
const STATE_LETTER = { working: 'w', waiting: '!', blocked: 'b', idle: 'i', dormant: '.' };

/* ------------------------------------------------------------------ logging */

const LOG_FILE = path.join(__dirname, '..', 'logs', 'aiquota.log');
const LOG_MAX_BYTES = 256 * 1024;

/**
 * The app does not surface a plugin's own logMessage output anywhere readable, so
 * keep a small file of our own. Every line is redacted first: this is on disk, and
 * the whole point of the redaction contract is that no token reaches it.
 */
function writeLogFile(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    // Cheap rotation: start over rather than grow without bound.
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.rmSync(LOG_FILE);
    } catch { /* no file yet */ }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never break the plugin */ }
}

function log(...parts) {
  // Redact here so a stray error string cannot leak a token, rather than trusting
  // every call site to have thought about it.
  const line = redact(parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' '));
  try {
    sd.log(`[aiquota] ${line}`);
  } catch { /* the socket may not be up yet */ }
  console.log(`[aiquota] ${line}`);
  writeLogFile(line);
}

/* ------------------------------------------------------------- source choice */

/**
 * The quota actions only. Every helper below this line is quota-specific, and an
 * agent key carries none of the settings they read.
 */
function quotaActions() {
  return [...actions.values()].filter((e) => e.kind !== 'agent');
}

/** A real, finite number. `Number(null)` is 0, so coercion is not good enough. */
function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function normaliseSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const warn = clamp(Math.round(num(s.warnThreshold, render.DEFAULT_THRESHOLDS.warn)), 1, 100);
  const crit = clamp(Math.round(num(s.critThreshold, render.DEFAULT_THRESHOLDS.crit)), 1, 100);
  return {
    sourceId: typeof s.sourceId === 'string' ? s.sourceId : null,
    customLabel: typeof s.customLabel === 'string' && s.customLabel.trim() ? s.customLabel.trim() : null,
    viewIndex: Math.max(0, Math.round(num(s.viewIndex, 0))),
    // Remaining by default; the thresholds below stay expressed as percent used.
    showRemaining: s.showRemaining !== false,
    warnThreshold: warn,
    // Amber must sit at or below red, whatever the stored values say.
    critThreshold: Math.max(warn, crit),
    pollSeconds: clamp(
      Math.round(num(s.pollSeconds, DEFAULT_POLL_MS / 1000)),
      MIN_POLL_MS / 1000,
      3600
    ),
  };
}

/**
 * Agent keys carry far less than quota segments: which session to follow, and
 * which of its views to show. Everything else is read off disk each scan.
 */
function normaliseAgentSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    sessionId: typeof s.sessionId === 'string' && s.sessionId ? s.sessionId : null,
    customLabel: typeof s.customLabel === 'string' && s.customLabel.trim() ? s.customLabel.trim() : null,
    mode: s.mode === 'summary' ? 'summary' : 'session',
    viewIndex: Math.max(0, Math.round(num(s.viewIndex, 0))),
  };
}

/**
 * Where this key sits among the agent keys, in reading order.
 *
 * An unbound key follows the nth most recently active session, so dropping the
 * action onto eight keys fills them with your eight most recent pieces of work
 * and reorders itself as you move between them. Binding one in the property
 * inspector opts that key out and pins it to a project.
 */
function agentSlotIndex(target) {
  const ordered = [...actions.values()]
    // Only keys that are actually following the recent list take a slot. A pinned
    // key or a summary key sitting in the middle of the row must not push the
    // keys after it onto different sessions.
    .filter((e) => e.kind === 'agent' && e.settings.mode !== 'summary' && !e.settings.sessionId)
    .sort((a, b) => (a.coords.row - b.coords.row) || (a.coords.column - b.coords.column));
  const i = ordered.indexOf(target);
  return i === -1 ? 0 : i;
}

/** The session a key should draw: its pinned one, or its slot in the recent list. */
function sessionFor(entry) {
  if (entry.settings.sessionId) return sessions.get(entry.settings.sessionId);
  return sessions.nth(agentSlotIndex(entry));
}

/**
 * Waits for the current burst of willAppear events to finish before assigning.
 * The app does not deliver them in coordinate order, so assigning immediately
 * would hand out accounts in whatever order the events happened to arrive.
 */
function scheduleBackfill() {
  if (backfillTimer) clearTimeout(backfillTimer);
  backfillTimer = setTimeout(() => {
    backfillTimer = null;
    backfillSources();
  }, 400);
  if (backfillTimer.unref) backfillTimer.unref();
}

/**
 * Assigns a distinct source to every action that has none, in screen order.
 * Runs after discovery and whenever an action appears, because willAppear can
 * arrive before discovery has finished and would otherwise find an empty list.
 */
function backfillSources() {
  const all = registry.list();
  if (!all.length) return;

  const taken = new Set();
  for (const entry of quotaActions()) {
    if (entry.settings.sourceId) taken.add(entry.settings.sourceId);
  }
  const unassigned = quotaActions()
    .filter((e) => !e.settings.sourceId)
    .sort((a, b) => (a.coords.row - b.coords.row) || (a.coords.column - b.coords.column));
  if (!unassigned.length) return;

  for (const entry of unassigned) {
    // Prefer a source nobody is showing yet; fall back to the first once they run out.
    const pick = all.find((a) => !taken.has(a.id)) || all[0];
    if (!pick) break;
    taken.add(pick.id);
    entry.settings.sourceId = pick.id;
    sd.setSettings(entry.context, entry.settings);
    log(`auto-assigned ${pick.id} to the ${entry.controller} at ${entry.coords.column},${entry.coords.row}`);
    paint(entry.context);
  }
}

function pollIntervalMs() {
  let ms = DEFAULT_POLL_MS;
  for (const entry of quotaActions()) {
    const secs = num(entry.settings.pollSeconds, DEFAULT_POLL_MS / 1000);
    ms = Math.min(ms, secs * 1000);
  }
  // A NaN here would reach setInterval and make it fire as fast as the event loop
  // allows, which rate limits both providers within seconds.
  if (!Number.isFinite(ms)) ms = DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, ms);
}

/* ----------------------------------------------------------------- painting */

function paint(context) {
  const entry = actions.get(context);
  if (!entry) return;
  if (entry.kind === 'agent') return paintAgent(entry);
  const { settings } = entry;
  const cacheEntry = settings.sourceId ? registry.get(settings.sourceId) : null;

  // A configured source that discovery has not seen: say so rather than draw nothing.
  const readable = cacheEntry || (settings.sourceId
    ? { account: { kind: settings.sourceId.startsWith('codex') ? 'codex' : 'claude', label: settings.sourceId }, data: null, fetchedAt: 0, ok: false, error: 'account not found on this Mac' }
    : { account: { kind: 'none', label: null }, data: null, fetchedAt: 0, ok: false, error: 'pick an account in settings' });

  try {
    if (entry.controller === 'Encoder') {
      sd.setFeedback(context, { 'full-canvas': render.renderStrip(readable, settings) });
    } else {
      sd.setImage(context, render.renderKey(readable, settings));
    }
  } catch (e) {
    log('paint failed:', e.message);
  }
}

function paintAgent(entry) {
  try {
    const session = entry.settings.mode === 'summary' ? null : sessionFor(entry);
    sd.setImage(entry.context, render.renderAgent(session, entry.settings, {
      counts: sessions.counts(),
      total: sessions.list().length,
    }));
  } catch (e) {
    log('agent paint failed:', e.message);
  }
}

function paintAll() {
  for (const context of actions.keys()) paint(context);
}

/**
 * Coalesces a burst of key events into one scan.
 *
 * The app delivers willAppear one key at a time, and every agent key's slot
 * depends on how many others are present, so acting on each event in turn
 * rescans and repaints the whole row once per key for no benefit.
 */
function scheduleAgentScan(reason) {
  if (agentScanTimer) clearTimeout(agentScanTimer);
  agentScanTimer = setTimeout(() => {
    agentScanTimer = null;
    scanAgents(reason);
  }, 250);
  if (agentScanTimer.unref) agentScanTimer.unref();
}

/** True when any agent key is on screen, so the scan timer can stay idle otherwise. */
function haveAgentKeys() {
  for (const e of actions.values()) if (e.kind === 'agent') return true;
  return false;
}

/**
 * Rescans the transcripts and repaints the agent keys.
 *
 * Nothing here can fail in a way worth reporting on a key: a scan either finds
 * files or it does not, and a session that has gone away simply stops being in
 * the list. So unlike the quota poll there is no error state to render.
 */
async function scanAgents(reason) {
  if (!haveAgentKeys()) return;
  // Overlapping scans would spawn herdr twice and paint the same keys twice.
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    // Pane ids and live status come from herdr; a failure here is not fatal, it
    // just means the keys fall back to what the transcripts alone can tell us.
    await herdr.refresh();
    sessions.scan(herdr);
  } catch (e) {
    log(`agent scan (${reason}) failed:`, e.message);
    return;
  } finally {
    scanInFlight = false;
  }

  const shown = [];
  for (const e of actions.values()) {
    if (e.kind !== 'agent') continue;
    paintAgent(e);
    const at = `${e.coords.column},${e.coords.row}`;
    if (e.settings.mode === 'summary') {
      shown.push(`${at}=sum`);
      continue;
    }
    const session = sessionFor(e);
    // Terse on purpose: redact() truncates every log line to 200 characters, and a
    // full eight-key row spelling out each state and title ran to about 280, so the
    // last two keys were silently cut off exactly when the row was most worth
    // reading. One letter per state keeps a full row inside the budget.
    shown.push(`${at}=` + (session
      ? `${STATE_LETTER[session.state] || '?'}:${session.label.slice(0, 11)}`
      : '-'));
  }

  // A scan runs every few seconds, so logging each one would bury everything else.
  // Only a change in what the keys are actually showing is worth a line.
  const line = shown.sort().join('  ');
  if (line === lastAgentLine) return;
  lastAgentLine = line;
  log(`agents (${reason}):`, line);
}

/* ------------------------------------------------------------------ polling */

/** Source ids every visible action currently wants. */
function wantedSources() {
  return [...new Set(quotaActions().map((e) => e.settings.sourceId).filter(Boolean))];
}

async function poll(reason, only) {
  // Requests arriving mid-poll are remembered, not thrown away. At startup the
  // first willAppear fires a poll while only one action is registered, so the
  // poll in flight covers one account and the other two would otherwise be
  // dropped and left blank until the next interval.
  if (pollInFlight) {
    pollQueued = true;
    return;
  }
  pollInFlight = true;
  const all = wantedSources();
  const wanted = only ? all.filter((id) => only.includes(id)) : all;
  // An empty list means "everything the registry knows about", so record what
  // that actually covered. Otherwise the follow-up below sees nothing as covered
  // and repeats the whole fetch, doubling requests for no reason.
  const covered = wanted.length ? wanted : registry.list().map((a) => a.id);
  try {
    await registry.refresh(wanted.length ? wanted : undefined);
  } catch (e) {
    log(`poll (${reason}) failed:`, e.message);
  } finally {
    pollInFlight = false;
    // Always repaint: even a failed poll has news, such as why it failed.
    paintAll();
    // One line per cycle, so a later look at the log shows what each account did.
    const summary = (wanted.length ? wanted : covered).map((id) => {
      const e = registry.get(id);
      if (!e) return `${id}=?`;
      if (e.ok && e.data) {
        const five = e.data.fiveHour && e.data.fiveHour.percent;
        const seven = e.data.sevenDay && e.data.sevenDay.percent;
        return `${id}=used ${five}/${seven}`;
      }
      return `${id}=${e.error || 'no reading'}`;
    }).join('  ');
    log(`poll (${reason}):`, summary);
  }

  if (!pollQueued) return;
  pollQueued = false;
  // Chase only what the finished poll did not already cover or could not read,
  // so a burst of requests does not turn into a burst of HTTP calls.
  const missing = wantedSources().filter((id) => {
    if (!covered.includes(id)) return true;
    const entry = registry.get(id);
    return !entry || !entry.data;
  });
  if (missing.length) await poll('queued', missing);
}

function restartTimers() {
  const interval = pollIntervalMs();
  // Leave a running schedule alone unless the interval really changed, so UI
  // churn cannot keep pushing the next poll further away.
  if (pollTimer && interval === currentIntervalMs) return;
  currentIntervalMs = interval;
  if (pollTimer) clearInterval(pollTimer);
  if (repaintTimer) clearInterval(repaintTimer);
  // A little jitter so several segments never line up into a burst.
  const jitter = Math.floor(Math.random() * 3000);
  pollTimer = setInterval(() => poll('timer'), interval + jitter);
  // Repaint on its own cadence so the countdown text stays honest between polls.
  repaintTimer = setInterval(paintAll, REPAINT_MS);
  if (pollTimer.unref) pollTimer.unref();
  if (repaintTimer.unref) repaintTimer.unref();
}

/** Runs only while an agent key is on screen; a profile without one costs nothing. */
function restartScanTimer() {
  const wanted = haveAgentKeys();
  if (wanted === !!scanTimer) return;
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (!wanted) return;
  scanTimer = setInterval(() => scanAgents('timer'), SCAN_MS);
  if (scanTimer.unref) scanTimer.unref();
}

/* ---------------------------------------------------------------- jumping */

/**
 * Takes you to the pane this key is following.
 *
 * Focus only ever moves from a keypress. Nothing on a timer or a scan touches it,
 * because a window that raises itself while you are typing somewhere else is worse
 * than no shortcut at all.
 */
async function jumpTo(entry) {
  const session = entry.settings.mode === 'summary' ? mostUrgentSession() : sessionFor(entry);
  if (!session || !session.pane) {
    // Nothing to jump to: a historical session, or herdr is not running.
    sd.showAlert(entry.context);
    if (!herdr.available) log('jump: herdr is not installed');
    else if (session) log(`jump: ${session.label.slice(0, 30)} has no herdr pane`);
    return;
  }
  const result = await herdr.focus(session.pane, session.workspace);
  if (!result.ok) {
    sd.showAlert(entry.context);
    log(`jump to ${session.pane} failed:`, result.error || 'unknown');
    return;
  }
  sd.showOk(entry.context);
  const caveats = [
    result.switched === false ? 'view did not switch' : null,
    result.raised === false ? 'window did not come forward' : null,
  ].filter(Boolean);
  log(`jumped to ${session.workspace || session.pane}`
    + (caveats.length ? ` (${caveats.join('; ')})` : '') + ':',
    session.label.slice(0, 30));
}

/**
 * What the summary key jumps to: the agent most likely to be waiting on you.
 * Blocked outranks a finished turn, which outranks work still in progress.
 */
function mostUrgentSession() {
  const rank = { blocked: 0, waiting: 1, working: 2 };
  return sessions.list()
    .filter((s) => s.pane && rank[s.state] !== undefined)
    .sort((a, b) => (rank[a.state] - rank[b.state]) || (a.ageMs - b.ageMs))[0] || null;
}

/* ------------------------------------------------------------ view cycling */

function cycleView(context, delta, { debounceSave = false } = {}) {
  const entry = actions.get(context);
  if (!entry) return;
  let count;
  if (entry.kind === 'agent') {
    // A summary key has nothing to cycle through.
    if (entry.settings.mode === 'summary') return;
    count = render.AGENT_VIEWS.length;
  } else {
    const cacheEntry = entry.settings.sourceId ? registry.get(entry.settings.sourceId) : null;
    count = Math.max(1, render.availableViews(render.toState(cacheEntry || {}, entry.settings)).length);
  }
  const next = ((entry.settings.viewIndex + delta) % count + count) % count;
  entry.settings.viewIndex = next;
  paint(context);

  // Each setSettings makes the app rewrite the profile on disk. A fast dial spin
  // would be dozens of writes, so coalesce those into one.
  if (!debounceSave) {
    sd.setSettings(context, entry.settings);
    return;
  }
  if (rotateSaveTimer) clearTimeout(rotateSaveTimer);
  rotateSaveTimer = setTimeout(() => {
    rotateSaveTimer = null;
    const live = actions.get(context);
    if (live) sd.setSettings(context, live.settings);
  }, 600);
  if (rotateSaveTimer.unref) rotateSaveTimer.unref();
}

/* ------------------------------------------------------- property inspector */

function sendSourcesTo(context) {
  const entry = actions.get(context);
  const sources = registry.list().map((a) => ({
    id: a.id,
    kind: a.kind,
    label: a.label,
    email: a.email,
    org: a.org,
  }));
  sd.sendToPropertyInspector(context, {
    event: 'sources',
    sources,
    settings: entry ? entry.settings : null,
  });
}

function sendSessionsTo(context) {
  const entry = actions.get(context);
  sd.sendToPropertyInspector(context, {
    event: 'sessions',
    sessions: sessions.list().map((x) => ({
      id: x.id,
      label: x.label,
      account: x.account,
      branch: x.branch,
      state: x.state,
      ageMs: x.ageMs,
      pane: x.pane,
    })),
    settings: entry ? entry.settings : null,
  });
}

/* -------------------------------------------------------------- event wiring */

sd.on('open', async () => {
  log(`connected; ${(args.info.devices || []).length} device(s)`);
  try {
    const found = await registry.discover();
    log(`discovered ${found.length} source(s): ${found.map((a) => a.id).join(', ')}`);
  } catch (e) {
    log('discovery failed:', e.message);
  }
  scheduleBackfill();
  log(herdr.available
    ? `herdr found at ${herdr.bin}; agent keys can jump to a pane`
    : 'herdr not installed; agent keys will show status but cannot jump');
  scanAgents('startup');
  paintAll();
  restartTimers();
  restartScanTimer();
  await poll('startup');
});

sd.on('willAppear', (msg) => {
  const { context, payload = {} } = msg;
  const controller = payload.controller === 'Encoder' ? 'Encoder' : 'Keypad';
  const coords = payload.coordinates || { column: 0, row: 0 };

  if (msg.action === AGENT_UUID) {
    actions.set(context, {
      context, controller, coords, device: msg.device,
      kind: 'agent',
      settings: normaliseAgentSettings(payload.settings),
    });
    // Slot order changed, so every unbound agent key may now want a different
    // session, not just this one.
    scheduleAgentScan('willAppear');
    restartScanTimer();
    return;
  }
  if (msg.action && msg.action !== ACTION_UUID) return;

  const settings = normaliseSettings(payload.settings);
  actions.set(context, {
    context, controller, settings, device: msg.device, coords, kind: 'quota',
  });

  if (!settings.sourceId) scheduleBackfill();

  if (controller === 'Encoder') sd.setFeedbackLayout(context, LAYOUT);
  paint(context);
  restartTimers();

  // A freshly placed action should not sit blank until the next cycle.
  const cached = settings.sourceId ? registry.get(settings.sourceId) : null;
  if (!cached || !cached.data) poll('willAppear');
});

sd.on('willDisappear', (msg) => {
  const gone = actions.get(msg.context);
  actions.delete(msg.context);
  restartTimers();
  restartScanTimer();
  // The keys after it in reading order have all shifted up a slot.
  pressedAt.delete(msg.context);
  if (gone && gone.kind === 'agent') scheduleAgentScan('willDisappear');
});

sd.on('didReceiveSettings', (msg) => {
  const entry = actions.get(msg.context);
  if (!entry) return;
  if (entry.kind === 'agent') {
    const before = entry.settings.sessionId;
    entry.settings = normaliseAgentSettings(msg.payload && msg.payload.settings);
    if (entry.settings.sessionId !== before) entry.settings.viewIndex = 0;
    // Pinning or unpinning one key reshuffles which slot the unbound ones take.
    scheduleAgentScan('settings changed');
    return;
  }
  const previous = entry.settings.sourceId;
  entry.settings = normaliseSettings(msg.payload && msg.payload.settings);
  if (entry.settings.sourceId !== previous) entry.settings.viewIndex = 0;
  paint(msg.context);
  restartTimers();
  // A settings message can carry an older, empty object and clear a source that
  // back-fill had just assigned. Fill it back in rather than leave it blank.
  if (!entry.settings.sourceId) scheduleBackfill();
  else if (entry.settings.sourceId !== previous) poll('settings changed');
});

sd.on('dialDown', (msg) => cycleView(msg.context, 1));

sd.on('keyDown', (msg) => {
  const entry = actions.get(msg.context);
  // An agent key acts on release, because what it does depends on how long it was
  // held. A quota key has only one behaviour and can act immediately.
  if (entry && entry.kind === 'agent') {
    pressedAt.set(msg.context, Date.now());
    return;
  }
  cycleView(msg.context, 1);
});

sd.on('keyUp', (msg) => {
  const entry = actions.get(msg.context);
  if (!entry || entry.kind !== 'agent') return;
  const started = pressedAt.get(msg.context);
  pressedAt.delete(msg.context);
  // A missing keyDown means the press began before this action was registered;
  // treat that as a tap rather than swallowing it.
  const held = started ? Date.now() - started : 0;
  if (held >= LONG_PRESS_MS) {
    cycleView(msg.context, 1);
    return;
  }
  jumpTo(entry).catch((e) => log('jump threw:', e && e.message ? e.message : String(e)));
});

sd.on('dialRotate', (msg) => {
  const ticks = msg.payload && Number(msg.payload.ticks);
  cycleView(msg.context, ticks > 0 ? 1 : ticks < 0 ? -1 : 0, { debounceSave: true });
});

sd.on('touchTap', (msg) => {
  if (msg.payload && msg.payload.hold) {
    sd.showOk(msg.context);
    poll('long touch');
  } else {
    cycleView(msg.context, 1);
  }
});

sd.on('propertyInspectorDidAppear', (msg) => {
  const entry = actions.get(msg.context);
  if (entry && entry.kind === 'agent') {
    // Through scanAgents, so the herdr index is refreshed too. Scanning without it
    // would clear every pane id and unlink the keys until the next timer tick.
    scanAgents('inspector').then(() => sendSessionsTo(msg.context));
    return;
  }
  sendSourcesTo(msg.context);
});

sd.on('sendToPlugin', (msg) => {
  const p = msg.payload || {};
  if (p.event === 'getSources') sendSourcesTo(msg.context);
  else if (p.event === 'getSessions') {
    scanAgents('inspector').then(() => sendSessionsTo(msg.context));
  } else if (p.event === 'refresh') {
    const entry = actions.get(msg.context);
    if (entry && entry.kind === 'agent') scanAgents('property inspector');
    else poll('property inspector');
  }
});

sd.on('systemDidWakeUp', () => {
  poll('wake');
  scanAgents('wake');
});

sd.on('close', () => {
  // A reconnect brings fresh context strings, so every entry here is now dead.
  // Painting to a stale context is harmless but pointless, and stale entries
  // would otherwise pin the poll interval and keep polling their sources.
  if (actions.size) log(`connection closed; dropping ${actions.size} stale action(s)`);
  actions.clear();
  if (pollTimer) clearInterval(pollTimer);
  if (repaintTimer) clearInterval(repaintTimer);
  if (scanTimer) clearInterval(scanTimer);
  if (agentScanTimer) clearTimeout(agentScanTimer);
  agentScanTimer = null;
  pollTimer = null;
  repaintTimer = null;
  scanTimer = null;
  currentIntervalMs = 0;
});

sd.on('gaveUp', (attempts) => {
  log(`could not reconnect after ${attempts} attempts; exiting`);
  process.exit(0);
});

sd.on('handlerError', (err, event) => log(`handler for ${event} threw:`, err && err.message ? err.message : String(err)));

sd.on('socketError', (err) => log('socket error:', err && err.message ? err.message : String(err)));

/* --------------------------------------------------------------- resilience */

process.on('uncaughtException', (e) => log('uncaught:', e && e.message ? e.message : String(e)));
process.on('unhandledRejection', (e) => log('unhandled rejection:', e && e.message ? e.message : String(e)));

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    sd.close();
    process.exit(0);
  });
}

try {
  sd.connect();
} catch (e) {
  // Redacted like every other message, so the contract holds even here.
  console.error(`[aiquota] cannot start: ${redact(e)}`);
  process.exit(1);
}
