// app.js — the interface. It only ever does two things with data:
// append a new entry to the log, or re-derive what is on screen from the log.

import * as C from './core.js';
import { openStore, uuid } from './store.js';
import { makeZip, readZip } from './zip.js';

const PREVIEW = !!window.HL_PREVIEW;
const NATIVE = typeof window.HLNative !== 'undefined'; // running inside the Android app
const VERSION = (document.querySelector('meta[name="app-version"]') || {}).content || 'dev';
// iPhone and iPad. An iPad can report itself as a Mac, so touch support is checked too.
const IOS = !NATIVE && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
// Opened from the Home Screen rather than in a browser tab.
const STANDALONE = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
const main = document.getElementById('main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let store;
let entries = [];
let model;
let chain = null;
let persisted = null;
let lastBackup = null;
let objectUrls = [];
let pendingLink = null;
const rep = { type: 'pay', anchor: null, from: null, to: null };
const bc = (() => { try { return new BroadcastChannel('hours-ledger'); } catch { return null; } })();

// ---------------------------------------------------------------- helpers

const tz = () => model.settings.timeZone;
const cur = () => model.settings.currency;
const today = () => C.localDate(Date.now(), tz());
const fmtT = (ms) => C.localTime(ms, tz());
const dFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dFmtShort = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtD = (d) => dFmt.format(new Date(C.parseDate(d)));
const fmtDs = (d) => dFmtShort.format(new Date(C.parseDate(d)));
const fmtDT = (ms) => `${fmtD(C.localDate(ms, tz()))}, ${fmtT(ms)}`;
const fmtRange = (r) => (r.from === r.to ? fmtD(r.from) : `${fmtDs(r.from)} – ${fmtD(r.to)}`);
const money = (p) => C.fmtMoney(p, cur());
const signed = (sec) => (sec > 0 ? '+' : '') + C.fmtDur(sec);
const pill = (text, tone = 'mute') => `<span class="pill pill--${tone}">${esc(text)}</span>`;
const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const bytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

async function add(type, payload, nowMs) {
  const e = await store.append(type, payload, nowMs);
  if (bc) bc.postMessage('changed');
  return e;
}

async function refresh(soft = false) {
  entries = await store.all();
  model = C.buildModel(entries, Date.now());
  render(soft);
}

function toast(msg, tone = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast--${tone}`;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), tone === 'bad' ? 9000 : 4000);
}

// Inside the Android app, files are handed to the app shell in pieces and saved to Downloads/Hours Ledger.
async function nativeSave(blob, name, share) {
  const id = window.HLNative.fileBegin();
  const STEP = 3 * 256 * 1024;
  for (let off = 0; off < blob.size; off += STEP) {
    const u8 = new Uint8Array(await blob.slice(off, off + STEP).arrayBuffer());
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    if (!window.HLNative.fileChunk(id, btoa(bin))) throw new Error('The file could not be written to the phone.');
  }
  const res = String(window.HLNative.fileEnd(id, name, blob.type || 'application/octet-stream', !!share));
  if (!res.startsWith('ok:')) throw new Error(res.replace(/^error:/, '') || 'The file could not be saved.');
  return res.slice(3);
}

// On an iPhone a web app cannot write to a folder itself. The file is handed to the share sheet, where
// "Save to Files" keeps it and any other choice sends it. The sheet only opens from a tap, so the file is
// prepared first and offered on a button. Resolves true once it has been handed over, false if the person backs out.
function iosSave(blob, name) {
  return new Promise((resolve) => {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const url = URL.createObjectURL(blob);
    let done = false;
    const kb = blob.size < 1024 * 1024 ? `${Math.max(1, Math.round(blob.size / 1024))} KB` : `${(blob.size / 1048576).toFixed(1)} MB`;
    const d = dialog({ title: 'File ready', body: `<p><b>${esc(name)}</b> <span class="mute">${kb}</span></p>
      <p class="note">${canShare ? 'Tap the button, then choose <b>Save to Files</b> to keep it on this iPhone or in iCloud Drive, or send it to yourself.' : 'Open the file, then use the share button to save it to Files.'}</p>
      <div class="btnrow">${canShare ? '<button type="button" class="btn btn--primary" data-ios-share>Save or send</button>' : `<a class="btn btn--primary" data-ios-open href="${url}" download="${esc(name)}" target="_blank" rel="noopener">Open file</a>`}</div>` });
    const err = d.querySelector('.dlg__err');
    const share = d.querySelector('[data-ios-share]');
    if (share) share.addEventListener('click', async () => {
      err.hidden = true;
      try { await navigator.share({ files: [file] }); done = true; d.close(); } catch (e) {
        if (e && e.name === 'AbortError') return; // the sheet was dismissed: leave the dialog open to try again
        err.textContent = 'The share sheet could not be opened. ' + (e && e.message ? e.message : ''); err.hidden = false;
      }
    });
    const open = d.querySelector('[data-ios-open]');
    if (open) open.addEventListener('click', () => { done = true; setTimeout(() => d.close(), 300); });
    d.addEventListener('close', () => { setTimeout(() => URL.revokeObjectURL(url), 30000); resolve(done); });
  });
}

// An iPhone keeps a Safari tab's records apart from the Home Screen app's, and can clear a tab's records
// after a week without a visit. So the app asks to be installed before anything is recorded in a tab.
function iosInstallCard() {
  if (!IOS || STANDALONE || PREVIEW) return '';
  return `<section class="card card--warn"><h2>Add this app to your Home Screen first</h2>
    <ol class="steps"><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open <b>Hours Ledger</b> from the Home Screen and record there.</li></ol>
    <p class="note">Records made in this browser tab stay in the tab. They do not move to the Home Screen app, and Safari can clear them after seven days without a visit. The Home Screen app keeps its records until you remove it, and works with no connection.</p></section>`;
}

// Returns where the file went (a folder path in the Android app, otherwise true), or false if nothing was saved.
async function download(blob, name, share = false) {
  if (PREVIEW) { toast('Downloads are switched off in this preview. They work in the installed app.', 'warn'); return false; }
  if (NATIVE) return nativeSave(blob, name, share);
  if (IOS) return iosSave(blob, name);
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

function dialog({ title, body, submit = 'Save', danger = false, onSubmit, wide = false }) {
  const d = document.createElement('dialog');
  d.className = 'dlg' + (wide ? ' dlg--wide' : '');
  d.innerHTML = `<form class="dlg__form" novalidate>
    <h2>${esc(title)}</h2>
    <div class="dlg__body">${body}</div>
    <p class="dlg__err" role="alert" hidden></p>
    <div class="dlg__actions">
      <button type="button" class="btn" data-close>${onSubmit ? 'Cancel' : 'Close'}</button>
      ${onSubmit ? `<button type="submit" class="btn ${danger ? 'btn--stop' : 'btn--primary'}">${esc(submit)}</button>` : ''}
    </div></form>`;
  document.body.append(d);
  const form = d.querySelector('form');
  const err = d.querySelector('.dlg__err');
  d.querySelector('[data-close]').addEventListener('click', () => d.close());
  d.addEventListener('close', () => d.remove());
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!onSubmit) return;
    err.hidden = true;
    try {
      if (!form.reportValidity()) return;
      const out = await onSubmit(Object.fromEntries(new FormData(form)), form);
      if (out !== false) d.close();
    } catch (e) {
      err.textContent = e.message || String(e);
      err.hidden = false;
    }
  });
  d.showModal();
  return d;
}

const field = (id, label, input, help = '') =>
  `<div class="field"><label for="${id}">${label}</label>${input}${help ? `<small>${help}</small>` : ''}</div>`;

function toInstant(date, time) {
  const z = C.zonedToUtc(date, time, tz());
  return z;
}

// ---------------------------------------------------------------- routing

const NAV = { shift: 'shifts', more: 'more', rota: 'more', evidence: 'more', bin: 'more', audit: 'more', setup: 'more' };

function route() {
  const h = location.hash.replace(/^#/, '') || 'dashboard';
  if (h.startsWith('shift-')) return { name: 'shift', id: h.slice(6) };
  return { name: VIEWS[h] ? h : 'dashboard' };
}

function render(soft = false) {
  if (soft) {
    const a = document.activeElement;
    if (a && main.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
  }
  const r = route();
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
  main.innerHTML = banners() + (r.name === 'shift' ? vShift(r.id) : VIEWS[r.name]());
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === r.name || (a.closest('.tabbar') && NAV[r.name] === a.dataset.nav);
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  hydrateThumbs();
  if (r.name === 'audit') runVerify();
}

function banners() {
  let out = '';
  if (PREVIEW) {
    out += `<div class="banner banner--info"><b>Preview with example data.</b> Nothing here is saved, and location, camera and downloads are switched off. Use it to try the interface; record real hours only in the installed app.</div>`;
  } else if (!store.saved) {
    out += `<div class="banner banner--bad"><b>Records are not being saved.</b> This browser is blocking on-device storage (private browsing can do this). Anything you record now will be lost when the page closes.</div>`;
  }
  if (chain && !chain.ok) {
    out += `<div class="banner banner--bad"><b>The record chain failed its check</b> at record #${chain.problems[0].seq}. <a href="#audit">Open the audit log</a>.</div>`;
  }
  return out;
}

// ---------------------------------------------------------------- shared pieces

function shiftPills(sh) {
  const p = [];
  if (sh.status === 'open') p.push(pill(sh.onBreak ? 'On break' : 'In progress', sh.onBreak ? 'warn' : 'ok'));
  if (sh.status === 'incomplete') p.push(pill('Missing clock-out', 'bad'));
  else if (sh.anomalies.length) p.push(pill('Check', 'warn'));
  if (sh.corrected) p.push(pill('Corrected'));
  if (sh.fromRota) p.push(pill('From rota'));
  else if (sh.manual) p.push(pill('Entered by hand'));
  return p.join('');
}

function timesText(sh) {
  const start = fmtT(sh.startMs);
  if (sh.status === 'complete') {
    const next = C.localDate(sh.endMs, tz()) !== sh.date ? '<sup title="Ends the next day">+1</sup>' : '';
    return `${start} – ${fmtT(sh.endMs)}${next}`;
  }
  return `${start} – ${sh.status === 'open' ? 'now' : '?'}`;
}

function shiftRow(sh) {
  return `<a class="row" href="#shift-${sh.id}">
    <span class="row__date">${esc(fmtD(sh.date))}</span>
    <span class="row__times num">${timesText(sh)}</span>
    <span class="row__flags">${shiftPills(sh)}</span>
    <span class="row__worked num">${sh.status === 'incomplete' ? '–' : C.fmtDur(sh.workedSec)}</span>
  </a>`;
}

const tile = (label, key, value, sub, foot = '') =>
  `<div class="tile"><div class="tile__label">${label}</div>
   <div class="tile__value num" data-live="${key}-worked">${value}</div>
   <div class="tile__sub num" data-live="${key}-sub">${sub}</div>${foot ? `<div class="tile__foot">${foot}</div>` : ''}</div>`;

const sumSub = (x) => `${C.fmtHours(x.workedSec)} h · ${money(x.payPence)}`;

function attention() {
  const items = [];
  for (const sh of model.shifts) {
    if (sh.status === 'incomplete' || sh.anomalies.length) {
      items.push(`<li><a href="#shift-${sh.id}">${esc(fmtD(sh.date))}</a>: ${esc(sh.status === 'incomplete' ? 'Missing clock-out. This shift is not being counted.' : sh.anomalies[0])}</li>`);
    }
  }
  if (model.orphans.length) items.push(`<li><a href="#shifts">${model.orphans.length} record${model.orphans.length > 1 ? 's' : ''}</a> could not be matched to a shift.</li>`);
  if (!PREVIEW && store.saved) {
    if (persisted === false) items.push(`<li>This browser has not promised to keep the app's storage. Install the app to your home screen and keep regular backups. <a href="#setup">Storage and backup</a></li>`);
    const head = model.head ? model.head.seq : 0;
    if (head > 0 && (!lastBackup || lastBackup.seq < head)) {
      const n = head - (lastBackup ? lastBackup.seq : 0);
      const stale = !lastBackup || Date.now() - lastBackup.at > 7 * 86400000;
      if (stale) items.push(`<li>${lastBackup ? `${n} record${n > 1 ? 's' : ''} added since the last backup on ${esc(fmtDT(lastBackup.at))}.` : 'No backup has been exported from this device yet.'} <a href="#setup">Export a backup</a></li>`);
    }
  }
  return items.length ? `<section class="card card--warn"><h2>Needs attention</h2><ul class="plain">${items.join('')}</ul></section>` : '';
}

// ---------------------------------------------------------------- dashboard

function vDashboard() {
  const s = model.settings, t = today(), o = model.open;
  const wk = C.weekRange(t, s.weekStartsOn), pp = C.payPeriod(t, s.payPeriodStartDay);
  const day = C.summarise(model, t, t), week = C.summarise(model, wk.from, wk.to), pay = C.summarise(model, pp.from, pp.to);
  const sys = esc(s.employerSystem || "your employer's system");
  const clockNow = `<span class="status__now num" data-live="now">${fmtT(Date.now())}</span>`;
  let status;
  if (!o) {
    const last = model.shifts.filter((x) => x.status === 'complete').pop();
    status = `<section class="status status--off">
      <div class="status__top"><span class="status__state">Not clocked in</span>${clockNow}</div>
      <div class="status__big num">0:00:00</div>
      <p class="status__meta">${last ? `Last shift: ${esc(fmtD(last.date))}, ${C.fmtDur(last.workedSec)} worked` : 'No shifts recorded yet.'}</p>
      <div class="status__actions"><button class="btn btn--go btn--xl" data-action="clock" data-kind="in">Clock in</button></div>
      <p class="status__hint">Tap at the same moment you clock in on ${sys}.</p>
    </section>`;
  } else if (!o.onBreak) {
    status = `<section class="status status--working">
      <div class="status__top"><span class="status__state">Working</span>${clockNow}</div>
      <div class="status__big num" data-live="open-worked">${C.fmtDur(o.workedSec)}</div>
      <p class="status__meta">Clocked in ${fmtT(o.startMs)}, ${esc(fmtD(o.date))} · breaks so far <span class="num" data-live="open-break">${C.fmtDur(o.breakSec)}</span></p>
      <div class="status__actions">
        <button class="btn btn--warn btn--xl" data-action="clock" data-kind="break_start">Start break</button>
        <button class="btn btn--stop btn--xl" data-action="clock" data-kind="out">Clock out</button>
      </div>
      <p class="status__hint"><a href="#shift-${o.id}">Open this shift</a> to add a screenshot or a note.</p>
    </section>`;
  } else {
    const b = o.breaks.find((x) => x.open);
    status = `<section class="status status--break">
      <div class="status__top"><span class="status__state">On break</span>${clockNow}</div>
      <div class="status__big num" data-live="open-break-cur">${C.fmtDur(b ? b.sec : 0)}</div>
      <p class="status__meta">Break started ${b ? fmtT(b.startEv.atMs) : ''} · worked so far <span class="num" data-live="open-worked">${C.fmtDur(o.workedSec)}</span></p>
      <div class="status__actions">
        <button class="btn btn--go btn--xl" data-action="clock" data-kind="break_end">End break</button>
        <button class="btn btn--xl" data-action="clock" data-kind="out">Clock out</button>
      </div>
      <p class="status__hint"><a href="#shift-${o.id}">Open this shift</a> to add a screenshot or a note.</p>
    </section>`;
  }
  const recent = model.shifts.slice(-6).reverse();
  return `<header class="page-head"><h1>Dashboard</h1><p>${esc(fmtD(t))}</p></header>
    ${iosInstallCard()}
    ${status}
    <section class="tiles">
      ${tile('Today', 'day', C.fmtDur(day.workedSec), sumSub(day), `${day.count} shift${day.count === 1 ? '' : 's'} started today`)}
      ${tile('This week', 'week', C.fmtDur(week.workedSec), sumSub(week), esc(fmtRange(wk)))}
      ${tile('This pay period', 'pay', C.fmtDur(pay.workedSec), sumSub(pay), `${esc(fmtRange(pp))} · paid ${esc(fmtDs(C.payDate(pp, s.payDay)))}`)}
    </section>
    ${attention()}
    <section class="card"><div class="card__head"><h2>Recent shifts</h2><a href="#shifts">All shifts</a></div>
      ${recent.length ? `<div class="rows">${recent.map(shiftRow).join('')}</div>` : '<p class="empty">Your shifts will appear here once you clock in.</p>'}
    </section>`;
}

