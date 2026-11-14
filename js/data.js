// Domain logic. Rule for this app: only show what the owner entered or what the phone
// actually measured. Nothing here invents motorcycle readings, and anything calculated
// is labelled as calculated where it is shown.
import { db } from './db.js';
import { num, money, today, getJson } from './ui.js';

const field = (key, label, value, verified = true) => ({ key, label, value, verified });

const DEFAULT_PROFILE = [
  field('manufacturer', 'Manufacturer', 'Honda'),
  field('model', 'Model', 'CB350RS'),
  field('engine_capacity', 'Engine capacity', '348.36 cc'),
  field('engine_type', 'Engine type', 'Single-cylinder, 4-stroke'),
  field('cooling_system', 'Cooling system', 'Air-cooled'),
  field('fuel_system', 'Fuel system', 'PGM-FI'),
  field('transmission', 'Transmission', '5-speed manual'),
  field('clutch', 'Clutch', 'Assist and slipper clutch'),
  field('maximum_power', 'Maximum power', '21.07 PS'),
  field('maximum_torque', 'Maximum torque', '30 Nm'),
  field('fuel_tank_capacity', 'Fuel tank capacity', '15 litres'),
  field('kerb_weight', 'Kerb weight (approximate)', '180 kg', false),
  field('bluetooth', 'Bluetooth connectivity', 'Yes'),
  field('diagnostic_protocol', 'Diagnostic protocol', 'Unknown', false),
  field('engine_oil', 'Engine oil in use', 'Motul 7100 10W-50', false),
];

// A general rider's walk-around, not a Honda-specific procedure. Fully editable.
const DEFAULT_CHECKLIST = [
  'Tyres: pressure and condition',
  'Brakes: front and rear feel firm',
  'Chain: tension and lubrication',
  'Lights, indicators and horn',
  'Engine oil level',
  'Fuel level',
  'Mirrors adjusted',
  'Side stand up, luggage secure',
  'Helmet and riding gear',
  'Licence and documents',
];

export const DEFAULT_SETTINGS = {
  voice: true, speedAlert: null, autoPause: true, sensors: true, autoPark: true, budget: null, theme: 'auto',
};
export const getSettings = async () => ({ ...DEFAULT_SETTINGS, ...(await db.kvGet('settings', {})) });

export async function seed() {
  if (!(await db.kvGet('seeded'))) {
    await db.kvSet('profile', DEFAULT_PROFILE);
    await db.kvSet('settings', DEFAULT_SETTINGS);
    await db.kvSet('checklist', { items: DEFAULT_CHECKLIST.map((text) => ({ text, done: false })) });
    await db.kvSet('emergency', {
      name: '', blood: '', medical: '', insurance: '',
      contacts: [
        { label: 'Police', phone: '113', verified: false },
        { label: 'Ambulance', phone: '112', verified: false },
        { label: 'Fire', phone: '110', verified: false },
      ],
    });

    // Reminder intervals are left empty on purpose: they must come from the owner's manual.
    const firstServiceNote = 'Last done at the first service (800–1000 km, exact reading not recorded).';
    for (const [name, notes] of [
      ['Engine oil change', firstServiceNote],
      ['Chain lubrication', firstServiceNote],
      ['Chain adjustment', firstServiceNote],
      ['Periodic service', ''],
    ]) {
      await db.put('maintenance', { name, intervalKm: null, intervalDays: null, lastOdo: null, lastDate: '', notes });
    }

    await db.put('services', {
      title: 'First service', date: '', odo: null,
      odoText: '800–1000 km (exact reading not recorded)',
      work: 'Engine oil replacement\nChain lubrication\nChain adjustment',
      parts: 'Engine oil: Motul 7100 10W-50',
      cost: null, notes: '', verified: false,
    });

    for (const name of ['Insurance', 'Vehicle registration', 'Driving licence']) {
      await db.put('docs', { name, number: '', expiry: '', notes: '' });
    }
    await db.kvSet('seeded', true);
  }

  if (!(await db.kvGet('seed2'))) {
    // Wear parts start empty: expected life and fitting details come from the owner.
    for (const name of ['Front tyre', 'Rear tyre', 'Battery', 'Front brake pads', 'Rear brake pads', 'Chain and sprockets']) {
      await db.put('parts', { name, brand: '', installedDate: '', installedOdo: null, expectedKm: null, expectedMonths: null, cost: null, notes: '' });
    }
    const old = await db.kvGet('parked'); // from the first version of the app
    if (old) {
      await db.put('parking', { lat: old.lat, lng: old.lng, time: old.time, note: old.note || '', address: '' });
      await db.kvDel('parked');
    }
    await db.kvSet('seed2', true);
  }
}

