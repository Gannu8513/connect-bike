import { db } from '../db.js';
import { fuelSummary, sinceLastFill } from '../data.js';
import { esc, num, money, today, fmtDate, openForm, barChart, shareFile, toCsv, meta, icon } from '../ui.js';

export const title = 'Fuel';

const FIELDS = [
  { name: 'date', label: 'Date', type: 'date', required: true },
  { name: 'odo', label: 'Odometer (km)', type: 'number', hint: 'Needed to work out mileage.' },
  { name: 'litres', label: 'Fuel added (litres)', type: 'number', required: true },
  { name: 'cost', label: 'Total cost (Nu.)', type: 'number' },
  { name: 'full', label: 'Filled to a full tank', type: 'checkbox', default: true },
  { name: 'missed', label: 'I skipped logging a fill-up before this one', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'text', placeholder: 'Station, fuel type…' },
];

function edit(rec) {
  openForm({
    title: rec ? 'Edit fill-up' : 'Add fill-up',
    fields: FIELDS,
    values: rec || { date: today() },
    onSave: (v) => {
      if (!v.litres) return 'Fuel added must be more than zero.';
      // "at" lets the app count GPS distance ridden since this fill-up.
      const at = rec?.at || (v.date === today() ? Date.now() : null);
      return db.put('fuel', { ...rec, ...v, at }).then(() => {});
    },
    onDelete: rec ? () => db.del('fuel', rec.id) : null,
  });
}

export async function render(el) {
  const [fills, profile, rides] = await Promise.all([db.all('fuel'), db.kvGet('profile', []), db.all('rides')]);
  const fs = fuelSummary(fills);
  const sorted = [...fills].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.odo || 0) - (a.odo || 0));
  const tank = parseFloat(profile.find((f) => f.key === 'fuel_tank_capacity')?.value);
  const range = fs.avg != null && tank > 0 ? fs.avg * tank : null;
  const since = sinceLastFill(fills, rides);
  const tile = (label, value, unit, sub = '') =>
    `<div class="tile"><div class="lbl">${label}</div><span class="big">${value}</span>${unit ? `<span class="unit">${unit}</span>` : ''}${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const dm = (d) => (d ? d.slice(8, 10) + '/' + d.slice(5, 7) : '');

  el.innerHTML = `
    <button class="btn primary block mb" data-act="add">${icon('plus', 18)} Add fill-up</button>

    <div class="tiles">
      ${tile('Average', fs.avg == null ? '—' : num(fs.avg, 1), 'km/l')}
      ${tile('Last tank', fs.last == null ? '—' : num(fs.last, 1), 'km/l')}
      ${tile('Fuel cost', fs.costPerKm == null ? '—' : num(fs.costPerKm, 2), 'Nu./km')}
      ${tile('Full-tank range', range == null ? '—' : num(range), 'km', `Estimate: your average × ${tank > 0 ? num(tank) : '?'} L tank`)}
      ${tile('Since last fill-up', since ? num(since.km, 1) : '—', 'km', 'GPS distance on tracked rides')}
      ${tile('Spent on fuel', money(fs.spend), '', `${num(fs.litres, 1)} L bought`)}
    </div>
    <p class="muted small mb">Mileage, cost per km and range are worked out between full-tank fill-ups from the odometer readings you enter. They are not read from the bike.</p>

    <div class="card">
      <h2>Mileage by tank, km/l</h2>
      ${barChart(fs.series.slice(-8).map((s) => ({ label: dm(s.date), value: s.kmpl })), (v) => num(v, 1))}
    </div>

    <div class="card">
      <h2>Price paid per litre, Nu.</h2>
      ${barChart(fs.prices.slice(-8).map((p) => ({ label: dm(p.date), value: p.value })), (v) => num(v, 1))}
    </div>

    <div class="card">
      <div class="row head"><h2>Fill-ups</h2>${sorted.length ? `<button class="btn sm" data-act="csv">${icon('share', 16)} CSV</button>` : ''}</div>
      ${
        sorted.length
          ? `<ul class="list">${sorted
              .map((f) => {
                const seg = fs.segments[f.id];
                return `<li class="row" data-act="edit" data-id="${f.id}">
                  <div class="grow">
                    <div class="t">${num(f.litres, 2)} L ${f.full ? '' : '<span class="chip">partial</span>'} ${
                  seg ? `<span class="chip info">${num(seg.kmpl, 1)} km/l</span>` : ''
                }</div>
                    ${meta([fmtDate(f.date), f.odo != null ? `${num(f.odo)} km` : '', f.cost && f.litres ? `Nu. ${num(f.cost / f.litres, 2)} per litre` : '', esc(f.notes)])}
                  </div>
                  <div class="v">${f.cost ? money(f.cost) : ''}</div>
                </li>`;
              })
              .join('')}</ul>`
          : '<p class="empty">Add a fill-up each time you refuel. After two full tanks you get your real mileage.</p>'
      }
    </div>
  `;

  el.onclick = (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'add') edit(null);
    if (t.dataset.act === 'edit') edit(fills.find((f) => f.id === Number(t.dataset.id)));
    if (t.dataset.act === 'csv') {
      const rows = [['Date', 'Odometer (km)', 'Litres', 'Cost (Nu.)', 'Full tank', 'Calculated km/l', 'Notes']];
      for (const f of sorted) {
        rows.push([f.date, f.odo, f.litres, f.cost, f.full ? 'yes' : 'no', fs.segments[f.id] ? fs.segments[f.id].kmpl.toFixed(2) : '', f.notes]);
      }
      shareFile(`fuel-log-${today()}.csv`, toCsv(rows), 'text/csv');
    }
  };
}
