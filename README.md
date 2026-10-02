# AI Quota for Stream Deck

Two things on one Stream Deck +: **how much quota is left** on the touch strip, and
**what every Claude Code session is doing** on the keys above it.

Live Claude Code and OpenAI Codex quota on the Stream Deck + touch strip. Each of the
strip's four segments can show one account, with the 5-hour and 7-day windows side by
side. Press or turn a dial to cycle that segment through more detail.

```
┌──────────────────────┬──────────────────────┬──────────────────────┬────────────┐
│ CLAUDE · main   LEFT │ CLAUDE · work   LEFT │ CODEX           LEFT │            │
│ 5h ▓▓▓▓▓▓▓▓▓░  93%   │ 5h ▓▓▓░░░░░░░  28%   │ 5h ▓▓▓▓▓▓▓▓▓▓ 100%   │   (free)   │
│ 7d ▓▓▓▓░░░░░░  45%   │ 7d ▓▓▓░░░░░░░  36%   │ 7d ▓▓▓▓▓▓▓▓░░  80%   │            │
│ 5h 41m · 7d 3d4h     │ 5h 41m · 7d 3d4h     │ 5h 5h00m · 7d 3d22h  │            │
└──────────────────────┴──────────────────────┴──────────────────────┴────────────┘
```

The figures are what is **left**, so a full bar is good and it drains as you spend quota.
The `LEFT` marker in the corner says which direction you are looking at; switch a segment
to `USED` in its settings if you prefer counting up.

Bars turn amber once 60% is spent and red at 85%, both adjustable per segment. Those
thresholds are always expressed as percent used, so they mean the same thing in either
direction.

## Running it later

**Day to day, nothing.** The Stream Deck app is registered as a login item, so it starts
with your Mac, loads the profile, and launches this plugin on its own. The plugin polls by
itself and needs no terminal, no server, and no session of anything left open.

One command answers "is it still set up?":

```sh
cd ~/StreamDeck && npm run status
```

A healthy answer names this folder as the link target and says the app, the plugin process
and developer mode are all present. `plugin proc: no` is normal whenever the action is not
on a dial in the profile that is currently showing.

### If the segments have gone blank or the action has disappeared

Almost always the symlink is gone, which is what a Stream Deck app update does. Put it
back and restart the app:

```sh
cd ~/StreamDeck
npm run link
npm run restart
```

If the action list has **AI Quota → Quota** but your dials are empty, the profile lost its
assignments. Drag the action onto a dial three times; each one claims a different account
by itself, left to right, so there is normally nothing to configure. To change one, click
the segment and pick an account in the panel on the right.

### If one segment reads an error instead of a number

| It says | Do this |
| --- | --- |
| `rate limited, retrying in Nm` | Nothing. It backs off and recovers by itself. |
| `token expired, run a Claude session to renew` | Run `claude` once, or `wclaude` for the work account. |
| `token expired, run a Codex session to renew` | Run `codex` once. |
| `not signed in on this Mac` | That account is logged out. Log in with its CLI. |
| `signed out on this Mac` | Its config directory or keychain item is gone. Pick another account in settings. |
| `account not found on this Mac` | The segment points at an account that no longer exists. Pick another in settings. |

A segment never goes blank and never shows a misleading zero. How it degrades tells you
how much to trust the number on it:

- **dimmed, with "retrying"** means the newest attempt failed but the figure on screen is
  still current.
- **dimmed, with "12m old"** means the last success was that long ago and attempts since
  have failed. The figure is real but ageing. A rate-limited account looks like this while
  it waits out its backoff.
- **em-dashes and a sentence** means no reading has ever succeeded, and the sentence is
  the reason.

To see what the plugin sees, without involving the hardware:

```sh
cd ~/StreamDeck && npm run check      # every account it can find, and its numbers
cd ~/StreamDeck && npm run logs       # what each poll actually saw
```

