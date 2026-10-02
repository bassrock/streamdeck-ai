'use strict';
/**
 * herdr.js — links a session on a key to the Ghostty pane it is running in.
 *
 * herdr (https://herdr.dev) is the terminal workspace manager that owns the Ghostty
 * window: it knows every agent pane, its working directory, and its live status. Two
 * things come from it that the transcripts cannot give us:
 *
 *  - a pane id, so pressing a key can jump straight to that agent, and
 *  - a real status, including `blocked`, which is an agent sitting on an approval
 *    prompt. A transcript cannot tell that apart from ordinary thinking, and it is
 *    the single state most worth walking over to.
 *
 * Everything here degrades to nothing if herdr is absent: no pane ids, no status
 * override, keys keep working off the transcripts alone.
 *
 * On controlling herdr from outside a herdr session: its own guidance tells agents
 * not to, which is about an AI stealing the user's focus mid-task. This is the
 * opposite — a person pressing a physical key to be taken somewhere — so focus only
 * ever moves as the direct result of a keypress, never on a timer or a scan.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();

/** Where herdr installs itself. PATH is not inherited by a Stream Deck plugin. */
const CANDIDATES = [
  path.join(HOME, '.local/bin/herdr'),
  '/usr/local/bin/herdr',
  '/opt/homebrew/bin/herdr',
];

const GHOSTTY_BUNDLE_ID = 'com.mitchellh.ghostty';

/** herdr answers in well under this; past it something is wrong and we give up. */
const CALL_TIMEOUT_MS = 4000;

/**
 * The plugin is launched by the Stream Deck app, so it inherits none of the login
 * shell's environment. herdr finds its own socket at the default path when
 * HERDR_SOCKET_PATH is unset, which is why a bare environment works.
 */
const CHILD_ENV = { HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

function findBinary() {
  // A test must be able to exercise the jump path without moving the real
  // terminal's focus, so it points this at a stub that records the call instead.
  const override = process.env.AIQUOTA_HERDR_BIN;
  if (override) {
    try {
      fs.accessSync(override, fs.constants.X_OK);
      return override;
    } catch { /* fall through to the real search */ }
  }
  for (const p of CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* try the next one */ }
  }
  return null;
}

/**
 * Claude Code names a project directory after its cwd with every `/` and `.`
 * replaced by `-`. Encoding herdr's cwd the same way is how the two are matched:
 * decoding the other direction is ambiguous, because a `-` in the directory name
 * could have been any of the three characters.
 */
function encodeCwd(cwd) {
  return String(cwd || '').replace(/[/.]/g, '-');
}

class HerdrLink {
  constructor() {
    this.bin = findBinary();
    this.available = !!this.bin;
    /** encoded cwd -> { paneId, status, title, cwd } */
    this.byProject = new Map();
    this.lastError = null;
    this.refreshing = null;
    this.lastOk = 0;
  }

  /** Re-reads the agent list. Safe to call often: concurrent calls share one run. */
  refresh() {
    if (!this.available) return Promise.resolve(this.byProject);
    if (this.refreshing) return this.refreshing;
    this.refreshing = new Promise((resolve) => {
      execFile(this.bin, ['agent', 'list'],
        { env: CHILD_ENV, timeout: CALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            // herdr not running is normal, not a fault worth shouting about; keep
            // the previous map so a momentary blip does not unlink every key.
            this.lastError = err.message;
            resolve(this.byProject);
            return;
          }
          try {
            const parsed = JSON.parse(stdout);
            const agents = (parsed && parsed.result && parsed.result.agents) || [];
            const next = new Map();
            for (const a of agents) {
              if (!a || !a.cwd || !a.pane_id) continue;
              next.set(encodeCwd(a.cwd), {
                paneId: a.pane_id,
                // The workspace is what the TUI actually displays; see focus().
                workspaceId: a.workspace_id || null,
                status: a.agent_status || null,
                title: a.terminal_title_stripped || null,
                cwd: a.cwd,
                focused: !!a.focused,
              });
            }
            this.byProject = next;
            this.lastError = null;
            this.lastOk = Date.now();
          } catch (e) {
            this.lastError = `unparseable agent list: ${e.message}`;
          }
          resolve(this.byProject);
        });
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** What herdr knows about the project a session lives in, or null. */
  get(projectDir) {
    return this.byProject.get(projectDir) || null;
  }

  get count() {
    return this.byProject.size;
  }

  /**
   * Takes you to an agent: selects its pane, switches the view to it, and brings
   * Ghostty forward. All three are needed, and the middle one is the one that is
   * easy to miss.
   *
   * `agent focus` marks the pane focused server-side and the window re-titles, so
   * it looks like it worked — but the TUI keeps rendering whatever workspace it was
   * already on. `workspace focus` is what actually moves the view. Doing only the
   * first is the "the tab name changes but it does not take me there" bug.
   *
   * Raising uses `open -b` rather than AppleScript because `open` needs no
   * Automation permission, and a background plugin cannot answer a consent dialog.
   */
  focus(paneId, workspaceId) {
    return new Promise((resolve) => {
      if (!this.available || !paneId) {
        resolve({ ok: false, error: 'herdr not available' });
        return;
      }
      const run = (args) => new Promise((done) => {
        execFile(this.bin, args, { env: CHILD_ENV, timeout: CALL_TIMEOUT_MS },
          (e) => done(e || null));
      });

      run(['agent', 'focus', paneId]).then(async (err) => {
          if (err) {
            resolve({ ok: false, error: err.message });
            return;
          }
          // Without this the view does not move, however healthy the first call looks.
          const wsErr = workspaceId ? await run(['workspace', 'focus', workspaceId]) : null;
          if (process.env.AIQUOTA_NO_RAISE) {
            resolve({ ok: true, raised: false, switched: !wsErr });
            return;
          }
          execFile('/usr/bin/open', ['-b', GHOSTTY_BUNDLE_ID],
            { env: CHILD_ENV, timeout: CALL_TIMEOUT_MS },
            (raiseErr) => resolve({
              ok: true,
              // The pane moved even if the window failed to come forward or the
              // view failed to switch, so neither makes the whole press a failure.
              raised: !raiseErr,
              switched: !wsErr,
            }));
        });
    });
  }
}

module.exports = { HerdrLink, encodeCwd, GHOSTTY_BUNDLE_ID };