/* ---------- odometer ---------- */

/** Every odometer reading the owner has typed in, newest first. */
export async function odoReadings() {
  const [log, fuel, services, manual] = await Promise.all([db.all('odolog'), db.all('fuel'), db.all('services'), db.kvGet('odometer')]);
  const out = [
    ...log.map((l) => ({ date: l.date, value: l.value, source: 'Odometer update', id: l.id })),
    ...fuel.filter((f) => typeof f.odo === 'number').map((f) => ({ date: f.date, value: f.odo, source: 'Fill-up' })),
    ...services.filter((s) => typeof s.odo === 'number').map((s) => ({ date: s.date, value: s.odo, source: s.title || 'Service' })),
  ];
  if (manual?.value != null && !log.some((l) => l.value === manual.value)) {
    out.push({ date: manual.date, value: manual.value, source: 'Odometer update' });
  }
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.value - a.value);
}

/** Highest odometer reading the owner has typed in anywhere, or null if none yet. */
export async function getOdo() {
  const vals = (await odoReadings()).map((r) => r.value).filter((v) => typeof v === 'number' && !Number.isNaN(v));
  return vals.length ? Math.max(...vals) : null;
}

export async function setOdo(value, date = today()) {
  await db.kvSet('odometer', { value, date });
  await db.put('odolog', { value, date });
}

/* ---------- fuel ---------- */

/**
 * Mileage by the full-tank method: distance between two full fill-ups divided by the fuel
 * added since the first of them. Calculated from entered fill-ups, not measured by the bike.
 */
export function fuelSummary(fills) {
  const sorted = fills.filter((f) => typeof f.odo === 'number').sort((a, b) => a.odo - b.odo);
  const segments = {};
  const series = [];
  let lastFull = null;
  let litres = 0, cost = 0, costKnown = true;
  let km = 0, used = 0, costKm = 0, costSum = 0;

  const reset = () => { litres = 0; cost = 0; costKnown = true; };

  for (const f of sorted) {
    if (f.missed) { lastFull = f.full ? f : null; reset(); continue; }
    if (lastFull) {
      litres += f.litres || 0;
      if (f.cost) cost += f.cost; else costKnown = false;
    }
    if (f.full) {
      if (lastFull && litres > 0 && f.odo > lastFull.odo) {
        const seg = { km: f.odo - lastFull.odo, litres, kmpl: (f.odo - lastFull.odo) / litres, date: f.date, cost: costKnown ? cost : null };
        segments[f.id] = seg;
        series.push(seg);
        km += seg.km;
        used += seg.litres;
        if (seg.cost != null) { costKm += seg.km; costSum += seg.cost; }
      }
      lastFull = f;
      reset();
    }
  }

  const priced = fills.filter((f) => f.cost && f.litres).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return {
    segments,
    series,
    avg: used > 0 ? km / used : null,
    last: series.length ? series[series.length - 1].kmpl : null,
    costPerKm: costKm > 0 ? costSum / costKm : null,
    litres: fills.reduce((a, f) => a + (f.litres || 0), 0),
    spend: fills.reduce((a, f) => a + (f.cost || 0), 0),
    prices: priced.map((f) => ({ date: f.date, value: f.cost / f.litres })),
    lastPrice: priced.length ? priced[priced.length - 1].cost / priced[priced.length - 1].litres : null,
  };
}

/** GPS distance ridden since the most recent fill-up, from rides tracked with the app. */
export function sinceLastFill(fills, rides) {
  if (!fills.length) return null;
  const last = [...fills].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.at || 0) - (b.at || 0)).pop();
  const from = last.at || new Date(last.date + 'T23:59:59').getTime();
  const later = rides.filter((r) => r.start >= from);
  return { fill: last, km: later.reduce((a, r) => a + r.distanceM, 0) / 1000, rides: later.length };
}

/* ---------- maintenance, parts, documents ---------- */

