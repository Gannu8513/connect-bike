import { db } from '../db.js';
import { esc, openForm, refresh, icon } from '../ui.js';

export const title = 'Pre-ride check';

export async function render(el) {
  const list = await db.kvGet('checklist', { items: [] });
  const items = list.items;
  const done = items.filter((i) => i.done).length;
  const save = () => db.kvSet('checklist', { items });

  el.innerHTML = `
    <a class="back" href="#bike">${icon('back', 18)} More</a>
    <div class="card">
      <div class="row">
        <div><span class="big" style="font-size:44px">${done}/${items.length}</span><span class="unit">checked</span></div>
        <button class="btn sm" data-act="reset">Start again</button>
      </div>
      <div class="bar ok"><i style="width:${items.length ? Math.round((done / items.length) * 100) : 0}%"></i></div>
      ${items.length && done === items.length ? '<p style="color:var(--ok);font-weight:700;margin-top:10px">All checked. Ride safe.</p>' : ''}
    </div>
    <div class="card">
      ${
        items.length
          ? `<ul class="list">${items
              .map(
                (it, i) => `<li class="row">
                  <div class="checkitem grow ${it.done ? 'done' : ''}" data-act="toggle" data-i="${i}" role="checkbox" aria-checked="${it.done}" tabindex="0">
                    <span class="box">${icon('check', 18)}</span><span class="t">${esc(it.text)}</span>
                  </div>
                  <button class="btn sm" data-act="edit" data-i="${i}">Edit</button>
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty">The list is empty. Add the things you check before a ride.</p>'
      }
      <button class="btn block" style="margin-top:12px" data-act="add">${icon('plus', 18)} Add a check</button>
    </div>
    <p class="muted small">This is a general walk-around. Change it to match your owner's manual and your own routine.</p>
  `;

  el.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const i = Number(t.dataset.i);
    switch (t.dataset.act) {
      case 'toggle': items[i].done = !items[i].done; await save(); refresh(); break;
      case 'reset': items.forEach((it) => { it.done = false; }); await save(); refresh(); break;
      case 'add':
        openForm({
          title: 'Add a check',
          fields: [{ name: 'text', label: 'What to check', type: 'text', required: true }],
          onSave: (v) => { items.push({ text: v.text, done: false }); return save(); },
        });
        break;
      case 'edit':
        openForm({
          title: 'Edit check',
          fields: [{ name: 'text', label: 'What to check', type: 'text', required: true }],
          values: items[i],
          onSave: (v) => { items[i].text = v.text; return save(); },
          onDelete: () => { items.splice(i, 1); return save(); },
        });
        break;
    }
  };
}
