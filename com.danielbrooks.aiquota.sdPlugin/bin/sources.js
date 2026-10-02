'use strict';
/**
 * sources.js — discovers Claude Code accounts and the Codex account, reads their
 * OAuth tokens, and polls each provider's first-party usage endpoint.
 *
 * Security contract:
 *   - Tokens are read from the macOS keychain and ~/.codex/auth.json, held only in
 *     memory, and sent only to their own provider's host.
 *   - No token, or any fragment of one, is ever logged, cached to disk, or attached
 *     to an error message.
 *   - Usage responses (never tokens) are shared through ~/Library/Caches/ai-usage-shared
 *     with the Claude Usage menu bar app, so the two don't both poll every account.
 *   - Tokens are NEVER refreshed here. Refreshing would rotate the refresh token out
 *     from under the owning CLI and force an interactive re-login. An expired token
 *     is reported as stale and left for a real CLI session to renew.
 */

const https = require('node:https');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const KEYCHAIN_ACCOUNT = process.env.USER || os.userInfo().username;

/** The CLI's own margin: treat a token as expired this long before it truly expires. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15000;

/**
 * How long to leave a source alone after it answers 429, doubling while the 429s
 * keep coming. The usage endpoints do rate limit, and a quota readout that is a
 * few minutes stale is far better than one being throttled. A success resets it.
 */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 30 * 60 * 1000;

/** Gap between requests within one refresh, so several accounts are not a burst. */
const STAGGER_MS = 400;

/**
 * Cloudflare fronts chatgpt.com and fingerprints the TLS handshake. Node 20's
 * default cipher and extension ordering trips its bot challenge and comes back
 * 403 with `cf-mitigated: challenge`, while Node 24 passes. Since the Stream Deck
 * app runs plugins under its bundled Node 20, the handshake has to be spelled out
 * to look like an ordinary client. Verified 403 -> 200 on Node 20.20.0 and still
 * 200 on Node 24.15.0.
 *
 * Anthropic's endpoint has no such challenge, so this is applied to Codex only.
 */
const CODEX_TLS = {
  ciphers: [
    'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
  ].join(':'),
  sigalgs: [
    'ecdsa_secp256r1_sha256', 'rsa_pss_rsae_sha256', 'rsa_pkcs1_sha256',
    'ecdsa_secp384r1_sha384', 'rsa_pss_rsae_sha384', 'rsa_pkcs1_sha384',
    'rsa_pss_rsae_sha512', 'rsa_pkcs1_sha512',
  ].join(':'),
  ecdhCurve: 'X25519:prime256v1:secp384r1',
  minVersion: 'TLSv1.2',
};

let cachedCodexUA = null;

/**
 * Cloudflare in front of chatgpt.com refuses a request with no User-Agent, and
 * refuses well-known scripting agents. Identify as the Codex CLI family, whose
 * credentials and endpoint these are, while still naming this client.
 */
function codexUserAgent() {
  if (cachedCodexUA) return cachedCodexUA;
  let version = '0.144.1';
  const candidates = [];
  const nvm = path.join(HOME, '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvm)) {
      candidates.push(path.join(nvm, v, 'lib', 'node_modules', '@openai', 'codex', 'package.json'));
    }
  } catch { /* no nvm; fall through to the other candidates */ }
  candidates.push('/opt/homebrew/lib/node_modules/@openai/codex/package.json');
  candidates.push('/usr/local/lib/node_modules/@openai/codex/package.json');
  for (const c of candidates) {
    const pkg = readJSONFile(c);
    if (pkg && typeof pkg.version === 'string') { version = pkg.version; break; }
  }
  cachedCodexUA = `codex_cli_rs/${version} (macOS ${os.release()}; ${os.arch()}) StreamDeck-AIQuota`;
  return cachedCodexUA;
}

const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10080;

/* ------------------------------------------------------------------ helpers */

/**
 * Error text from a failed request can quote a header, and a JSON parse error can
 * quote the start of a credential blob. Strip anything token-shaped, with or
 * without a `Bearer` prefix, before the text goes anywhere. Truncation happens
 * last: slicing first could cut a token mid-string and defeat the match.
 */