export function maintStatus(item, odo) {
  const res = { kmLeft: null, daysLeft: null, dueDate: null, pct: null, state: 'setup' };
  let a = null, b = null;
  if (item.intervalKm && typeof item.lastOdo === 'number' && odo != null) {
    res.kmLeft = item.lastOdo + item.intervalKm - odo;
    a = (odo - item.lastOdo) / item.intervalKm;
  }
  if (item.intervalDays && item.lastDate) {
    const due = new Date(item.lastDate + 'T00:00:00');
    due.setDate(due.getDate() + item.intervalDays);
    res.daysLeft = Math.ceil((due - new Date()) / 864e5);
    res.dueDate = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
    b = 1 - res.daysLeft / item.intervalDays;
  }
  if (res.kmLeft == null && res.daysLeft == null) return res;
  res.pct = Math.max(a ?? 0, b ?? 0);
  const overdue = (res.kmLeft != null && res.kmLeft <= 0) || (res.daysLeft != null && res.daysLeft <= 0);
  const soon =
    (res.kmLeft != null && res.kmLeft <= Math.max(100, item.intervalKm * 0.1)) ||
    (res.daysLeft != null && res.daysLeft <= 14);
  res.state = overdue ? 'overdue' : soon ? 'soon' : 'ok';
  return res;
}

export function statusText(s) {
  if (s.state === 'setup') return 'Needs setup';
  const parts = [];
  if (s.kmLeft != null) parts.push(s.kmLeft > 0 ? `${num(s.kmLeft)} km left` : `${num(-s.kmLeft)} km overdue`);
  if (s.daysLeft != null) parts.push(s.daysLeft > 0 ? `${s.daysLeft} days left` : `${-s.daysLeft} days overdue`);
  return parts.join(', ');
}

/** Wear of a fitted part against the life the owner expects from it. */
export function partStatus(p, odo) {
  const res = { pct: null, kmUsed: null, monthsUsed: null, state: 'setup', text: 'Add when it was fitted and the life you expect' };
  if (typeof p.installedOdo === 'number' && odo != null) res.kmUsed = Math.max(0, odo - p.installedOdo);
  if (p.installedDate) res.monthsUsed = Math.max(0, (Date.now() - new Date(p.installedDate + 'T00:00:00')) / (864e5 * 30.44));
  const used = [res.kmUsed != null ? `${num(res.kmUsed)} km` : '', res.monthsUsed != null ? `${num(res.monthsUsed, res.monthsUsed < 10 ? 1 : 0)} months` : '']
    .filter(Boolean)
    .join(', ');
  const a = p.expectedKm && res.kmUsed != null ? res.kmUsed / p.expectedKm : null;
  const b = p.expectedMonths && res.monthsUsed != null ? res.monthsUsed / p.expectedMonths : null;
  if (a == null && b == null) {
    if (used) { res.state = 'none'; res.text = `${used} in use. Add an expected life to track wear.`; }
    return res;
  }
  res.pct = Math.max(a ?? 0, b ?? 0);
  res.state = res.pct >= 1 ? 'overdue' : res.pct >= 0.8 ? 'soon' : 'ok';
  res.text = `${used} in use`;
  return res;
}

/** Expiry status of a document: state is none | ok | soon (30 days or less) | overdue. */
export function docStatus(doc) {
  if (!doc.expiry) return { state: 'none', text: 'No expiry date set' };
  const days = Math.ceil((new Date(doc.expiry + 'T23:59:59') - new Date()) / 864e5) - 1;
  if (days < 0) return { state: 'overdue', text: `Expired ${-days} day${days === -1 ? '' : 's'} ago` };
  if (days === 0) return { state: 'overdue', text: 'Expires today' };
  return { state: days <= 30 ? 'soon' : 'ok', text: `${days} day${days === 1 ? '' : 's'} left` };
}

/* ---------- rides, trips ---------- */

/** Figures derived from a ride's recorded GPS points. */
export function rideMetrics(points) {
  let movingMs = 0;
  let maxAlt = null;
  for (let i = 0; i < points.length; i++) {
    const alt = points[i][4];
    if (alt != null && (maxAlt == null || alt > maxAlt)) maxAlt = alt;
    if (i > 0) {
      const dt = points[i][2] - points[i - 1][2];
      if (dt > 0 && dt <= 15000) movingMs += dt; // longer gaps are stops or lost signal
    }
  }
  return { movingS: Math.round(movingMs / 1000), maxAlt };
}