`logs` is usually the faster answer, because the plugin writes one line per poll saying
what every account returned:

```
2026-09-11T23:30:52Z discovered 3 source(s): claude:default, claude:claude-work, codex
2026-09-11T23:30:53Z poll (willAppear): codex=used 0/20
2026-09-11T23:30:58Z poll (queued): claude:claude-work=rate limited, retrying in 5m  claude:default=used 10/56
```

Those figures are percent used, and the file caps itself at 256 KB. Every line is passed
through the same redaction as everything else, so no token can reach it.

`check` prints every account it can find and its current numbers. It reports percent **used**,
which is the raw figure from each provider; the strip shows what is left, so the two are
complements. It costs one request per account, so do not sit in a loop on it.

### After adding or removing a Claude account

Nothing. Accounts are discovered by scanning for `~/.claude*` config directories, so a new
one appears in the settings dropdown within ten minutes, or immediately after
`npm run reload`. Assign it to a dial when you want it on the strip.

### Setting it up again from scratch, or on another Mac

This folder is not a git repository, so copy it across as-is.

```sh
cd ~/StreamDeck
npm install --prefix com.danielbrooks.aiquota.sdPlugin   # only if node_modules is missing
npm run link
npm run restart
```

Then drag the action onto three dials. The plugin needs the Claude and Codex CLIs to have
been logged in on that machine, because it reads their existing credentials and never
prompts for any of its own.

You do not need Node installed for the plugin itself: the Stream Deck app ships its own,
and `scripts/node.sh` points the helper commands at that same one, so none of this depends
on which nvm version is active.

### Where everything lives

| What | Where |
| --- | --- |
| This project | `~/StreamDeck` |
| The link the app follows | `~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.danielbrooks.aiquota.sdPlugin` |
| Dial assignments, key assignments and their settings | the `Default` Stream Deck + profile under `ProfilesV3` |
| The transcripts the agent keys read | `~/.claude*/projects/<encoded cwd>/*.jsonl` |
| The herdr binary the keys jump through | `~/.local/bin/herdr` |
| A backup of that profile from before the dials were touched | `~/StreamDeck/backups` |
| Plugin log, one line per poll | `~/StreamDeck/com.danielbrooks.aiquota.sdPlugin/logs/aiquota.log` |
| App log | `~/Library/Logs/ElgatoStreamDeck/StreamDeck.log` |

The action also works on a regular key, where it draws the same two windows at 144×144.

## Agents