// ---------------------------------------------------------------- shifts

// The Shifts page has three views of the same records:
//   week        every day Monday to Sunday, like a rota, with a marker where a pay period starts
//   pay period  6th to 5th (or whatever Setup says), split into its weeks, oldest first
//   month       calendar month, split the same way
const shv = { mode: 'week', anchor: null };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shvRange() {
  const s = model.settings, a = shv.anchor || today();
  if (shv.mode === 'week') return C.weekRange(a, s.weekStartsOn);
  if (shv.mode === 'month') return C.monthRange(a);
  return C.payPeriod(a, s.payPeriodStartDay);
}

// "16 – 22 Nov 2026", "30 Nov – 6 Dec 2026"
function fmtSpan(r) {
  const [y1, m1, d1] = r.from.split('-').map(Number), [y2, m2, d2] = r.to.split('-').map(Number);
  if (r.from === r.to) return `${d1} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 !== y2) return `${d1} ${MONTHS[m1 - 1]} ${y1} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
  return m1 === m2 ? `${d1} – ${d2} ${MONTHS[m2 - 1]} ${y2}` : `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}

function shvTitle(r) {
  const s = model.settings, t = today();
  if (shv.mode === 'week') {
    const cur = C.weekRange(t, s.weekStartsOn);
    if (r.from === cur.from) return 'This week';
    if (r.from === C.addDays(cur.from, -7)) return 'Last week';
    if (r.from === C.addDays(cur.from, 7)) return 'Next week';
    return 'Week';
  }
  if (shv.mode === 'month') return t >= r.from && t <= r.to ? 'This month' : 'Month';
  return t >= r.from && t <= r.to ? 'This pay period' : 'Pay period';
}

function shiftCard(sh) {
  const hm = (ms) => fmtT(ms).slice(0, 5);
  const end = sh.status === 'complete'
    ? hm(sh.endMs) + (C.localDate(sh.endMs, tz()) !== sh.date ? '<sup title="Ends the next day">+1</sup>' : '')
    : sh.status === 'open' ? 'now' : '?';
  const v = sh.scheduledSec != null && sh.status === 'complete' ? sh.workedSec - sh.scheduledSec : null;
  return `<a class="shiftcard${sh.status === 'incomplete' ? ' shiftcard--bad' : sh.status === 'open' ? ' shiftcard--open' : ''}" href="#shift-${sh.id}">
    <span class="shiftcard__times num">${hm(sh.startMs)} – ${end}</span>
    <span class="shiftcard__worked num">${sh.status === 'incomplete' ? '–' : C.fmtDur(sh.workedSec)}</span>
    <span class="shiftcard__sub">${shiftPills(sh)}${v != null ? `<span class="num ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${signed(v)} against rota</span>` : ''}</span>
  </a>`;
}

function shiftsWeek(r) {
  const s = model.settings, t = today();
  let html = '', lastMonth = null;
  for (let d = r.from; d <= r.to; d = C.addDays(d, 1)) {
    const [, m, day] = d.split('-').map(Number);
    if (day === s.payPeriodStartDay) {
      html += `<div class="daysplit"><span>Pay period ${esc(fmtSpan(C.payPeriod(d, s.payPeriodStartDay)))} starts</span></div>`;
    }
    const shifts = model.shifts.filter((x) => x.date === d);
    const rota = model.schedule.filter((x) => x.date === d);
    const showMonth = m !== lastMonth;
    lastMonth = m;
    const due = rota.some((x) => !x.off);
    const none = shifts.length ? '' : d <= t
      ? `<div class="day__none"><span>${d === t ? 'Not clocked in yet' : due ? 'Scheduled, nothing recorded' : 'Nothing recorded'}</span><span class="btnrow">${rota.filter((x) => !x.off && rotaOver(x)).slice(0, 1).map((x) => `<button class="day__add" data-action="as-scheduled" data-id="${x.id}">As scheduled</button>`).join('')}<button class="day__add" data-action="add-shift" data-date="${d}">${due ? 'Other times' : 'Add'}</button></span></div>`
      : `<div class="day__none"><span>${due ? 'Not worked yet' : rota.length ? '' : 'Nothing recorded'}</span></div>`;
    html += `<div class="day${d === t ? ' is-today' : ''}">
      <div class="day__date"><span class="day__dow">${DOW[C.dayOfWeek(d)]}</span><span class="day__num num">${day}</span>${showMonth ? `<span class="day__mon">${MONTHS[m - 1]}</span>` : ''}</div>
      <div class="day__body">${shifts.map(shiftCard).join('')}${rota.map((x) => `<div class="day__rota">${rotaText(x)}</div>`).join('')}${none}</div>
    </div>`;
  }
  // Which pay period(s) this week falls in, with their running totals.
  const periods = [C.payPeriod(r.from, s.payPeriodStartDay), C.payPeriod(r.to, s.payPeriodStartDay)].filter((p, i, a) => i === 0 || p.from !== a[0].from);
  const chips = periods.map((p) => {
    const sum = C.summarise(model, p.from, p.to);
    return `<button class="ppchip" data-action="shv-mode" data-mode="pay" data-anchor="${p.from}">
      <span class="ppchip__label">Pay period ${esc(fmtSpan(p))}</span>
      <span class="ppchip__val num">${C.fmtDur(sum.workedSec)} · ${money(sum.payPence)}</span></button>`;
  }).join('');
  return `<section class="card card--flush"><div class="days">${html}</div></section><div class="ppchips">${chips}</div>`;
}

// One rota entry as text: "Rota 17:00 – 01:00+1 · Bar Person", or "Time off".
function rotaText(x) {
  if (x.off) return 'Time off';
  return `Rota <span class="num">${esc(x.start)} – ${esc(x.end)}${x.end <= x.start ? '<sup title="Ends the next day">+1</sup>' : ''}</span>${x.role ? ` · ${esc(x.role)}` : ''}`;
}

const rotaOver = (x) => { try { return rotaTimes(x).outMs <= Date.now(); } catch { return false; } };

function rotaRow(x, canAdd) {
  return `<div class="row row--rota">
    <span class="row__date">${esc(fmtD(x.date))}</span>
    <span class="row__times">${rotaText(x)}</span>
    <span class="row__flags">${x.off ? '' : pill(canAdd ? 'Nothing recorded' : 'Not worked yet')}</span>
    <span class="row__worked btnrow">${canAdd && !x.off ? `${rotaOver(x) ? `<button class="day__add" data-action="as-scheduled" data-id="${x.id}">As scheduled</button>` : ''}<button class="day__add" data-action="add-shift" data-date="${x.date}">Other times</button>` : ''}</span>
  </div>`;
}

function shiftsPeriod(r) {
  const s = model.settings, t = today();
  const sum = C.summarise(model, r.from, r.to);
  const blocks = C.weeksIn(model, r.from, r.to).map((w) => {
    const part = { from: w.from < r.from ? r.from : w.from, to: w.to > r.to ? r.to : w.to };
    const ws = C.summarise(model, part.from, part.to);
    let rows = '';
    for (let d = part.from; d <= part.to; d = C.addDays(d, 1)) {
      const shifts = ws.shifts.filter((x) => x.date === d);
      rows += shifts.length ? shifts.map(shiftRow).join('') : model.schedule.filter((x) => x.date === d).map((x) => rotaRow(x, d <= t)).join('');
    }
    if (!rows) return '';
    return `<section class="card"><div class="card__head">
        <button class="weeklink" data-action="shv-mode" data-mode="week" data-anchor="${part.from}">${esc(fmtSpan(part))}${w.partial ? ' <span class="mute">part week</span>' : ''}</button>
        <span class="num"><b>${C.fmtDur(ws.workedSec)}</b>${ws.scheduledCount ? ` <span class="mute">of ${C.fmtDur(ws.scheduledSec)} rota</span>` : ''}</span></div>
      <div class="rows">${rows}</div></section>`;
  }).join('');
  return `<section class="tiles">
      <div class="tile"><div class="tile__label">Worked</div><div class="tile__value num">${C.fmtDur(sum.workedSec)}</div><div class="tile__sub num">${C.fmtHours(sum.workedSec)} h over ${sum.count} shift${sum.count === 1 ? '' : 's'}</div></div>
      <div class="tile"><div class="tile__label">On the rota</div><div class="tile__value num">${sum.scheduledCount ? C.fmtDur(sum.scheduledSec) : '–'}</div><div class="tile__sub num">${sum.scheduledCount ? `${C.fmtHours(sum.scheduledSec)} h over ${sum.scheduledCount} shift${sum.scheduledCount === 1 ? '' : 's'}` : 'no rota entered'}</div></div>
      <div class="tile"><div class="tile__label">Expected gross</div><div class="tile__value num">${money(sum.payPence)}</div><div class="tile__sub">${shv.mode === 'pay' ? `paid ${esc(fmtDs(C.payDate(r, s.payDay)))}` : 'hours × hourly rate'}</div></div>
    </section>
    ${(() => { const p = splitUnrecorded(sum.unrecorded); return p.past.length > 1 ? `<div class="btnrow"><button class="btn" data-action="as-scheduled-all" data-ids="${p.past.map((x) => x.id).join(',')}">Record all ${p.past.length} unrecorded shifts as worked as scheduled</button></div>` : ''; })()}
    ${blocks || '<section class="card"><p class="empty">Nothing recorded or scheduled in this period.</p></section>'}`;
}

function vShifts() {
  const r = shvRange(), t = today();
  const sum = C.summarise(model, r.from, r.to);
  const loose = [...model.orphans].sort((a, b) => b.atMs - a.atMs);
  const modes = [['week', 'Week'], ['pay', 'Pay period'], ['month', 'Month']];
  const here = t >= r.from && t <= r.to;
  return `<header class="page-head"><h1>Shifts</h1>
      <div class="page-head__actions btnrow"><button class="btn btn--primary" data-action="add-shift">Add shift by hand</button><button class="btn" data-action="add-event">Add one record</button><a class="btn" href="#bin">Bin${model.bin.length ? ` (${model.bin.length})` : ''}</a></div></header>
    <div class="seg" role="group" aria-label="View">${modes.map(([k, l]) => `<button class="seg__btn${shv.mode === k ? ' is-on' : ''}" data-action="shv-mode" data-mode="${k}">${l}</button>`).join('')}</div>
    <section class="weeknav">
      <button class="weeknav__btn" data-action="shv-step" data-dir="-1" aria-label="Earlier">&lsaquo;</button>
      <div class="weeknav__mid"><strong>${shvTitle(r)}</strong><span>${esc(fmtSpan(r))}</span>
        <span class="num mute">${sum.count} shift${sum.count === 1 ? '' : 's'} · ${C.fmtDur(sum.workedSec)}</span>
        ${here ? '' : '<button class="link" data-action="shv-today">Back to today</button>'}</div>
      <button class="weeknav__btn" data-action="shv-step" data-dir="1" aria-label="Later">&rsaquo;</button>
    </section>
    ${shv.mode === 'week' ? shiftsWeek(r) : shiftsPeriod(r)}
    ${loose.length ? `<section class="card"><h2>Records outside any shift</h2>
      <p class="note">Records that could not be matched to a shift, for example a clock-out dated before its clock-in. Correct the date or time, or move them to the bin.</p>
      <ul class="events">${loose.map((ev) => eventItem(ev, true)).join('')}</ul></section>` : ''}`;
}

function locationLine(ev) {
  return ev.locations.map((l) => {
    const p = l.payload;
    if (p.status === 'ok') {
      return `<div class="ev__loc">Location reported by device: <span class="num">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span>, accurate to about <span class="num">${Math.round(p.accuracyM)} m</span></div>`;
    }
    const why = { denied: 'permission was refused', unavailable: 'the device could not get a position', timeout: 'the device took too long', unsupported: 'this browser has no location service' }[p.status] || p.status;
    return `<div class="ev__loc ev__loc--none">Location not captured: ${esc(why)}.</div>`;
  }).join('');
}

function eventItem(ev, loose = false) {
  const fix = loose && !ev.voided ? nextDayFix(ev) : null;
  const hist = ev.corrected
    ? `<ul class="ev__hist"><li>Original record: <b class="num">${esc(fmtDT(ev.originalMs))}</b> (kept)</li>${ev.corrections.map((c, i) =>
        `<li>Correction ${i + 1}: set to <b class="num">${esc(fmtDT(Date.parse(c.payload.newAt)))}</b>, entered ${esc(fmtDT(Date.parse(c.recordedAt)))}. Reason: ${esc(c.payload.reason)}</li>`).join('')}</ul>`
    : '';
  const src = ev.source === 'manual' ? `Entered by hand on ${esc(fmtDT(ev.recordedMs))}` : 'Live tap';
  const voidNote = ev.voided ? `<div class="ev__void">Moved to the bin ${esc(fmtDT(Date.parse(ev.voidEntry.recordedAt)))}${ev.voidEntry.payload.reason ? `. Reason: ${esc(ev.voidEntry.payload.reason)}` : ''}</div>` : '';
  return `<li class="ev ev--${ev.kind}${ev.voided ? ' is-void' : ''}">
    <div class="ev__head"><span class="ev__kind">${C.KIND_LABEL[ev.kind]}</span><span class="ev__time num">${fmtT(ev.atMs)}</span></div>
    <div class="ev__sub">${esc(fmtD(C.localDate(ev.atMs, tz())))} · ${src} ${ev.corrected ? pill('Corrected') : ''}${ev.voided ? pill('In bin', 'bad') : ''}</div>
    ${hist}${ev.note ? `<div class="ev__note">Note: ${esc(ev.note)}</div>` : ''}${locationLine(ev)}${voidNote}
    <div class="ev__actions">${ev.voided
      ? `<button class="link" data-action="restore" data-id="${ev.id}">Restore</button>`
      : `${fix ? `<button class="btn btn--sm btn--primary" data-action="next-day" data-id="${ev.id}">Move to ${esc(fmtDs(fix.date))}, where it fits a shift</button>` : ''}<button class="link" data-action="correct" data-id="${ev.id}">Correct time</button><button class="link" data-action="void" data-id="${ev.id}" data-what="this ${C.KIND_LABEL[ev.kind].toLowerCase()}">Move to bin</button>`}</div>
  </li>`;
}

function evidenceGrid(list, emptyText) {
  if (!list.length) return `<p class="empty">${emptyText}</p>`;
  return `<div class="thumbs">${list.map((e) => `<button class="thumb${e.voided ? ' is-void' : ''}" data-action="view-evidence" data-id="${e.id}">
      <span class="thumb__img" data-att="${e.attachmentId}" data-mime="${esc(e.mime || '')}"></span>
      <span class="thumb__name">${esc(e.caption || e.name)}</span>
      <span class="thumb__meta">${esc(fmtDT(e.recordedMs))}</span></button>`).join('')}</div>`;
}

const evidenceButtons = (linkId) => `<div class="btnrow">
  <button class="btn" data-action="add-evidence" data-link="${linkId || ''}">Add file or screenshot</button>
  <button class="btn" data-action="add-photo" data-link="${linkId || ''}">Take photo</button></div>`;

function vShift(id) {
  const sh = model.shifts.find((x) => x.id === id);
  if (!sh) return `<header class="page-head"><h1>Shift not found</h1></header><section class="card"><p>This shift no longer exists in its earlier form, usually because its clock-in was moved to the bin or corrected. <a href="#shifts">Back to shifts</a> · <a href="#bin">Open the bin</a></p></section>`;
  const s = model.settings;
  const variance = sh.scheduledSec != null && sh.status !== 'incomplete' ? sh.workedSec - sh.scheduledSec : null;
  const emp = sh.employer;
  const empDiff = emp && emp.paidHours != null && sh.status === 'complete' ? Number(emp.paidHours) * 3600 - sh.workedSec : null;
  const ev = model.evidence.filter((e) => e.linkId && sh.eventIds.has(e.linkId) && !e.voided);
  const notes = model.notes.filter((n) => n.linkId && sh.eventIds.has(n.linkId) && !n.voided);
  const endMs = sh.endMs || Date.now();
  const nearVoid = model.clock.filter((c) => c.voided && c.atMs >= sh.startMs - 3600000 && c.atMs <= endMs + 3600000);
  const stat = (label, value, sub = '') => `<div class="stat"><dt>${label}</dt><dd class="num">${value}</dd>${sub ? `<small>${sub}</small>` : ''}</div>`;
  return `<header class="page-head"><a class="back" href="#shifts">All shifts</a><h1>${esc(fmtD(sh.date))}</h1><p>${shiftPills(sh) || pill('Complete', 'ok')}</p></header>
    ${sh.anomalies.length ? `<section class="card card--warn"><h2>Check this shift</h2><ul class="plain">${sh.anomalies.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
      ${sh.status !== 'complete' ? `<div class="btnrow"><button class="btn btn--primary" data-action="add-event" data-shift="${sh.id}" data-kind="out">Add the clock-out</button></div>` : ''}</section>` : ''}
    <section class="card"><dl class="stats">
      ${stat('Clock in', fmtT(sh.startMs))}
      ${stat('Clock out', sh.status === 'complete' ? fmtT(sh.endMs) : sh.status === 'open' ? 'In progress' : 'Missing', sh.status === 'complete' && C.localDate(sh.endMs, tz()) !== sh.date ? esc(fmtD(C.localDate(sh.endMs, tz()))) : '')}
      ${stat('Start to finish', sh.status === 'incomplete' ? '–' : C.fmtDur(sh.spanSec))}
      ${stat(`Breaks (${sh.breaks.length})`, C.fmtDur(sh.breakSec), s.breaksPaid ? 'paid, not deducted' : 'unpaid, deducted')}
      ${stat('Worked', sh.status === 'incomplete' ? '–' : C.fmtDur(sh.workedSec), sh.status === 'incomplete' ? '' : `${C.fmtHours(sh.workedSec)} h`)}
      ${stat('Expected gross', money(sh.payPence), `at ${money(sh.ratePence)}/h`)}
    </dl></section>
    <section class="card"><h2>Compared with</h2>
      <dl class="compare">
        <div><dt>Rota for this day</dt><dd>${sh.scheduledSec != null ? `<span class="num">${C.fmtDur(sh.scheduledSec)}</span> scheduled${variance != null ? ` · you worked <b class="num ${variance > 0 ? 'pos' : variance < 0 ? 'neg' : ''}">${signed(variance)}</b>` : ''}` : `Nothing entered. <a href="#rota">Add the rota</a>`}</dd></div>
        <div><dt>${esc(s.employerSystem || 'Employer')} figure</dt><dd>${emp ? `<span class="num">${Number(emp.paidHours).toFixed(2)} h</span>${emp.overtimeApprovedHours ? ` (incl. ${Number(emp.overtimeApprovedHours).toFixed(2)} h approved overtime)` : ''}${empDiff != null ? ` · <b class="num ${empDiff < 0 ? 'neg' : empDiff > 0 ? 'pos' : ''}">${signed(empDiff)}</b> against your record` : ''}${emp.note ? `<br><span class="mute">${esc(emp.note)}</span>` : ''}` : 'Not entered.'}
          <button class="link" data-action="add-employer" data-id="${sh.id}">${emp ? 'Change' : 'Enter figure'}</button></dd></div>
      </dl></section>
    <section class="card"><div class="card__head"><h2>Records</h2><button class="btn btn--sm" data-action="add-event" data-shift="${sh.id}" data-kind="${sh.status === 'complete' ? 'break_start' : 'out'}">Add a missed record</button></div>
      <ul class="events">${sh.events.map((e) => eventItem(e)).join('')}</ul>
      ${nearVoid.length ? `<p class="note">${nearVoid.length} record${nearVoid.length > 1 ? 's' : ''} from around this shift ${nearVoid.length > 1 ? 'are' : 'is'} in the bin. <a href="#bin">Open the bin</a></p>` : ''}
    </section>
    <section class="card"><h2>Evidence</h2>
      ${evidenceGrid(ev, 'No files attached to this shift.')}
      ${evidenceButtons(sh.id)}
    </section>
    <section class="card"><div class="card__head"><h2>Notes</h2><button class="btn btn--sm" data-action="add-note" data-link="${sh.id}">Add note</button></div>
      ${notes.length ? `<ul class="plain notes">${notes.map((n) => `<li><span class="mute num">${esc(fmtDT(n.recordedMs))}</span> <button class="link" data-action="void" data-id="${n.id}" data-what="this note">Move to bin</button><br>${esc(n.text)}</li>`).join('')}</ul>` : '<p class="empty">No notes.</p>'}
    </section>
    <section class="card"><h2>Remove this shift</h2>
      <p class="note">Takes the whole shift out of every total. It goes to the bin and can be restored from there.</p>
      <div class="btnrow"><button class="btn btn--stop" data-action="bin-shift" data-id="${sh.id}">Move shift to bin</button></div>
    </section>`;
}

// ---------------------------------------------------------------- rota shifts with no record

function rotaTimes(x) {
  const inMs = handInstant(x.date, x.start);
  const outMs = handInstant(x.end <= x.start ? C.addDays(x.date, 1) : x.date, x.end);
  return { inMs, outMs };
}

// Scheduled shifts with no record, split into those already over and those still to come.
function splitUnrecorded(list) {
  const past = [], upcoming = [];
  for (const x of list) {
    let over = false;
    try { over = rotaTimes(x).outMs <= Date.now(); } catch { over = false; }
    (over ? past : upcoming).push(x);
  }
  return { past, upcoming, pastSec: past.reduce((n, x) => n + x.scheduledSec, 0) };
}

function unrecordedCard(pending, where) {
  if (!pending.past.length) return '';
  const n = pending.past.length;
  return `<section class="card card--warn"><h2>${n} scheduled shift${n === 1 ? ' has' : 's have'} no record ${where}</h2>
    <p>${C.fmtDur(pending.pastSec)} on the rota is not in your worked total yet, because the rota only says what you were asked to work.</p>
    <ul class="plain rotalist">${pending.past.map((x) => `<li><span><b>${esc(fmtD(x.date))}</b> <span class="num">${esc(x.start)} – ${esc(x.end)}</span>${x.role ? ` · ${esc(x.role)}` : ''}</span>
      <span class="btnrow"><button class="btn btn--sm" data-action="as-scheduled" data-id="${x.id}">Worked as scheduled</button><button class="btn btn--sm" data-action="add-shift" data-date="${x.date}">Different times</button></span></li>`).join('')}</ul>
    ${n > 1 ? `<div class="btnrow"><button class="btn btn--primary" data-action="as-scheduled-all" data-ids="${pending.past.map((x) => x.id).join(',')}">Record all ${n} as worked as scheduled</button></div>` : ''}
    <p class="note">"Worked as scheduled" saves the rota times as your record for that shift, marked "From rota". Use "Different times" wherever you started or finished at another time, or open the shift afterwards and correct it.</p>
  </section>`;
}

// Turn rota entries into worked shifts at the rota times. Each record is hand-entered and says where its times came from.
async function recordAsScheduled(ids) {
  const done = [];
  let n = 0, skipped = 0;
  for (const id of ids) {
    const x = model.schedule.find((r) => r.id === id);
    if (!x || x.off) { skipped++; continue; }
    let tm;
    try { tm = rotaTimes(x); } catch { skipped++; continue; }
    const clash = (a, b) => tm.inMs <= b && tm.outMs >= a;
    if (tm.outMs > Date.now() || model.shifts.some((sh) => clash(sh.startMs, sh.endMs || sh.startMs)) || done.some((d) => clash(d.inMs, d.outMs))) { skipped++; continue; }
    const groupId = uuid();
    const base = { source: 'manual', basis: 'rota', scheduleId: x.id, groupId, note: 'Recorded as worked as scheduled. These are the rota times, not times clocked at the moment.' };
    await add('clock', { kind: 'in', at: new Date(tm.inMs).toISOString(), ...base });
    await add('clock', { kind: 'out', at: new Date(tm.outMs).toISOString(), ...base });
    done.push(tm);
    n++;
  }
  await refresh();
  toast(`${n} shift${n === 1 ? '' : 's'} recorded as worked as scheduled${skipped ? `; ${skipped} skipped (not finished yet, or overlapping a shift you already have)` : ''}.`, n ? 'ok' : 'warn');
}

function asScheduledAllDialog(ids) {
  dialog({
    title: `Record ${ids.length} shifts as worked as scheduled`, submit: `Record ${ids.length} shifts`,
    body: `<p>Each of these scheduled shifts will be saved as a shift you worked, from the rota start time to the rota finish time.</p>
      <p class="note">You are stating that you worked them. Every one is marked "From rota" and "entered by hand", so it is clear the times came from the schedule and were not clocked at the moment. Where you worked longer or shorter, open that shift and correct the time. Any of them can be moved to the bin.</p>`,
    onSubmit: async () => { await recordAsScheduled(ids); },
  });
}

// ---------------------------------------------------------------- reports

function repRange() {
  const s = model.settings, a = rep.anchor || today();
  if (rep.type === 'day') return { from: a, to: a };
  if (rep.type === 'week') return C.weekRange(a, s.weekStartsOn);
  if (rep.type === 'month') return C.monthRange(a);
  if (rep.type === 'custom') { const from = rep.from || a, to = rep.to || a; return from <= to ? { from, to } : { from: to, to: from }; }
  return C.payPeriod(a, s.payPeriodStartDay);
}

function reportRows(sum) {
  return sum.shifts.map((sh) => {
    const v = sh.scheduledSec != null && sh.status !== 'incomplete' ? sh.workedSec - sh.scheduledSec : null;
    return { sh, v };
  });
}

function vReports() {
  const r = repRange(), sum = C.summarise(model, r.from, r.to), s = model.settings;
  const types = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['pay', 'Pay period'], ['custom', 'Custom']];
  const variance = sum.rotaVarianceSec;
  const pending = splitUnrecorded(sum.unrecorded);
  const weeks = r.from !== r.to ? C.weeksIn(model, r.from, r.to) : [];
  const rows = reportRows(sum);
  return `<header class="page-head"><h1>Reports</h1>
      <div class="page-head__actions"><button class="btn" data-action="export-csv">Export this view (CSV)</button></div></header>
    <section class="card">
      <div class="seg" role="group" aria-label="Period">${types.map(([k, l]) => `<button class="seg__btn${rep.type === k ? ' is-on' : ''}" data-action="rep-type" data-type="${k}">${l}</button>`).join('')}</div>
      ${rep.type === 'custom'
        ? `<div class="range">${field('rep-from', 'From', `<input id="rep-from" type="date" value="${r.from}" data-change="rep-from">`)}${field('rep-to', 'To', `<input id="rep-to" type="date" value="${r.to}" data-change="rep-to">`)}</div>`
        : `<div class="stepper"><button class="btn btn--sm" data-action="rep-step" data-dir="-1" aria-label="Previous period">Earlier</button><strong>${esc(fmtRange(r))}</strong><button class="btn btn--sm" data-action="rep-step" data-dir="1" aria-label="Next period">Later</button></div>`}
    </section>
    <section class="tiles tiles--5">
      <div class="tile"><div class="tile__label">Worked</div><div class="tile__value num">${C.fmtDur(sum.workedSec)}</div><div class="tile__sub num">${C.fmtHours(sum.workedSec)} h over ${sum.count} shift${sum.count === 1 ? '' : 's'}</div></div>
      <div class="tile"><div class="tile__label">Expected gross</div><div class="tile__value num">${money(sum.payPence)}</div><div class="tile__sub">hours × hourly rate, before deductions</div></div>
      <div class="tile"><div class="tile__label">On the rota</div><div class="tile__value num">${sum.scheduledCount ? C.fmtDur(sum.scheduledSec) : '–'}</div><div class="tile__sub">${sum.scheduledCount ? `${sum.scheduledCount} shift${sum.scheduledCount === 1 ? '' : 's'}, worth <span class="num">${money(sum.scheduledPayPence)}</span>` : 'no rota entered'}</div></div>
      <div class="tile"><div class="tile__label">Worked against rota</div><div class="tile__value num ${variance > 0 ? 'pos' : variance < 0 ? 'neg' : ''}">${variance == null ? '–' : signed(variance)}</div><div class="tile__sub">${variance == null ? 'no recorded shift to compare yet' : `across the ${sum.rotaMatchedCount} scheduled shift${sum.rotaMatchedCount === 1 ? '' : 's'} with a record`}</div></div>
      <div class="tile"><div class="tile__label">Breaks</div><div class="tile__value num">${C.fmtDur(sum.breakSec)}</div><div class="tile__sub">${s.breaksPaid ? 'paid' : 'unpaid, already deducted'}</div></div>
    </section>
    ${sum.flagged || sum.open ? `<section class="card card--warn"><p>${sum.flagged ? `${sum.flagged} shift${sum.flagged > 1 ? 's' : ''} in this period need${sum.flagged > 1 ? '' : 's'} checking, so the totals may be incomplete. ` : ''}${sum.open ? 'One shift is still in progress and is counted up to now.' : ''}</p></section>` : ''}
    ${unrecordedCard(pending, 'in this period')}
    <section class="card"><h2>Shifts in this period</h2>
      ${rows.length ? `<div class="tablewrap"><table class="table"><thead><tr><th>Date</th><th>In</th><th>Out</th><th class="r">Breaks</th><th class="r">Worked</th><th class="r">Hours</th><th class="r">Rota</th><th class="r">Difference</th><th class="r">${esc(s.employerSystem || 'Employer')} h</th><th class="r">Gross</th><th>Flags</th></tr></thead><tbody>
        ${rows.map(({ sh, v }) => `<tr><td><a href="#shift-${sh.id}">${esc(fmtD(sh.date))}</a></td><td class="num">${fmtT(sh.startMs)}</td><td class="num">${sh.status === 'complete' ? fmtT(sh.endMs) : sh.status === 'open' ? 'now' : '?'}</td>
          <td class="num r">${C.fmtDur(sh.breakSec)}</td><td class="num r">${sh.status === 'incomplete' ? '–' : C.fmtDur(sh.workedSec)}</td><td class="num r">${C.fmtHours(sh.workedSec)}</td>
          <td class="num r">${sh.scheduledSec != null ? C.fmtDur(sh.scheduledSec) : ''}</td><td class="num r ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v != null ? signed(v) : ''}</td>
          <td class="num r">${sh.employer ? Number(sh.employer.paidHours).toFixed(2) : ''}</td><td class="num r">${money(sh.payPence)}</td><td>${shiftPills(sh)}</td></tr>`).join('')}
        </tbody><tfoot><tr><th colspan="3">Total</th><td class="num r">${C.fmtDur(sum.breakSec)}</td><td class="num r">${C.fmtDur(sum.workedSec)}</td><td class="num r">${C.fmtHours(sum.workedSec)}</td><td class="num r">${sum.scheduledCount ? C.fmtDur(sum.scheduledSec) : ''}</td><td class="num r">${variance != null ? signed(variance) : ''}</td><td class="num r">${sum.employerCount ? sum.employerHours.toFixed(2) : ''}</td><td class="num r">${money(sum.payPence)}</td><td></td></tr></tfoot></table></div>`
        : '<p class="empty">No shifts started in this period.</p>'}
    </section>
    ${weeks.length > 1 ? `<section class="card"><h2>Week by week</h2>
      <div class="tablewrap"><table class="table"><thead><tr><th>Week</th><th class="r">Shifts</th><th class="r">Worked</th><th class="r">Hours</th>${s.weeklyOvertimeAfterHours ? `<th class="r">Over ${s.weeklyOvertimeAfterHours} h</th>` : ''}</tr></thead><tbody>
      ${weeks.map((w) => `<tr><td>${esc(fmtRange(w))}${w.partial ? ' <span class="mute">(whole week, runs outside this period)</span>' : ''}</td><td class="num r">${w.count}</td><td class="num r">${C.fmtDur(w.workedSec)}</td><td class="num r">${C.fmtHours(w.workedSec)}</td>${s.weeklyOvertimeAfterHours ? `<td class="num r ${w.overSec ? 'pos' : ''}">${C.fmtDur(w.overSec)}</td>` : ''}</tr>`).join('')}
      </tbody></table></div></section>` : ''}`;
}

const csvCell = (v) => {
  v = v == null ? '' : String(v);
  if (/^[=+@]/.test(v)) v = "'" + v;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
const csv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

function shiftsCsv(shifts) {
  const rows = [['Shift date', 'Clock in (local)', 'Clock out (local)', 'Clock in (UTC)', 'Clock out (UTC)', 'Start to finish', 'Breaks', 'Worked', 'Worked (decimal hours)', 'Rota', 'Difference from rota', 'Hourly rate', 'Expected gross', 'Employer figure (hours)', 'Status', 'Corrected', 'Entered by hand', 'Flags', 'Shift id']];
  for (const sh of shifts) {
    rows.push([
      sh.date, fmtDT(sh.startMs), sh.endMs ? fmtDT(sh.endMs) : '', new Date(sh.startMs).toISOString(), sh.endMs ? new Date(sh.endMs).toISOString() : '',
      C.fmtDur(sh.spanSec), C.fmtDur(sh.breakSec), C.fmtDur(sh.workedSec), C.fmtHours(sh.workedSec),
      sh.scheduledSec != null ? C.fmtDur(sh.scheduledSec) : '', sh.scheduledSec != null && sh.status !== 'incomplete' ? C.fmtDur(sh.workedSec - sh.scheduledSec) : '',
      (sh.ratePence / 100).toFixed(2), (sh.payPence / 100).toFixed(2), sh.employer ? sh.employer.paidHours : '',
      sh.status, sh.corrected ? 'yes' : 'no', sh.manual ? 'yes' : 'no', sh.anomalies.join(' | '), sh.id,
    ]);
  }
  return csv(rows);
}

function eventsCsv() {
  const rows = [['Record #', 'Record id', 'Kind', 'Effective time (local)', 'Effective time (UTC)', 'Original time (UTC)', 'Written to log (UTC)', 'Source', 'Corrections', 'In bin', 'Latitude', 'Longitude', 'Accuracy (m)', 'Location status', 'Fingerprint (SHA-256)']];
  for (const ev of model.clock) {
    const l = ev.locations[0] ? ev.locations[0].payload : null;
    rows.push([ev.seq, ev.id, C.KIND_LABEL[ev.kind], fmtDT(ev.atMs), new Date(ev.atMs).toISOString(), new Date(ev.originalMs).toISOString(), ev.entry.recordedAt, ev.source, ev.corrections.length, ev.voided ? 'yes' : 'no', l && l.status === 'ok' ? l.lat : '', l && l.status === 'ok' ? l.lon : '', l && l.status === 'ok' ? Math.round(l.accuracyM) : '', l ? l.status : '', ev.entry.hash]);
  }
  return csv(rows);
}

// ---------------------------------------------------------------- rota

function vRota() {
  const list = [...model.schedule].reverse();
  const imports = new Map();
  for (const x of model.schedule) {
    if (!x.importId) continue;
    if (!imports.has(x.importId)) imports.set(x.importId, { id: x.importId, name: x.importName || 'rota file', at: Date.parse(x.entry.recordedAt), n: 0 });
    imports.get(x.importId).n++;
  }
  const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  let last = '';
  const rows = list.map((x) => {
    const mk = x.date.slice(0, 7);
    const head = mk !== last ? `<tr class="table__group"><th colspan="7">${esc(monthFmt.format(new Date(C.parseDate(x.date))))}</th></tr>` : '';
    last = mk;
    const day = C.summarise(model, x.date, x.date);
    const v = !x.off && day.count ? day.workedSec - (model.scheduledByDate.get(x.date) || 0) : null;
    const bin = `<button class="link" data-action="void" data-id="${x.id}" data-what="this rota entry">Move to bin</button>`;
    return head + (x.off
      ? `<tr><td>${esc(fmtD(x.date))}</td><td colspan="2">Time off</td><td></td><td class="num r">${day.count ? C.fmtDur(day.workedSec) : ''}</td><td></td><td class="r">${bin}</td></tr>`
      : `<tr><td>${esc(fmtD(x.date))}</td><td class="num">${esc(x.start)} – ${esc(x.end)}${x.end <= x.start ? '<sup>+1</sup>' : ''}</td><td>${esc(x.role || '')}</td><td class="num r">${C.fmtDur(x.scheduledSec)}</td>
        <td class="num r">${day.count ? C.fmtDur(day.workedSec) : '<span class="mute">no record</span>'}</td><td class="num r ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v != null ? signed(v) : ''}</td>
        <td class="r"><button class="link" data-action="add-schedule" data-id="${x.id}">Change</button> ${bin}</td></tr>`);
  }).join('');
  return `<header class="page-head"><h1>Rota</h1><div class="page-head__actions btnrow"><button class="btn btn--primary" data-action="add-schedule">Add scheduled shift</button><button class="btn" data-action="import-rota">Import rota file</button></div></header>
    <section class="card"><p class="note">Your scheduled shifts, as ${esc(model.settings.employerSystem || 'your employer')} shows them. The rota is what you were asked to work, never a record of what you did work: the app compares the two. Rota entries show on the Shifts page under their day.</p>
      ${[...imports.values()].map((im) => `<p class="note">Imported ${esc(fmtDT(im.at))}: ${im.n} entr${im.n === 1 ? 'y' : 'ies'} from "${esc(im.name)}". <button class="link" data-action="bin-import" data-id="${im.id}">Move this import to the bin</button></p>`).join('')}
    </section>
    <section class="card">${list.length ? `<div class="tablewrap"><table class="table"><thead><tr><th>Date</th><th>Scheduled</th><th>Role</th><th class="r">Hours</th><th class="r">Worked</th><th class="r">Difference</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">No scheduled shifts entered.</p>'}
    </section>`;
}

// A rota import file is JSON (optionally inside a ZIP with screenshots):
//   { format: 'hours-ledger-import/1', name, schedule: [{ date, start, end, role?, breakMin?, off?, note? }], evidence: [{ file, caption }] }
// Importing adds rota entries (and the screenshots as evidence). It never creates clock records.
async function importRota(file) {
  let data, zipFiles = [];
  if (/\.zip$/i.test(file.name) || /zip/.test(file.type)) {
    zipFiles = await readZip(file);
    const j = zipFiles.find((f) => f.name === 'import.json');
    if (!j) throw new Error('This ZIP is not a rota import file. To restore a backup, use Restore from backup in Setup.');
    data = JSON.parse(await (await j.blob()).text());
  } else {
    data = JSON.parse(await file.text());
  }
  if (!data || data.format !== 'hours-ledger-import/1' || !Array.isArray(data.schedule)) throw new Error('This is not an Hours Ledger rota import file.');
  const okDate = /^\d{4}-\d{2}-\d{2}$/, okTime = /^\d{2}:\d{2}$/;
  const key = (x) => `${x.date}|${x.off ? 'off' : `${x.start}-${x.end}`}`;
  const have = new Set(model.schedule.map(key));
  const fresh = [];
  for (const x of data.schedule) {
    if (!okDate.test(x.date) || (!x.off && (!okTime.test(x.start) || !okTime.test(x.end)))) throw new Error(`The file has an entry that cannot be read: ${JSON.stringify(x).slice(0, 80)}`);
    if (have.has(key(x))) continue;
    have.add(key(x));
    fresh.push(x);
  }
  // Screenshots are matched by fingerprint, so a file already held under Evidence is not added twice.
  const shots = [];
  for (const e of data.evidence || []) {
    const zf = zipFiles.find((f) => f.name === e.file);
    if (!zf) continue;
    const buf = await (await zf.blob()).arrayBuffer();
    const sha256 = await C.sha256Hex(buf);
    if (!model.evidence.some((v) => v.sha256 === sha256) && !shots.some((v) => v.sha256 === sha256)) shots.push({ ...e, buf, sha256 });
  }
  const dates = data.schedule.map((x) => x.date).sort();
  const work = fresh.filter((x) => !x.off).length;
  const skipped = data.schedule.length - fresh.length;
  if (!fresh.length && !shots.length) return toast('Everything in that file is already in your rota.', 'warn');
  dialog({
    title: 'Import rota', submit: fresh.length ? `Import ${fresh.length} entries` : 'Import screenshots',
    body: `<p>"${esc(data.name || file.name)}" covers ${esc(fmtD(dates[0]))} to ${esc(fmtD(dates[dates.length - 1]))}.</p>
      <ul class="plain">
        <li><b>${work}</b> scheduled shift${work === 1 ? '' : 's'} and <b>${fresh.length - work}</b> time-off day${fresh.length - work === 1 ? '' : 's'} will be added to your rota.</li>
        ${skipped ? `<li>${skipped} already in your rota will be skipped.</li>` : ''}
        ${shots.length ? `<li>${shots.length} screenshot${shots.length === 1 ? '' : 's'} will be added under Evidence.</li>` : ''}
      </ul>
      <p class="note">These go in as rota entries only. No hours are added to your worked totals; you add what you actually worked for each shift. The whole import can be moved to the bin afterwards from the Rota page.</p>`,
    onSubmit: async () => {
      const importId = uuid(), importName = data.name || file.name;
      for (const x of fresh) {
        await add('schedule', {
          date: x.date, start: x.off ? '' : x.start, end: x.off ? '' : x.end, breakMin: Number(x.breakMin) || 0,
          role: x.role || undefined, off: x.off ? true : undefined, note: x.note || '', source: 'import', importId, importName,
        });
      }
      let added = 0;
      for (const e of shots) {
        const { buf, sha256 } = e;
        const attachmentId = uuid();
        const name = e.file.split('/').pop();
        const mime = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'application/octet-stream';
        await store.putBlob({ id: attachmentId, name, mime, data: buf });
        await add('evidence', { attachmentId, sha256, name, mime, size: buf.byteLength, fileModifiedAt: null, linkId: null, caption: e.caption || '', importId });
        added++;
      }
      await refresh();
      toast(`Imported ${fresh.length} rota entr${fresh.length === 1 ? 'y' : 'ies'}${added ? ` and ${added} screenshot${added === 1 ? '' : 's'}` : ''}.`);
    },
  });
}

function binImport(importId) {
  const ids = model.schedule.filter((x) => x.importId === importId).map((x) => x.id);
  if (ids.length) binDialog(ids, 'this import', `Rota import: ${ids.length} entries`);
}

// ---------------------------------------------------------------- payslips

function payPeriods() {
  const s = model.settings;
  const first = model.shifts.length ? model.shifts[0].date : today();
  const stop = C.payPeriod(first, s.payPeriodStartDay).from;
  const out = [];
  let p = C.payPeriod(today(), s.payPeriodStartDay);
  while (p.from >= stop && out.length < 60) { out.push(p); p = C.payPeriod(C.addDays(p.from, -1), s.payPeriodStartDay); }
  return out;
}

function vPayslips() {
  const s = model.settings, t = today();
  return `<header class="page-head"><h1>Payslips</h1></header>
    <section class="card"><p class="note">Each pay period runs from the ${s.payPeriodStartDay}${ord(s.payPeriodStartDay)} to the day before the next ${s.payPeriodStartDay}${ord(s.payPeriodStartDay)}. The comparison covers hours and gross pay for those hours only. Tax, National Insurance, pension, tips and holiday pay are not worked out here.</p></section>
    ${payPeriods().map((p) => {
      const sum = C.summarise(model, p.from, p.to);
      const slip = model.payslips.filter((x) => x.from === p.from && x.to === p.to).pop();
      const inProgress = t <= p.to;
      let verdict = inProgress ? pill('Period in progress', 'info') : pill('No payslip entered', 'mute');
      const hasRota = sum.scheduledCount > 0;
      const pending = splitUnrecorded(sum.unrecorded);
      const cmp = (base, label) => {
        const d = Number(slip.hours) * 3600 - base;
        return Math.abs(d) < 180 ? pill(`Payslip matches ${label}`, 'ok') : d < 0 ? pill(`Payslip is ${(Math.abs(d) / 3600).toFixed(2)} h below ${label}`, 'bad') : pill(`Payslip is ${(d / 3600).toFixed(2)} h above ${label}`, 'info');
      };
      if (slip) verdict = (sum.count ? cmp(sum.workedSec, 'your record') : '') + (hasRota ? cmp(sum.scheduledSec, 'the rota') : '');
      const slipPence = slip ? Math.round(Number(slip.gross) * 100) : null;
      const ev = slip ? model.evidence.filter((e) => e.linkId === slip.id && !e.voided) : [];
      return `<section class="card"><div class="card__head"><h2>${esc(fmtSpan(p))}</h2><span>${verdict}</span></div>
        <p class="mute">Paid ${esc(fmtD(C.payDate(p, s.payDay)))} · ${sum.count} shift${sum.count === 1 ? '' : 's'} recorded${hasRota ? ` · ${sum.scheduledCount} on the rota` : ''}${sum.flagged ? ` · ${sum.flagged} need checking` : ''}</p>
        <div class="tablewrap"><table class="table table--cmp"><thead><tr><th></th><th class="r">Your record</th><th class="r">Rota</th><th class="r">Payslip</th></tr></thead><tbody>
          <tr><th>Hours</th><td class="num r">${C.fmtHours(sum.workedSec)}</td><td class="num r">${hasRota ? C.fmtHours(sum.scheduledSec) : '–'}</td><td class="num r">${slip ? Number(slip.hours).toFixed(2) : '–'}</td></tr>
          <tr><th>Gross for hours</th><td class="num r">${money(sum.payPence)}</td><td class="num r">${hasRota ? money(sum.scheduledPayPence) : '–'}</td><td class="num r">${slip ? money(slipPence) : '–'}</td></tr>
        </tbody></table></div>
        ${pending.past.length ? `<p class="note">${pending.past.length} scheduled shift${pending.past.length === 1 ? ' has' : 's have'} no record in this period, so "Your record" is short by up to ${C.fmtDur(pending.pastSec)}. <button class="link" data-action="open-report" data-from="${p.from}">Sort them out in Reports</button></p>` : ''}
        ${slip && slip.note ? `<p class="mute">Note: ${esc(slip.note)}</p>` : ''}
        ${slip ? evidenceGrid(ev, '') : ''}
        <div class="btnrow"><button class="btn" data-action="add-payslip" data-from="${p.from}" data-to="${p.to}">${slip ? 'Change payslip figures' : 'Enter payslip figures'}</button>
          ${slip ? `<button class="btn" data-action="add-evidence" data-link="${slip.id}">Attach payslip</button>` : ''}
          <button class="btn" data-action="open-report" data-from="${p.from}">Shift list</button></div>
      </section>`;
    }).join('')}`;
}

const ord = (n) => (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

// ---------------------------------------------------------------- evidence

function linkLabel(e) {
  if (!e.linkId) return 'Not linked to a shift';
  const sh = model.shifts.find((x) => x.eventIds.has(e.linkId));
  if (sh) return `Shift on ${fmtD(sh.date)}`;
  const slip = model.payslips.find((x) => x.id === e.linkId);
  if (slip) return `Payslip for ${fmtRange(slip)}`;
  return model.voidOf(e.linkId) ? 'A record that is now in the bin' : 'A record that has been replaced';
}

function vEvidence() {
  const list = model.evidence.filter((e) => !e.voided).reverse();
  return `<header class="page-head"><h1>Evidence</h1></header>
    <section class="card"><p class="note">Files are stored exactly as you add them, with a SHA-256 fingerprint recorded in the log. A later change to a file will show up as a mismatch. The fingerprint says nothing about whether the picture itself is genuine.</p>
      ${evidenceButtons('')}
      <div class="btnrow"><button class="btn" data-action="verify-evidence">Check every file against its fingerprint</button></div>
      <p id="evidence-check" class="note" role="status"></p>
    </section>
    <section class="card"><h2>${list.length} file${list.length === 1 ? '' : 's'}</h2>${evidenceGrid(list, 'Nothing attached yet. Screenshots of your clock-in screen, rota or payslip are the usual things to keep.')}</section>`;
}

async function hydrateThumbs() {
  for (const el of main.querySelectorAll('[data-att]')) {
    const mime = el.dataset.mime;
    if (!mime.startsWith('image/')) { el.textContent = (mime.split('/')[1] || 'file').slice(0, 6).toUpperCase(); continue; }
    const rec = await store.getBlob(el.dataset.att);
    if (!rec || !el.isConnected) { if (!rec) el.textContent = 'missing'; continue; }
    const url = URL.createObjectURL(new Blob([rec.data], { type: rec.mime }));
    objectUrls.push(url);
    el.style.backgroundImage = `url("${url}")`;
  }
}

async function viewEvidence(id) {
  const e = model.evidence.find((x) => x.id === id);
  if (!e) return;
  const rec = await store.getBlob(e.attachmentId);
  let url = null;
  if (rec && (e.mime || '').startsWith('image/')) url = URL.createObjectURL(new Blob([rec.data], { type: rec.mime }));
  const d = dialog({
    title: e.name, wide: true,
    body: `${url ? `<img class="viewer" src="${url}" alt="">` : rec ? '' : '<p class="dlg__warn">The file itself is missing from this device. Its record and fingerprint are still in the log.</p>'}
      <dl class="meta">
        <div><dt>Added</dt><dd>${esc(fmtDT(e.recordedMs))}</dd></div>
        <div><dt>File's own date</dt><dd>${e.fileModifiedAt ? esc(fmtDT(Date.parse(e.fileModifiedAt))) : 'not provided'}</dd></div>
        <div><dt>Size</dt><dd>${bytes(e.size)}</dd></div>
        <div><dt>Linked to</dt><dd>${esc(linkLabel(e))}</dd></div>
        ${e.caption ? `<div><dt>Caption</dt><dd>${esc(e.caption)}</dd></div>` : ''}
        <div><dt>Fingerprint</dt><dd class="hash">${e.sha256}</dd></div>
        ${e.voided ? `<div><dt>Status</dt><dd>In the bin${model.voidOf(e.id).payload.reason ? `. Reason: ${esc(model.voidOf(e.id).payload.reason)}` : ''}</dd></div>` : ''}
      </dl>
      <p id="ev-check" class="note" role="status"></p>
      <div class="btnrow">
        <button type="button" class="btn" id="ev-verify">Check file against fingerprint</button>
        <button type="button" class="btn" id="ev-download">Download</button>
        ${e.voided ? '' : `<button type="button" class="btn" id="ev-void">Move to bin</button>`}
      </div>
      <p class="note">This shows the file is unchanged since it was added. It cannot show that the image is authentic or when it was really taken.</p>`,
  });
  d.addEventListener('close', () => url && URL.revokeObjectURL(url));
  d.querySelector('#ev-verify').addEventListener('click', async () => {
    const out = d.querySelector('#ev-check');
    if (!rec) { out.textContent = 'File is missing, so it cannot be checked.'; return; }
    const ok = (await C.sha256Hex(rec.data)) === e.sha256;
    out.textContent = ok ? 'Match: the file is identical to the one added.' : 'MISMATCH: the stored file differs from the one originally added.';
    out.className = `note ${ok ? 'pos' : 'neg'}`;
  });
  d.querySelector('#ev-download').addEventListener('click', async () => {
    if (!rec) return;
    try { const where = await download(new Blob([rec.data], { type: rec.mime }), e.name); if (typeof where === 'string') toast(`Saved to ${where}.`); } catch (err) { toast(err.message, 'bad'); }
  });
  const v = d.querySelector('#ev-void');
  if (v) v.addEventListener('click', () => { d.close(); binDialog([e.id], 'this file'); });
}

async function verifyAllEvidence() {
  const out = document.getElementById('evidence-check');
  let ok = 0, bad = 0, missing = 0;
  for (const e of model.evidence) {
    const rec = await store.getBlob(e.attachmentId);
    if (!rec) missing++;
    else if ((await C.sha256Hex(rec.data)) === e.sha256) ok++;
    else bad++;
  }
  out.textContent = `${ok} file${ok === 1 ? ' matches its' : 's match their'} fingerprint${ok === 1 ? '' : 's'}, ${bad} mismatch${bad === 1 ? '' : 'es'}, ${missing} missing.`;
  out.className = `note ${bad || missing ? 'neg' : 'pos'}`;
}

async function addEvidence(files, linkId) {
  let n = 0;
  for (const file of files) {
    const data = await file.arrayBuffer();
    const sha256 = await C.sha256Hex(data);
    const attachmentId = uuid();
    await store.putBlob({ id: attachmentId, name: file.name, mime: file.type || 'application/octet-stream', data });
    await add('evidence', {
      attachmentId, sha256, name: file.name, mime: file.type || 'application/octet-stream', size: file.size,
      fileModifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null, linkId: linkId || null,
    });
    n++;
  }
  await refresh();
  if (n) toast(`${n} file${n > 1 ? 's' : ''} added and fingerprinted.`);
}

// ---------------------------------------------------------------- audit

function describe(e) {
  const p = e.payload || {};
  const t = (iso) => fmtDT(Date.parse(iso));
  switch (e.type) {
    case 'clock': return `${C.KIND_LABEL[p.kind]} at ${t(p.at)}${p.source === 'manual' ? ' (entered by hand)' : ''}`;
    case 'correction': return `Correction: time set to ${t(p.newAt)}. Reason: ${p.reason}`;
    case 'void': return `Moved to bin${p.reason ? `. Reason: ${p.reason}` : ''}`;
    case 'restore': return 'Restored from bin';
    case 'location': return p.status === 'ok' ? `Location ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} (about ${Math.round(p.accuracyM)} m)` : `Location not captured (${p.status})`;
    case 'evidence': return `File added: ${p.name} (${bytes(p.size)})`;
    case 'note': return `Note: ${p.text}`;
    case 'schedule': return `Rota: ${p.date} ${p.off ? 'time off' : `${p.start}–${p.end}`}${p.role ? `, ${p.role}` : ''}${p.source === 'import' ? ' (imported)' : ''}${p.supersedes ? ' (replaces an earlier entry)' : ''}`;
    case 'employer': return `Employer figure: ${p.paidHours} h`;
    case 'payslip': return `Payslip ${p.from} to ${p.to}: ${p.hours} h, ${p.gross} gross`;
    case 'settings': return 'Settings changed';
    default: return e.type;
  }
}

let auditAll = false;
function vAudit() {
  const list = [...entries].reverse();
  const shown = auditAll ? list : list.slice(0, 100);
  const head = model.head;
  const checkpoint = head
    ? `Hours Ledger checkpoint\nRecords: ${head.seq}\nLatest record fingerprint (SHA-256): ${head.hash}\nTaken (device clock, UTC): ${new Date().toISOString()}`
    : '';
  return `<header class="page-head"><h1>Audit log</h1></header>
    <section class="card"><div class="card__head"><h2>Chain check</h2><button class="btn btn--sm" data-action="verify">Check again</button></div>
      <p id="chain-status" role="status">Checking…</p>
      <p class="note">Each record carries the fingerprint of the record before it. Changing, removing or reordering an old record breaks every link after it.</p>
    </section>
    ${head ? `<section class="card"><h2>Checkpoint</h2>
      <p class="note">Send this somewhere outside this device from time to time, for example in an email to yourself. A dated copy held elsewhere is what lets you show later that the log has not been rewritten since.</p>
      <textarea id="checkpoint" class="mono" rows="4" readonly>${esc(checkpoint)}</textarea>
      <div class="btnrow"><button class="btn" data-action="copy-checkpoint">Copy checkpoint</button></div></section>` : ''}
    <section class="card"><h2>What these records can and cannot show</h2>
      <ul class="plain limits">
        <li><b>Times</b> come from this device's clock. If the clock was wrong or was changed, the recorded time is wrong too. Nothing here checks the time against an outside source.</li>
        <li><b>Location</b> is whatever the device reported, with the accuracy it claimed. Indoors it can be off by a long way, and a device can be made to report a false position.</li>
        <li><b>Files</b> are kept unaltered and fingerprinted, so a later change is detectable. The app cannot tell whether a screenshot or photo is genuine.</li>
        <li><b>The chain</b> makes quiet edits detectable, but someone with full control of this device could rebuild the whole chain. Checkpoints and backups sent elsewhere at the time are what guard against that.</li>
        <li><b>Hand-entered records and corrections</b> are marked as such and carry the time they were actually entered, which may be long after the event.</li>
      </ul>
    </section>
    <section class="card"><div class="card__head"><h2>${entries.length} record${entries.length === 1 ? '' : 's'}</h2><span class="mute">newest first</span></div>
      <ol class="audit">${shown.map((e) => `<li><details><summary><span class="audit__seq num">#${e.seq}</span><span class="audit__when num">${esc(fmtDT(Date.parse(e.recordedAt)))}</span><span class="audit__what">${esc(describe(e))}</span><span class="audit__hash num">${short(e.hash)}</span></summary><pre class="mono">${esc(JSON.stringify(e, null, 2))}</pre></details></li>`).join('')}</ol>
      ${list.length > shown.length ? `<div class="btnrow"><button class="btn" data-action="audit-all">Show all ${list.length}</button></div>` : ''}
    </section>`;
}

async function runVerify() {
  chain = await C.verifyChain(entries);
  const el = document.getElementById('chain-status');
  if (!el) return;
  if (chain.ok) {
    el.innerHTML = `${pill('Intact', 'ok')} All ${chain.count} records link correctly and match their fingerprints.${chain.notices.length ? ` <span class="mute">Note: at ${chain.notices.length} point${chain.notices.length > 1 ? 's' : ''} the device clock read earlier than at the previous record (first at #${chain.notices[0].seq}). Hand-dated test data and clock adjustments both cause this.</span>` : ''}`;
  } else {
    el.innerHTML = `${pill('Broken', 'bad')} ${chain.problems.length} problem${chain.problems.length > 1 ? 's' : ''}. First: record #${chain.problems[0].seq}. ${esc(chain.problems[0].problem)}`;
  }
}

// ---------------------------------------------------------------- setup

function vSetup() {
  const s = model.settings;
  const rates = [...s.rates].sort((a, b) => (a.from < b.from ? -1 : 1));
  const zones = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return [s.timeZone]; } })();
  return `<header class="page-head"><h1>Setup and backup</h1></header>
    ${iosInstallCard()}<section class="card"><h2>Backup</h2>
      <p class="note">A backup is one ZIP file: the full log, every evidence file, and spreadsheets of your shifts and records. It can be restored into this app on any device. ${NATIVE ? 'It is saved to Downloads/Hours Ledger on this phone, and you are then offered the chance to send a copy elsewhere. ' : IOS ? 'On an iPhone you are shown the share sheet: choose Save to Files, or send it to yourself. ' : ''}${lastBackup ? `Last exported from this device ${esc(fmtDT(lastBackup.at))}.` : 'None exported from this device yet.'}</p>
      <div class="btnrow"><button class="btn btn--primary" data-action="export-backup">Export backup</button><button class="btn" data-action="import-backup">Restore from backup</button></div>
      <p class="note">Storage on this device: ${PREVIEW ? 'preview, nothing is saved' : !store.saved ? 'not available' : NATIVE ? 'kept inside the app. Uninstalling the app or clearing its data erases every record, so export a backup first' : IOS && STANDALONE ? 'kept with the Home Screen app. Removing the app from the Home Screen, or clearing Safari website data in Settings, erases every record, so export a backup often' : IOS ? 'a Safari tab, which Safari can clear after seven days without a visit. Add the app to your Home Screen and record there' : persisted === true ? 'the browser has agreed to keep it' : persisted === false ? 'the browser may clear it under pressure; install the app and back up often' : 'status unknown'}.</p>
    </section>
    <section class="card"><h2>Pay and periods</h2>
      <form id="settings-form" class="form">
        ${field('s-system', "Employer's system", `<input id="s-system" name="employerSystem" value="${esc(s.employerSystem)}">`, 'Used in labels only. This app never connects to it.')}
        ${field('s-start', 'Pay period starts on day', `<input id="s-start" name="payPeriodStartDay" type="number" min="1" max="28" value="${s.payPeriodStartDay}" required>`, 'A period runs from this day to the day before it in the next month.')}
        ${field('s-payday', 'Pay day', `<input id="s-payday" name="payDay" type="number" min="1" max="28" value="${s.payDay}" required>`)}
        ${field('s-week', 'Week starts on', `<select id="s-week" name="weekStartsOn">${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => `<option value="${i}"${i === s.weekStartsOn ? ' selected' : ''}>${d}</option>`).join('')}</select>`)}
        ${field('s-breaks', 'Breaks', `<select id="s-breaks" name="breaksPaid"><option value="false"${s.breaksPaid ? '' : ' selected'}>Unpaid: deduct from worked time</option><option value="true"${s.breaksPaid ? ' selected' : ''}>Paid: do not deduct</option></select>`)}
        ${field('s-ot', 'Report weekly hours above', `<input id="s-ot" name="weeklyOvertimeAfterHours" type="number" min="0" step="0.25" value="${s.weeklyOvertimeAfterHours ?? ''}" placeholder="off">`, 'Your contracted weekly hours, if you want hours beyond them listed in reports. Pay is still worked out at the flat hourly rate.')}
        ${field('s-tz', 'Time zone', `<select id="s-tz" name="timeZone">${zones.map((z) => `<option${z === s.timeZone ? ' selected' : ''}>${z}</option>`).join('')}</select>`, 'Shift dates and displayed times use this zone, whatever the device is set to.')}
        ${field('s-loc', 'Location', `<select id="s-loc" name="captureLocation"><option value="true"${s.captureLocation ? ' selected' : ''}>Capture with each clock record</option><option value="false"${s.captureLocation ? '' : ' selected'}>Do not capture</option></select>`)}
        <div class="btnrow"><button class="btn btn--primary" type="submit">Save settings</button></div>
      </form>
    </section>
    <section class="card"><div class="card__head"><h2>Hourly rate</h2><button class="btn btn--sm" data-action="add-rate">Add rate change</button></div>
      <div class="tablewrap"><table class="table"><thead><tr><th>From</th><th class="r">Rate</th><th></th></tr></thead><tbody>
      ${rates.map((r, i) => `<tr><td>${i === 0 ? 'Start' : esc(fmtD(r.from))}</td><td class="num r">${money(Math.round(r.rate * 100))}</td><td class="r">${i === 0 ? '' : `<button class="link" data-action="remove-rate" data-from="${r.from}">Remove</button>`}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="note">Each shift is priced at the rate in force on the day it started, so a pay rise does not rewrite earlier periods.</p>
    </section>
    ${NATIVE ? `<section class="card"><h2>Updating the app</h2>
      <p class="note">To update, open the new APK file and tap Update. It installs over this version and your records stay. <b>Do not uninstall first</b>: uninstalling erases everything stored in the app. Export a backup before each update, to be safe.</p>
      <p class="note">This is version ${esc(VERSION)}.</p></section>` : PREVIEW ? '' : `<section class="card"><h2>Updating the app</h2>
      <p class="note">This version updates itself. When you open it with a connection it fetches any newer version, and your records stay where they are. With no connection it runs from the copy already on this device.</p>
      <p class="note">This is version ${esc(VERSION)}.</p></section>`}
    <section class="card"><h2>Erase everything</h2>
      <p class="note">Removes every record and file from this device. Meant for clearing test data before real use. Export a backup first if there is anything to keep.</p>
      <div class="btnrow"><button class="btn btn--stop" data-action="erase">Erase all data on this device</button></div>
    </section>`;
}

function vMore() {
  const link = (h, t, d) => `<a class="row row--more" href="#${h}"><span><b>${t}</b><br><span class="mute">${d}</span></span></a>`;
  return `<header class="page-head"><h1>More</h1></header><section class="card"><div class="rows">
    ${link('rota', 'Rota', 'Scheduled shifts, compared with what you worked')}
    ${link('evidence', 'Evidence', 'Screenshots, photos and other files')}
    ${link('bin', `Bin${model.bin.length ? ` (${model.bin.length})` : ''}`, 'Shifts, records and files you removed. Restore them here')}
    ${link('audit', 'Audit log', 'Every record, the chain check and checkpoints')}
    ${link('setup', 'Setup and backup', 'Pay rate, pay period, export and restore')}
  </div></section><p class="note">Hours Ledger version ${esc(VERSION)}</p>`;
}

// ---------------------------------------------------------------- bin

const BIN_KIND = { clock: 'Clock record', evidence: 'File', note: 'Note', schedule: 'Rota entry', payslip: 'Payslip figures', employer: 'Employer figure' };

function binText(e) {
  if (e.type === 'clock') {
    const c = model.clockById.get(e.id);
    return `${C.KIND_LABEL[e.payload.kind]} at ${fmtDT(c ? c.atMs : Date.parse(e.payload.at))}${e.payload.source === 'manual' ? ' (entered by hand)' : ''}`;
  }
  return describe(e).replace(/^(File added|Note|Rota|Employer figure): /, '');
}

function vBin() {
  const groups = model.bin;
  return `<header class="page-head"><h1>Bin</h1></header>
    <section class="card"><p class="note">Things you removed. They are left out of every total, but nothing is erased: each item stays here, and in the audit log, and can be put back at any time. The bin is never emptied.</p></section>
    ${groups.length ? `<section class="card"><div class="rows">${groups.map((g) => {
      const one = g.items.length === 1 ? g.items[0] : null;
      const title = one ? binText(one) : (g.label || `${g.items.length} records`);
      return `<div class="binitem">
        <div class="binitem__head">${pill(one ? (BIN_KIND[one.type] || 'Record') : g.items.every((e) => e.type === 'schedule') ? 'Rota' : 'Shift', 'mute')}<b>${esc(title)}</b></div>
        ${one ? '' : `<ul class="binitem__list">${g.items.map((e) => `<li>${esc(binText(e))}</li>`).join('')}</ul>`}
        <div class="binitem__sub">Moved to the bin ${esc(fmtDT(g.binnedMs))}${g.reason ? ` · Reason: ${esc(g.reason)}` : ''}</div>
        <div class="btnrow"><button class="btn btn--sm btn--primary" data-action="restore-group" data-key="${g.key}">Restore</button>
          ${one && one.type === 'evidence' ? `<button class="btn btn--sm" data-action="view-evidence" data-id="${one.id}">View file</button>` : ''}</div>
      </div>`;
    }).join('')}</div></section>` : '<section class="card"><p class="empty">The bin is empty.</p></section>'}`;
}

const VIEWS = { dashboard: vDashboard, shifts: vShifts, reports: vReports, rota: vRota, payslips: vPayslips, evidence: vEvidence, bin: vBin, audit: vAudit, setup: vSetup, more: vMore };

// ---------------------------------------------------------------- actions

function captureLocation(targetId) {
  if (PREVIEW || !model.settings.captureLocation) return;
  const save = (payload) => add('location', { targetId, ...payload }).then(() => refresh(true)).catch((e) => toast(`Location could not be saved: ${e.message}`, 'bad'));
  if (!('geolocation' in navigator)) return save({ status: 'unsupported' });
  navigator.geolocation.getCurrentPosition(
    (pos) => save({
      status: 'ok', lat: pos.coords.latitude, lon: pos.coords.longitude, accuracyM: pos.coords.accuracy,
      altitudeM: pos.coords.altitude ?? null, fixAt: new Date(pos.timestamp).toISOString(),
    }),
    (err) => save({ status: err.code === 1 ? 'denied' : err.code === 2 ? 'unavailable' : 'timeout', message: err.message || '' }),
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
  );
}

let clocking = false;
async function doClock(kind) {
  const t = Date.now(); // taken before anything else happens
  if (clocking) return;
  clocking = true;
  try {
    const e = await add('clock', { kind, at: new Date(t).toISOString(), source: 'live' }, t);
    captureLocation(e.id);
    await refresh();
    toast(`${C.KIND_LABEL[kind]} recorded at ${fmtT(t)}.`);
  } finally {
    clocking = false;
  }
}

function correctDialog(id) {
  const ev = model.clockById.get(id);
  dialog({
    title: `Correct ${C.KIND_LABEL[ev.kind].toLowerCase()}`, submit: 'Record correction',
    body: `<p class="note">The original record (${esc(fmtDT(ev.originalMs))}) stays in the log. This adds a correction beside it, and both remain visible.</p>
      ${field('c-date', 'Correct date', `<input id="c-date" name="date" type="date" value="${C.localDate(ev.atMs, tz())}" required>`)}
      ${field('c-time', 'Correct time', `<input id="c-time" name="time" type="time" step="1" value="${fmtT(ev.atMs)}" required>`)}
      ${field('c-reason', 'Reason', `<textarea id="c-reason" name="reason" rows="2" required placeholder="For example: tapped two minutes after starting"></textarea>`)}`,
    onSubmit: async (f) => {
      if (!f.reason.trim()) throw new Error('Give a reason, so the correction explains itself later.');
      const z = toInstant(f.date, f.time);
      if (z.nonexistent) throw new Error('That time does not exist on that date because the clocks went forward.');
      await add('correction', { targetId: id, newAt: new Date(z.ms).toISOString(), previousAt: new Date(ev.atMs).toISOString(), reason: f.reason.trim(), localTimeOccursTwice: z.ambiguous || undefined });
      await refresh();
      toast(z.ambiguous ? 'Correction recorded. That time happens twice that night; the earlier one was used.' : 'Correction recorded. The original is kept.');
    },
  });
}

// "Delete" in this app means move to the bin: a void entry is added, the original stays in the log.
// Several ids binned together (a whole shift) share a batchId so they restore together.
function binDialog(ids, what, label) {
  dialog({
    title: `Move ${what} to the bin`, submit: 'Move to bin', danger: true,
    body: `<p class="note">It comes out of every total straight away. Nothing is erased: it stays in the bin and can be restored at any time.</p>
      ${field('v-reason', 'Reason (optional)', `<input id="v-reason" name="reason" placeholder="For example: test entry, tapped by mistake">`)}`,
    onSubmit: async (f) => {
      const was = route();
      const batchId = ids.length > 1 ? uuid() : undefined;
      for (const targetId of ids) {
        await add('void', { targetId, reason: f.reason.trim() || undefined, batchId, label: batchId ? label : undefined });
      }
      await refresh();
      toast('Moved to the bin. You can restore it from More, then Bin.');
      if (was.name === 'shift' && !model.shifts.some((s) => s.id === was.id)) location.hash = '#shifts';
    },
  });
}

function binShift(id) {
  const sh = model.shifts.find((x) => x.id === id);
  if (!sh) return;
  const label = `Shift on ${fmtD(sh.date)}, ${fmtT(sh.startMs)} to ${sh.endMs ? fmtT(sh.endMs) : sh.status === 'open' ? 'still open' : 'no clock-out'}`;
  binDialog(sh.events.map((e) => e.id), 'this shift', label);
}

async function restoreGroup(key) {
  const g = model.bin.find((x) => x.key === key);
  if (!g) return;
  for (const e of g.items) await add('restore', { targetId: e.id, batchId: g.batch ? g.key : undefined });
  await refresh();
  toast(g.items.length > 1 && g.items.every((e) => e.type === 'clock') ? 'Shift restored. It counts towards your totals again.' : 'Restored.');
}

const handInstant = (date, time) => {
  const z = toInstant(date, time);
  if (z.nonexistent) throw new Error(`${time} does not exist on that date because the clocks went forward.`);
  return z.ms;
};

// One form for a whole shift entered after the fact: clock in, clock out and an optional break.
function addShiftDialog(date) {
  const due = date ? model.schedule.filter((x) => x.date === date && !x.off) : [];
  const pre = due.length === 1 && !model.shifts.some((x) => x.date === date) ? due[0] : null;
  const t = (id, name, label, value = '') => field(id, label, `<input id="${id}" name="${name}" type="time" value="${value}">`);
  dialog({
    title: 'Add a shift by hand', submit: 'Add shift',
    body: `<p class="note">For a shift you did not clock at the time. Each record is saved as entered by hand, stamped with the time you add it.</p>
      ${field('h-date', 'Date the shift started', `<input id="h-date" name="date" type="date" value="${date || today()}" required>`)}
      <div class="range">${t('h-in', 'tin', 'Clock in', pre ? pre.start : '')}${t('h-out', 'tout', 'Clock out', pre ? pre.end : '')}</div>
      ${pre ? '<p class="dlg__hint">These are the rota times for this day. Change them to when you actually started and finished.</p>' : ''}
      <p class="note">A clock-out earlier than the clock-in is taken as the next day.</p>
      <div class="range">${t('h-bs', 'bstart', 'Break start (optional)')}${t('h-be', 'bend', 'Break end (optional)')}</div>
      ${field('h-note', 'Note (optional)', `<input id="h-note" name="note" placeholder="For example: forgot to open the app">`)}`,
    onSubmit: async (f) => {
      if (!f.date || !f.tin) throw new Error('Enter the date and the clock-in time.');
      const inMs = handInstant(f.date, f.tin);
      const after = (time, what) => {
        let ms = handInstant(f.date, time);
        if (ms <= inMs) ms = handInstant(C.addDays(f.date, 1), time);
        if (ms - inMs > 20 * 3600000) throw new Error(`${what} is more than 20 hours after the clock-in. Check the times.`);
        return ms;
      };
      const outMs = f.tout ? after(f.tout, 'The clock-out') : null;
      let bs = null, be = null;
      if (f.bstart || f.bend) {
        if (!f.bstart || !f.bend) throw new Error('Enter both the break start and the break end, or leave both empty.');
        bs = after(f.bstart, 'The break start');
        be = after(f.bend, 'The break end');
        if (be <= bs) throw new Error('The break has to end after it starts.');
        if (outMs && be > outMs) throw new Error('The break has to fall inside the shift.');
      }
      if ((outMs || be || inMs) > Date.now() + 60000) throw new Error('Those times are in the future.');
      if (!outMs && model.shifts.some((sh) => sh.startMs >= inMs)) throw new Error('Enter the clock-out time. Only a shift you are still working can be left without one.');
      for (const sh of model.shifts) {
        const end = sh.endMs || (sh.status === 'open' ? Date.now() : sh.startMs);
        if (inMs <= end && (outMs || Date.now()) >= sh.startMs) {
          throw new Error(`That overlaps the shift already recorded on ${fmtD(sh.date)} (${fmtT(sh.startMs)} to ${sh.endMs ? fmtT(sh.endMs) : 'no clock-out'}). Correct that shift or move it to the bin first.`);
        }
      }
      const groupId = uuid();
      const note = f.note.trim() || undefined;
      const recs = [['in', inMs], ['break_start', bs], ['break_end', be], ['out', outMs]].filter((r) => r[1] != null);
      let first = null;
      for (const [kind, ms] of recs) {
        const e = await add('clock', { kind, at: new Date(ms).toISOString(), source: 'manual', note, groupId });
        first = first || e;
      }
      await refresh();
      toast(outMs ? 'Shift added, marked as entered by hand.' : 'Shift added with no clock-out yet. Clock out from the dashboard when you finish.');
      location.hash = `#shift-${first.id}`;
    },
  });
}

