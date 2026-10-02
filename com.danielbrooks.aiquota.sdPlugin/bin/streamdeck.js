'use strict';
/**
 * streamdeck.js — a thin client for the Stream Deck plugin WebSocket protocol.
 *
 * The app launches the plugin process with -port, -pluginUUID, -registerEvent and
 * -info, then expects a single registration frame on ws://127.0.0.1:<port>. Every
 * other message is a JSON object of the form {event, context, payload}.
 */

const WebSocket = require('ws');
const { EventEmitter } = require('node:events');

/** Give up after this many consecutive failed reconnects. */
const MAX_RECONNECT_ATTEMPTS = 8;

/** Cap on queued messages while disconnected. */
const MAX_QUEUE = 200;

/** Parses the four arguments the Stream Deck app passes on launch. */
function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (typeof key !== 'string' || !key.startsWith('-')) continue;
    const value = argv[i + 1];
    if (value === undefined || (typeof value === 'string' && value.startsWith('-') && key !== '-info')) continue;
    out[key.slice(1)] = value;
    i += 1;
  }
  let info = {};
  if (out.info) {
    try {
      info = JSON.parse(out.info);
    } catch { /* malformed -info is not fatal; devices simply stay unknown */ }
  }
  return {
    port: Number(out.port),
    pluginUUID: out.pluginUUID,
    registerEvent: out.registerEvent || 'registerPlugin',
    info,
  };
}

class StreamDeck extends EventEmitter {
  constructor(args) {
    super();
    this.args = args;
    this.ws = null;
    this.connected = false;
    this.queue = [];
    this.reconnectDelay = 500;
    this.closing = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
  }

  connect() {
    if (!Number.isFinite(this.args.port) || !this.args.pluginUUID) {
      throw new Error('missing -port or -pluginUUID; not launched by Stream Deck');
    }
    this.ws = new WebSocket(`ws://127.0.0.1:${this.args.port}`);

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 500;
      this.reconnectAttempts = 0;
      this.ws.send(JSON.stringify({ event: this.args.registerEvent, uuid: this.args.pluginUUID }));
      const queued = this.queue.splice(0);
      for (const msg of queued) this.ws.send(msg);
      this.emit('open');
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || !msg.event) return;
      try {
        this.emit(msg.event, msg);
        this.emit('*', msg);
      } catch (err) {
        // One malformed message must not abandon the rest of the chain.
        this.emit('handlerError', err, msg.event);
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      if (this.closing) return;
      this.emit('close');
      // The app restarts plugins rather than dropping them, so a close usually
      // means the app is going away. Retry a bounded number of times in case it
      // was a transient socket error, then stop so an orphan can exit instead of
      // reconnecting every ten seconds for the rest of the login session.
      this.reconnectAttempts += 1;
      if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        this.emit('gaveUp', this.reconnectAttempts);
        return;
      }
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      // Unref'd like every other timer here, so a dead plugin does not keep the
      // process alive on its own.
      if (this.reconnectTimer.unref) this.reconnectTimer.unref();
    });

    this.ws.on('error', (err) => this.emit('socketError', err));
    return this;
  }

  send(event, context, payload) {
    const msg = JSON.stringify(
      payload === undefined ? { event, context } : { event, context, payload }
    );
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
      return;
    }
    if (this.queue.length >= MAX_QUEUE) {
      // Make room by discarding the oldest repaint, which is worthless by now,
      // rather than the write that just arrived.
      const stale = this.queue.findIndex((m) => m.startsWith('{"event":"setFeedback"')
        || m.startsWith('{"event":"setImage"'));
      if (stale !== -1) this.queue.splice(stale, 1);
      else if (event === 'setFeedback' || event === 'setImage') return;
      else this.queue.shift();
    }
    this.queue.push(msg);
  }

  /* ------------------------------------------------------------ commands */

  setImage(context, image, opts = {}) {
    this.send('setImage', context, { image, target: opts.target ?? 0, state: opts.state ?? 0 });
  }

  setTitle(context, title, opts = {}) {
    this.send('setTitle', context, { title, target: opts.target ?? 0, state: opts.state ?? 0 });
  }

  setFeedback(context, payload) {
    this.send('setFeedback', context, payload);
  }

  setFeedbackLayout(context, layout) {
    this.send('setFeedbackLayout', context, { layout });
  }

  setSettings(context, settings) {
    this.send('setSettings', context, settings);
  }

  getSettings(context) {
    this.send('getSettings', context);
  }

  setGlobalSettings(settings) {
    this.send('setGlobalSettings', this.args.pluginUUID, settings);
  }

  getGlobalSettings() {
    this.send('getGlobalSettings', this.args.pluginUUID);
  }

  sendToPropertyInspector(context, payload) {
    this.send('sendToPropertyInspector', context, payload);
  }

  showAlert(context) {
    this.send('showAlert', context);
  }

  showOk(context) {
    this.send('showOk', context);
  }

  openUrl(url) {
    this.send('openUrl', this.args.pluginUUID, { url });
  }

  log(message) {
    this.send('logMessage', undefined, { message: String(message).slice(0, 4000) });
  }

  close() {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }
}

module.exports = { StreamDeck, parseArgs };
