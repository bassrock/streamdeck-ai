'use strict';
/**
 * agents.js — discovers live Claude Code sessions and works out what each one is
 * doing right now.
 *
 * Everything here comes off the local disk: Claude Code appends one JSONL
 * transcript per session under <config dir>/projects/<encoded cwd>/<id>.jsonl, and
 * the file's mtime is the moment it last wrote a line. There is no API and nothing
 * to authenticate, so unlike sources.js this costs no network and no quota.
 *
 * Two things make the scan cheap enough to run every few seconds:
 *
 *  - only the tail of each transcript is read. The largest on this machine is 21 MB
 *    and the state we want is in the final handful of lines.
 *  - a parsed result is cached against (size, mtime), so a file nobody has touched
 *    since the last scan is stat'd and skipped.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();

/** How much of the end of a transcript to read. Comfortably more than one turn. */
const TAIL_BYTES = 64 * 1024;

/**
 * State thresholds, all measured from the transcript's last write.
 *
 * `working` is deliberately tight: Claude writes a line per tool call and per
 * chunk of reply, so a genuinely busy session touches its file every few seconds.
 * A gap longer than this means the turn ended, whatever the last line says.
 */
const WORKING_MS = 90 * 1000;
/** How long a finished turn still counts as "your move" rather than merely old. */
const ATTENTION_MS = 60 * 60 * 1000;
/** Beyond this a session is history, not work in progress. */
const IDLE_MS = 24 * 60 * 60 * 1000;

/** Entry types that represent real conversation rather than bookkeeping. */
const SUBSTANTIVE = new Set(['user', 'assistant']);

/* ------------------------------------------------------------------ helpers */

/** "main" for ~/.claude, otherwise the suffix: ~/.claude-work -> "work". */
function labelForHome(dir) {
  const base = path.basename(dir);
  if (base === '.claude') return 'main';
  const m = base.match(/^\.claude[-_]?(.+)$/);
  return (m && m[1] ? m[1] : base.replace(/^\./, '')).slice(0, 12);
}

/** Every ~/.claude* directory that actually has a projects/ tree. */
function claudeHomes() {
  const out = [];
  const dflt = path.join(HOME, '.claude');
  if (fs.existsSync(path.join(dflt, 'projects'))) {
    out.push({ dir: dflt, account: labelForHome(dflt) });
  }
  let entries = [];
  try {
    entries = fs.readdirSync(HOME, { withFileTypes: true });
  } catch { /* unreadable home: whatever we already have is the answer */ }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.claude') || e.name === '.claude') continue;
    const dir = path.join(HOME, e.name);
    if (!fs.existsSync(path.join(dir, 'projects'))) continue;
    out.push({ dir, account: labelForHome(dir) });
  }
  return out;
}

/**
 * Reads the last `bytes` of a file as text.
 *
 * A transcript can be tens of megabytes and is appended to constantly, so reading
 * the whole thing on every scan would be the single most expensive act this plugin
 * performs. The first line of the slice is usually a fragment; callers drop it.
 */
function readTail(file, bytes = TAIL_BYTES) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    const txt = buf.toString('utf8');
    // Drop the leading partial line unless we happened to read from the very start.
    return start === 0 ? txt : txt.slice(txt.indexOf('\n') + 1);
  } catch {
    return '';
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/** Parses JSONL from the end backwards, calling `visit` until it returns true. */
function eachEntryBackwards(text, visit) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (visit(d) === true) return;
  }
}

/**
 * Pulls the facts a key wants out of one transcript's tail.
 *
 * Fields are taken from the newest entry that carries them, because the early
 * entries of a long session can name a cwd or branch it has since moved off.
 */
