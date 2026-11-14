import { db } from '../db.js';
import { fuelSummary, allCosts } from '../data.js';
import { num, money, fmtDur, barChart, lastMonths, icon } from '../ui.js';

export const title = 'Stats';

const ymOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const maxOf = (list) => (list.length ? Math.max(...list) : null);

export async function render(el) {
  const [rides, fills, costs, parking] = await Promise.all([db.all('rides'), db.all('fuel'), allCosts(), db.all('parking')]);
  const fs = fuelSummary(fills);
  const months = lastMonths(6);

  const totalKm = rides.reduce((a, r) => a + r.distanceM, 0) / 1000;
  const totalS = rides.reduce((a, r) => a + (r.movingS || r.durationS), 0);
  const longest = rides.reduce((a, r) => Math.max(a, r.distanceM), 0) / 1000;
  const pick = (k) => maxOf(rides.map((r) => r[k]).filter((v) => v != null));
  const lean = maxOf(rides.flatMap((r) => [r.maxLeanLeft, r.maxLeanRight]).filter((v) => v != null));

  const rideKmByMonth = months.map((m) => ({
    label: m.label,
    value: rides.filter((r) => ymOf(r.start) === m.ym).reduce((a, r) => a + r.distanceM, 0) / 1000,
  }));
  const spendByMonth = months.map((m) => ({
    label: m.label,
    value: costs.filter((c) => c.date?.startsWith(m.ym)).reduce((a, c) => a + c.amount, 0),
  }));
  const allTime = costs.reduce((a, c) => a + c.amount, 0);

  const tile = (label, value, unit = '') =>
    `<div class="tile"><div class="lbl">${label}</div><span class="big">${value}</span>${unit ? `<span class="unit">${unit}</span>` : ''}</div>`;
  const orDash = (v, d = 0) => (v == null ? '—' : num(v, d));

  el.innerHTML = `
    <a class="back" href="#bike">${icon('back', 18)} More</a>
    <div class="tiles">
      ${tile('Rides tracked', num(rides.length))}
      ${tile('Distance, GPS', num(totalKm, 1), 'km')}
      ${tile('Riding time', fmtDur(totalS))}
      ${tile('Longest ride', rides.length ? num(longest, 1) : '—', 'km')}
      ${tile('Top GPS speed', orDash(pick('maxSpeed')), 'km/h')}
      ${tile('Highest point', orDash(pick('maxAlt')), 'm')}
      ${tile('Deepest lean, phone', lean == null ? '—' : `${num(lean)}°`)}
      ${tile('Peak G, phone', orDash(pick('maxG'), 2), 'g')}
      ${tile('Average mileage', orDash(fs.avg, 1), 'km/l')}
      ${tile('Fuel cost', orDash(fs.costPerKm, 2), 'Nu./km')}
      ${tile('Total spent', money(allTime))}
      ${tile('Places parked', num(parking.length))}
    </div>

    <div class="card">
      <h2>Ride distance by month, km</h2>
      ${barChart(rideKmByMonth, (v) => num(v, v < 100 ? 1 : 0))}
    </div>
    <div class="card">
      <h2>Spending by month, Nu.</h2>
      ${barChart(spendByMonth)}
    </div>
    <div class="card">
      <h2>Mileage by tank, km/l</h2>
      ${barChart(
        fs.series.slice(-8).map((s) => ({ label: s.date ? s.date.slice(8, 10) + '/' + s.date.slice(5, 7) : '', value: s.kmpl })),
        (v) => num(v, 1)
      )}
    </div>
    <p class="muted small">Ride figures come from the phone's GPS and motion sensors on rides tracked with this app. Mileage and spending are worked out from what you entered.</p>
  `;
}
