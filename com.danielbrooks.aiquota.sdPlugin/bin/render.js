'use strict';
/**
 * render.js — builds the SVG shown on a Stream Deck + touch strip segment (200x100)
 * or on a key (144x144).
 *
 * The Stream Deck app rasterises these through Qt's SVG renderer, which supports only
 * a conservative subset of SVG. So: presentation attributes only (no <style> blocks,
 * no CSS classes), no dominant-baseline (every text baseline is computed here), and a
 * font stack limited to faces that certainly exist on macOS.
 */

const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';

const COLORS = {
  text: '#f5f5f5',
  muted: '#9ca3af',
  faint: '#6b7280',
  track: '#2f2f35',
  ok: '#4ade80',
  warn: '#fbbf24',
  crit: '#f87171',
  unknown: '#4b5563',
};

const ACCENT = {
  claude: '#d97757',
  codex: '#10a37f',
  none: '#4b5563',
};

const DEFAULT_THRESHOLDS = { warn: 60, crit: 85 };

/* ----------------------------------------------------------------- helpers */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function barColor(percent, thresholds) {
  if (percent === null || percent === undefined) return COLORS.unknown;
  const t = thresholds || DEFAULT_THRESHOLDS;
  if (percent >= t.crit) return COLORS.crit;
  if (percent >= t.warn) return COLORS.warn;
  return COLORS.ok;
}

/** Vertical centre of a text run of the given size inside a band. */
function centredBaseline(bandTop, bandHeight, fontSize) {
  return bandTop + bandHeight / 2 + fontSize * 0.355;
}

/**
 * Every provider reports a window as percent *used*. The display can show that
 * directly, or show what is left, which is what most people actually want to
 * know. Colour always keys off the used figure, so a threshold means the same
 * thing in either mode.
 */
function shown(usedPercent, showRemaining) {
  if (usedPercent === null || usedPercent === undefined) return null;
  return showRemaining ? 100 - usedPercent : usedPercent;
}

function pctText(w, showRemaining) {
  const v = w ? shown(w.percent, showRemaining) : null;
  return v === null ? '--' : `${Math.round(v)}%`;
}

/** Small right-aligned marker so a bare number is never ambiguous. */
function modeMark(showRemaining) {
  return showRemaining ? 'LEFT' : 'USED';
}