function readTranscript(file) {
  const text = readTail(file);
  if (!text) return null;

  const out = {
    title: null, branch: null, cwd: null, version: null,
    sessionId: null, pr: null, lastRole: null, endTurn: false,
  };
  let sawSubstantive = false;

  eachEntryBackwards(text, (d) => {
    const t = d.type;
    if (!out.title && t === 'ai-title' && d.aiTitle) out.title = String(d.aiTitle);
    if (!out.pr && t === 'pr-link' && d.prNumber) out.pr = Number(d.prNumber);
    if (!out.branch && d.gitBranch) out.branch = String(d.gitBranch);
    if (!out.cwd && d.cwd) out.cwd = String(d.cwd);
    if (!out.version && d.version) out.version = String(d.version);
    if (!out.sessionId && d.sessionId) out.sessionId = String(d.sessionId);

    if (!sawSubstantive && SUBSTANTIVE.has(t)) {
      // A sidechain is a subagent's turn inside the parent transcript; it says
      // nothing about whether the main conversation is waiting on the user.
      if (d.isSidechain) return false;
      sawSubstantive = true;
      out.lastRole = t;
      const msg = d.message || {};
      out.endTurn = msg.stop_reason === 'end_turn';
    }
    // Stop once every field is settled; there is no point parsing further back.
    return sawSubstantive && out.title && out.branch && out.cwd && out.pr !== null;
  });

  return out;
}

/**
 * Turns "when did it last write" and "who spoke last" into one state.
 *
 * The two signals are needed together. A transcript whose last line is an
 * assistant end_turn looks identical whether it finished ten seconds ago or last
 * Tuesday, and a transcript in the middle of a tool call looks busy long after the
 * process that was writing it has exited.
 */
function classify(t, ageMs, herdrStatus) {
  // herdr watches the pane itself, so where it has an opinion it beats any guess
  // made from file timestamps. `blocked` in particular — an agent sitting on an
  // approval prompt — is invisible in a transcript and is the state most worth
  // walking over to.
  if (herdrStatus === 'blocked') return 'blocked';
  if (herdrStatus === 'working') return 'working';
  if (herdrStatus === 'idle' || herdrStatus === 'done') {
    // Ready for input. Age still decides how loudly to say so, because a pane left
    // at a prompt overnight is not the same news as one that just finished.
    if (ageMs > IDLE_MS) return 'dormant';
    return ageMs <= ATTENTION_MS ? 'waiting' : 'idle';
  }
  if (ageMs > IDLE_MS) return 'dormant';
  // Mid-turn: a user entry is either a fresh prompt or a tool result coming back,
  // and both mean the model has the ball.
  if (ageMs <= WORKING_MS && t.lastRole === 'user') return 'working';
  // It spoke last and stopped. Within the attention window that is your move.
  if (t.lastRole === 'assistant' && t.endTurn) {
    return ageMs <= ATTENTION_MS ? 'waiting' : 'idle';
  }
  // Still writing, but slowly: long tool calls leave gaps bigger than WORKING_MS.
  if (ageMs <= WORKING_MS) return 'working';
  return ageMs <= ATTENTION_MS ? 'idle' : 'dormant';
}

/** Best human name for a session, in descending order of how much it tells you. */
function displayLabel(t, projectDir) {
  if (t && t.title) return t.title;
  if (t && t.branch) return t.branch;
  if (t && t.cwd) return path.basename(t.cwd);
  // Fall back to the encoded directory name, which is the cwd with / as -.
  const tail = String(projectDir || '').split('-').filter(Boolean).pop();
  return tail || 'session';
}

/**
 * A stable id for a key to hold on to.
 *
 * Deliberately the project directory rather than the session id: starting a new
 * session in the same worktree should keep the key pointed at that work, and
 * session ids change every time.
 */
function projectIdFor(account, projectDir) {
  return `${account}/${projectDir}`;
}

/* --------------------------------------------------------------- registry */

/**
 * Holds one entry per project directory, newest session first.
 *
 * Unlike the quota Registry there is nothing to fail and nothing to rate limit, so
 * there is no staleness contract here: a scan either sees a file or it does not.
 */
class SessionRegistry {
  constructor() {
    this.sessions = [];
    this.scannedAt = 0;
    this.parseCache = new Map(); // file -> { size, mtimeMs, parsed }
  }