const DAY_MS = 24 * 3600000;

// Would a hand-entered break or clock-out at `ms` land inside a shift that can take it?
// Returns that shift, or null if the record would be left outside every shift.
function shiftFor(kind, ms) {
  const sh = [...model.shifts].reverse().find((x) => x.startMs < ms);
  if (!sh || ms - sh.startMs > DAY_MS) return null;
  if (sh.status === 'complete') return kind !== 'out' && ms < sh.endMs ? sh : null;
  const next = model.shifts.find((x) => x.startMs > sh.startMs);
  return !next || ms < next.startMs ? sh : null;
}

// Add one record by hand. Opened from a shift, it belongs to that shift: only the time is asked,
// and a time earlier than the clock-in is taken as the next day.
function addEventDialog(date, kind, shiftId) {
  const sh = shiftId ? model.shifts.find((x) => x.id === shiftId) : null;
  const kinds = Object.entries(C.KIND_LABEL).filter(([k]) => !sh || k !== 'in');
  dialog({
    title: sh ? `Add a record to the shift on ${fmtD(sh.date)}` : 'Add a missed record', submit: 'Add record',
    body: `<p class="note">${sh
        ? `This shift started at ${fmtT(sh.startMs)}. A time earlier than that is taken as the next day, so a finish after midnight needs no date.`
        : 'For one clock-in, break or clock-out you did not tap at the time. To enter a whole shift at once, use "Add shift by hand" on the Shifts page.'} It is saved as entered by hand, stamped with the time you add it.</p>
      ${field('m-kind', 'What happened', `<select id="m-kind" name="kind">${kinds.map(([k, l]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${sh ? '' : field('m-date', 'Date', `<input id="m-date" name="date" type="date" value="${date || today()}" required>`)}
      ${field('m-time', 'Time', `<input id="m-time" name="time" type="time" step="1" required>`)}
      ${field('m-note', 'Note (optional)', `<input id="m-note" name="note" placeholder="For example: forgot to tap out">`)}`,
    onSubmit: async (f) => {
      if (!f.time) throw new Error('Enter the time.');
      let ms, moved = false;
      if (sh) {
        ms = handInstant(sh.date, f.time);
        if (ms <= sh.startMs) ms = handInstant(C.addDays(sh.date, 1), f.time);
        const home = shiftFor(f.kind, ms);
        if (!home || home.id !== sh.id) {
          throw new Error(sh.status === 'complete'
            ? `That time is not inside this shift (${fmtT(sh.startMs)} to ${fmtT(sh.endMs)}).`
            : `${fmtDT(ms)} runs into your next recorded shift. Check the time.`);
        }
      } else {
        ms = handInstant(f.date, f.time);
        if (f.kind === 'in') {
          const clash = model.shifts.find((x) => x.status === 'complete' && ms >= x.startMs && ms <= x.endMs);
          if (clash) throw new Error(`That is inside the shift already recorded on ${fmtD(clash.date)} (${fmtT(clash.startMs)} to ${fmtT(clash.endMs)}).`);
        } else if (!shiftFor(f.kind, ms)) {
          // Usual cause: a finish after midnight entered against the day the shift started.
          const alt = handInstant(C.addDays(f.date, 1), f.time);
          if (!shiftFor(f.kind, alt)) throw new Error(`No shift is open at ${fmtDT(ms)}, so this record would not belong to any shift. Check the date, or add the clock-in first.`);
          ms = alt;
          moved = true;
        }
      }
      if (ms > Date.now() + 60000) throw new Error(`${fmtDT(ms)} is in the future.`);
      await add('clock', { kind: f.kind, at: new Date(ms).toISOString(), source: 'manual', note: f.note.trim() || undefined });
      await refresh();
      toast(`${C.KIND_LABEL[f.kind]} added for ${fmtDT(ms)}${moved ? ' (the next day, to match the shift it belongs to)' : ''}.`);
    },
  });
}

// A record left outside every shift because it was entered against the day the shift started:
// if the same time one day later fits a shift, offer that as a one-tap correction.
function nextDayFix(ev) {
  if (ev.kind === 'in') return null;
  const date = C.localDate(ev.atMs, tz());
  let alt;
  try { alt = handInstant(C.addDays(date, 1), fmtT(ev.atMs)); } catch { return null; }
  return shiftFor(ev.kind, alt) ? { ms: alt, date: C.addDays(date, 1) } : null;
}

async function moveToNextDay(id) {
  const ev = model.clockById.get(id);
  const fix = ev && nextDayFix(ev);
  if (!fix) return;
  await add('correction', {
    targetId: id, newAt: new Date(fix.ms).toISOString(), previousAt: new Date(ev.atMs).toISOString(),
    reason: 'Entered against the day the shift started. It belongs to the next day.',
  });
  await refresh();
  toast(`Moved to ${fmtDT(fix.ms)}. The original entry is kept.`);
}

function noteDialog(linkId) {
  dialog({
    title: 'Add note', submit: 'Add note',
    body: field('n-text', 'Note', `<textarea id="n-text" name="text" rows="4" required placeholder="For example: manager asked me to stay to close"></textarea>`),
    onSubmit: async (f) => {
      if (!f.text.trim()) throw new Error('Write the note first.');
      await add('note', { linkId, text: f.text.trim() });
      await refresh();
    },
  });
}

function scheduleDialog(id) {
  const old = id ? model.schedule.find((x) => x.id === id) : null;
  dialog({
    title: old ? 'Change scheduled shift' : 'Add scheduled shift',
    body: `${old ? '<p class="note">The earlier entry stays in the log, marked as replaced.</p>' : ''}
      ${field('r-date', 'Date', `<input id="r-date" name="date" type="date" value="${old ? old.date : today()}" required>`)}
      ${field('r-start', 'Scheduled start', `<input id="r-start" name="start" type="time" value="${old ? old.start : ''}" required>`)}
      ${field('r-end', 'Scheduled finish', `<input id="r-end" name="end" type="time" value="${old ? old.end : ''}" required>`, 'A finish earlier than the start is taken as the next day.')}
      ${field('r-role', 'Role (optional)', `<input id="r-role" name="role" value="${old ? esc(old.role || '') : ''}">`)}
      ${field('r-break', 'Scheduled break (minutes)', `<input id="r-break" name="breakMin" type="number" min="0" step="1" value="${old ? old.breakMin : 0}">`)}
      ${field('r-note', 'Note', `<input id="r-note" name="note" value="${old ? esc(old.note || '') : ''}">`)}`,
    onSubmit: async (f) => {
      if (!f.date || !f.start || !f.end) throw new Error('Enter the date, start and finish.');
      await add('schedule', { date: f.date, start: f.start.slice(0, 5), end: f.end.slice(0, 5), breakMin: Number(f.breakMin) || 0, role: f.role.trim() || undefined, note: f.note.trim(), supersedes: old ? old.id : undefined });
      await refresh();
    },
  });
}

function employerDialog(shiftId) {
  const old = model.employer.get(shiftId);
  const sys = esc(model.settings.employerSystem || 'your employer');
  dialog({
    title: `${model.settings.employerSystem || 'Employer'} figure for this shift`,
    body: `<p class="note">Copy what ${sys} shows for this shift. A screenshot of that screen, attached as evidence, backs the number up.</p>
      ${field('e-hours', 'Paid hours shown', `<input id="e-hours" name="paidHours" type="number" min="0" step="0.01" value="${old ? old.paidHours : ''}" required>`)}
      ${field('e-ot', 'Of which approved overtime (hours)', `<input id="e-ot" name="overtimeApprovedHours" type="number" min="0" step="0.01" value="${old && old.overtimeApprovedHours ? old.overtimeApprovedHours : ''}">`)}
      ${field('e-note', 'Note', `<input id="e-note" name="note" value="${old ? esc(old.note || '') : ''}">`)}`,
    onSubmit: async (f) => {
      if (f.paidHours === '') throw new Error('Enter the hours shown.');
      await add('employer', { shiftId, paidHours: Number(f.paidHours), overtimeApprovedHours: f.overtimeApprovedHours ? Number(f.overtimeApprovedHours) : undefined, note: f.note.trim(), supersedes: old ? old.id : undefined });
      await refresh();
    },
  });
}

function payslipDialog(from, to) {
  const old = model.payslips.filter((x) => x.from === from && x.to === to).pop();
  dialog({
    title: `Payslip for ${fmtRange({ from, to })}`,
    body: `${field('p-hours', 'Hours paid', `<input id="p-hours" name="hours" type="number" min="0" step="0.01" value="${old ? old.hours : ''}" required>`, 'Basic hours as printed on the payslip.')}
      ${field('p-gross', `Gross pay for those hours (${esc(cur())})`, `<input id="p-gross" name="gross" type="number" min="0" step="0.01" value="${old ? old.gross : ''}" required>`, 'Before tax and other deductions. Leave out tips, holiday pay and bonuses.')}
      ${field('p-note', 'Note', `<input id="p-note" name="note" value="${old ? esc(old.note || '') : ''}">`)}`,
    onSubmit: async (f) => {
      if (f.hours === '' || f.gross === '') throw new Error('Enter both the hours and the gross pay.');
      await add('payslip', { from, to, payDate: C.payDate({ from, to }, model.settings.payDay), hours: Number(f.hours), gross: Number(f.gross), note: f.note.trim(), supersedes: old ? old.id : undefined });
      await refresh();
    },
  });
}

async function saveSettings(patch) {
  const next = { ...model.settings, ...patch };
  await add('settings', { settings: next });
  await refresh();
  toast('Settings saved. Totals have been recalculated.');
}

function rateDialog() {
  dialog({
    title: 'Add rate change',
    body: `${field('rt-from', 'From date', `<input id="rt-from" name="from" type="date" value="${today()}" required>`)}
      ${field('rt-rate', `New hourly rate (${esc(cur())})`, `<input id="rt-rate" name="rate" type="number" min="0" step="0.01" required>`)}`,
    onSubmit: async (f) => {
      const rate = Number(f.rate);
      if (!f.from || !(rate > 0)) throw new Error('Enter a date and a rate above zero.');
      const rates = model.settings.rates.filter((r) => r.from !== f.from).concat({ from: f.from, rate });
      await saveSettings({ rates });
    },
  });
}

// ---------------------------------------------------------------- backup

const safeName = (n) => String(n || 'file').replace(/[^\w.\- ]+/g, '_').slice(-80);

async function exportBackup() {
  const all = await store.all();
  const check = await C.verifyChain(all);
  const m = C.buildModel(all, Date.now());
  const head = all[all.length - 1] || null;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const log = {
    format: C.FORMAT, app: 'Hours Ledger', exportedAt: new Date().toISOString(),
    entryCount: all.length, headSeq: head ? head.seq : 0, headHash: head ? head.hash : C.GENESIS,
    chainIntactAtExport: check.ok, entries: all,
  };
  const files = [
    { name: 'README.txt', data: backupReadme(log) },
    { name: 'log.json', data: JSON.stringify(log, null, 1) },
    { name: 'shifts.csv', data: shiftsCsv(m.shifts) },
    { name: 'records.csv', data: eventsCsv() },
  ];
  let missing = 0;
  for (const e of m.evidence) {
    const rec = await store.getBlob(e.attachmentId);
    if (rec) files.push({ name: `evidence/${e.attachmentId}__${safeName(e.name)}`, data: new Blob([rec.data], { type: rec.mime }) });
    else missing++;
  }
  const where = await download(await makeZip(files), `hours-ledger-backup-${stamp}.zip`, true);
  if (!where) return;
  lastBackup = { at: Date.now(), seq: log.headSeq };
  await store.setMeta('lastBackup', lastBackup);
  render();
  const saved = typeof where === 'string' ? `Backup saved to ${where}.` : 'Backup exported.';
  toast(missing ? `${saved} ${missing} evidence file${missing > 1 ? 's were' : ' was'} missing from this device.` : `${saved} Keep a copy somewhere other than this phone.`, missing ? 'warn' : 'ok');
}

function backupReadme(log) {
  return [
    'HOURS LEDGER BACKUP', '',
    `Exported: ${log.exportedAt} (device clock, UTC)`,
    `Records: ${log.entryCount}`,
    `Latest record fingerprint: ${log.headHash}`,
    `Chain intact at export: ${log.chainIntactAtExport ? 'yes' : 'NO'}`, '',
    'WHAT IS IN THIS FILE',
    '  log.json      Every record ever written, in order. This is the source of truth.',
    '  shifts.csv    Shifts worked out from the log, for reading in a spreadsheet.',
    '  records.csv   Every clock record with original time, effective time and location.',
    '  evidence/     Attached files, unaltered. Each name starts with its attachment id.', '',
    'HOW THE LOG IS PROTECTED',
    '  Each record holds "prevHash", the fingerprint of the record before it, and "hash",',
    '  its own fingerprint. A fingerprint is the SHA-256 of the record (without its "hash"',
    '  field) written as JSON with keys sorted alphabetically and no spaces.',
    '  Changing, removing or reordering any record breaks the chain from that point on.',
    '  Each evidence record holds the SHA-256 of its file, so a changed file is detectable.', '',
    'CORRECTIONS',
    '  Nothing is edited in place. A correction is a new record of type "correction" that',
    '  points at the original through "targetId". A "void" record takes a record out of the',
    '  calculations without removing it. Originals are always still in log.json.', '',
    'LIMITS',
    '  Times come from the device clock and are only as right as that clock was.',
    '  Locations are as reported by the device, with its own accuracy estimate.',
    '  The chain shows the log is internally consistent. It cannot by itself show when the',
    '  log was written. A copy of this backup, or of its latest fingerprint, held somewhere',
    '  else with an independent date (an email to yourself, for example) does that.', '',
  ].join('\r\n');
}

async function importBackup(file) {
  const files = await readZip(file);
  const lf = files.find((f) => f.name === 'log.json');
  if (!lf) throw new Error('This ZIP has no log.json, so it is not an Hours Ledger backup.');
  const data = JSON.parse(await (await lf.blob()).text());
  if (!data || !Array.isArray(data.entries)) throw new Error('log.json is not in the expected format.');
  const incoming = [...data.entries].sort((a, b) => a.seq - b.seq);
  const check = await C.verifyChain(incoming);
  if (!check.ok) throw new Error(`The backup failed its chain check at record #${check.problems[0].seq}: ${check.problems[0].problem} Nothing was imported.`);
  const mine = await store.all();
  const n = Math.min(mine.length, incoming.length);
  const shared = n === 0 || mine[n - 1].hash === incoming[n - 1].hash;

  const loadBlobs = async () => {
    let bad = 0, absent = 0;
    for (const e of incoming) {
      if (e.type !== 'evidence') continue;
      const f = files.find((x) => x.name.startsWith(`evidence/${e.payload.attachmentId}__`));
      if (!f) { absent++; continue; }
      const buf = await (await f.blob()).arrayBuffer();
      if ((await C.sha256Hex(buf)) !== e.payload.sha256) { bad++; continue; }
      await store.putBlob({ id: e.payload.attachmentId, name: e.payload.name, mime: e.payload.mime, data: buf });
    }
    return { bad, absent };
  };
  const finish = async (msg, r) => {
    await refresh();
    chain = await C.verifyChain(entries);
    render();
    const extra = r.bad || r.absent ? ` ${r.bad} evidence file${r.bad === 1 ? '' : 's'} did not match their fingerprints and were left out; ${r.absent} were not in the backup.` : '';
    toast(msg + extra, r.bad ? 'bad' : r.absent ? 'warn' : 'ok');
  };

  if (shared && incoming.length <= mine.length) {
    const r = await loadBlobs();
    return finish(mine.length === incoming.length ? 'This device already matches that backup.' : `This device already holds everything in that backup, plus ${mine.length - incoming.length} newer records. Nothing was changed.`, r);
  }
  if (shared) {
    await store.load(incoming.slice(mine.length), [], { replace: false });
    const r = await loadBlobs();
    return finish(`${incoming.length - mine.length} records restored from the backup.`, r);
  }
  dialog({
    title: 'This backup has a different history', submit: 'Replace this device', danger: true,
    body: `<p>The backup and this device both hold records the other does not, so they cannot be merged. This usually means records were added on two devices separately.</p>
      <p><b>Replacing will discard the ${mine.length} records on this device</b> and load the ${incoming.length} from the backup. Export a backup of this device first if you might need it.</p>
      ${field('i-confirm', 'Type REPLACE to go ahead', `<input id="i-confirm" name="confirm" autocomplete="off" required>`)}`,
    onSubmit: async (f) => {
      if (f.confirm !== 'REPLACE') throw new Error('Type REPLACE in capitals to confirm.');
      await store.load(incoming, [], { replace: true });
      const r = await loadBlobs();
      await finish(`This device now holds the ${incoming.length} records from the backup.`, r);
    },
  });
}

function eraseDialog() {
  dialog({
    title: 'Erase all data on this device', submit: 'Erase everything', danger: true,
    body: `<p>This removes all ${entries.length} records and every evidence file from this device. It cannot be undone, and no backup is made for you.</p>
      ${field('x-confirm', 'Type ERASE to go ahead', `<input id="x-confirm" name="confirm" autocomplete="off" required>`)}`,
    onSubmit: async (f) => {
      if (f.confirm !== 'ERASE') throw new Error('Type ERASE in capitals to confirm.');
      await store.eraseAll();
      lastBackup = null;
      await refresh();
      chain = await C.verifyChain(entries);
      location.hash = '#dashboard';
      toast('All data on this device has been erased.', 'warn');
    },
  });
}

// ---------------------------------------------------------------- events

const ACTIONS = {
  clock: (d) => doClock(d.kind),
  correct: (d) => correctDialog(d.id),
  void: (d) => binDialog([d.id], d.what || 'this record'),
  'bin-shift': (d) => binShift(d.id),
  'restore-group': (d) => restoreGroup(d.key),
  'add-shift': (d) => addShiftDialog(d.date),
  'as-scheduled': (d) => recordAsScheduled([d.id]),
  'as-scheduled-all': (d) => asScheduledAllDialog(d.ids.split(',')),
  'shv-mode': (d) => { shv.mode = d.mode; if (d.anchor) shv.anchor = d.anchor; render(); window.scrollTo(0, 0); },
  'shv-step': (d) => { const r = shvRange(); shv.anchor = Number(d.dir) < 0 ? C.addDays(r.from, -1) : C.addDays(r.to, 1); render(); },
  'shv-today': () => { shv.anchor = null; render(); },
  restore: async (d) => { await add('restore', { targetId: d.id }); await refresh(); toast('Restored.'); },
  'add-event': (d) => addEventDialog(d.date, d.kind, d.shift),
  'next-day': (d) => moveToNextDay(d.id),
  'add-note': (d) => noteDialog(d.link),
  'add-evidence': (d) => { pendingLink = d.link || null; document.getElementById('file-evidence').click(); },
  'add-photo': (d) => { pendingLink = d.link || null; document.getElementById('file-camera').click(); },
  'view-evidence': (d) => viewEvidence(d.id),
  'verify-evidence': () => verifyAllEvidence(),
  'add-schedule': (d) => scheduleDialog(d.id),
  'add-employer': (d) => employerDialog(d.id),
  'add-payslip': (d) => payslipDialog(d.from, d.to),
  'open-report': (d) => { rep.type = 'pay'; rep.anchor = d.from; location.hash = '#reports'; },
  'rep-type': (d) => { if (d.type === 'custom') { const r = repRange(); rep.from = r.from; rep.to = r.to; } rep.type = d.type; render(); },
  'rep-step': (d) => { const r = repRange(); rep.anchor = Number(d.dir) < 0 ? C.addDays(r.from, -1) : C.addDays(r.to, 1); render(); },
  'export-csv': async () => { const r = repRange(); const where = await download(new Blob([shiftsCsv(C.summarise(model, r.from, r.to).shifts)], { type: 'text/csv' }), `hours-${r.from}-to-${r.to}.csv`); if (typeof where === 'string') toast(`Saved to ${where}.`); },
  'export-backup': () => exportBackup(),
  'import-backup': () => document.getElementById('file-import').click(),
  'import-rota': () => document.getElementById('file-rota').click(),
  'bin-import': (d) => binImport(d.id),
  verify: () => runVerify(),
  'audit-all': () => { auditAll = true; render(); },
  'copy-checkpoint': async () => {
    const ta = document.getElementById('checkpoint');
    if (NATIVE && window.HLNative.copy(ta.value)) return toast('Checkpoint copied.');
    try { await navigator.clipboard.writeText(ta.value); toast('Checkpoint copied.'); } catch { ta.select(); toast('Copy was blocked. The text is selected: copy it by hand.', 'warn'); }
  },
  'add-rate': () => rateDialog(),
  'remove-rate': (d) => saveSettings({ rates: model.settings.rates.filter((r) => r.from !== d.from) }),
  erase: () => eraseDialog(),
};

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  ev.preventDefault();
  try {
    await ACTIONS[el.dataset.action](el.dataset);
  } catch (e) {
    console.error(e);
    toast(`Not saved: ${e.message || e}`, 'bad');
  }
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  try {
    if (t.id === 'file-evidence' || t.id === 'file-camera') {
      const files = [...t.files];
      t.value = '';
      if (files.length) await addEvidence(files, pendingLink);
    } else if (t.id === 'file-rota') {
      const file = t.files[0];
      t.value = '';
      if (file) await importRota(file);
    } else if (t.id === 'file-import') {
      const file = t.files[0];
      t.value = '';
      if (file) await importBackup(file);
    } else if (t.dataset.change === 'rep-from') { rep.from = t.value || rep.from; render(); }
    else if (t.dataset.change === 'rep-to') { rep.to = t.value || rep.to; render(); }
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'bad');
  }
});

document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'settings-form') return;
  ev.preventDefault();
  try {
    const f = Object.fromEntries(new FormData(ev.target));
    const start = Number(f.payPeriodStartDay), payDay = Number(f.payDay);
    if (!(start >= 1 && start <= 28) || !(payDay >= 1 && payDay <= 28)) throw new Error('Pay period start and pay day must be between 1 and 28.');
    document.activeElement && document.activeElement.blur();
    await saveSettings({
      employerSystem: f.employerSystem.trim(), payPeriodStartDay: start, payDay, weekStartsOn: Number(f.weekStartsOn),
      breaksPaid: f.breaksPaid === 'true', weeklyOvertimeAfterHours: f.weeklyOvertimeAfterHours ? Number(f.weeklyOvertimeAfterHours) : null,
      timeZone: f.timeZone, captureLocation: f.captureLocation === 'true',
    });
  } catch (e) {
    toast(`Not saved: ${e.message}`, 'bad');
  }
});