/** "19m", "4h20m", "3d" — short enough for a 200px strip. */
function shortCountdown(resetsAt) {
  if (!resetsAt) return null;
  const mins = Math.round((resetsAt - Date.now()) / 60000);
  if (mins <= 0) return 'due';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h${String(mins % 60).padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d${h % 24}h` : `${d}d`;
}

function clockTime(resetsAt) {
  if (!resetsAt) return null;
  return new Date(resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Greedy word wrap to a character budget, at most `maxLines` lines. */
function wrap(str, perLine, maxLines) {
  const words = String(str || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length <= perLine) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      cur = word.length > perLine ? word.slice(0, perLine - 1) + '\u2026' : word;
    }
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines.slice(0, maxLines);
}

function text(x, y, size, fill, content, opts = {}) {
  const anchor = opts.anchor ? ` text-anchor="${opts.anchor}"` : '';
  const weight = opts.weight ? ` font-weight="${opts.weight}"` : '';
  const spacing = opts.spacing ? ` letter-spacing="${opts.spacing}"` : '';
  const opacity = opts.opacity != null ? ` opacity="${opts.opacity}"` : '';
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}"` +
    `${anchor}${weight}${spacing}${opacity}>${esc(content)}</text>`;
}

function bar(x, y, w, h, percent, color) {
  const r = Math.min(3, h / 2);
  const track = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${COLORS.track}"/>`;
  if (percent === null || percent === undefined) return track;
  const filled = Math.max(0, Math.min(w, (w * percent) / 100));
  // A sliver still reads as "some usage"; zero width would read as "none".
  const drawn = percent > 0 ? Math.max(filled, 2) : 0;
  if (drawn <= 0) return track;
  return `${track}<rect x="${x}" y="${y}" width="${drawn}" height="${h}" rx="${r}" fill="${color}"/>`;
}

function svg(width, height, body, opacity) {
  const wrap = opacity != null && opacity < 1
    ? `<g opacity="${opacity}">${body}</g>`
    : body;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">${wrap}</svg>`;
}

function dataUri(svgString) {
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svgString)}`;
}

/** Heading such as "CLAUDE · work". Trimmed to fit the strip. */
function heading(state) {
  if (state.kind === 'none') return 'AI QUOTA';
  const provider = state.kind === 'codex' ? 'CODEX' : 'CLAUDE';
  const label = state.label && state.label !== 'codex' ? ` · ${state.label}` : '';
  return `${provider}${label}`.slice(0, 22);
}

/* -------------------------------------------------------------- strip 200x100 */

function stripBoth(state, t, rem) {
  const { data } = state;
  const five = data && data.fiveHour;
  const seven = data && data.sevenDay;
  const rows = [
    { label: '5h', w: five, y: 31 },
    { label: '7d', w: seven, y: 59 },
  ];

  let body = `<rect x="0" y="0" width="3" height="100" rx="1.5" fill="${state.accent}"/>`;
  body += text(11, 17, 12, COLORS.muted, heading(state), { weight: 600, spacing: 0.4 });
  body += text(196, 17, 9, COLORS.faint, modeMark(rem), { anchor: 'end', spacing: 0.5 });

  for (const row of rows) {
    const h = 14;
    const used = row.w && row.w.percent;
    const color = barColor(used, t);
    body += text(11, centredBaseline(row.y, h, 11), 11, COLORS.muted, row.label);
    body += bar(31, row.y, 104, h, shown(used, rem), color);
    body += text(196, centredBaseline(row.y, h, 15), 15, COLORS.text, pctText(row.w, rem), {
      anchor: 'end', weight: 600,
    });
  }

  const parts = [];
  const c5 = shortCountdown(five && five.resetsAt);
  const c7 = shortCountdown(seven && seven.resetsAt);
  if (c5) parts.push(`5h ${c5}`);
  if (c7) parts.push(`7d ${c7}`);
  if (parts.length) body += text(11, 92, 9, COLORS.faint, parts.join('  ·  '));
  if (state.staleLabel) {
    body += text(196, 92, 9, COLORS.warn, state.staleLabel, { anchor: 'end' });
  }
  return svg(200, 100, body, state.dim);
}

function stripWindow(state, t, which, rem) {
  const w = state.data && state.data[which];
  const title = which === 'fiveHour' ? '5 HOUR' : '7 DAY';
  const used = w && w.percent;
  const color = barColor(used, t);

  let body = `<rect x="0" y="0" width="3" height="100" rx="1.5" fill="${state.accent}"/>`;
  body += text(11, 17, 11, COLORS.muted, `${heading(state)} · ${title}`, { weight: 600, spacing: 0.4 });
  body += text(189, 17, 9, COLORS.faint, modeMark(rem), { anchor: 'end', spacing: 0.5 });
  body += text(11, 60, 38, COLORS.text, pctText(w, rem), { weight: 700 });
  body += bar(11, 70, 178, 10, shown(used, rem), color);

  const cd = shortCountdown(w && w.resetsAt);
  const at = clockTime(w && w.resetsAt);
  const foot = cd ? (at ? `resets in ${cd}  ·  ${at}` : `resets in ${cd}`) : 'no reset time';
  body += text(11, 94, 9, COLORS.faint, foot);
  if (state.staleLabel) {
    body += text(189, 94, 9, COLORS.warn, state.staleLabel, { anchor: 'end' });
  }
  return svg(200, 100, body, state.dim);
}

function stripExtra(state, t, rem) {
  const extra = (state.data && state.data.extra) || {};
  let body = `<rect x="0" y="0" width="3" height="100" rx="1.5" fill="${state.accent}"/>`;
  body += text(11, 17, 11, COLORS.muted, `${heading(state)} · EXTRA`, { weight: 600, spacing: 0.4 });
  if (extra.percent != null) {
    body += text(189, 17, 9, COLORS.faint, modeMark(rem), { anchor: 'end', spacing: 0.5 });
  }

  if (extra.unlimited) {
    body += text(11, 58, 26, COLORS.text, 'Unlimited', { weight: 700 });
    body += text(11, 84, 10, COLORS.faint, 'credit balance');
  } else if (extra.percent != null) {
    const disp = shown(extra.percent, rem);
    body += text(11, 58, 34, COLORS.text, `${disp.toFixed(1)}%`, { weight: 700 });
    body += bar(11, 68, 178, 10, disp, barColor(extra.percent, t));
    // Keep the footer in the same direction as the big number above it.
    let foot = 'extra usage';
    if (extra.used != null && extra.limit != null) {
      const n = rem ? Math.max(0, extra.limit - extra.used) : extra.used;
      foot = `${n.toLocaleString()} of ${extra.limit.toLocaleString()}${rem ? ' left' : ' used'}`;
    }
    body += text(11, 94, 9, COLORS.faint, foot);
  } else if (extra.balance !== null && extra.balance !== undefined) {
    body += text(11, 58, 30, COLORS.text, String(extra.balance), { weight: 700 });
    body += text(11, 84, 10, COLORS.faint, 'credits remaining');
  } else {
    body += text(11, 52, 14, COLORS.faint, 'No extra usage');
    body += text(11, 70, 11, COLORS.faint, 'on this account');
  }
  return svg(200, 100, body, state.dim);
}

/* ----------------------------------------------------------------- key 144 */

function keyImage(state, t, rem) {
  const { data } = state;
  const five = data && data.fiveHour;
  const seven = data && data.sevenDay;

  let body = `<rect x="0" y="0" width="144" height="144" fill="#17171a"/>`;
  body += `<rect x="0" y="0" width="144" height="4" fill="${state.accent}"/>`;
  body += text(72, 24, 13, COLORS.muted, heading(state), { anchor: 'middle', weight: 600 });
  body += text(72, 36, 9, COLORS.faint, modeMark(rem), { anchor: 'middle', spacing: 0.5 });

  const rows = [
    { label: '5h', w: five, y: 46 },
    { label: '7d', w: seven, y: 92 },
  ];
  for (const row of rows) {
    const used = row.w && row.w.percent;
    const color = barColor(used, t);
    body += text(12, row.y + 14, 12, COLORS.muted, row.label);
    body += text(132, row.y + 16, 22, COLORS.text, pctText(row.w, rem), { anchor: 'end', weight: 700 });
    body += bar(12, row.y + 24, 120, 10, shown(used, rem), color);
  }
  if (state.staleLabel) {
    body += text(72, 138, 10, COLORS.warn, state.staleLabel, { anchor: 'middle' });
  }
  return svg(144, 144, body, state.dim);
}

/* ---------------------------------------------------------------- agents */

/**
 * Colour is the whole message on an agent key: you read it from across the desk
 * and only lean in if something is amber. Green is the model working, amber is a
 * finished turn waiting on you, grey is neither.
 */
const AGENT_COLORS = {
  working: COLORS.ok,
  waiting: COLORS.warn,
  // Red, and the only state that is neither working nor merely finished: the agent
  // is stopped on an approval prompt and nothing moves until you answer it.
  blocked: COLORS.crit,
  idle: COLORS.muted,
  dormant: COLORS.faint,
  none: COLORS.unknown,
};

/**
 * Which Claude config directory a session belongs to, as a chip.
 *
 * The top bar is already spoken for by state, so the account gets its own colour
 * here instead. Pairs are solid rather than one colour at low opacity, because Qt's
 * SVG renderer is unreliable about fill-opacity and a chip that fails to paint its
 * background would leave unreadable text on the card.
 */
/**
 * Deliberately contains no green and no amber. Those two belong to state, and a
 * green WORK chip sitting beside a green WORKING bar reads as one signal repeated
 * rather than two different facts.
 */
const ACCOUNT_COLORS = {
  main: { fg: '#e8a184', bg: '#3b2620' }, // Claude orange, the default directory
  work: { fg: '#8fbcf0', bg: '#1e2c3e' }, // blue, by far the usual second account
};

/** Colours for any further ~/.claude* directory, in the same no-green spirit. */
const ACCOUNT_SPARE = [
  { fg: '#d8b4fe', bg: '#2d2340' },
  { fg: '#f0a6c8', bg: '#3a2030' },
  { fg: '#a5b4fc', bg: '#25273f' },
];

function accountStyle(account) {
  if (!account) return null;
  if (ACCOUNT_COLORS[account]) return ACCOUNT_COLORS[account];
  // Anything else gets a stable colour of its own, so a third account added later
  // does not silently share the second one's.
  let h = 0;
  for (let i = 0; i < account.length; i += 1) h = (h * 31 + account.charCodeAt(i)) >>> 0;
  return ACCOUNT_SPARE[h % ACCOUNT_SPARE.length];
}

/** The account chip, right-aligned to `right` on the given baseline. */
function accountChip(account, right, top) {
  const style = accountStyle(account);
  if (!style) return '';
  const label = String(account).toUpperCase().slice(0, 7);
  // Helvetica caps at 9.5px run a little over 6px each; the padding absorbs the rest.
  const w = Math.round(12 + label.length * 6.3);
  return `<rect x="${right - w}" y="${top}" width="${w}" height="16" rx="3.5" fill="${style.bg}"/>`
    + text(right - w / 2, top + 11.4, 9.5, style.fg, label, {
      anchor: 'middle', weight: 700, spacing: 0.5,
    });
}

const AGENT_WORDS = {
  working: 'WORKING',
  waiting: 'YOUR MOVE',
  blocked: 'BLOCKED',
  idle: 'IDLE',
  dormant: 'DORMANT',
  none: 'NO SESSION',
};

/** "6s", "43s", "2m", "22h27m", "4d" — the same scale agents.js prints. */
function ageText(ms) {
  if (ms == null) return '';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h${String(mins % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d`;
}

