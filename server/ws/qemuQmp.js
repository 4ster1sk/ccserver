// Minimal QMP (QEMU Machine Protocol) client: one connection to a VM's
// -qmp unix socket, used to hot-plug virtiofs shares (see qemuShares.js).
//
// QMP is line-delimited JSON. After the greeting the client must send
// qmp_capabilities; then every command gets exactly one reply ({return} or
// {error}) in order, and asynchronous {event} lines may arrive at any time.
// Commands are matched to replies by their `id`.

import { connect } from 'node:net';

export class QmpError extends Error {
  constructor(command, error) {
    super(`QMP ${command}: ${error?.desc || error?.class || 'error'}`);
    this.name = 'QmpError';
    this.qmpClass = error?.class || null;
  }
}

export class QmpClient {
  #sock;
  #buf = '';
  #nextId = 1;
  #pending = new Map(); // id -> { resolve, reject, command }
  #waiters = new Set(); // { name, match, resolve, reject, timer }
  #closed = false;
  #closeError = null;
  #greeting;
  #onGreeting;

  constructor(sock) {
    this.#sock = sock;
    this.#greeting = new Promise((resolve, reject) => { this.#onGreeting = { resolve, reject }; });
    this.#greeting.catch(() => {});
    sock.setEncoding('utf-8');
    sock.on('data', (d) => this.#onData(d));
    sock.on('error', (e) => this.#fail(e));
    sock.on('close', () => this.#fail(new Error('QMP connection closed')));
  }

  // Connects, waits for the greeting and negotiates capabilities.
  static async connect(socketPath, { timeoutMs = 5000 } = {}) {
    const client = new QmpClient(connect(socketPath));
    let timer;
    try {
      client.greeting = await Promise.race([
        client.#greeting,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`QMP greeting timed out (${socketPath})`)), timeoutMs); }),
      ]);
      await client.execute('qmp_capabilities');
    } catch (e) {
      client.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    return client;
  }

  get closed() {
    return this.#closed;
  }

  execute(command, args = undefined) {
    if (this.#closed) return Promise.reject(this.#closeError || new Error('QMP connection closed'));
    const id = this.#nextId++;
    const msg = { execute: command, id };
    if (args !== undefined) msg.arguments = args;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, command });
      this.#sock.write(`${JSON.stringify(msg)}\n`);
    });
  }

  // Resolves with the next event named `name` whose data satisfies match().
  // Register before issuing the command that triggers it, so an event that
  // arrives together with the command's reply is not missed.
  waitEvent(name, match = () => true, timeoutMs = 10000) {
    if (this.#closed) return Promise.reject(this.#closeError || new Error('QMP connection closed'));
    return new Promise((resolve, reject) => {
      const w = { name, match, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        this.#waiters.delete(w);
        reject(new Error(`timed out waiting for QMP event ${name}`));
      }, timeoutMs);
      this.#waiters.add(w);
    });
  }

  close() {
    this.#fail(new Error('QMP connection closed'));
    this.#sock.destroy();
  }

  #onData(d) {
    this.#buf += d;
    let nl;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    if (msg.QMP) {
      this.#onGreeting.resolve(msg.QMP);
      return;
    }
    if (msg.event) {
      for (const w of [...this.#waiters]) {
        if (w.name !== msg.event) continue;
        let ok = false;
        try { ok = w.match(msg.data || {}); } catch { ok = false; }
        if (!ok) continue;
        clearTimeout(w.timer);
        this.#waiters.delete(w);
        w.resolve(msg.data || {});
      }
      return;
    }
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.error) p.reject(new QmpError(p.command, msg.error));
    else p.resolve(msg.return);
  }

  #fail(err) {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = err;
    this.#onGreeting.reject(err);
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    for (const w of this.#waiters) { clearTimeout(w.timer); w.reject(err); }
    this.#waiters.clear();
  }
}
