// Where the bike is parked now, how long it has been there, and where it was kept before.
import { db } from '../db.js';
import { currentSpot, parkAt, leaveSpot } from '../data.js';
import { photoButton } from '../photos.js';
import { esc, fmtDateTime, fmtSpan, fmtDist, openForm, refresh, toast, icon, meta, haversine, bearing, compassWord, makeMap, dropMap, dot } from '../ui.js';
import { getPos, routeTo } from './ride.js';

export const title = 'Parking';

let me = null;       // the rider's position, once known
let located = false; // look the rider up once each time the screen is opened
let pmap = null;

async function locate(quiet) {
  try {
    me = await getPos();
    refresh();
  } catch {
    if (!quiet) toast('Could not get your location. Allow location access and try again.');
  }
}

const mapsLink = (p, mode = 'w') => `https://maps.apple.com/?daddr=${p.lat},${p.lng}&dirflg=${mode}`;
const where = (p) => p.address || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;

export async function render(el) {
  const [spot, all, counts] = await Promise.all([currentSpot(), db.all('parking'), db.photoCounts()]);
  const history = all.filter((p) => p.leftAt).sort((a, b) => b.time - a.time);

  let finder = '';
  if (spot) {
    const dist = me ? haversine(me[0], me[1], spot.lat, spot.lng) : null;
    const dir = me ? bearing(me[0], me[1], spot.lat, spot.lng) : null;
    finder = `
      <div class="finder mb">
        <div class="arrow" aria-hidden="true"><svg viewBox="0 0 24 24" style="transform:rotate(${dir ?? 0}deg);${me ? '' : 'opacity:.3'}"><path d="M12 3 5.5 20l6.5-4 6.5 4z" fill="currentColor"/></svg></div>
        <div class="grow">
          ${
            me
              ? dist < 25
                ? '<div class="big" style="font-size:28px">You are at the bike</div>'
                : `<div class="big">${fmtDist(dist)}</div><div class="muted small">to the ${compassWord(dir)}, in a straight line. The arrow points there when the top of your phone faces north.</div>`
              : '<div class="muted">Finding where you are…</div>'
          }
        </div>
      </div>`;
  }

  el.innerHTML = `
    <a class="back" href="#bike">${icon('back', 18)} More</a>
    ${
      spot
        ? `<div class="card">
            <div class="row head"><h2>Parked ${fmtSpan(Date.now() - spot.time)} ago</h2>${photoButton(`parking:${spot.id}`, counts)}</div>
            <p><b>${esc(where(spot))}</b></p>
            ${meta([`since ${fmtDateTime(spot.time)}`, spot.auto ? 'saved when your ride ended' : '', esc(spot.note)])}
            <div style="height:12px"></div>
            ${finder}
            <div id="pmap" class="minimap"></div>
            <div class="chips">
              <button class="btn sm" data-act="locate">${icon('target', 16)} Update my position</button>
              <a class="btn sm primary" target="_blank" rel="noopener" href="${mapsLink(spot)}">Walk there in Apple Maps</a>
              <button class="btn sm" data-act="route">${icon('route', 16)} Route in app</button>
              <button class="btn sm" data-act="note">Note</button>
              <button class="btn sm" data-act="share">${icon('share', 16)} Share spot</button>
              <button class="btn sm" data-act="left">The bike has moved</button>
            </div>
          </div>`
        : `<div class="card">
            <h2>Where is the bike?</h2>
            <p class="muted">No parking spot is saved right now. Save one when you leave the bike and the app will lead you back to it.</p>
            <button class="btn primary block" data-act="park" style="margin-top:10px">${icon('parking', 18)} Park here</button>
          </div>`
    }
    ${spot ? `<button class="btn block mb" data-act="park">${icon('parking', 18)} Move the spot to where I am now</button>` : ''}

    <div class="card">
      <div class="row head"><h2>Where it was kept before</h2>${history.length ? '<button class="btn sm danger" data-act="clear">Clear</button>' : ''}</div>
      ${
        history.length
          ? `<ul class="list">${history
              .map(
                (p) => `<li class="row">
                  <a class="grow" style="color:inherit;text-decoration:none" target="_blank" rel="noopener" href="${mapsLink(p, 'd')}">
                    <div class="t">${esc(where(p))}</div>
                    ${meta([`${fmtDateTime(p.time)} to ${fmtDateTime(p.leftAt)}`, `stayed ${fmtSpan(p.leftAt - p.time)}`, esc(p.note)])}
                  </a>
                  ${photoButton(`parking:${p.id}`, counts)}
                  <button class="btn sm danger" data-act="del" data-id="${p.id}" aria-label="Delete this entry">×</button>
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty">Past parking spots will be listed here with when the bike arrived and left.</p>'
      }
    </div>
    <p class="muted small">A spot is saved automatically when you stop a tracked ride (you can turn that off in More, Settings), and it is closed when the next ride starts. Positions come from the phone's GPS.</p>
  `;

  if (pmap) { dropMap(pmap); pmap = null; }
  if (spot) {
    pmap = makeMap('pmap', [spot.lat, spot.lng], 17);
    if (pmap) {
      dot([spot.lat, spot.lng], '#7c5cff', 10).addTo(pmap).bindTooltip('Bike');
      if (me) {
        dot(me, '#2f8fd0').addTo(pmap).bindTooltip('You');
        pmap.fitBounds([[spot.lat, spot.lng], me], { padding: [36, 36], maxZoom: 18 });
      }
    }
    if (!located) { located = true; locate(true); }
  }

  el.onclick = async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    switch (t.dataset.act) {
      case 'park':
        try {
          me = null;
          const [lat, lng] = await getPos();
          me = [lat, lng];
          await parkAt(lat, lng);
          toast('Parking spot saved');
          refresh();
        } catch {
          toast('Could not get your location. Allow location access and try again.');
        }
        break;
      case 'locate': me = null; locate(false); break;
      case 'route':
        location.hash = 'ride';
        routeTo({ name: 'Parked bike', lat: spot.lat, lng: spot.lng });
        break;
      case 'note':
        openForm({
          title: 'Parking note',
          fields: [{ name: 'note', label: 'Note', type: 'text', placeholder: 'Level, slot number, landmark…' }],
          values: spot,
          onSave: (v) => db.put('parking', { ...spot, ...v }).then(() => {}),
        });
        break;
      case 'share': {
        const url = `https://maps.apple.com/?ll=${spot.lat},${spot.lng}&q=Parked%20bike`;
        if (navigator.share) navigator.share({ title: 'Where my bike is parked', url }).catch(() => {});
        else { await navigator.clipboard?.writeText(url); toast('Map link copied'); }
        break;
      }
      case 'left': await leaveSpot(); refresh(); break;
      case 'del': await db.del('parking', Number(t.dataset.id)); refresh(); break;
      case 'clear':
        if (confirm('Delete all past parking spots? The current spot is kept.')) {
          for (const p of history) await db.del('parking', p.id);
          refresh();
        }
        break;
    }
  };
}

export function leave() {
  located = false;
  if (pmap) { dropMap(pmap); pmap = null; }
}
