import { seed, getSettings } from './data.js';
import { startAutoSync } from './sync.js';
import { startBikeCapture } from './bikeble.js';
import { openPhotos } from './photos.js';
import * as home from './views/home.js';
import * as ride from './views/ride.js';
import * as fuel from './views/fuel.js';
import * as service from './views/service.js';
import * as money from './views/money.js';
import * as bike from './views/bike.js';
import * as profile from './views/profile.js';
import * as docs from './views/docs.js';
import * as checklist from './views/checklist.js';
import * as emergency from './views/emergency.js';
import * as stats from './views/stats.js';
import * as trips from './views/trips.js';
import * as parking from './views/parking.js';
import * as odometer from './views/odometer.js';
import * as backup from './views/backup.js';
import * as blebike from './views/blebike.js';

const views = { home, ride, fuel, service, money, bike, profile, docs, checklist, emergency, stats, trips, parking, odometer, backup, blebike };
const TABS = ['home', 'ride', 'fuel', 'service', 'money'];
const viewEl = document.getElementById('view');
let currentName = null;

/** 'auto' follows the phone; 'light' and 'dark' force a theme. */
export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('bc-theme', theme); } catch { /* private mode */ }
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0e1b1d' : '#e4ebe8';
}
window.addEventListener('app:theme', (e) => applyTheme(e.detail));

async function show(keepScroll) {
  const name = views[location.hash.slice(1)] ? location.hash.slice(1) : 'home';
  const scroll = keepScroll && name === currentName ? viewEl.scrollTop : 0;

  if (currentName && currentName !== name) views[currentName].leave?.();
  currentName = name;

  document.getElementById('title').textContent = views[name].title;
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  document.getElementById('bikeBtn').classList.toggle('active', !TABS.includes(name));

  viewEl.onclick = null;
  viewEl.onsubmit = null;
  viewEl.onchange = null;
  viewEl.oninput = null;
  try {
    await views[name].render(viewEl);
  } catch (e) {
    console.error(e);
    viewEl.innerHTML = '<div class="card"><p>This screen could not be shown. Close the app and open it again.</p></div>';
  }
  viewEl.scrollTop = scroll;
}

window.addEventListener('hashchange', () => show(false));
window.addEventListener('app:refresh', () => show(true));

// Any camera button, on any screen, opens the photos for its record.
viewEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-photos]');
  if (!b) return;
  e.stopPropagation();
  openPhotos(b.dataset.photos, 'Photos');
}, true);

(async () => {
  try {
    await seed();
  } catch (e) {
    console.error(e);
    viewEl.innerHTML =
      '<div class="card"><p>This browser is blocking on-device storage, so the app cannot save anything. Turn off Private Browsing and reload.</p></div>';
    return;
  }
  applyTheme((await getSettings()).theme);
  await show(false);
  // Ask the browser not to evict our data when the phone is low on space.
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  startAutoSync();
  startBikeCapture().catch((e) => console.error(e));
})();
