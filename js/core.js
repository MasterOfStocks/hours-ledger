// core.js — the record engine. Pure functions only: no DOM, no storage.
// Runs unchanged in the browser and in Node (see tests/).
//
// One rule holds the whole app together: the log of entries is the only source
// of truth. Shifts, breaks, totals and pay are never stored; they are derived
// from the log every time by buildModel() and summarise().

export const FORMAT = 'hours-ledger/1';
export const GENESIS = '0'.repeat(64);

export const DEFAULT_SETTINGS = Object.freeze({
  timeZone: 'Europe/London',
  currency: 'GBP',
  rates: [{ from: '2000-01-01', rate: 10.85 }], // hourly rate history, by effective date
  payPeriodStartDay: 6, // period runs 6th -> 5th
  payDay: 15,
  weekStartsOn: 1, // 0 = Sunday, 1 = Monday
  breaksPaid: false,
  weeklyOvertimeAfterHours: null, // report hours above this per week; null = off
  captureLocation: true,
  employerSystem: 'Bizimply',
});

export const KIND_LABEL = {
  in: 'Clock in',
  out: 'Clock out',
  break_start: 'Break start',
  break_end: 'Break end',
};

const pad = (n, w = 2) => String(n).padStart(w, '0');

// ---------------------------------------------------------------- hashing

// Canonical JSON: keys sorted, undefined dropped. The same entry always
// serialises to the same string, so its hash is reproducible anywhere.
export function canonical(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
      .join(',') +
    '}'
  );
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
const toHex = (bytes) => Array.from(bytes, (b) => pad(b.toString(16))).join('');

// Plain-JS SHA-256, used only where WebCrypto is unavailable.
export function sha256Js(bytes) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const l = bytes.length;
  const buf = new Uint8Array(((l + 9 + 63) >> 6) << 6);
  buf.set(bytes);
  buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(l / 0x20000000));
  dv.setUint32(buf.length - 4, (l << 3) >>> 0);
  const w = new Uint32Array(64);
  for (let i = 0; i < buf.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return toHex(out);
}

export async function sha256Hex(input) {
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) {
    try {
      return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
    } catch {
      /* fall through */
    }
  }
  return sha256Js(bytes);
}

// ---------------------------------------------------------------- the log

export async function hashEntry(e) {
  const { hash, ...body } = e; // eslint-disable-line no-unused-vars
  return sha256Hex(canonical(body));
}

// Build the next entry in the chain. `prev` is the current last entry or null.
export async function makeEntry(prev, type, payload, nowMs, env) {
  const d = new Date(nowMs);
  const e = {
    v: 1,
    seq: prev ? prev.seq + 1 : 1,
    id: env.id,
    type,
    recordedAt: d.toISOString(), // device clock when this entry was written
    deviceTz: env.tz || null,
    deviceOffsetMin: -d.getTimezoneOffset(),
    payload,
    prevHash: prev ? prev.hash : GENESIS,
  };
  e.hash = await hashEntry(e);
  return e;
}

// Recompute every hash and check every link. Returns problems rather than throwing.
export async function verifyChain(entries) {
  const problems = [];
  const notices = [];
  let prev = null;
  for (const e of entries) {
    if (e.seq !== (prev ? prev.seq + 1 : 1)) {
      problems.push({ seq: e.seq, problem: `Sequence gap: expected ${prev ? prev.seq + 1 : 1}, found ${e.seq}.` });
    }
    if (e.prevHash !== (prev ? prev.hash : GENESIS)) {
      problems.push({ seq: e.seq, problem: 'Does not link to the record before it.' });
    }
    if ((await hashEntry(e)) !== e.hash) {
      problems.push({ seq: e.seq, problem: 'Contents do not match the stored fingerprint.' });
    }
    if (prev && Date.parse(e.recordedAt) < Date.parse(prev.recordedAt)) {
      notices.push({ seq: e.seq, notice: 'Device clock was earlier than at the previous record.' });
    }
    prev = e;
  }
  return {
    ok: problems.length === 0,
    count: entries.length,
    headSeq: prev ? prev.seq : 0,
    headHash: prev ? prev.hash : GENESIS,
    problems,
    notices,
  };
}