const dayOf = (ms) => {
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

/** Everything that happened between a trip's start and end dates. */
export function tripSummary(trip, rides, costs) {
  const end = trip.end || trip.start;
  const inRange = (d) => d && d >= trip.start && d <= end;
  const tripRides = rides.filter((r) => inRange(dayOf(r.start))).sort((a, b) => a.start - b.start);
  const tripCosts = costs.filter((c) => inRange(c.date));
  const alts = tripRides.map((r) => r.maxAlt).filter((v) => v != null);
  const fuel = tripCosts.filter((c) => c.source === 'fuel').reduce((a, c) => a + c.amount, 0);
  const total = tripCosts.reduce((a, c) => a + c.amount, 0);
  return {
    rides: tripRides,
    costs: tripCosts,
    days: Math.round((new Date(end) - new Date(trip.start)) / 864e5) + 1,
    km: tripRides.reduce((a, r) => a + r.distanceM, 0) / 1000,
    seconds: tripRides.reduce((a, r) => a + (r.movingS || r.durationS), 0),
    maxAlt: alts.length ? Math.max(...alts) : null,
    fuel, other: total - fuel, total,
  };
}

/* ---------- money ---------- */

/** Every cost in one list: manual expenses plus costs entered on fill-ups, services and parts. */
export async function allCosts() {
  const [expenses, fuel, services, parts] = await Promise.all([db.all('expenses'), db.all('fuel'), db.all('services'), db.all('parts')]);
  return [
    ...expenses.map((e) => ({ date: e.date, category: e.category, amount: e.amount || 0, note: e.note, source: 'expense', id: e.id })),
    ...fuel.filter((f) => f.cost).map((f) => ({ date: f.date, category: 'Fuel', amount: f.cost, note: `${f.litres} L`, source: 'fuel', id: f.id })),
    ...services.filter((s) => s.cost).map((s) => ({ date: s.date, category: 'Service', amount: s.cost, note: s.title, source: 'service', id: s.id })),
    ...parts.filter((p) => p.cost && p.installedDate).map((p) => ({ date: p.installedDate, category: 'Parts', amount: p.cost, note: p.name, source: 'part', id: p.id })),
  ];
}

export function budgetStatus(spent, budget) {
  if (!budget) return null;
  const pct = spent / budget;
  if (pct >= 1) return { pct, state: 'overdue', text: spent > budget ? `Over budget by ${money(spent - budget)}` : 'Budget used up' };
  return { pct, state: pct >= 0.8 ? 'soon' : 'ok', text: `${money(budget - spent)} left of ${money(budget)}` };
}

/* ---------- parking ---------- */

/** The spot where the bike is parked now, or null. */
export async function currentSpot() {
  const open = (await db.all('parking')).filter((p) => !p.leftAt);
  return open.sort((a, b) => b.time - a.time)[0] || null;
}

/** Marks any open parking spot as left (the bike has moved on). */
export async function leaveSpot(when = Date.now()) {
  for (const p of (await db.all('parking')).filter((x) => !x.leftAt)) await db.put('parking', { ...p, leftAt: when });
}

/** Saves a new parking spot, then looks up a street address for it in the background. */
export async function parkAt(lat, lng, { note = '', auto = false, time = Date.now() } = {}) {
  await leaveSpot(time);
  const id = await db.put('parking', { lat, lng, time, note, auto, address: '' });
  getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}`, { headers: { Accept: 'application/json' } }, 12000)
    .then(async (r) => {
      const spot = await db.get('parking', id);
      if (spot && r.display_name) {
        await db.put('parking', { ...spot, address: r.display_name.split(',').slice(0, 3).join(',') });
        globalThis.dispatchEvent?.(new Event('app:refresh'));
      }
    })
    .catch(() => {});
  return id;
}

/* ---------- what needs attention ---------- */

/** One prioritised list for the Home screen: overdue first, then due soon. */
export async function attention() {
  const [maint, docs, parts, odo, costs, settings] = await Promise.all([
    db.all('maintenance'), db.all('docs'), db.all('parts'), getOdo(), allCosts(), getSettings(),
  ]);
  const items = [];
  for (const m of maint) {
    const s = maintStatus(m, odo);
    if (s.state === 'overdue' || s.state === 'soon') items.push({ title: m.name, text: statusText(s), state: s.state, href: '#service' });
  }
  for (const p of parts.filter((x) => !x.retired)) {
    const s = partStatus(p, odo);
    if (s.state === 'overdue' || s.state === 'soon') {
      items.push({ title: p.name, text: `${Math.round(s.pct * 100)}% of expected life used`, state: s.state, href: '#service' });
    }
  }
  for (const d of docs) {
    const s = docStatus(d);
    if (s.state === 'overdue' || s.state === 'soon') items.push({ title: d.name, text: s.text, state: s.state, href: '#docs' });
  }
  const ym = today().slice(0, 7);
  const b = budgetStatus(costs.filter((c) => c.date?.startsWith(ym)).reduce((a, c) => a + c.amount, 0), settings.budget);
  if (b && b.state !== 'ok') items.push({ title: 'Monthly budget', text: b.text, state: b.state, href: '#money' });
  return {
    items: items.sort((x, y) => (x.state === y.state ? 0 : x.state === 'overdue' ? -1 : 1)),
    needSetup: maint.filter((m) => maintStatus(m, odo).state === 'setup').length,
  };
}
