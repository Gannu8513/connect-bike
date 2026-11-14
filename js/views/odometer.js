import { db } from '../db.js';
import { odoReadings, setOdo } from '../data.js';
import { esc, num, today, fmtDate, openForm, refresh, icon, meta, barChart, lastMonths } from '../ui.js';

export const title = 'Odometer';

export async function render(el) {
  const readings = await odoReadings();
  const dated = readings.filter((r) => r.date);
  const odo = readings.length ? Math.max(...readings.map((r) => r.value)) : null;

  // Distance covered in a month = highest reading in it minus the highest reading before it.
  const months = lastMonths(6).map((m) => {
    const inMonth = dated.filter((r) => r.date.startsWith(m.ym)).map((r) => r.value);
    const before = dated.filter((r) => r.date.slice(0, 7) < m.ym).map((r) => r.value);
    const value = inMonth.length && before.length ? Math.max(0, Math.max(...inMonth) - Math.max(...before)) : 0;
    return { label: m.label, value };
  });

  el.innerHTML = `
    <a class="back" href="#bike">${icon('back', 18)} More</a>
    <div class="card">
      <div class="row">
        <div><span class="big" style="font-size:44px">${odo == null ? 'Not set' : num(odo)}</span>${odo == null ? '' : '<span class="unit">km</span>'}
        <div class="muted small">The highest reading you have entered</div></div>
        <button class="btn primary" data-act="add">Update</button>
      </div>
    </div>
    <div class="card">
      <h2>Distance by month, km</h2>
      ${barChart(months)}
      <p class="muted small" style="margin-top:8px">Worked out from the readings below, so it is only as complete as they are.</p>
    </div>
    <div class="card">
      <h2>Every reading you entered</h2>
      ${
        readings.length
          ? `<ul class="list">${readings
              .map(
                (r) => `<li class="row">
                  <div class="grow"><div class="t">${num(r.value)} km</div>${meta([fmtDate(r.date), esc(r.source)])}</div>
                  ${r.id ? `<button class="btn sm danger" data-act="del" data-id="${r.id}" aria-label="Delete this reading">×</button>` : ''}
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty">No readings yet. Add the number shown on your meter.</p>'
      }
    </div>
    <p class="muted small">Readings also come from fill-ups and service records; change those on their own screens.</p>
  `;

  el.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'add') {
      openForm({
        title: 'Update odometer',
        note: "Type the reading shown on the bike's meter.",
        fields: [
          { name: 'value', label: 'Odometer (km)', type: 'number', required: true },
          { name: 'date', label: 'Date of the reading', type: 'date', required: true },
        ],
        values: { value: odo ?? '', date: today() },
        onSave: (v) => setOdo(v.value, v.date),
      });
    }
    if (t.dataset.act === 'del' && confirm('Delete this reading?')) {
      const id = Number(t.dataset.id);
      const rec = await db.get('odolog', id);
      await db.del('odolog', id);
      const manual = await db.kvGet('odometer');
      if (manual && rec && manual.value === rec.value) await db.kvDel('odometer');
      refresh();
    }
  };
}
