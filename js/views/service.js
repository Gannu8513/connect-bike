import { db } from '../db.js';
import { getOdo, maintStatus, statusText, partStatus } from '../data.js';
import { photoButton } from '../photos.js';
import { esc, num, money, today, fmtDate, openForm, refresh, ring, meta, icon, icsEvent, shareFile, fileSafe } from '../ui.js';

export const title = 'Garage';

let tab = 'reminders';

const REMINDER_FIELDS = [
  { name: 'name', label: 'What to do', type: 'text', required: true, placeholder: 'e.g. Engine oil change' },
  { name: 'intervalKm', label: 'Repeat every (km)', type: 'number', hint: "From your owner's manual. Leave empty if it only depends on time." },
  { name: 'intervalDays', label: 'Repeat every (days)', type: 'number', hint: 'Optional. Whichever comes first is used.' },
  { name: 'lastOdo', label: 'Last done at odometer (km)', type: 'number' },
  { name: 'lastDate', label: 'Last done on', type: 'date' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

const PART_FIELDS = [
  { name: 'name', label: 'Part', type: 'text', required: true, placeholder: 'e.g. Rear tyre' },
  { name: 'brand', label: 'Brand and model', type: 'text', placeholder: 'What is fitted' },
  { name: 'installedDate', label: 'Fitted on', type: 'date' },
  { name: 'installedOdo', label: 'Fitted at odometer (km)', type: 'number', hint: 'Use 0 if it has been on the bike since new.' },
  { name: 'expectedKm', label: 'Life you expect (km)', type: 'number', hint: 'Your own figure, from experience or the maker. Leave empty if unsure.' },
  { name: 'expectedMonths', label: 'Life you expect (months)', type: 'number', hint: 'Useful for the battery. Optional.' },
  { name: 'cost', label: 'Cost (Nu.)', type: 'number' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

const HISTORY_FIELDS = [
  { name: 'title', label: 'Title', type: 'text', required: true, placeholder: 'e.g. Second service' },
  { name: 'date', label: 'Date', type: 'date' },
  { name: 'odo', label: 'Odometer (km)', type: 'number' },
  { name: 'odoText', label: 'Odometer note', type: 'text', hint: 'Use this if you only know a range, e.g. 800–1000 km.' },
  { name: 'work', label: 'Work performed', type: 'textarea', placeholder: 'One item per line' },
  { name: 'parts', label: 'Parts and fluids used', type: 'textarea' },
  { name: 'cost', label: 'Cost (Nu.)', type: 'number' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
  { name: 'verified', label: 'I have checked these details against the bill or service record', type: 'checkbox', default: true },
];

const saved = (p) => p.then(() => {});

function editReminder(rec) {
  openForm({
    title: rec ? 'Edit reminder' : 'New reminder',
    fields: REMINDER_FIELDS,
    values: rec || {},
    onSave: (v) => saved(db.put('maintenance', { ...rec, ...v })),
    onDelete: rec ? () => db.del('maintenance', rec.id) : null,
  });
}

function markDone(rec, odo) {
  openForm({
    title: `Done: ${rec.name}`,
    fields: [
      { name: 'date', label: 'Done on', type: 'date', required: true },
      { name: 'odo', label: 'Odometer (km)', type: 'number', required: true },
      { name: 'cost', label: 'Cost (Nu.)', type: 'number' },
      { name: 'log', label: 'Also add to service history', type: 'checkbox', default: true },
    ],
    values: { date: today(), odo: odo ?? '' },
    onSave: async (v) => {
      await db.put('maintenance', { ...rec, lastDate: v.date, lastOdo: v.odo });
      if (v.log) {
        await db.put('services', { title: rec.name, date: v.date, odo: v.odo, odoText: '', work: rec.name, parts: '', cost: v.cost, notes: '', verified: true });
      }
    },
  });
}

function editPart(rec) {
  openForm({
    title: rec ? rec.name : 'Add part',
    fields: PART_FIELDS,
    values: rec || {},
    onSave: (v) => saved(db.put('parts', { ...rec, ...v })),
    onDelete: rec ? () => db.del('parts', rec.id) : null,
  });
}

// Replacing keeps the old part as history, so you learn how long each one really lasted.
function replacePart(rec, odo) {
  openForm({
    title: `Replace: ${rec.name}`,
    note: 'The current one is kept in the history below with how long it lasted.',
    fields: [
      { name: 'date', label: 'Replaced on', type: 'date', required: true },
      { name: 'odo', label: 'Odometer (km)', type: 'number', required: true },
      { name: 'brand', label: 'New brand and model', type: 'text' },
      { name: 'cost', label: 'Cost (Nu.)', type: 'number' },
      { name: 'log', label: 'Also add to service history', type: 'checkbox', default: true },
    ],
    values: { date: today(), odo: odo ?? '' },
    onSave: async (v) => {
      await db.put('parts', { ...rec, retired: true, removedDate: v.date, removedOdo: v.odo });
      await db.put('parts', {
        name: rec.name, brand: v.brand, installedDate: v.date, installedOdo: v.odo,
        expectedKm: rec.expectedKm, expectedMonths: rec.expectedMonths, cost: v.cost, notes: '',
      });
      if (v.log) {
        await db.put('services', {
          title: `${rec.name} replaced`, date: v.date, odo: v.odo, odoText: '', work: `${rec.name} replaced`,
          parts: v.brand || '', cost: null, notes: '', verified: true,
        });
      }
    },
  });
}

function editHistory(rec) {
  openForm({
    title: rec ? 'Edit service record' : 'Add service record',
    fields: HISTORY_FIELDS,
    values: rec || { date: today() },
    onSave: (v) => saved(db.put('services', { ...rec, ...v })),
    onDelete: rec ? () => db.del('services', rec.id) : null,
  });
}

export async function render(el) {
  const [maint, services, parts, odo, counts] = await Promise.all([
    db.all('maintenance'), db.all('services'), db.all('parts'), getOdo(), db.photoCounts(),
  ]);
  const order = { overdue: 0, soon: 1, ok: 2, none: 3, setup: 4 };
  const items = maint.map((m) => ({ m, s: maintStatus(m, odo) })).sort((a, b) => order[a.s.state] - order[b.s.state]);
  const fitted = parts.filter((p) => !p.retired).map((p) => ({ p, s: partStatus(p, odo) })).sort((a, b) => order[a.s.state] - order[b.s.state]);
  const retired = parts.filter((p) => p.retired).sort((a, b) => (b.removedDate || '').localeCompare(a.removedDate || ''));
  const history = [...services].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.odo || 0) - (a.odo || 0));
  const needOdo = odo == null ? '<div class="notice">Enter your odometer on the Home screen so distance-based tracking can work.</div>' : '';

  const remindersHtml = `
    ${needOdo}
    <button class="btn primary block mb" data-act="addReminder">${icon('plus', 18)} New reminder</button>
    <div class="card">
      ${
        items.length
          ? `<ul class="list">${items
              .map(
                ({ m, s }) => `<li>
                  <div class="row">
                    ${ring(s.pct, s.state === 'setup' ? 'ok' : s.state)}
                    <div class="grow" data-act="editReminder" data-id="${m.id}">
                      <div class="t">${esc(m.name)}</div>
                      <span class="chip ${s.state}">${esc(statusText(s))}</span>
                      ${meta([
                        [m.intervalKm ? `every ${num(m.intervalKm)} km` : '', m.intervalDays ? `every ${num(m.intervalDays)} days` : ''].filter(Boolean).join(' or ') || 'No interval yet, tap to set it',
                        m.lastOdo != null ? `last at ${num(m.lastOdo)} km` : '',
                        m.lastDate ? fmtDate(m.lastDate) : '',
                      ])}
                      ${m.notes ? `<div class="muted small">${esc(m.notes)}</div>` : ''}
                    </div>
                  </div>
                  <div class="chips">
                    <button class="btn sm" data-act="done" data-id="${m.id}">${icon('check', 16)} Mark done</button>
                    ${s.dueDate ? `<button class="btn sm" data-act="cal" data-id="${m.id}">${icon('calendar', 16)} Calendar alert</button>` : ''}
                  </div>
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty">No reminders yet. Add the jobs from your service schedule.</p>'
      }
    </div>
    <p class="muted small">The ring shows how much of the interval is used. Reminders appear in the app; "Calendar alert" adds date-based ones to the iPhone Calendar so you are told even when the app is closed.</p>`;

  const partsHtml = `
    ${needOdo}
    <button class="btn primary block mb" data-act="addPart">${icon('plus', 18)} Add part</button>
    <div class="card">
      ${
        fitted.length
          ? `<ul class="list">${fitted
              .map(
                ({ p, s }) => `<li>
                  <div class="row">
                    ${ring(s.pct, s.pct == null ? 'ok' : s.state)}
                    <div class="grow" data-act="editPart" data-id="${p.id}">
                      <div class="t">${esc(p.name)}</div>
                      ${p.brand ? `<div class="small">${esc(p.brand)}</div>` : ''}
                      <div class="muted small">${esc(s.text)}</div>
                      ${meta([
                        p.expectedKm ? `expected ${num(p.expectedKm)} km` : '',
                        p.expectedMonths ? `expected ${num(p.expectedMonths)} months` : '',
                        p.installedDate ? `fitted ${fmtDate(p.installedDate)}` : '',
                      ])}
                    </div>
                    <button class="btn sm" data-act="replacePart" data-id="${p.id}">Replace</button>
                  </div>
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty">No parts yet.</p>'
      }
    </div>
    ${
      retired.length
        ? `<div class="card"><h2>Replaced parts</h2><ul class="list">${retired
            .map(
              (p) => `<li data-act="editPart" data-id="${p.id}">
                <div class="t">${esc(p.name)}${p.brand ? `, ${esc(p.brand)}` : ''}</div>
                ${meta([
                  p.removedOdo != null && p.installedOdo != null ? `lasted ${num(p.removedOdo - p.installedOdo)} km` : '',
                  p.installedDate ? `fitted ${fmtDate(p.installedDate)}` : '',
                  p.removedDate ? `replaced ${fmtDate(p.removedDate)}` : '',
                ])}
              </li>`
            )
            .join('')}</ul></div>`
        : ''
    }
    <p class="muted small">Wear is measured against the life you enter yourself. The app does not assume how long a tyre, battery or set of pads should last.</p>`;

  const historyHtml = `
    <button class="btn primary block mb" data-act="addHistory">${icon('plus', 18)} Add service record</button>
    <div class="card">
      ${
        history.length
          ? `<ul class="list">${history
              .map(
                (s) => `<li>
                  <div class="row" style="align-items:flex-start">
                    <div class="grow" data-act="editHistory" data-id="${s.id}">
                      <div class="t">${esc(s.title)} ${s.verified ? '' : '<span class="chip unverified">Unverified</span>'}</div>
                      ${meta([fmtDate(s.date), s.odo != null ? `${num(s.odo)} km` : esc(s.odoText) || 'Odometer not recorded', s.cost ? money(s.cost) : ''])}
                      ${s.work ? `<div class="small pre" style="margin-top:6px">${esc(s.work)}</div>` : ''}
                      ${s.parts ? `<div class="muted small pre">${esc(s.parts)}</div>` : ''}
                      ${s.notes ? `<div class="muted small pre">${esc(s.notes)}</div>` : ''}
                    </div>
                    ${photoButton(`services:${s.id}`, counts)}
                  </div>
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty">No service records yet.</p>'
      }
    </div>
    <p class="muted small">Use the camera button to keep a photo of each bill. The full history can be exported as a PDF from More, Backup and sync.</p>`;

  el.innerHTML = `
    <div class="seg" role="tablist">
      <button data-act="tab" data-tab="reminders" class="${tab === 'reminders' ? 'on' : ''}">Reminders</button>
      <button data-act="tab" data-tab="parts" class="${tab === 'parts' ? 'on' : ''}">Parts</button>
      <button data-act="tab" data-tab="history" class="${tab === 'history' ? 'on' : ''}">History</button>
    </div>
    ${tab === 'reminders' ? remindersHtml : tab === 'parts' ? partsHtml : historyHtml}
  `;

  el.onclick = (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const id = Number(t.dataset.id);
    switch (t.dataset.act) {
      case 'tab': tab = t.dataset.tab; refresh(); break;
      case 'addReminder': editReminder(null); break;
      case 'editReminder': editReminder(maint.find((m) => m.id === id)); break;
      case 'done': markDone(maint.find((m) => m.id === id), odo); break;
      case 'cal': {
        const m = maint.find((x) => x.id === id);
        const due = maintStatus(m, odo).dueDate;
        shareFile(`${fileSafe(m.name)}-due.ics`, icsEvent({ uid: `maint-${m.id}-${due}`, date: due, title: `${m.name} due (motorcycle)` }), 'text/calendar');
        break;
      }
      case 'addPart': editPart(null); break;
      case 'editPart': editPart(parts.find((p) => p.id === id)); break;
      case 'replacePart': replacePart(parts.find((p) => p.id === id), odo); break;
      case 'addHistory': editHistory(null); break;
      case 'editHistory': editHistory(services.find((s) => s.id === id)); break;
    }
  };
}
