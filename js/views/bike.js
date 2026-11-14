// The "More" hub: everything that is not on the tab bar, plus settings.
import { db } from '../db.js';
import { getSettings } from '../data.js';
import { num, money, openForm, refresh, icon } from '../ui.js';

export const title = 'More';

const MENU = [
  ['stats', 'chart', 'Stats'],
  ['trips', 'flag', 'Trips'],
  ['parking', 'parking', 'Parking'],
  ['odometer', 'gauge', 'Odometer'],
  ['docs', 'doc', 'Documents'],
  ['checklist', 'check', 'Pre-ride check'],
  ['emergency', 'cross', 'Emergency'],
  ['profile', 'bike', 'Bike profile'],
  ['backup', 'cloud', 'Backup and sync'],
];

export async function render(el) {
  const settings = await getSettings();
  const save = (patch) => db.kvSet('settings', { ...settings, ...patch });
  const onOff = (v) => (v ? 'On' : 'Off');

  el.innerHTML = `
    <nav class="menu" aria-label="More screens">
      ${MENU.map(([href, ic, label]) => `<a href="#${href}">${icon(ic, 26)}${label}</a>`).join('')}
    </nav>

    <div class="card">
      <h2>Appearance</h2>
      <div class="seg" style="margin-bottom:0">
        ${['auto', 'light', 'dark']
          .map((t) => `<button data-act="theme" data-theme="${t}" class="${settings.theme === t ? 'on' : ''}">${t === 'auto' ? 'Match phone' : t === 'light' ? 'Light' : 'Dark'}</button>`)
          .join('')}
      </div>
    </div>

    <div class="card">
      <div class="row head"><h2>Riding</h2><button class="btn sm" data-act="ride">Change</button></div>
      <dl class="kv">
        <dt>Voice directions</dt><dd>${onOff(settings.voice)}</dd>
        <dt>Speed alert</dt><dd>${settings.speedAlert ? `Above ${num(settings.speedAlert)} km/h by GPS` : 'Off'}</dd>
        <dt>Pause timer at stops</dt><dd>${onOff(settings.autoPause)}</dd>
        <dt>Lean and G-force</dt><dd>${onOff(settings.sensors)}</dd>
        <dt>Save parking spot after a ride</dt><dd>${onOff(settings.autoPark)}</dd>
      </dl>
    </div>

    <div class="card">
      <div class="row head"><h2>Monthly budget</h2><button class="btn sm" data-act="budget">${settings.budget ? 'Change' : 'Set'}</button></div>
      <p>${settings.budget ? `${money(settings.budget)} a month. You are warned at 80% and when you go over.` : 'No budget set.'}</p>
    </div>
  `;

  el.onclick = (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    switch (t.dataset.act) {
      case 'theme':
        window.dispatchEvent(new CustomEvent('app:theme', { detail: t.dataset.theme }));
        save({ theme: t.dataset.theme }).then(refresh);
        break;
      case 'ride':
        openForm({
          title: 'Riding settings',
          fields: [
            { name: 'voice', label: 'Speak turn directions and alerts', type: 'checkbox' },
            { name: 'speedAlert', label: 'Speed alert above (km/h)', type: 'number', hint: 'Uses GPS speed while a ride is tracked, and marks the speedometer. Leave empty to turn it off.' },
            { name: 'autoPause', label: 'Pause the ride timer while stopped', type: 'checkbox' },
            { name: 'sensors', label: 'Show lean angle and G-force from the phone', type: 'checkbox' },
            { name: 'autoPark', label: 'Save the parking spot when a ride ends', type: 'checkbox' },
          ],
          values: settings,
          onSave: (v) => save({ ...v, speedAlert: v.speedAlert || null }),
        });
        break;
      case 'budget':
        openForm({
          title: 'Monthly budget',
          note: 'Covers fuel, service, parts and other expenses. Leave empty to switch the budget off.',
          fields: [{ name: 'budget', label: 'Budget per month (Nu.)', type: 'number' }],
          values: { budget: settings.budget ?? '' },
          onSave: (v) => save({ budget: v.budget || null }),
        });
        break;
    }
  };
}
