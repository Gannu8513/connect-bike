// Shared helpers: escaping, formatting, icons, the bottom sheet, charts, files and maps.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const refresh = () => window.dispatchEvent(new Event('app:refresh'));

/* ---------- dates and numbers ---------- */

export function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

export const fmtDate = (s) =>
  s
    ? new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Date not recorded';

export const fmtDateTime = (ms) =>
  new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function num(n, decimals = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export const money = (n) => (n == null || Number.isNaN(n) ? '—' : 'Nu. ' + num(n, Number.isInteger(n) ? 0 : 2));

export const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** "3 h 12 min", "2 days 4 h", "5 min" */
export function fmtSpan(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ${h % 24} h`;
}

/** The last n months as [{ ym: '2026-11', label: 'Nov' }], oldest first. */
export function lastMonths(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({
      ym: `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`,
      label: m.toLocaleDateString('en-GB', { month: 'short' }),
    });
  }
  return out;
}

export const meta = (parts) => `<div class="meta">${parts.filter(Boolean).map((p) => `<span>${p}</span>`).join('')}</div>`;

/* ---------- icons ---------- */

const ICONS = {
  gauge: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="m12 14 4-5"/><circle cx="12" cy="14" r="1.2"/>',
  drop: '<path d="M12 3.5s6 6.2 6 10.5a6 6 0 0 1-12 0c0-4.3 6-10.5 6-10.5z"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.3 5.3L3.5 17.5l3 3 5.9-5.9a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-2.4z"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18"/><path d="M15.5 15H18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.2"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8.5 3v4M15.5 3v4"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  parking: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M10 16.5V8h3a2.6 2.6 0 0 1 0 5.2h-3"/>',
  chart: '<path d="M5 19.5V11M12 19.5V5M19 19.5v-6"/>',
  flag: '<path d="M6 21V4h11l-2 4 2 4H6"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12.5h5M10 16.5h5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  cross: '<path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 9.5a4.3 4.3 0 0 1 .5 8.5z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  target: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6"/>',
  tyre: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bike: '<circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5 9 9h5l4.5 7.5M14 9l-2.5 7.5h-6M15 6h3"/>',
  sliders: '<path d="M5 7h9M18 7h1M5 17h1M10 17h9"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  arrow: '<path d="M12 3 5.5 20l6.5-4 6.5 4z"/>',
  list: '<path d="M8 7h11M8 12h11M8 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/>',
};

export const icon = (name, size = 20) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/* ---------- small visual pieces ---------- */

/** Circular progress. pct is 0..1 (or null for "not known"); state: ok | soon | overdue. */
export function ring(pct, state = 'ok') {
  const c = 2 * Math.PI * 19;
  const shown = pct == null ? 0 : Math.min(1, Math.max(0, pct));
  const arc = shown > 0 ? `<circle class="val" cx="24" cy="24" r="19" stroke-dasharray="${(shown * c).toFixed(1)} ${c.toFixed(1)}"/>` : '';
  return `<span class="ring ${state}"><svg viewBox="0 0 48 48"><circle class="trk" cx="24" cy="24" r="19"/>${arc}</svg><b>${
    pct == null ? '?' : Math.round(pct * 100)
  }</b></span>`;
}

/** items: [{ label, value }] */
export function barChart(items, fmt = (v) => num(v)) {
  const max = Math.max(0, ...items.map((i) => i.value || 0));
  if (!items.length || max <= 0) return '<p class="muted small">Not enough data yet.</p>';
  return `<div class="chart">${items
    .map(
      (i) => `<div class="col"><span class="val">${i.value ? esc(fmt(i.value)) : ''}</span>
        <div class="box"><i style="height:${i.value ? Math.max(3, Math.round((i.value / max) * 100)) : 0}%"></i></div>
        <span class="lbl">${esc(i.label)}</span></div>`
    )
    .join('')}</div>`;
}

/** A small line chart from a list of numbers (nulls are skipped). */
export function sparkline(values, color = 'var(--accent)') {
  const pts = values.map((v, i) => [i, v]).filter((p) => p[1] != null);
  if (pts.length < 2) return '';
  const ys = pts.map((p) => p[1]);
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = max - min || 1;
  const n = values.length - 1 || 1;
  const line = pts.map(([i, v]) => `${((i / n) * 300).toFixed(1)},${(52 - ((v - min) / span) * 48).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 300 56" preserveAspectRatio="none"><polyline points="${line}" style="stroke:${color}"/></svg>`;
}

let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
}

/* ---------- bottom sheet ---------- */

/** Opens the sheet with any content and returns the dialog element. */
export function openSheet(html) {
  const dlg = document.getElementById('sheet');
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
  return dlg;
}

/**
 * Opens a form in the sheet.
 * fields: [{ name, label, type: text|number|date|time|tel|select|textarea|checkbox, options, required, hint, placeholder, default }]
 * onSave receives { name: value } with numbers parsed (empty number = null). Return a string to show it as an error.
 */
export function openForm({ title, fields, values = {}, onSave, onDelete, note, saveLabel = 'Save', cancelLabel = 'Cancel' }) {
  const body = fields
    .map((f) => {
      const v = values[f.name] ?? f.default ?? '';
      const id = 'f_' + f.name;
      if (f.type === 'checkbox') {
        return `<label class="check"><input type="checkbox" id="${id}" name="${f.name}" ${v ? 'checked' : ''}><span>${esc(f.label)}</span></label>`;
      }
      let input;
      if (f.type === 'select') {
        input = `<select id="${id}" name="${f.name}">${f.options
          .map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`)
          .join('')}</select>`;
      } else if (f.type === 'textarea') {
        input = `<textarea id="${id}" name="${f.name}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
      } else {
        const extra = f.type === 'number' ? 'inputmode="decimal" step="any" min="0"' : '';
        input = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" ${extra}>`;
      }
      return `<label class="field" for="${id}"><span>${esc(f.label)}${f.required ? ' *' : ''}</span>${input}${
        f.hint ? `<small>${esc(f.hint)}</small>` : ''
      }</label>`;
    })
    .join('');

  const dlg = openSheet(`<form novalidate>
    <h2>${esc(title)}</h2>
    ${note ? `<p class="muted small mb">${esc(note)}</p>` : ''}
    ${body}
    <p class="err" role="alert"></p>
    <div class="actions">
      ${onDelete ? '<button type="button" class="btn danger" data-x="delete">Delete</button>' : ''}
      <button type="button" class="btn" data-x="cancel">${esc(cancelLabel)}</button>
      <button type="submit" class="btn primary">${esc(saveLabel)}</button>
    </div>
  </form>`);

  const form = dlg.querySelector('form');
  const err = dlg.querySelector('.err');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      if (f.type === 'checkbox') { out[f.name] = el.checked; continue; }
      const raw = el.value.trim();
      if (f.required && raw === '') { err.textContent = `Please fill in "${f.label}".`; el.focus(); return; }
      if (f.type === 'number') {
        if (raw === '') { out[f.name] = null; continue; }
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) { err.textContent = `"${f.label}" must be a valid number.`; el.focus(); return; }
        out[f.name] = n;
      } else {
        out[f.name] = raw;
      }
    }
    try {
      const problem = await onSave(out);
      if (typeof problem === 'string') { err.textContent = problem; return; }
      dlg.close();
      refresh();
    } catch (ex) {
      console.error(ex);
      err.textContent = 'Could not save. Please try again.';
    }
  });

  form.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'cancel') dlg.close();
    if (x === 'delete' && confirm('Delete this entry? This cannot be undone.')) {
      await onDelete();
      dlg.close();
      refresh();
    }
  });
}