  /**
   * Synchronous on purpose. Every read below is a stat or a bounded tail read,
   * the results are cached against mtime, and a caller that got a promise here
   * would still have nothing to await on. Measured at well under a frame on a
   * cold cache with ~190 transcripts.
   */
  scan(herdrIndex) {
    const now = Date.now();
    /** projectId -> best (most recently written) session in it */
    const byProject = new Map();
    const liveFiles = new Set();

    for (const home of claudeHomes()) {
      const projects = path.join(home.dir, 'projects');
      let dirs = [];
      try {
        dirs = fs.readdirSync(projects, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dir = path.join(projects, d.name);
        let files = [];
        try {
          files = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }

        let newest = null;
        let count = 0;
        for (const f of files) {
          // Subagent transcripts live one level down and are not sessions of
          // their own; a key showing one would double-count the parent's work.
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
          const file = path.join(dir, f.name);
          let st;
          try {
            st = fs.statSync(file);
          } catch {
            continue;
          }
          count += 1;
          if (!newest || st.mtimeMs > newest.st.mtimeMs) newest = { file, st };
        }
        if (!newest) continue;

        liveFiles.add(newest.file);
        const cached = this.parseCache.get(newest.file);
        let parsed;
        if (cached && cached.size === newest.st.size && cached.mtimeMs === newest.st.mtimeMs) {
          parsed = cached.parsed;
        } else {
          parsed = readTranscript(newest.file) || {};
          this.parseCache.set(newest.file, {
            size: newest.st.size, mtimeMs: newest.st.mtimeMs, parsed,
          });
        }

        const ageMs = Math.max(0, now - newest.st.mtimeMs);
        const id = projectIdFor(home.account, d.name);
        const linked = herdrIndex ? herdrIndex.get(d.name) : null;
        byProject.set(id, {
          id,
          account: home.account,
          projectDir: d.name,
          file: newest.file,
          sessions: count,
          updatedAt: newest.st.mtimeMs,
          ageMs,
          state: classify(parsed, ageMs, linked && linked.status),
          // The pane to jump to when this key is pressed, when there is one.
          pane: linked ? linked.paneId : null,
          workspace: linked ? linked.workspaceId : null,
          herdrStatus: linked ? linked.status : null,
          label: displayLabel(parsed, d.name),
          title: parsed.title || null,
          branch: parsed.branch || null,
          cwd: parsed.cwd || null,
          pr: parsed.pr || null,
          sessionId: parsed.sessionId || null,
        });
      }
    }

    // Keep the cache from growing for the life of the login session.
    for (const file of this.parseCache.keys()) {
      if (!liveFiles.has(file)) this.parseCache.delete(file);
    }

    this.sessions = [...byProject.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    this.scannedAt = now;
    return this.sessions;
  }

  list() {
    return this.sessions.slice();
  }

  get(id) {
    return this.sessions.find((s) => s.id === id) || null;
  }

  /** The nth most recently active session, which is what an unconfigured key shows. */
  nth(index) {
    return this.sessions[index] || null;
  }

  /** Counts by state, for a summary key. */
  counts() {
    const c = { working: 0, waiting: 0, idle: 0, dormant: 0, blocked: 0 };
    for (const s of this.sessions) c[s.state] = (c[s.state] || 0) + 1;
    return c;
  }
}

/* ------------------------------------------------------------- standalone */

function fmtAge(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return `${Math.floor(ms / 1000)}s`;
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h${String(mins % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d`;
}

async function main() {
  const { HerdrLink } = require('./herdr.js');
  const link = new HerdrLink();
  await link.refresh();
  const reg = new SessionRegistry();
  reg.scan(link);
  const list = reg.list();
  console.log(link.available
    ? `herdr: ${link.count} agent pane(s)${link.lastError ? ` (${link.lastError})` : ''}`
    : 'herdr: not installed; keys will not link to a terminal');
  const counts = reg.counts();
  console.log(`${list.length} project(s):  ${counts.blocked} blocked, ${counts.working} working, `
    + `${counts.waiting} waiting, ${counts.idle} idle, ${counts.dormant} dormant\n`);
  for (const s of list.slice(0, 25)) {
    const mark = { working: '*', waiting: '!', blocked: '?', idle: ' ', dormant: ' ' }[s.state] || ' ';
    console.log(
      `${mark} ${s.state.padEnd(8)} ${fmtAge(s.ageMs).padStart(6)} ago  `
      + `${(s.pane || '-').padEnd(7)} `
      + `[${s.account}] ${s.label.slice(0, 40).padEnd(40)} `
      + `${s.branch ? s.branch.slice(0, 24) : ''}`
    );
  }
}

module.exports = {
  SessionRegistry,
  claudeHomes,
  readTranscript,
  classify,
  displayLabel,
  fmtAge,
  WORKING_MS,
  ATTENTION_MS,
  IDLE_MS,
};

if (require.main === module) main();