// ---------------------------------------------------------------- time

const fmtCache = new Map();
function partsFmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function wallParts(ms, tz) {
  const o = {};
  for (const p of partsFmt(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = +p.value;
  return { y: o.year, mo: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}

export function tzOffsetMs(ms, tz) {
  const p = wallParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

export function localDate(ms, tz) {
  const p = wallParts(ms, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

export function localTime(ms, tz, seconds = true) {
  const p = wallParts(ms, tz);
  return `${pad(p.h)}:${pad(p.mi)}` + (seconds ? `:${pad(p.s)}` : '');
}

// Wall-clock date + time in a zone -> instant. Flags the two awkward cases:
// a time that happens twice (clocks go back) and one that never happens (clocks go forward).
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const [h = 0, mi = 0, s = 0] = String(timeStr).split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(guess)) throw new Error('That date or time is not valid.');
  const before = tzOffsetMs(guess - 86400000, tz);
  const after = tzOffsetMs(guess + 86400000, tz);
  const cands = [...new Set([guess - before, guess - after])]
    .filter((c) => tzOffsetMs(c, tz) === guess - c)
    .sort((a, b) => a - b);
  if (cands.length === 0) return { ms: guess - before, ambiguous: false, nonexistent: true };
  return { ms: cands[0], ambiguous: cands.length > 1, nonexistent: false };
}

// Calendar maths on 'YYYY-MM-DD' strings.
export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
export const fmtDate = (utcMs) => new Date(utcMs).toISOString().slice(0, 10);
export const addDays = (s, n) => fmtDate(parseDate(s) + n * 86400000);
export const dayOfWeek = (s) => new Date(parseDate(s)).getUTCDay();

export function weekRange(s, weekStartsOn = 1) {
  const from = addDays(s, -((dayOfWeek(s) - weekStartsOn + 7) % 7));
  return { from, to: addDays(from, 6) };
}
export function monthRange(s) {
  const [y, m] = s.split('-').map(Number);
  return { from: `${y}-${pad(m)}-01`, to: fmtDate(Date.UTC(y, m, 0)) };
}
export function payPeriod(s, startDay = 6) {
  const [y, m, d] = s.split('-').map(Number);
  const mi = d >= startDay ? m - 1 : m - 2;
  return {
    from: fmtDate(Date.UTC(y, mi, startDay)),
    to: fmtDate(Date.UTC(y, mi + 1, startDay) - 86400000),
  };
}
// First pay day after the period closes (6 Oct - 5 Nov -> 15 Nov).
export function payDate(period, payDay = 15) {
  let d = addDays(period.to, 1);
  for (let i = 0; i < 62; i++) {
    if (+d.slice(8) === payDay) return d;
    d = addDays(d, 1);
  }
  return null;
}

// ---------------------------------------------------------------- formatting

export function fmtDur(sec) {
  const neg = sec < 0;
  sec = Math.abs(Math.round(sec));
  return `${neg ? '-' : ''}${Math.floor(sec / 3600)}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}
export const fmtHours = (sec) => (sec / 3600).toFixed(2);
export function fmtMoney(pence, currency = 'GBP') {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(pence / 100);
}

// ---------------------------------------------------------------- model

export function rateOn(settings, dateStr) {
  const rates = [...(settings.rates || [])].sort((a, b) => (a.from < b.from ? -1 : 1));
  let r = rates.length ? rates[0].rate : 0;
  for (const x of rates) if (x.from <= dateStr) r = x.rate;
  return r;
}

export function scheduledSec(p, settings) {
  if (p.off) return 0; // a "time off" day: on the rota, but no hours scheduled
  const tz = settings.timeZone;
  const s = zonedToUtc(p.date, p.start, tz).ms;
  const e = zonedToUtc(p.end <= p.start ? addDays(p.date, 1) : p.date, p.end, tz).ms;
  const brk = settings.breaksPaid ? 0 : (Number(p.breakMin) || 0) * 60;
  return Math.max(0, Math.round((e - s) / 1000) - brk);
}

// Turn clock events into shifts. Events are ordered by their *effective* time
// (the latest correction, or the original), so a correction re-flows everything.
export function deriveShifts(events, settings, nowMs) {
  const tz = settings.timeZone;
  const nowSec = Math.floor(nowMs / 1000);
  const sorted = [...events].sort((a, b) => a.atSec - b.atSec || a.seq - b.seq);
  const shifts = [];
  const orphans = [];
  let cur = null;

  const finish = (sh, endEv, isLast) => {
    sh.startMs = sh.startEv.atMs;
    sh.startSec = sh.startEv.atSec;
    sh.date = localDate(sh.startMs, tz); // a shift belongs to the day it started
    sh.onBreak = false;
    if (endEv) {
      sh.status = 'complete';
      sh.endEv = endEv;
      sh.endMs = endEv.atMs;
      sh.endSec = endEv.atSec;
    } else if (isLast) {
      sh.status = 'open';
      sh.endMs = null;
      sh.endSec = Math.max(nowSec, sh.startSec);
      if (sh.openBreak) {
        sh.onBreak = true;
        sh.breaks.push({ startEv: sh.openBreak.startEv, endEv: null, open: true });
      }
      if (sh.endSec - sh.startSec > 20 * 3600) {
        sh.anomalies.push('This shift has been open for more than 20 hours. If a clock-out was missed, add it.');
      }
    } else {
      sh.status = 'incomplete';
      sh.endMs = null;
      sh.endSec = null;
    }
    delete sh.openBreak;
    for (const b of sh.breaks) {
      b.startSec = b.startEv.atSec;
      b.endSec = b.endEv ? b.endEv.atSec : sh.endSec;
      b.sec = Math.max(0, b.endSec - b.startSec);
    }
    if (sh.status === 'incomplete') {
      // No end time: nothing can be honestly counted until the missing clock-out is added.
      sh.spanSec = 0; sh.breakSec = 0; sh.workedSec = 0;
    } else {
      sh.spanSec = sh.endSec - sh.startSec;
      sh.breakSec = sh.breaks.reduce((t, b) => t + b.sec, 0);
      sh.workedSec = Math.max(0, sh.spanSec - (settings.breaksPaid ? 0 : sh.breakSec));
    }
    shifts.push(sh);
  };

  for (const ev of sorted) {
    if (ev.kind === 'in') {
      if (cur) {
        cur.anomalies.push('No clock-out was recorded before the next clock-in. Hours for this shift are not counted until the missing clock-out is added.');
        finish(cur, null, false);
      }
      cur = { id: ev.id, startEv: ev, endEv: null, breaks: [], openBreak: null, events: [ev], anomalies: [] };
      continue;
    }
    if (!cur) { orphans.push(ev); continue; }
    cur.events.push(ev);
    if (ev.kind === 'break_start') {
      if (cur.openBreak) cur.anomalies.push('A break was started while another was still open. The second start is ignored.');
      else cur.openBreak = { startEv: ev };
    } else if (ev.kind === 'break_end') {
      if (!cur.openBreak) cur.anomalies.push('A break end was recorded with no break in progress. It is ignored.');
      else { cur.breaks.push({ startEv: cur.openBreak.startEv, endEv: ev }); cur.openBreak = null; }
    } else if (ev.kind === 'out') {
      if (cur.openBreak) {
        cur.anomalies.push('The shift ended while a break was still open. The break is counted up to clock-out.');
        cur.breaks.push({ startEv: cur.openBreak.startEv, endEv: ev, implied: true });
        cur.openBreak = null;
      }
      finish(cur, ev, false);
      cur = null;
    }
  }
  if (cur) finish(cur, null, true);
  return { shifts, orphans };
}

// Fold the whole log into everything the interface shows.
export function buildModel(entries, nowMs = Date.now()) {
  let settings = { ...DEFAULT_SETTINGS };
  const corrections = new Map();
  const marks = new Map(); // targetId -> latest void / restore entry
  const locations = new Map();
  const superseded = new Set();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };

  for (const e of entries) {
    const p = e.payload || {};
    if (e.type === 'settings') settings = { ...DEFAULT_SETTINGS, ...p.settings };
    else if (e.type === 'correction') push(corrections, p.targetId, e);
    else if (e.type === 'void' || e.type === 'restore') marks.set(p.targetId, e);
    else if (e.type === 'location') push(locations, p.targetId, e);
    if (p.supersedes) superseded.add(p.supersedes);
  }
  const voidOf = (id) => (marks.get(id) && marks.get(id).type === 'void' ? marks.get(id) : null);

  // The bin: everything currently voided. Items binned together (a whole shift) share a batchId.
  const byId = new Map(entries.map((e) => [e.id, e]));
  const binGroups = new Map();
  for (const [targetId, mark] of marks) {
    if (mark.type !== 'void' || !byId.has(targetId)) continue;
    const key = mark.payload.batchId || mark.id;
    if (!binGroups.has(key)) {
      binGroups.set(key, { key, batch: !!mark.payload.batchId, binnedMs: Date.parse(mark.recordedAt), reason: mark.payload.reason || '', label: mark.payload.label || '', items: [] });
    }
    binGroups.get(key).items.push(byId.get(targetId));
  }
  const bin = [...binGroups.values()].sort((a, b) => b.binnedMs - a.binnedMs);
  const live = (e) => !voidOf(e.id) && !superseded.has(e.id);

  const clock = entries.filter((e) => e.type === 'clock').map((e) => {
    const corr = corrections.get(e.id) || [];
    const last = corr[corr.length - 1];
    const originalMs = Date.parse(e.payload.at);
    const atMs = last ? Date.parse(last.payload.newAt) : originalMs;
    return {
      id: e.id, seq: e.seq, kind: e.payload.kind, source: e.payload.source || 'live',
      note: e.payload.note || '', originalMs, atMs, atSec: Math.floor(atMs / 1000),
      corrected: corr.length > 0, corrections: corr, voided: !!voidOf(e.id), voidEntry: voidOf(e.id),
      recordedMs: Date.parse(e.recordedAt), locations: locations.get(e.id) || [], entry: e,
    };
  });
  const clockById = new Map(clock.map((c) => [c.id, c]));

  const { shifts, orphans } = deriveShifts(clock.filter((c) => !c.voided), settings, nowMs);

  const schedule = entries
    .filter((e) => e.type === 'schedule' && live(e))
    .map((e) => ({ id: e.id, ...e.payload, scheduledSec: scheduledSec(e.payload, settings), entry: e }))
    .sort((a, b) => (a.date + a.start < b.date + b.start ? -1 : 1));
  const scheduledByDate = new Map();
  for (const s of schedule) if (!s.off) scheduledByDate.set(s.date, (scheduledByDate.get(s.date) || 0) + s.scheduledSec);

  const employer = new Map();
  for (const e of entries) if (e.type === 'employer' && live(e)) employer.set(e.payload.shiftId, { id: e.id, ...e.payload, entry: e });

  const payslips = entries
    .filter((e) => e.type === 'payslip' && live(e))
    .map((e) => ({ id: e.id, ...e.payload, entry: e }));

  const evidence = entries
    .filter((e) => e.type === 'evidence')
    .map((e) => ({ id: e.id, ...e.payload, voided: !!voidOf(e.id), recordedMs: Date.parse(e.recordedAt), entry: e }));
  const notes = entries
    .filter((e) => e.type === 'note')
    .map((e) => ({ id: e.id, ...e.payload, voided: !!voidOf(e.id), recordedMs: Date.parse(e.recordedAt), entry: e }));

  for (const sh of shifts) {
    const rate = rateOn(settings, sh.date);
    sh.ratePence = Math.round(rate * 100);
    sh.payPence = Math.round((sh.workedSec * sh.ratePence) / 3600);
    sh.scheduledSec = scheduledByDate.has(sh.date) ? scheduledByDate.get(sh.date) : null;
    sh.employer = employer.get(sh.id) || null;
    sh.corrected = sh.events.some((ev) => ev.corrected);
    sh.manual = sh.events.some((ev) => ev.source === 'manual');
    sh.fromRota = sh.events.some((ev) => ev.entry.payload.basis === 'rota'); // recorded "as scheduled" from a rota entry
    sh.eventIds = new Set(sh.events.map((ev) => ev.id));
  }
  shifts.sort((a, b) => a.startSec - b.startSec);
  const open = shifts.length && shifts[shifts.length - 1].status === 'open' ? shifts[shifts.length - 1] : null;

  return {
    settings, entries, clock, clockById, shifts, orphans, schedule, scheduledByDate, employer,
    payslips, evidence, notes, open, bin,
    status: open ? (open.onBreak ? 'break' : 'working') : 'off',
    voidOf,
    head: entries.length ? entries[entries.length - 1] : null,
  };
}

// Totals for any inclusive date range. Every figure in the app comes from here.
export function summarise(model, from, to) {
  const shifts = model.shifts.filter((s) => s.date >= from && s.date <= to);
  let spanSec = 0, breakSec = 0, workedSec = 0, payNum = 0, employerHours = 0, employerCount = 0, flagged = 0, open = 0;
  for (const s of shifts) {
    spanSec += s.spanSec; breakSec += s.breakSec; workedSec += s.workedSec;
    payNum += s.workedSec * s.ratePence;
    if (s.employer && s.employer.paidHours != null) { employerHours += Number(s.employer.paidHours) || 0; employerCount++; }
    if (s.anomalies.length || s.status === 'incomplete') flagged++;
    if (s.status === 'open') open++;
  }
  // The rota is compared with worked time only on days that have a usable record.
  // A scheduled shift with no record is listed as unrecorded; it is never counted as hours owed or lost.
  const anyShift = new Set(shifts.map((s) => s.date));
  const usable = new Set(shifts.filter((s) => s.status !== 'incomplete').map((s) => s.date));
  let schedSec = 0, schedCount = 0, schedPayNum = 0, matchedSched = 0, matchedCount = 0, matchedWorked = 0;
  const unrecorded = [];
  const rotaDates = new Set();
  for (const s of model.schedule) {
    if (s.off || s.date < from || s.date > to) continue;
    schedSec += s.scheduledSec; schedCount++;
    schedPayNum += s.scheduledSec * Math.round(rateOn(model.settings, s.date) * 100);
    if (usable.has(s.date)) { matchedSched += s.scheduledSec; matchedCount++; rotaDates.add(s.date); }
    else if (!anyShift.has(s.date)) unrecorded.push(s);
  }
  for (const s of shifts) if (s.status !== 'incomplete' && rotaDates.has(s.date)) matchedWorked += s.workedSec;
  return {
    scheduledPayPence: Math.round(schedPayNum / 3600),
    rotaMatchedCount: matchedCount,
    rotaVarianceSec: matchedCount ? matchedWorked - matchedSched : null,
    unrecorded,
    from, to, shifts, count: shifts.length, spanSec, breakSec, workedSec,
    payPence: Math.round(payNum / 3600),
    scheduledSec: schedSec, scheduledCount: schedCount,
    employerHours, employerCount, flagged, open,
  };
}

// Week-by-week breakdown of a range, with hours above the weekly threshold if one is set.
export function weeksIn(model, from, to) {
  const out = [];
  const limit = model.settings.weeklyOvertimeAfterHours;
  let w = weekRange(from, model.settings.weekStartsOn);
  while (w.from <= to) {
    const s = summarise(model, w.from, w.to);
    out.push({
      ...w, workedSec: s.workedSec, count: s.count, scheduledSec: s.scheduledSec,
      overSec: limit ? Math.max(0, s.workedSec - limit * 3600) : null,
      partial: w.from < from || w.to > to,
    });
    w = { from: addDays(w.from, 7), to: addDays(w.to, 7) };
  }
  return out;
}