/** Strips the noise a branch name carries so the useful half survives truncation. */
function shortBranch(branch) {
  if (!branch) return null;
  if (branch === 'HEAD') return 'detached';
  return branch.replace(/^(feature|feat|fix|chore|db)\//, '');
}

/**
 * Wraps like `wrap`, but may also break immediately after a hyphen, underscore or
 * slash. Session labels are very often branch names, and a single 22-character
 * token would otherwise be truncated on one line while two lines sat empty below.
 */
function wrapTight(str, perLine, maxLines) {
  const tokens = String(str || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  const push = () => { if (cur) { lines.push(cur); cur = ''; } };

  for (const token of tokens) {
    if (lines.length >= maxLines) break;
    // Split into chunks that each end on a break character, so rejoining them
    // never invents a space that is not in the original.
    const chunks = token.match(/[^-_/]*[-_/]|[^-_/]+/g) || [token];
    for (const chunk of chunks) {
      const sep = cur && !/[-_/]$/.test(cur) ? ' ' : '';
      if ((cur + sep + chunk).length <= perLine) {
        cur += sep + chunk;
        continue;
      }
      push();
      if (lines.length >= maxLines) return lines.slice(0, maxLines);
      cur = chunk.length > perLine ? chunk.slice(0, perLine - 1) + '\u2026' : chunk;
    }
  }
  push();
  return lines.slice(0, maxLines);
}

function agentKey(session, settings = {}) {
  const state = session ? session.state : 'none';
  const accent = AGENT_COLORS[state] || AGENT_COLORS.none;
  const label = settings.customLabel || (session ? session.label : null);

  let body = `<rect x="0" y="0" width="144" height="144" fill="#17171a"/>`;
  body += `<rect x="0" y="0" width="144" height="5" fill="${accent}"/>`;
  // A left edge says this key will take you somewhere when pressed. Its absence is
  // the real signal: a session with no pane is history, and pressing does nothing.
  if (session && session.pane) {
    body += `<rect x="0" y="5" width="3" height="139" fill="${accent}" opacity="0.5"/>`;
  }

  // State word and account, on one line so the title gets the room.
  body += text(10, 23, 10, accent, AGENT_WORDS[state] || '', { weight: 700, spacing: 0.6 });
  if (session && session.account) body += accountChip(session.account, 134, 12);

  if (!session) {
    body += text(72, 78, 11, COLORS.faint, 'no Claude session', { anchor: 'middle' });
    body += text(72, 94, 11, COLORS.faint, 'for this key', { anchor: 'middle' });
    return svg(144, 144, body, 0.8);
  }

  // The title is what identifies the work, so it gets the largest type and the
  // most lines. Three lines of 13px is the most that fits above the footer.
  const lines = wrapTight(label, 17, 3);
  lines.forEach((line, i) => {
    body += text(10, 48 + i * 16, 13, COLORS.text, line, { weight: 600 });
  });

  // Footer: age is the liveness signal, so it is the biggest thing down here.
  body += `<rect x="10" y="104" width="124" height="1" fill="${COLORS.track}"/>`;
  const branch = shortBranch(session.branch);
  if (branch) body += text(10, 120, 9.5, COLORS.faint, branch.slice(0, 21));
  body += text(10, 137, 14, accent, ageText(session.ageMs), { weight: 700 });
  if (session.pr) {
    body += text(134, 137, 10, COLORS.faint, `#${session.pr}`, { anchor: 'end' });
  } else if (session.sessions > 1) {
    body += text(134, 137, 10, COLORS.faint, `${session.sessions} sess`, { anchor: 'end' });
  }
  return svg(144, 144, body, state === 'dormant' ? 0.6 : 1);
}

/** The second view: where the work actually is, rather than what it is called. */
function agentDetailKey(session) {
  const state = session ? session.state : 'none';
  const accent = AGENT_COLORS[state] || AGENT_COLORS.none;

  let body = `<rect x="0" y="0" width="144" height="144" fill="#17171a"/>`;
  body += `<rect x="0" y="0" width="144" height="5" fill="${accent}"/>`;
  body += text(10, 23, 10, COLORS.muted, 'WHERE', { weight: 700, spacing: 0.6 });
  if (session && session.account) body += accountChip(session.account, 134, 12);
  if (!session) {
    body += text(72, 80, 11, COLORS.faint, 'nothing bound', { anchor: 'middle' });
    return svg(144, 144, body, 0.8);
  }

  let y = 44;
  const put = (heading, value) => {
    if (!value) return;
    body += text(10, y, 8.5, COLORS.faint, heading, { spacing: 0.5 });
    const rows = wrapTight(value, 19, 2);
    rows.forEach((line, i) => {
      body += text(10, y + 13 + i * 12, 10.5, COLORS.text, line);
    });
    y += 13 + 12 * rows.length + 6;
  };
  // The account is already named by the chip in the header, so it does not get a
  // row of its own: three rows overflow the card once a branch wraps to two lines.
  put('BRANCH', session.branch || null);
  // The last path segment is the worktree; the full path never fits and the
  // parent directories are the same for every one of them anyway.
  put('WORKTREE', session.cwd ? session.cwd.split('/').slice(-2).join('/') : null);
  body += text(10, 137, 11, accent, `${ageText(session.ageMs)} ago`, { weight: 600 });
  // The pane this key jumps to, so it is possible to tell which one it means.
  if (session.pane) {
    body += text(134, 137, 10, COLORS.faint, session.pane, { anchor: 'end' });
  }
  return svg(144, 144, body, 1);
}

/**
 * A roll-up key: how many agents are in each state, without naming any of them.
 * Useful on one key when the other seven are bound to specific work.
 */
function agentSummaryKey(counts, total) {
  const live = (counts.working || 0) + (counts.waiting || 0) + (counts.blocked || 0);
  // Worst-first: a blocked agent outranks one merely waiting, which outranks work
  // in progress, because that is the order you would want to deal with them.
  const accent = counts.blocked ? COLORS.crit
    : counts.waiting ? COLORS.warn
      : counts.working ? COLORS.ok : COLORS.faint;

  let body = `<rect x="0" y="0" width="144" height="144" fill="#17171a"/>`;
  body += `<rect x="0" y="0" width="144" height="5" fill="${accent}"/>`;
  body += text(10, 22, 10, COLORS.muted, 'AGENTS', { weight: 700, spacing: 0.6 });
  body += text(72, 62, 34, COLORS.text, String(live), { anchor: 'middle', weight: 700 });
  body += text(72, 78, 9, COLORS.faint, 'active', { anchor: 'middle', spacing: 0.5 });

  const rows = [
    { word: 'blocked', n: counts.blocked || 0, c: COLORS.crit },
    { word: 'working', n: counts.working || 0, c: COLORS.ok },
    { word: 'your move', n: counts.waiting || 0, c: COLORS.warn },
  ];
  rows.forEach((r, i) => {
    const y = 98 + i * 15;
    body += `<rect x="10" y="${y - 7}" width="6" height="6" rx="1.5" fill="${r.c}"/>`;
    body += text(22, y, 10, COLORS.muted, r.word);
    body += text(134, y, 10, COLORS.text, String(r.n), { anchor: 'end', weight: 600 });
  });
  return svg(144, 144, body, total ? 1 : 0.7);
}

/** Views an agent key cycles through on press. */
const AGENT_VIEWS = ['status', 'where'];

function renderAgent(session, settings = {}, extra = {}) {
  if (settings.mode === 'summary') {
    return dataUri(agentSummaryKey(extra.counts || {}, extra.total || 0));
  }
  const view = AGENT_VIEWS[(settings.viewIndex || 0) % AGENT_VIEWS.length];
  if (view === 'where') return dataUri(agentDetailKey(session));
  return dataUri(agentKey(session, settings));
}

/* -------------------------------------------------------------- public API */

/**
 * Turns a registry cache entry into the flat shape the painters consume,
 * including how stale the reading is.
 */
function toState(entry, settings = {}) {
  const account = entry && entry.account ? entry.account : {};
  const kind = account.kind || 'claude';
  const label = settings.customLabel || account.label || (kind === 'none' ? null : kind);
  const ageMs = entry && entry.fetchedAt ? Date.now() - entry.fetchedAt : null;
  const never = !entry || !entry.data;
  const stale = !never && (!entry.ok || (ageMs !== null && ageMs > 6 * 60 * 1000));

  // Distinguish "the newest attempt just failed, but this number is still current"
  // from "this number is genuinely old", rather than announcing a useless "0m old".
  let staleLabel = null;
  if (!never && stale) {
    const mins = ageMs === null ? null : Math.floor(ageMs / 60000);
    if (mins === null) staleLabel = 'stale';
    else if (mins < 1) staleLabel = 'retrying';
    else staleLabel = `${mins}m old`;
  }

  return {
    kind,
    label,
    accent: ACCENT[kind] || ACCENT.claude,
    data: entry ? entry.data : null,
    ok: !!(entry && entry.ok),
    error: entry ? entry.error : null,
    staleLabel,
    dim: never ? 0.55 : stale ? 0.6 : 1,
  };
}

/** Views an account actually has something to show for. */
function availableViews(state) {
  const views = ['both', 'fiveHour', 'sevenDay'];
  const extra = state.data && state.data.extra;
  if (extra && (extra.enabled || extra.unlimited || extra.balance != null)) views.push('extra');
  return views;
}

/** Remaining is the default; `showRemaining: false` switches back to used. */
function remainingMode(settings) {
  return settings.showRemaining !== false;
}

function renderStrip(entry, settings = {}) {
  const state = toState(entry, settings);
  const t = thresholdsFrom(settings);
  const rem = remainingMode(settings);
  const views = availableViews(state);
  const view = views[(settings.viewIndex || 0) % views.length];
  if (!state.data) return dataUri(placeholderStrip(state));
  if (view === 'fiveHour' || view === 'sevenDay') return dataUri(stripWindow(state, t, view, rem));
  if (view === 'extra') return dataUri(stripExtra(state, t, rem));
  return dataUri(stripBoth(state, t, rem));
}

function renderKey(entry, settings = {}) {
  const state = toState(entry, settings);
  const t = thresholdsFrom(settings);
  if (!state.data) return dataUri(placeholderKey(state));
  return dataUri(keyImage(state, t, remainingMode(settings)));
}

function placeholderStrip(state) {
  let body = `<rect x="0" y="0" width="3" height="100" rx="1.5" fill="${state.accent}"/>`;
  body += text(11, 17, 12, COLORS.muted, heading(state), { weight: 600, spacing: 0.4 });
  body += text(11, 48, 20, COLORS.faint, '\u2014\u2014', { weight: 700, spacing: 2 });
  wrap(state.error || 'waiting for first reading', 34, 2).forEach((line, i) => {
    body += text(11, 70 + i * 12, 9.5, COLORS.faint, line);
  });
  return svg(200, 100, body, 0.75);
}

function placeholderKey(state) {
  let body = `<rect x="0" y="0" width="144" height="144" fill="#17171a"/>`;
  body += `<rect x="0" y="0" width="144" height="4" fill="${state.accent}"/>`;
  body += text(72, 30, 13, COLORS.muted, heading(state), { anchor: 'middle', weight: 600 });
  body += text(72, 76, 26, COLORS.faint, '\u2014', { anchor: 'middle', weight: 700 });
  wrap(state.error || 'waiting for first reading', 22, 3).forEach((line, i) => {
    body += text(72, 100 + i * 13, 10, COLORS.faint, line, { anchor: 'middle' });
  });
  return svg(144, 144, body, 0.8);
}

function thresholdsFrom(settings) {
  const warn = Number(settings.warnThreshold);
  const crit = Number(settings.critThreshold);
  return {
    warn: Number.isFinite(warn) ? warn : DEFAULT_THRESHOLDS.warn,
    crit: Number.isFinite(crit) ? crit : DEFAULT_THRESHOLDS.crit,
  };
}

module.exports = {
  renderStrip,
  renderKey,
  renderAgent,
  availableViews,
  toState,
  ageText,
  AGENT_VIEWS,
  DEFAULT_THRESHOLDS,
};
