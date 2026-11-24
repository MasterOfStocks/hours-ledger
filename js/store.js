// store.js — where records live on the device.
// The log is append-only: this module offers no way to edit or delete one entry.
// IndexedDB is used when available; otherwise an in-memory store (nothing saved).

import { makeEntry } from './core.js';

const DB_NAME = 'hours-ledger';
const DB_VERSION = 1;

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onerror = () => rej(tx.error);
  tx.onabort = () => rej(tx.error || new Error('Storage transaction was aborted.'));
});

export function uuid() {
  const c = globalThis.crypto;
  if (c && c.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const deviceTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } };

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { keyPath: 'seq' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('Storage is blocked by another open tab.'));
  });
}

class IdbStore {
  constructor(db) { this.db = db; this.saved = true; this.queue = Promise.resolve(); }

  all() { return req(this.db.transaction('log').objectStore('log').getAll()); }

  async last() {
    const cur = await req(this.db.transaction('log').objectStore('log').openCursor(null, 'prev'));
    return cur ? cur.value : null;
  }

  // Append one entry. `nowMs` is captured by the caller at the moment of the tap,
  // so waiting for storage never shifts a recorded time.
  append(type, payload, nowMs = Date.now()) {
    const run = async () => {
      const prev = await this.last();
      const entry = await makeEntry(prev, type, payload, nowMs, { id: uuid(), tz: deviceTz() });
      const tx = this.db.transaction('log', 'readwrite');
      tx.objectStore('log').add(entry); // add() refuses to overwrite an existing seq
      await done(tx);
      return entry;
    };
    const locked = () => (navigator.locks ? navigator.locks.request('hours-ledger-append', run) : run());
    const job = this.queue.then(locked);
    this.queue = job.catch(() => {});
    return job;
  }

  async putBlob(rec) { const tx = this.db.transaction('blobs', 'readwrite'); tx.objectStore('blobs').put(rec); await done(tx); }
  getBlob(id) { return req(this.db.transaction('blobs').objectStore('blobs').get(id)); }

  async getMeta(key) { const r = await req(this.db.transaction('meta').objectStore('meta').get(key)); return r ? r.value : null; }
  async setMeta(key, value) { const tx = this.db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key, value }); await done(tx); }

  // Restore from a backup. Used only by import, after the backup's chain has been verified.
  async load(entries, blobs, { replace }) {
    const tx = this.db.transaction(['log', 'blobs'], 'readwrite');
    if (replace) { tx.objectStore('log').clear(); tx.objectStore('blobs').clear(); }
    for (const e of entries) tx.objectStore('log').put(e);
    for (const b of blobs) tx.objectStore('blobs').put(b);
    await done(tx);
  }

  async eraseAll() {
    const tx = this.db.transaction(['log', 'blobs', 'meta'], 'readwrite');
    tx.objectStore('log').clear(); tx.objectStore('blobs').clear(); tx.objectStore('meta').clear();
    await done(tx);
  }
}

class MemoryStore {
  constructor() { this.saved = false; this.log = []; this.blobs = new Map(); this.meta = new Map(); this.queue = Promise.resolve(); }
  async all() { return [...this.log]; }
  async last() { return this.log[this.log.length - 1] || null; }
  append(type, payload, nowMs = Date.now()) {
    const job = this.queue.then(async () => {
      const entry = await makeEntry(await this.last(), type, payload, nowMs, { id: uuid(), tz: deviceTz() });
      this.log.push(entry);
      return entry;
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async putBlob(rec) { this.blobs.set(rec.id, rec); }
  async getBlob(id) { return this.blobs.get(id) || null; }
  async getMeta(key) { return this.meta.has(key) ? this.meta.get(key) : null; }
  async setMeta(key, value) { this.meta.set(key, value); }
  async load(entries, blobs, { replace }) {
    if (replace) { this.log = []; this.blobs.clear(); }
    const bySeq = new Map(this.log.map((e) => [e.seq, e]));
    for (const e of entries) bySeq.set(e.seq, e);
    this.log = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    for (const b of blobs) this.blobs.set(b.id, b);
  }
  async eraseAll() { this.log = []; this.blobs.clear(); this.meta.clear(); }
}

export async function openStore({ memory = false } = {}) {
  if (!memory && typeof indexedDB !== 'undefined') {
    try { return new IdbStore(await openDb()); } catch (e) { console.warn('IndexedDB unavailable:', e); }
  }
  return new MemoryStore();
}