function redact(value) {
  const msg = value && value.message ? String(value.message) : String(value);
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <redacted>')
    .replace(/sk-ant-[A-Za-z0-9._~+/-]+/gi, '<redacted>')
    .replace(/eyJ[A-Za-z0-9._~+/-]{16,}/g, '<redacted>')
    .replace(/"(access|refresh|id)_?[Tt]oken"\s*:\s*"[^"]*"/g, '"$1Token":"<redacted>"')
    .slice(0, 200);
}

/** `security` exit codes worth translating into something a person can act on. */
const SECURITY_ERRORS = {
  44: 'not signed in on this Mac',   // errSecItemNotFound
  45: 'keychain access was denied',  // errSecAuthFailed / user cancelled
  36: 'keychain is locked',
};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) {
        const code = err.code;
        const known = path.basename(cmd) === 'security' ? SECURITY_ERRORS[code] : null;
        reject(new Error(known || `${path.basename(cmd)} failed (code ${code ?? 'unknown'})`));
      } else {
        resolve(stdout);
      }
    });
  });
}

const RETRY_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

/** GET with one retry on the statuses that are transient rather than fatal. */
async function getJSONRetrying(url, headers, options = {}, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await getJSON(url, headers, options);
    } catch (e) {
      lastErr = e;
      const status = e && e.status;
      const retryable = status === undefined || RETRY_STATUS.has(status);
      if (i === attempts - 1 || !retryable) break;
      // A 429 usually carries Retry-After. Waiting longer than the whole poll
      // cycle is pointless, so cap it and let the next cycle pick things up.
      const wait = Math.min(e.retryAfterMs || 0, 5000) || 900 + Math.random() * 600;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function getJSON(url, headers, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, ...options }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          // Anthropic sends `retry-after: 0` on a 429, which says nothing useful,
          // so only a positive value is taken and otherwise our own backoff wins.
          const ra = Number(res.headers['retry-after']);
          if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('malformed JSON response'));
        }
      });
    });
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('request timed out')));
    req.on('error', (e) => reject(new Error(redact(e))));
    req.end();
  });
}

function readJSONFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Seconds-since-epoch `exp` out of a JWT, without verifying it. Null if absent. */
function jwtExpiryMs(token) {
  try {
    const seg = String(token).split('.')[1];
    if (!seg) return null;
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpired(expiresAtMs) {
  return typeof expiresAtMs === 'number' && Date.now() + EXPIRY_MARGIN_MS >= expiresAtMs;
}

/* -------------------------------------------------------- account discovery */

/**
 * Claude Code derives its keychain service name from the config directory:
 * no suffix when CLAUDE_CONFIG_DIR is unset, otherwise "-" plus the first 8 hex
 * characters of the SHA-256 of the NFC-normalised absolute directory path.
 */
function keychainServiceFor(configDir, isDefault) {
  if (isDefault) return 'Claude Code-credentials';
  const hash = crypto.createHash('sha256').update(configDir.normalize('NFC')).digest('hex');
  return `Claude Code-credentials-${hash.slice(0, 8)}`;
}

function labelForDir(configDir, isDefault) {
  if (isDefault) return 'main';
  const base = path.basename(configDir);
  const m = base.match(/^\.claude[-_]?(.+)$/);
  return (m && m[1] ? m[1] : base.replace(/^\./, '')).slice(0, 12);
}

async function keychainItemExists(service) {
  try {
    await run('/usr/bin/security', ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds every Claude config directory that still has a matching keychain item.
 * Orphaned keychain entries whose directory is gone are skipped, by construction:
 * discovery starts from directories on disk, not from the keychain.
 */
async function discoverClaudeAccounts() {
  const candidates = [];
  const defaultDir = path.join(HOME, '.claude');
  if (fs.existsSync(defaultDir)) {
    candidates.push({ configDir: defaultDir, isDefault: true, configFile: path.join(HOME, '.claude.json') });
  }
  let entries = [];
  try {
    entries = fs.readdirSync(HOME, { withFileTypes: true });
  } catch { /* unreadable home, fall through with what we have */ }

  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.claude') || e.name === '.claude') continue;
    const dir = path.join(HOME, e.name);
    candidates.push({ configDir: dir, isDefault: false, configFile: path.join(dir, '.claude.json') });
  }

  const accounts = [];
  for (const c of candidates) {
    const service = keychainServiceFor(c.configDir, c.isDefault);
    if (!(await keychainItemExists(service))) continue;
    const cfg = readJSONFile(c.configFile) || {};
    const oauth = cfg.oauthAccount || {};
    accounts.push({
      id: `claude:${c.isDefault ? 'default' : path.basename(c.configDir).replace(/^\./, '')}`,
      kind: 'claude',
      label: labelForDir(c.configDir, c.isDefault),
      email: oauth.emailAddress || null,
      org: oauth.organizationName || null,
      configDir: c.configDir,
      service,
    });
  }
  return accounts;
}

function discoverCodexAccount() {
  const authPath = path.join(HOME, '.codex', 'auth.json');
  if (!fs.existsSync(authPath)) return null;
  const auth = readJSONFile(authPath);
  const tokens = auth && auth.tokens;
  if (!tokens || !tokens.access_token || !tokens.account_id) return null;
  let email = null;
  const claims = (() => {
    try {
      const seg = String(tokens.id_token || tokens.access_token).split('.')[1];
      return seg ? JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) : null;
    } catch {
      return null;
    }
  })();
  if (claims && typeof claims.email === 'string') email = claims.email;
  return { id: 'codex', kind: 'codex', label: 'codex', email, org: null, authPath };
}

async function discoverAll() {
  const claude = await discoverClaudeAccounts();
  const codex = discoverCodexAccount();
  return codex ? [...claude, codex] : claude;
}

/* --------------------------------------------------------------- fetching */

async function fetchClaudeRaw(account) {
  const raw = await run('/usr/bin/security', [
    'find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-w', '-s', account.service,
  ]);
  let blob;
  try {
    blob = JSON.parse(raw);
  } catch {
    throw new Error('keychain item is not readable JSON');
  }
  const oauth = blob.claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error('no OAuth token in keychain item');
  if (isExpired(oauth.expiresAt)) throw new Error('token expired, run a Claude session to renew');

  return getJSONRetrying('https://api.anthropic.com/api/oauth/usage', {
    Authorization: `Bearer ${oauth.accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'StreamDeck-AIQuota',
  });
}

function parseClaude(data) {
  const extra = data.extra_usage || {};
  return {
    fiveHour: window(data.five_hour, FIVE_HOUR_MINUTES),
    sevenDay: window(data.seven_day, SEVEN_DAY_MINUTES),
    extra: {
      enabled: extra.is_enabled === true,
      percent: numOrNull(extra.utilization),
      used: numOrNull(extra.used_credits),
      limit: numOrNull(extra.monthly_limit),
      decimals: numOrNull(extra.decimal_places),
    },
  };

  function window(w, minutes) {
    if (!w) return null;
    return {
      percent: clampPercent(w.utilization),
      resetsAt: w.resets_at ? Date.parse(w.resets_at) : null,
      windowMinutes: minutes,
    };
  }
}

async function fetchCodexRaw(account) {
  const auth = readJSONFile(account.authPath);
  const tokens = auth && auth.tokens;
  if (!tokens || !tokens.access_token) throw new Error('no Codex token on disk');
  if (!tokens.account_id) throw new Error('Codex account id missing, sign in again');
  const exp = jwtExpiryMs(tokens.access_token);
  if (isExpired(exp)) throw new Error('token expired, run a Codex session to renew');

  return getJSONRetrying('https://chatgpt.com/backend-api/codex/usage', {
    Authorization: `Bearer ${tokens.access_token}`,
    'chatgpt-account-id': tokens.account_id,
    originator: 'codex_cli_rs',
    'User-Agent': codexUserAgent(),
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }, CODEX_TLS);
}

function parseCodex(data) {
  const rl = data.rate_limit || {};
  const credits = data.credits || {};
  return {
    fiveHour: window(rl.primary_window),
    sevenDay: window(rl.secondary_window),
    extra: {
      enabled: credits.has_credits === true || credits.unlimited === true,
      percent: null,
      used: null,
      limit: null,
      balance: numOrNull(credits.balance),
      unlimited: credits.unlimited === true,
    },
    planType: typeof data.plan_type === 'string' ? data.plan_type : null,
    // Banked "reset my limits" credits; applicable = usable right now.
    resetCredits: numOrNull((data.rate_limit_reset_credits || {}).available_count),
    resetCreditsUsable: numOrNull((data.rate_limit_reset_credits || {}).applicable_available_count),
  };

  function window(w) {
    if (!w) return null;
    return {
      percent: clampPercent(w.used_percent),
      resetsAt: typeof w.reset_at === 'number' ? w.reset_at * 1000 : null,
      windowMinutes: typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds / 60 : null,
    };
  }
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function fetchRaw(account) {
  if (account.kind === 'claude') return fetchClaudeRaw(account);
  if (account.kind === 'codex') return fetchCodexRaw(account);
  throw new Error(`unknown source kind: ${account.kind}`);
}

function parse(account, body) {
  return account.kind === 'claude' ? parseClaude(body) : parseCodex(body);
}

async function fetchOne(account) {
  return parse(account, await fetchRaw(account));
}

/* ------------------------------------------------------------ shared cache */

/**
 * Claude Usage (the menu bar app) reads the same accounts and is the primary
 * poller. Both keep one file per account here and check it before calling. This
 * plugin follows: a response younger than SHARED_FRESH_MS (two of the app's
 * ~3 minute polls, plus jitter) is used as is, so while the app runs the plugin
 * never calls the endpoints itself and only takes over when the app is closed. another reader's in-flight attempt or a 429
 * cooldown is waited out, and only then is the endpoint called. Same format as
 * Sources/ClaudeUsage/SharedUsage.swift in claude-usage; times are ms epoch.
 * Holds raw usage responses only, never a token. Files are 0600 in a 0700 dir.
 */
const SHARED_DIR = process.env.AI_USAGE_SHARED_DIR || path.join(HOME, 'Library', 'Caches', 'ai-usage-shared');
const SHARED_FRESH_MS = 390 * 1000;
const SHARED_ATTEMPT_HOLD_MS = 30 * 1000;

function sharedFile(account) {
  if (SHARED_DIR === 'off') return null; // tests that need every call to reach the network
  const dir = account.kind === 'claude' ? account.configDir : path.dirname(account.authPath || '');
  return dir ? path.join(SHARED_DIR, `${account.kind}-${path.basename(dir)}.json`) : null;
}

function readShared(file) {
  const j = file && readJSONFile(file);
  return j && typeof j === 'object' ? j : null;
}

function writeShared(file, account, entry) {
  if (!file) return;
  try {
    fs.mkdirSync(SHARED_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    const dir = account.kind === 'claude' ? account.configDir : path.dirname(account.authPath);
    fs.writeFileSync(tmp, JSON.stringify({
      provider: account.kind,
      dir,
      body: entry.body || null,
      fetchedAt: entry.fetchedAt || null,
      attemptAt: entry.attemptAt || null,
      cooldownUntil: entry.cooldownUntil || null,
      backoffMs: entry.backoffMs || 0,
      writer: 'StreamDeck-AIQuota',
    }), { mode: 0o600 });
    fs.renameSync(tmp, file); // atomic, so a reader never sees half a file
  } catch { /* the cache is an optimisation; polling still works without it */ }
}

/** 'use' | 'cooldown' | 'hold' | 'fetch' for a shared entry at `now`. */
function decideShared(e, now) {
  if (!e) return 'fetch';
  if (e.body && e.fetchedAt && now - e.fetchedAt < SHARED_FRESH_MS) return 'use';
  if (e.cooldownUntil && e.cooldownUntil > now) return 'cooldown';
  if (e.attemptAt && now - e.attemptAt < SHARED_ATTEMPT_HOLD_MS && e.attemptAt > (e.fetchedAt || 0)) return 'hold';
  return 'fetch';
}

function sharedWait(e, until, rateLimited) {
  const err = new Error(rateLimited ? 'rate limited' : 'another app is fetching');
  err.sharedWait = { until, rateLimited, body: e ? e.body : null, fetchedAt: e ? e.fetchedAt : null };
  return err;
}

/** Usage for one account through the shared cache: { data, fetchedAt }. */
async function fetchShared(account, now = Date.now()) {
  const file = sharedFile(account);
  const entry = readShared(file) || {};
  switch (file ? decideShared(entry, now) : 'fetch') {
    case 'use': return { data: parse(account, entry.body), fetchedAt: entry.fetchedAt };
    case 'cooldown': throw sharedWait(entry, entry.cooldownUntil, true);
    case 'hold': throw sharedWait(entry, entry.attemptAt + SHARED_ATTEMPT_HOLD_MS, false);
    default: break;
  }
  writeShared(file, account, { ...entry, attemptAt: now });
  let body;
  try {
    body = await fetchRaw(account);
  } catch (e) {
    if (e && e.status === 429) {
      const latest = readShared(file) || entry;
      const backoffMs = Math.min(Math.max((latest.backoffMs || 0) * 2, RATE_LIMIT_COOLDOWN_MS), RATE_LIMIT_COOLDOWN_MAX_MS);
      const cooldownUntil = Date.now() + Math.max(backoffMs, e.retryAfterMs || 0);
      writeShared(file, account, { ...latest, backoffMs, cooldownUntil });
      throw sharedWait(latest, cooldownUntil, true);
    }
    throw e;
  }
  const fetchedAt = Date.now();
  // Re-read so another reader's newer fields are not clobbered.
  writeShared(file, account, { ...(readShared(file) || entry), body, fetchedAt, cooldownUntil: null, backoffMs: 0 });
  return { data: parse(account, body), fetchedAt };
}

/* --------------------------------------------------------------- registry */

/**
 * Holds the discovered accounts and one cache entry per source. A reading that
 * fails leaves the previous good value in place, flagged stale, so the display
 * degrades rather than blanking or showing a misleading zero.
 */
class Registry {
  constructor({ onUpdate } = {}) {
    this.accounts = [];
    this.cache = new Map(); // id -> { account, data, fetchedAt, ok, error }
    this.onUpdate = onUpdate || (() => {});
    this.discoveredAt = 0;
    this.cooldownUntil = new Map(); // id -> ms epoch; set after a 429
    this.cooldownStreak = new Map(); // id -> consecutive 429s, for backoff
    this.discovering = null;        // shared promise while a discovery is running
  }

  discover() {
    // Concurrent callers join the running discovery rather than starting another.
    if (this.discovering) return this.discovering;
    this.discovering = this._discover().finally(() => { this.discovering = null; });
    return this.discovering;
  }

  async _discover() {
    this.accounts = await discoverAll();
    this.discoveredAt = Date.now();
    const live = new Set();
    for (const a of this.accounts) {
      live.add(a.id);
      if (!this.cache.has(a.id)) {
        this.cache.set(a.id, { account: a, data: null, fetchedAt: 0, ok: false, error: null, gone: false });
      } else {
        const entry = this.cache.get(a.id);
        entry.account = a;
        entry.gone = false;
      }
    }
    // Signed out, or its config directory removed: refresh will never reach it
    // again, so say so rather than leave a real-looking number quietly ageing.
    for (const [id, entry] of this.cache) {
      if (!live.has(id) && !entry.gone) {
        entry.gone = true;
        entry.ok = false;
        entry.error = 'signed out on this Mac';
      }
    }
    return this.accounts;
  }

  get(id) {
    return this.cache.get(id) || null;
  }

  list() {
    return this.accounts.slice();
  }

  /** Polls the given source ids, or every known source when none are given. */
  async refresh(ids) {
    if (!this.accounts.length || Date.now() - this.discoveredAt > 10 * 60 * 1000) {
      await this.discover();
    }
    const wanted = ids && ids.length
      ? this.accounts.filter((a) => ids.includes(a.id))
      : this.accounts;

    await Promise.allSettled(wanted.map(async (account, i) => {
      if (!this.cache.has(account.id)) {
        this.cache.set(account.id, { account, data: null, fetchedAt: 0, ok: false, error: null });
      }
      const entry = this.cache.get(account.id);
      if (i > 0) await new Promise((r) => setTimeout(r, i * STAGGER_MS));

      // Rate limited a moment ago: skip rather than make it worse. The cached
      // reading stays on screen and simply ages.
      const until = this.cooldownUntil.get(account.id) || 0;
      if (Date.now() < until) return;

      try {
        const { data, fetchedAt } = await fetchShared(account);
        entry.data = data;
        entry.fetchedAt = fetchedAt;
        entry.ok = true;
        entry.error = null;
        this.cooldownUntil.delete(account.id);
        this.cooldownStreak.delete(account.id);
      } catch (e) {
        if (e && e.sharedWait) {
          // Claude Usage (or our own earlier 429) holds this account off for now.
          const w = e.sharedWait;
          if (w.body && w.fetchedAt && w.fetchedAt > (entry.fetchedAt || 0)) {
            entry.data = parse(account, w.body);
            entry.fetchedAt = w.fetchedAt;
          }
          if (w.rateLimited) {
            entry.ok = false;
            this.cooldownUntil.set(account.id, w.until);
            entry.error = `rate limited, retrying in ${Math.max(1, Math.ceil((w.until - Date.now()) / 60000))}m`;
          } else if (entry.data) {
            entry.ok = true; // the other app's fresh result lands in the cache shortly
          }
          this.onUpdate(account.id, entry);
          return;
        }
        entry.ok = false;
        if (e && e.status === 429) {
          const streak = (this.cooldownStreak.get(account.id) || 0) + 1;
          this.cooldownStreak.set(account.id, streak);
          const backoff = Math.min(
            RATE_LIMIT_COOLDOWN_MS * 2 ** (streak - 1),
            RATE_LIMIT_COOLDOWN_MAX_MS
          );
          const wait = Math.max(e.retryAfterMs || 0, backoff);
          this.cooldownUntil.set(account.id, Date.now() + wait);
          entry.error = `rate limited, retrying in ${Math.round(wait / 60000)}m`;
        } else {
          entry.error = redact(e);
        }
        // entry.data is deliberately left alone: last good value stays on screen.
      }
      this.onUpdate(account.id, entry);
    }));
    return this.cache;
  }
}

/* ------------------------------------------------------------- standalone */

function fmtPct(w) {
  return w && w.percent !== null ? `${String(Math.round(w.percent)).padStart(3)}%` : '  --';
}

function fmtReset(w) {
  if (!w || !w.resetsAt) return '';
  const mins = Math.max(0, Math.round((w.resetsAt - Date.now()) / 60000));
  if (mins < 60) return `resets in ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `resets in ${h}h${String(mins % 60).padStart(2, '0')}m`;
  return `resets in ${Math.floor(h / 24)}d`;
}

async function main() {
  const reg = new Registry();
  const accounts = await reg.discover();
  if (!accounts.length) {
    console.log('No Claude or Codex accounts found.');
    process.exit(1);
  }
  console.log(`Discovered ${accounts.length} source(s):\n`);
  for (const a of accounts) {
    console.log(`  ${a.id.padEnd(16)} label=${a.label.padEnd(8)} ${a.email || '(no email on file)'}`);
  }
  console.log('\nFetching...\n');
  await reg.refresh();

  let failures = 0;
  for (const a of accounts) {
    const e = reg.get(a.id);
    if (e.ok && e.data) {
      const d = e.data;
      console.log(
        `  ${a.label.padEnd(8)} 5h ${fmtPct(d.fiveHour)}  7d ${fmtPct(d.sevenDay)}   ` +
        `${fmtReset(d.fiveHour)}`.padEnd(20) + `${fmtReset(d.sevenDay)}`
      );
      if (d.extra && d.extra.enabled && d.extra.percent !== null) {
        console.log(`  ${' '.repeat(8)} extra usage ${d.extra.percent.toFixed(1)}% of ${d.extra.limit}`);
      }
    } else {
      failures += 1;
      console.log(`  ${a.label.padEnd(8)} FAILED: ${e.error}`);
    }
  }
  console.log('');
  process.exit(failures ? 2 : 0);
}

module.exports = {
  Registry,
  redact,
  discoverAll,
  discoverClaudeAccounts,
  discoverCodexAccount,
  keychainServiceFor,
  decideShared,
  fetchShared,
  sharedFile,
  parseCodex,
  FIVE_HOUR_MINUTES,
  SEVEN_DAY_MINUTES,
};

if (require.main === module) {
  main().catch((e) => {
    console.error('fatal:', redact(e));
    process.exit(1);
  });
}