// Android back button: close an open dialog, else step back through the pages, else leave it to the app shell.
window.__hlBack = () => {
  const d = document.querySelector('dialog[open]');
  if (d) { d.close(); return true; }
  if (route().name !== 'dashboard') { location.hash = NAV[route().name] === 'more' && route().name !== 'more' ? '#more' : route().name === 'shift' ? '#shifts' : '#dashboard'; return true; }
  return false;
};

// ---------------------------------------------------------------- live clock

function tick() {
  if (!model) return;
  if (model.open) model = C.buildModel(entries, Date.now());
  const s = model.settings, t = today(), o = model.open;
  const v = { now: fmtT(Date.now()) };
  if (o) {
    const b = o.breaks.find((x) => x.open);
    v['open-worked'] = C.fmtDur(o.workedSec);
    v['open-break'] = C.fmtDur(o.breakSec);
    v['open-break-cur'] = C.fmtDur(b ? b.sec : 0);
  }
  if (document.querySelector('[data-live="day-worked"]')) {
    for (const [k, r] of [['day', { from: t, to: t }], ['week', C.weekRange(t, s.weekStartsOn)], ['pay', C.payPeriod(t, s.payPeriodStartDay)]]) {
      const x = C.summarise(model, r.from, r.to);
      v[`${k}-worked`] = C.fmtDur(x.workedSec);
      v[`${k}-sub`] = sumSub(x);
    }
  }
  for (const el of document.querySelectorAll('[data-live]')) {
    const val = v[el.dataset.live];
    if (val != null && el.textContent !== val) el.textContent = val;
  }
}