/* ---------- files, network, voice ---------- */

/** Hands a generated file to the iPhone share sheet ("Save to Files"), or downloads it elsewhere. */
export async function shareFile(name, content, type) {
  const blob = new Blob([content], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function toCsv(rows) {
  return rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

const icsText = (s) => String(s).replace(/([\\;,])/g, '\\$1').replace(/\r?\n/g, '\\n');

/** An all-day calendar event with alerts 14 days and 1 day before. date is 'YYYY-MM-DD'. */
export function icsEvent({ uid, date, title }) {
  const start = date.replaceAll('-', '');
  const next = new Date(date + 'T00:00:00');
  next.setDate(next.getDate() + 1);
  const end = `${next.getFullYear()}${String(next.getMonth() + 1).padStart(2, '0')}${String(next.getDate()).padStart(2, '0')}`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const alarm = (trigger) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`, `TRIGGER:${trigger}`, 'END:VALARM'];
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bike Companion//EN',
    'BEGIN:VEVENT', `UID:${uid}@bike-companion`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`, `SUMMARY:${icsText(title)}`,
    ...alarm('-P14D'), ...alarm('-P1D'),
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

export const fileSafe = (s) => String(s).replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'file';

/** fetch + JSON with a time limit, so a slow or blocked service never leaves a screen stuck. */
export async function getJson(url, options = {}, timeoutMs = 15000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}

export function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-GB';
    speechSynthesis.speak(u);
  } catch { /* voice is optional */ }
}

/* ---------- maps and geometry ---------- */

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Compass bearing in degrees from point 1 to point 2 (0 = north, 90 = east). */
export function bearing(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

export const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
export const compassWord = (deg) =>
  ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8];

/** A Leaflet map with OpenStreetMap tiles in the given element, or null if the library is missing. */
export function makeMap(elId, center, zoom) {
  if (typeof L === 'undefined') {
    document.getElementById(elId).innerHTML = '<p class="empty">The map could not load.</p>';
    return null;
  }
  const map = L.map(elId, { zoomControl: false }).setView(center, zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  return map;
}

/** Removes a map safely, even if it is in the middle of a zoom animation. */
export function dropMap(map) {
  if (!map) return;
  try { map.stop(); } catch { /* not animating */ }
  map._animatingZoom = false; // makes Leaflet's pending zoom-end timer a no-op
  map.remove();
}

export const dot = (latlng, fill, radius = 8) =>
  L.circleMarker(latlng, { radius, color: '#fff', weight: 3, fillColor: fill, fillOpacity: 1 });