Seven of the eight keys above the strip each follow one Claude Code session, and
the eighth sums them up. Colour is the whole message, readable without leaning in:

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ WORKING [WORK│ YOUR MOVE[WRK│ IDLE    [MAIN│ WORKING [MAIN│
│ Streamdeck   │ deduplicate- │ ai-importer- │ seed-data    │
│ node memory  │ seed-retry   │ bugs         │              │
│ 11s   3 sess │ 1m     #4623 │ 3m           │ 4s           │
├──────────────┼──────────────┼──────────────┼──────────────┤
│ …            │ …            │ …            │ AGENTS  6    │
└──────────────┴──────────────┴──────────────┴──────────────┘
   green            amber          grey        blue = work
                                               orange = main
```

- **red / BLOCKED** — stopped on an approval or question prompt. Nothing moves
  until you answer it, so this one outranks everything.
- **green / WORKING** — the model is mid-turn right now.
- **amber / YOUR MOVE** — it finished its turn and is waiting on you.
- **grey / IDLE or DORMANT** — neither, and how long ago.

### Pressing a key takes you there

**Press** a key and it focuses that agent's pane in Ghostty and brings the window
forward. **Press and hold** instead to flip the key between the session and where
it is running.

The summary key jumps too: pressing it goes to whichever agent is most stuck —
blocked first, then finished-and-waiting, then still working.

A jump is three steps, and the middle one is easy to miss. `herdr agent focus
<pane>` selects the pane and the window re-titles, so it looks like it worked — but
the TUI carries on rendering whatever workspace it was already showing. `herdr
workspace focus <workspace>` is what actually moves the view. Then `open -b` brings
Ghostty forward. Doing only the first is the "the tab name changes but it does not
take me there" bug.

A key can only jump while [herdr](https://herdr.dev) is running that session in a
pane. When it can, the key's **left edge is lit**; a key with no stripe is a
historical session and pressing it flashes an alert instead. Focus only ever moves
from a keypress — nothing on a timer or a scan touches it, because a window that
raises itself while you are typing elsewhere is worse than no shortcut at all.

The big number bottom-left is how long since that session last wrote anything, which
is the honest liveness signal. Bottom-right shows its PR number when it has one, or
the session count when the project has more than one.

**Keys assign themselves.** An unconfigured key takes its own slot in the
most-recently-active list, in key order, so the leftmost key is always your newest
work and the row reorders itself as you move between worktrees. Nothing to set up.

To pin a key to one project so it stops moving, pick it in the key's settings. A
pinned key stays on that project even when you start a fresh session in it, and it
drops out of the slot ordering so the automatic keys either side keep their places.

**Which account it is** sits top-right of every key as a coloured chip: orange
`MAIN` for `~/.claude`, blue `WORK` for `~/.claude-work`. Any further `~/.claude*`
directory gets a stable colour of its own. The palette deliberately contains no
green and no amber, because those two mean *state* — a green `WORK` chip beside a
green `WORKING` bar reads as one fact repeated rather than two different ones.

### Where agent status comes from

Two sources, joined on the working directory. herdr knows about panes it is running;
the transcripts know about every session that ever ran, including ones started
outside herdr.

**herdr**, via `herdr agent list` over its socket, gives the pane id and the live
status. Its status wins wherever it has one, because it is watching the pane rather
than inferring from a file. `blocked` is the reason this matters: an agent sitting
on an approval prompt is indistinguishable from one thinking hard if all you have is
a timestamp. A session herdr has never heard of still works, minus the jump.

herdr's own guidance tells agents not to drive a session from outside it, which is
about an AI stealing your focus mid-task. A person pressing a physical key is the
opposite case, which is why focus moves only on a keypress here.

Matching is by encoding herdr's `cwd` the way Claude Code encodes a project
directory — every `/` and `.` becomes `-`. It goes in that direction because
decoding is ambiguous: a `-` in a directory name could have been any of the three.

**The transcripts**, entirely off the local disk, and unlike the quota half they cost
no network and no quota at all. Claude Code appends one JSONL transcript per session under
`<config dir>/projects/<encoded cwd>/`, and its mtime is the moment it last wrote a
line. The state comes from two signals together, because neither is enough alone:

| Last substantive line | Written within 90s | Older |
| --- | --- | --- |
| a user entry (a prompt, or a tool result coming back) | working | idle, then dormant |
| an assistant entry that ended its turn | working | your move, for an hour |

The scan is cheap enough to run every four seconds: only the last 64 KB of each
transcript is read — the largest here is 21 MB — and a parse is cached against the
file's size and mtime, so an untouched session is stat'd and skipped. A cold scan of
49 projects measures about 30 ms.

To see what the keys see, without involving the hardware:

```sh
cd ~/StreamDeck && npm run agents
```

## Controls

| Gesture | Effect |
| --- | --- |
| Press the dial | next view |
| Turn the dial | next or previous view |
| Tap the segment | next view |
| Press and hold the segment | refresh that account now |
| Press an agent key | jump to that agent's pane in Ghostty |
| Press and hold an agent key | switch between the session and where it is running |

The views are: both windows, 5-hour with its reset time, 7-day with its reset time, and
extra usage where the account has it enabled. The chosen view is remembered per segment,
and so is the remaining-versus-used choice.

## Where the numbers come from

Both providers expose a first-party usage endpoint. Neither call consumes quota, and
neither is a scrape.

**Claude Code**, once per account: `GET https://api.anthropic.com/api/oauth/usage`, the
same endpoint the `/usage` command uses. Accounts are discovered by scanning for
`~/.claude*` config directories, so all of these are found automatically, as would be
any account added later:

| Account | Config directory |
| --- | --- |
| `main` | `~/.claude` |
| `work` | `~/.claude-work` |
| `bass_rock` | `~/.claude-bass_rock` |

Each account's OAuth token is read from its own macOS keychain item. Claude Code derives
the item's name from the config directory path, and this plugin follows the same rule:
`Claude Code-credentials` for the default directory, otherwise that name plus the first
eight hex characters of the SHA-256 of the directory path.

**Codex**: `GET https://chatgpt.com/backend-api/codex/usage`, with the token and account
id from `~/.codex/auth.json`.

**Shared with Claude Usage.** The [Claude Usage](https://github.com/breakawaydata/claude-usage)
menu bar app polls the same accounts. Without coordination, the two would double the
requests and set off the endpoints' rate limits. So both keep one file per account in
`~/Library/Caches/ai-usage-shared/` (`claude-.claude-work.json`, `codex-.codex.json`, …):

- **Fresh reading:** if a response there is under 2 minutes old, it's used as is, with no request.
- **Cooldown:** a 429 sets a cooldown that both apps honour (5 min, doubling to 30).
- **In flight:** an attempt that's still running holds the other app off for up to 30 seconds.

The files hold the raw usage response, never a token. They're `0600`, in a `0700` directory. To turn sharing off (the failure-path tests do this), set
`AI_USAGE_SHARED_DIR=off`.

## About your tokens

The plugin reads OAuth tokens so it can ask each provider about your own usage. It holds
them in memory only, and sends each one only to the host that issued it. No token is
logged, written to disk, or included in an error message; the log helper strips anything
resembling a bearer token before writing.

**The plugin never refreshes a token.** Claude Code rotates its refresh token through a
compare-and-swap inside the keychain item, so an outside refresh would rotate it away from
the CLI and force you to log in again. When an access token has expired the segment keeps
showing the last good reading, marked stale, and waits for a real CLI session to renew it.
Running `claude` or `codex` once clears that state.

Reading a keychain item does not prompt, because `/usr/bin/security` created the items and
is therefore already on their access list.

## Tests

```sh
npm test           # all four suites, on the Node the Stream Deck app actually uses
npm run preview    # render every view to a page and open it, to check legibility
```

- `test/failure-paths.js` forces the paths that are easy to get wrong: a keychain item
  that does not exist, a source that has never succeeded, the network dropping and coming
  back, percentages that are null or out of range, a reset time in the past, and a custom
  label containing markup. It makes a handful of real requests.
- `test/property-inspector.sh` runs the settings panel's own JavaScript in a headless
  browser with the Stream Deck socket stubbed, and checks its messages against what the
  plugin expects. No network.
- `test/agents.js` covers the agent action: the state machine's boundaries, reading a
  transcript from a tail that starts mid-line, and rendering every state. Its second
  half launches a real plugin process holding agent keys *and* a quota dial at once,
  which is the only way to reach the two bugs this action shipped with during
  development — the quota back-fill handing accounts to agent keys, and an agent
  key's absent `pollSeconds` turning the shared poll interval into `NaN`, which made
  `setInterval` fire as fast as the event loop allowed and rate limited both
  providers within seconds. No network.
- `test/end-to-end.js` impersonates the Stream Deck app: it launches the plugin exactly as
  the app does, sends `willAppear` for three dials, then presses, turns and long-touches
  them, and asserts on what comes back. It also scans every message the plugin sent for
  anything token-shaped. This is the suite that catches protocol mistakes.

All three passed against both Claude accounts and Codex on the machine this was built on.

## Development

No bundler and no TypeScript: edit a file, then reload.

```sh
npm run reload     # kill the plugin process; the app respawns it in about a second
npm run restart    # restart the whole app, needed only for manifest.json or the layout
```

Reload by that script rather than by hand. A bare `pkill -f com.danielbrooks.aiquota`
matches every process whose command line mentions the plugin folder, the test harnesses
included, so it kills more than you meant; the script matches the entry point instead.
Right-clicking the action in the app and choosing **Restart plugin** also works, since
developer mode adds that item.

| File | Role |
| --- | --- |
| `bin/plugin.js` | connection, visible actions, the poll and repaint timers |
| `bin/sources.js` | account discovery, keychain reads, both pollers, staleness cache |
| `bin/agents.js` | session discovery, tail reads, the working/waiting state machine |
| `bin/herdr.js` | pane ids and live status from herdr, and the jump itself |
| `bin/render.js` | the SVG for a 200×100 segment and a 144×144 key |
| `bin/streamdeck.js` | the plugin WebSocket protocol |
| `scripts/node.sh` | runs a script on the Node the app uses, so results match the plugin |
| `layouts/quota.json` | one full-bleed pixmap, which is what the SVG is painted into |
| `ui/quota.html` | the settings panel for a quota segment |
| `ui/agent.html` | the settings panel for an agent key |

`ws` is the only runtime dependency, and it lives inside the plugin folder rather than at
the repo root, because the Stream Deck app loads the plugin from that folder and the Node
20 runtime it bundles does not expose a global `WebSocket`. It is committed for that
reason; if it ever goes missing, `npm install` inside `com.danielbrooks.aiquota.sdPlugin`
restores it.

One quirk worth knowing: Cloudflare fronts the Codex endpoint and fingerprints the TLS
handshake. Node 20's defaults get challenged and come back 403, so `sources.js` spells the
handshake out explicitly. That block has a comment saying so; do not remove it just
because the request looks fine in Node 24.

The SVG is deliberately conservative: presentation attributes only, no stylesheets, no
`dominant-baseline`, and a font stack of faces that certainly exist on macOS. The app
rasterises through Qt, which supports much less SVG than a browser does.

One polling note: every visible segment shares a single timer, and sources are
deduplicated, so three segments showing three accounts make three requests per cycle,
staggered a few hundred milliseconds apart rather than fired at once. The default cycle is
three minutes and the floor is sixty seconds, because both usage endpoints rate limit and
these windows move over hours, not seconds. A source that answers 429 is left alone for
five minutes, doubling up to thirty while the 429s continue, or for whatever its
`Retry-After` asks. Its last good reading stays on screen and simply ages. The first
success resets the backoff.

Worth knowing if you are hacking on this: it is easy to trip the Claude rate limit from a
shell loop while testing, and once tripped it stays tripped for a good while. Its 429
carries `retry-after: 0`, so there is no hint about how long, and the window looks to be
sliding, meaning further requests keep extending it. The cure is to stop asking and let
the backoff run. `npm run check` is one request per account, so use it sparingly when the
plugin is also running.

## Caveats

The jump depends on herdr's CLI keeping `agent list`, `agent focus` and `workspace
focus` as they are, and on them accepting a pane id and a workspace id. If herdr is not installed or not running,
the keys still show status from the transcripts and pressing one simply flashes an
alert; nothing else degrades.

The agent keys read Claude Code's transcript format, which is internal and can change
between CLI versions. If it does, the keys degrade to the encoded directory name
rather than going blank, because the label falls back through title, branch, cwd and
finally the path. `npm run agents` is the fastest way to see whether the fields are
still being found.

The Codex endpoint is an internal ChatGPT API rather than a published one, so it can
change without notice. If it does, Codex segments degrade to em-dashes while the Claude
segments carry on.

A Stream Deck app update can remove the plugin symlink, which is the single most likely
reason this ever stops working. **Running it later** above covers the fix.