// ---------------------------------------------------------------- example data (preview only)

async function seedExamples() {
  const zone = C.DEFAULT_SETTINGS.timeZone;
  const t0 = C.localDate(Date.now(), zone);
  let seed = 11;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const at = (date, time) => C.zonedToUtc(date, time, zone).ms;
  const ids = {};
  const days = [];
  for (let back = 40; back >= 1; back--) {
    const date = C.addDays(t0, -back);
    const dow = C.dayOfWeek(date);
    if (dow !== 0 && dow !== 1) days.push({ date, dow }); // Sunday and Monday off
  }
  for (let i = 0; i < days.length; i++) {
    const { date, dow } = days[i];
    const ago = days.length - i; // 1 = most recent shift
    const late = dow === 5 || dow === 6;
    await store.append('schedule', { date, start: '17:00', end: late ? '00:30' : '23:00', breakMin: 30, note: '' }, at(date, '09:00:00') - 3 * 86400000);
    const start = at(date, '17:00:00') - 240000 + rnd(420) * 1000;
    const b1 = start + (3 * 3600 + rnd(1800)) * 1000;
    const b2 = b1 + (28 * 60 + rnd(300)) * 1000;
    const end = at(late ? C.addDays(date, 1) : date, late ? '00:30:00' : '23:00:00') + (120 + rnd(2700)) * 1000;
    const inE = await store.append('clock', { kind: 'in', at: new Date(start).toISOString(), source: 'live' }, start);
    await store.append('location', { targetId: inE.id, status: 'ok', lat: 51.4545 + rnd(40) / 1e5, lon: -2.5879 - rnd(40) / 1e5, accuracyM: 9 + rnd(30), altitudeM: null, fixAt: new Date(start + 2100).toISOString() }, start + 2400);
    await store.append('clock', { kind: 'break_start', at: new Date(b1).toISOString(), source: 'live' }, b1);
    await store.append('clock', { kind: 'break_end', at: new Date(b2).toISOString(), source: 'live' }, b2);
    if (ago === 6) {
      // forgot to clock out; added by hand the next morning
      ids.manual = inE.id;
      await store.append('clock', { kind: 'out', at: new Date(end).toISOString(), source: 'manual', note: 'Forgot to tap out when closing. Left at the same time as the supervisor.' }, end + 9 * 3600000);
    } else {
      await store.append('clock', { kind: 'out', at: new Date(end).toISOString(), source: 'live' }, end);
    }
    if (ago === 3) {
      ids.corrected = inE.id;
      await store.append('correction', { targetId: inE.id, newAt: new Date(start - 150000).toISOString(), previousAt: new Date(start).toISOString(), reason: 'Tapped in after I had already started setting up. Actual start was earlier.' }, end + 600000);
    }
    if (ago === 2 || ago === 3 || ago === 5) await store.append('employer', { shiftId: inE.id, paidHours: late ? 7 : 5.5, note: '' }, end + 3600000);
    if (ago === 2) ids.shot = inE.id;
  }
  const prev = C.payPeriod(C.addDays(C.payPeriod(t0, 6).from, -1), 6);
  const m = C.buildModel(await store.all(), Date.now());
  const sum = C.summarise(m, prev.from, prev.to);
  if (sum.count) {
    const hours = Math.max(0, Math.round((sum.workedSec / 3600 - 1.75) * 100) / 100);
    await store.append('payslip', { from: prev.from, to: prev.to, payDate: C.payDate(prev, 15), hours, gross: Math.round(hours * 1085) / 100, note: 'Example figures' }, Date.now() - 5 * 86400000);
  }
  if (ids.shot) {
    try {
      const c = Object.assign(document.createElement('canvas'), { width: 540, height: 360 });
      const g = c.getContext('2d');
      g.fillStyle = '#e8edf3'; g.fillRect(0, 0, 540, 360);
      g.fillStyle = '#1b2a41'; g.font = '600 26px sans-serif'; g.fillText('Example screenshot', 32, 70);
      g.font = '18px sans-serif'; g.fillStyle = '#51607a';
      g.fillText('A real one would show your clock-in screen.', 32, 110);
      g.fillStyle = '#ffffff'; g.fillRect(32, 150, 476, 150);
      g.fillStyle = '#1b2a41'; g.font = '600 20px sans-serif'; g.fillText('Clocked in', 56, 200);
      g.font = '40px monospace'; g.fillText('16:58', 56, 260);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const data = await blob.arrayBuffer();
      const attachmentId = uuid();
      await store.putBlob({ id: attachmentId, name: 'example-clock-in.png', mime: 'image/png', data });
      await store.append('evidence', { attachmentId, sha256: await C.sha256Hex(data), name: 'example-clock-in.png', mime: 'image/png', size: data.byteLength, fileModifiedAt: null, linkId: ids.shot }, Date.now() - 4 * 86400000);
    } catch { /* canvas blocked: the examples work without the picture */ }
  }
}

// ---------------------------------------------------------------- start

async function boot() {
  store = await openStore({ memory: PREVIEW });
  if (PREVIEW) await seedExamples();
  else if (NATIVE) persisted = true; // the Android app's private storage stays until the app is uninstalled or its data cleared
  else {
    try { persisted = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : null; } catch { persisted = null; }
  }
  lastBackup = await store.getMeta('lastBackup');
  await refresh();
  document.body.classList.remove('is-loading');
  chain = await C.verifyChain(entries);
  if (!chain.ok) render();
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  if (bc) bc.onmessage = () => refresh(true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
  setInterval(tick, 1000);
  if (!PREVIEW && !NATIVE && 'serviceWorker' in navigator) {
    const had = !!navigator.serviceWorker.controller; // false on the very first visit, when there is nothing to update from
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('A newer version has been fetched. Close the app and open it again to use it.'); });
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  }
}

boot().catch((e) => {
  console.error(e);
  main.innerHTML = `<section class="card card--warn"><h2>The app could not start</h2><p>${esc(e.message || e)}</p><p>Your records have not been touched. Reload the page; if this keeps happening, restore from your latest backup in another browser.</p></section>`;
});
