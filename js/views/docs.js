import { db } from '../db.js';
import { docStatus } from '../data.js';
import { photoButton } from '../photos.js';
import { esc, fmtDate, openForm, shareFile, icsEvent, fileSafe, icon, meta, refresh } from '../ui.js';

export const title = 'Documents';

const FIELDS = [
  { name: 'name', label: 'Document', type: 'text', required: true, placeholder: 'e.g. Insurance' },
  { name: 'number', label: 'Number', type: 'text', placeholder: 'Policy, registration or licence number' },
  { name: 'expiry', label: 'Expiry date', type: 'date' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

function edit(rec) {
  openForm({
    title: rec ? 'Edit document' : 'Add document',
    fields: FIELDS,
    values: rec || {},
    onSave: (v) => db.put('docs', { ...rec, ...v }).then(() => {}),
    onDelete: rec ? () => db.del('docs', rec.id) : null,
  });
}

export async function render(el) {
  const [docs, counts] = await Promise.all([db.all('docs'), db.photoCounts()]);
  const order = { overdue: 0, soon: 1, ok: 2, none: 3 };
  const items = docs.map((d) => ({ d, s: docStatus(d) })).sort((a, b) => order[a.s.state] - order[b.s.state]);

  el.innerHTML = `
    <a class="back" href="#bike">${icon('back', 18)} More</a>
    <button class="btn primary block mb" data-act="add">${icon('plus', 18)} Add document</button>
    <div class="card">
      ${
        items.length
          ? `<ul class="list">${items
              .map(
                ({ d, s }) => `<li>
                  <div class="row" style="align-items:flex-start">
                    <div class="grow" data-act="edit" data-id="${d.id}">
                      <div class="t">${esc(d.name)}</div>
                      ${s.state === 'none' ? '' : `<span class="chip ${s.state}">${esc(s.text)}</span>`}
                      ${meta([esc(d.number), d.expiry ? `expires ${fmtDate(d.expiry)}` : 'Tap to add the expiry date'])}
                      ${d.notes ? `<div class="muted small pre">${esc(d.notes)}</div>` : ''}
                    </div>
                    ${photoButton(`docs:${d.id}`, counts)}
                  </div>
                  <div class="chips">
                    <button class="btn sm" data-act="edit" data-id="${d.id}">Edit</button>
                    ${d.expiry ? `<button class="btn sm" data-act="cal" data-id="${d.id}">${icon('calendar', 16)} Calendar alert</button>` : ''}
                    <button class="btn sm danger" data-act="remove" data-id="${d.id}">Remove</button>
                  </div>
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty">Add your insurance, registration and licence to be warned before they expire.</p>'
      }
    </div>
    <p class="muted small">Insurance, registration and licence are only suggestions: remove any you do not need and add your own. Documents show on the Home screen 30 days before they expire. "Calendar alert" adds the date to the iPhone Calendar with reminders 14 days and 1 day ahead. Use the camera button to keep a photo of each document.</p>
  `;

  el.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const doc = docs.find((d) => d.id === Number(t.dataset.id));
    if (t.dataset.act === 'remove' && confirm(`Remove "${doc.name}" from your documents?`)) {
      for (const p of await db.byOwner(`docs:${doc.id}`)) await db.del('photos', p.id);
      await db.del('docs', doc.id);
      refresh();
      return;
    }
    if (t.dataset.act === 'add') edit(null);
    if (t.dataset.act === 'edit') edit(doc);
    if (t.dataset.act === 'cal') {
      shareFile(`${fileSafe(doc.name)}-expiry.ics`, icsEvent({ uid: `doc-${doc.id}-${doc.expiry}`, date: doc.expiry, title: `${doc.name} expires (motorcycle)` }), 'text/calendar');
    }
  };
}
