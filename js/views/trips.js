// Multi-day trips. A trip is a date range: rides, fuel and expenses inside it are gathered automatically.
import { db } from '../db.js';
import { tripSummary, allCosts } from '../data.js';
import { esc, num, money, today, fmtDate, fmtDateTime, fmtDur, openForm, refresh, icon, meta, makeMap, dropMap } from '../ui.js';

export const title = 'Trips';

let openId = null;
let tmap = null;

const FIELDS = [
  { name: 'name', label: 'Trip name', type: 'text', required: true, placeholder: 'e.g. Thimphu to Bumthang' },
  { name: 'start', label: 'First day', type: 'date', required: true },
  { name: 'end', label: 'Last day', type: 'date', hint: 'Leave empty for a one-day trip or one that is still going.' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

function edit(rec) {
  openForm({
    title: rec ? 'Edit trip' : 'New trip',
    fields: FIELDS,
    values: rec || { start: today() },
    onSave: (v) => {
      if (v.end && v.end < v.start) return 'The last day cannot be before the first day.';
      return db.put('trips', { ...rec, ...v }).then(() => {});
    },
    onDelete: rec ? async () => { await db.del('trips', rec.id); openId = null; } : null,
  });
}

const range = (t) => (t.end && t.end !== t.start ? `${fmtDate(t.start)} to ${fmtDate(t.end)}` : fmtDate(t.start));
const COLORS = ['#ff6a2b', '#2f8fd0', '#16a34a', '#e8b04a', '#7c5cff', '#e5484d'];

export async function render(el) {
  const [trips, rides, costs] = await Promise.all([db.all('trips'), db.all('rides'), allCosts()]);
  trips.sort((a, b) => b.start.localeCompare(a.start));
  const trip = trips.find((t) => t.id === openId);
  if (tmap) { dropMap(tmap); tmap = null; }

  if (trip) {
    // An open-ended trip counts everything up to today.
    const s = tripSummary({ ...trip, end: trip.end || today() }, rides, costs);
    const tile = (label, value, unit = '') => `<div class="tile"><div class="lbl">${label}</div><span class="big">${value}</span>${unit ? `<span class="unit">${unit}</span>` : ''}</div>`;
    el.innerHTML = `
      <a class="back" href="#trips" data-act="close">${icon('back', 18)} All trips</a>
      <div class="card">
        <div class="row head"><h2>${esc(trip.name)}</h2><button class="btn sm" data-act="edit">Edit</button></div>
        <p class="muted">${esc(range(trip))}${trip.end ? '' : ', still going'}</p>
        ${trip.notes ? `<p class="pre">${esc(trip.notes)}</p>` : ''}
      </div>
      <div class="tiles">
        ${tile('Days', num(s.days))}
        ${tile('Distance, GPS', num(s.km, 1), 'km')}
        ${tile('Riding time', fmtDur(s.seconds))}
        ${tile('Highest point', s.maxAlt == null ? '—' : num(s.maxAlt), 'm')}
        ${tile('Fuel', money(s.fuel))}
        ${tile('Total cost', money(s.total))}
      </div>
      ${s.rides.length ? '<div id="tmap" class="minimap" style="height:260px"></div>' : ''}
      <div class="card">
        <h2>Rides on this trip</h2>
        ${
          s.rides.length
            ? `<ul class="list">${s.rides
                .map(
                  (r, i) => `<li class="row"><span style="width:10px;height:10px;border-radius:50%;background:${COLORS[i % COLORS.length]};flex:none"></span>
                    <div class="grow"><div class="t">${esc(r.name || fmtDateTime(r.start))}</div>${meta([r.name ? esc(fmtDateTime(r.start)) : '', fmtDur(r.movingS || r.durationS)])}</div>
                    <div class="v">${num(r.distanceM / 1000, 1)} km</div></li>`
                )
                .join('')}</ul>`
            : '<p class="empty">No tracked rides fall inside these dates yet.</p>'
        }
      </div>
      <div class="card">
        <h2>Costs on this trip</h2>
        ${
          s.costs.length
            ? `<ul class="list">${s.costs
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((c) => `<li class="row"><div class="grow"><div class="t">${esc(c.category)}</div>${meta([fmtDate(c.date), esc(c.note)])}</div><div class="v">${money(c.amount)}</div></li>`)
                .join('')}</ul>`
            : '<p class="empty">No fuel or expenses were recorded inside these dates.</p>'
        }
      </div>`;

    if (s.rides.length) {
      const first = s.rides[0].points[0];
      tmap = makeMap('tmap', [first[0], first[1]], 10);
      if (tmap) {
        const bounds = [];
        s.rides.forEach((r, i) => {
          const pts = r.points.map((p) => [p[0], p[1]]);
          L.polyline(pts, { color: COLORS[i % COLORS.length], weight: 4 }).addTo(tmap);
          bounds.push(...pts);
        });
        tmap.fitBounds(bounds, { padding: [20, 20] });
      }
    }
  } else {
    el.innerHTML = `
      <a class="back" href="#bike">${icon('back', 18)} More</a>
      <button class="btn primary block mb" data-act="add">${icon('plus', 18)} New trip</button>
      ${
        trips.length
          ? trips
              .map((t) => {
                const s = tripSummary({ ...t, end: t.end || today() }, rides, costs);
                return `<div class="card" data-act="open" data-id="${t.id}" style="cursor:pointer">
                  <div class="row head"><h2>${esc(t.name)}</h2>${icon('chevron', 18)}</div>
                  <p class="muted small">${esc(range(t))}${t.end ? '' : ', still going'}</p>
                  ${meta([`${num(s.days)} day${s.days === 1 ? '' : 's'}`, `${num(s.km, 1)} km by GPS`, `${s.rides.length} ride${s.rides.length === 1 ? '' : 's'}`, money(s.total)])}
                </div>`;
              })
              .join('')
          : '<div class="card"><p class="empty">Give a tour its dates and the app gathers every ride, fill-up and expense inside them into one summary with a map.</p></div>'
      }`;
  }

  el.onclick = (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    switch (t.dataset.act) {
      case 'add': edit(null); break;
      case 'edit': edit(trip); break;
      case 'open': openId = Number(t.dataset.id); refresh(); document.getElementById('view').scrollTop = 0; break;
      case 'close': e.preventDefault(); openId = null; refresh(); break;
    }
  };
}

export function leave() {
  openId = null;
  if (tmap) { dropMap(tmap); tmap = null; }
}
