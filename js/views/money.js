import { db } from '../db.js';
import { allCosts, getSettings, budgetStatus } from '../data.js';
import { photoButton } from '../photos.js';
import { esc, money, num, today, fmtDate, openForm, refresh, toast, meta, icon, barChart, lastMonths } from '../ui.js';

export const title = 'Money';

const CATEGORIES = ['Parts & accessories', 'Insurance', 'Tax & registration', 'Riding gear', 'Tolls & parking', 'Washing', 'Repairs', 'Other'];
const FROM = { fuel: 'Fuel', service: 'Garage', part: 'Garage' };
let ym = today().slice(0, 7);

function shiftMonth(delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function edit(rec) {
  openForm({
    title: rec ? 'Edit expense' : 'Add expense',
    note: 'Fuel, service and part costs are added automatically from their own screens.',
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'category', label: 'Category', type: 'select', options: CATEGORIES },
      { name: 'amount', label: 'Amount (Nu.)', type: 'number', required: true },
      { name: 'note', label: 'Note', type: 'text' },
    ],
    values: rec || { date: today(), category: CATEGORIES[0] },
    onSave: (v) => db.put('expenses', { ...rec, ...v }).then(() => {}),
    onDelete: rec ? () => db.del('expenses', rec.id) : null,
  });
}

export async function render(el) {
  const [costs, expenses, settings, counts] = await Promise.all([allCosts(), db.all('expenses'), getSettings(), db.photoCounts()]);
  const month = costs.filter((c) => c.date?.startsWith(ym)).sort((a, b) => b.date.localeCompare(a.date));
  const total = month.reduce((a, c) => a + c.amount, 0);
  const allTime = costs.reduce((a, c) => a + c.amount, 0);
  const budget = budgetStatus(total, settings.budget);

  const byCat = {};
  for (const c of month) byCat[c.category] = (byCat[c.category] || 0) + c.amount;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const label = new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const trend = lastMonths(6).map((m) => ({ label: m.label, value: costs.filter((c) => c.date?.startsWith(m.ym)).reduce((a, c) => a + c.amount, 0) }));

  el.innerHTML = `
    <div class="card">
      <div class="row">
        <button class="btn sm" data-act="prev" aria-label="Previous month">${icon('back', 18)}</button>
        <div style="text-align:center">
          <div class="muted small">${esc(label)}</div>
          <div class="big" style="font-size:40px">${money(total)}</div>
        </div>
        <button class="btn sm" data-act="next" aria-label="Next month">${icon('chevron', 18)}</button>
      </div>
      ${
        budget
          ? `<div class="bar ${budget.state}" style="margin-top:14px;height:10px"><i style="width:${Math.min(100, Math.round(budget.pct * 100))}%"></i></div>
             <div class="row" style="margin-top:6px"><span class="chip ${budget.state}">${esc(budget.text)}</span><button class="btn sm" data-act="budget">Change budget</button></div>`
          : `<div class="row" style="margin-top:12px"><span class="muted small">Set a monthly budget to get a warning at 80% and when you go over.</span><button class="btn sm" data-act="budget">Set budget</button></div>`
      }
      ${
        cats.length
          ? `<ul class="list" style="margin-top:14px">${cats
              .map(
                ([c, amt]) => `<li>
                  <div class="row"><span class="t">${esc(c)}</span><span class="v">${money(amt)}</span></div>
                  <div class="bar"><i style="width:${Math.round((amt / total) * 100)}%"></i></div>
                </li>`
              )
              .join('')}</ul>`
          : ''
      }
    </div>

    <button class="btn primary block mb" data-act="add">${icon('plus', 18)} Add expense</button>

    <div class="card">
      <h2>Entries</h2>
      ${
        month.length
          ? `<ul class="list">${month
              .map(
                (c) => `<li class="row">
                  <div class="grow" data-act="open" data-src="${c.source}" data-id="${c.id}">
                    <div class="t">${esc(c.category)} ${c.source === 'expense' ? '' : `<span class="chip">from ${FROM[c.source]}</span>`}</div>
                    ${meta([fmtDate(c.date), esc(c.note)])}
                  </div>
                  ${c.source === 'expense' ? photoButton(`expenses:${c.id}`, counts) : ''}
                  <div class="v">${money(c.amount)}</div>
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty">Nothing recorded for this month.</p>'
      }
    </div>

    <div class="card">
      <h2>Last six months, Nu.</h2>
      ${barChart(trend)}
      <p class="muted small" style="margin-top:10px">Everything so far: ${money(allTime)}</p>
    </div>
  `;

  el.onclick = (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    switch (t.dataset.act) {
      case 'prev': shiftMonth(-1); refresh(); break;
      case 'next': shiftMonth(1); refresh(); break;
      case 'add': edit(null); break;
      case 'budget':
        openForm({
          title: 'Monthly budget',
          note: 'Covers fuel, service, parts and other expenses. Leave empty to switch the budget off.',
          fields: [{ name: 'budget', label: 'Budget per month (Nu.)', type: 'number' }],
          values: { budget: settings.budget ?? '' },
          onSave: (v) => db.kvSet('settings', { ...settings, budget: v.budget || null }),
        });
        break;
      case 'open':
        if (t.dataset.src === 'expense') edit(expenses.find((x) => x.id === Number(t.dataset.id)));
        else toast(`This comes from the ${FROM[t.dataset.src]} screen. Edit it there.`);
        break;
    }
  };
}
