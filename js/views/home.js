import { db } from '../db.js';
import { getOdo, setOdo, fuelSummary, sinceLastFill, allCosts, attention, currentSpot, getSettings, budgetStatus } from '../data.js';
import { getSync } from '../sync.js';
import { esc, num, money, today, fmtDate, fmtSpan, fmtTime, openForm, refresh, toast, getJson, icon, meta } from '../ui.js';
import { getPos } from './ride.js';

export const title = 'My bike';

// Weather is fetched only when asked for, and kept until the app is closed.
let wx = null;
let wxBusy = false;
let firstPaint = true;

// Turns a MET Norway symbol code such as "lightrainshowers_day" into "Light rain showers".
const SKY = { clearsky: 'Clear sky', fair: 'Fair', partlycloudy: 'Partly cloudy', cloudy: 'Cloudy', fog: 'Fog' };
function weatherText(symbol) {
  if (!symbol) return 'Conditions not available';
  const code = symbol.split('_')[0];
  if (SKY[code]) return SKY[code];
  const words = code.match(/light|heavy|rain|sleet|snow|showers|and|thunder/g) || [code];
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function loadWeather() {
  wxBusy = true;
  refresh();
  try {
    const [la, lo] = await getPos();
    // Two decimals (about 1 km) is enough for a forecast.
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${la.toFixed(2)}&lon=${lo.toFixed(2)}`;
    const j = await getJson(url, {}, 25000);
    const now = j.properties.timeseries[0].data;
    wx = {
      time: Date.now(),
      temp: now.instant.details.air_temperature,
      wind: now.instant.details.wind_speed * 3.6, // m/s to km/h
      symbol: (now.next_1_hours || now.next_6_hours)?.summary?.symbol_code,
      rain: now.next_6_hours?.details?.precipitation_amount ?? null,
    };
  } catch (e) {
    toast(e.message === 'nopos' ? 'Could not get your location for the forecast.' : 'Could not load the weather. Check your connection.');
  }
  wxBusy = false;
  refresh();
}

// The odometer as a row of number drums, like the one on the bike.
function drums(odo) {
  const animate = firstPaint ? '' : ' style="animation:none"';
  if (odo == null) return Array.from({ length: 6 }, () => '<i class="dim"><span style="animation:none">–</span></i>').join('');
  const digits = String(Math.round(odo)).padStart(6, '0').split('');
  const firstReal = digits.findIndex((d) => d !== '0');
  return digits
    .map((d, i) => `<i class="${firstReal === -1 || i < firstReal ? 'dim' : ''}"><span${animate || ` style="animation-delay:${i * 60}ms"`}>${d}</span></i>`)
    .join('');
}

export async function render(el) {
  const [profile, odo, odoRec, fills, costs, rides, checklist, parked, attn, settings, sync] = await Promise.all([
    db.kvGet('profile', []), getOdo(), db.kvGet('odometer'), db.all('fuel'), allCosts(), db.all('rides'),
    db.kvGet('checklist', { items: [] }), currentSpot(), attention(), getSettings(), getSync(),
  ]);
  const val = (k) => profile.find((f) => f.key === k)?.value || '';
  const fs = fuelSummary(fills);
  const ym = today().slice(0, 7);
  const monthTotal = costs.filter((c) => c.date?.startsWith(ym)).reduce((a, c) => a + c.amount, 0);
  const budget = budgetStatus(monthTotal, settings.budget);
  const since = sinceLastFill(fills, rides);
  const tank = parseFloat(val('fuel_tank_capacity'));
  const range = fs.avg != null && tank > 0 ? fs.avg * tank : null;
  const checked = checklist.items.filter((i) => i.done).length;

  el.innerHTML = `
    <section class="hero">
      <div class="row" style="align-items:flex-start">
        <div>
          <div class="hero-make">${esc(val('manufacturer')).toUpperCase()}</div>
          <div class="hero-model">${esc(val('model')) || 'My motorcycle'}</div>
        </div>
        <a class="btn sm" href="#profile">Profile</a>
      </div>
      <button class="odo" data-act="odo" aria-label="Odometer${odo == null ? ' not set' : ` ${Math.round(odo)} kilometres`}. Tap to update.">
        <span class="odo-cells">${drums(odo)}</span><span class="odo-unit">km</span>
      </button>
      <div class="hero-sub">${
        odo == null
          ? 'Tap the odometer and type the reading from your meter.'
          : `The reading you last entered${odoRec?.value === odo && odoRec.date ? `, ${fmtDate(odoRec.date)}` : ''}. Tap to update.`
      }</div>
    </section>

    <nav class="quick" aria-label="Quick actions">
      <a href="#ride">${icon('gauge', 24)}Ride</a>
      <a href="#fuel">${icon('drop', 24)}Add fuel</a>
      <a href="#money">${icon('wallet', 24)}Expense</a>
      <a href="#parking">${icon('parking', 24)}${parked ? 'Find bike' : 'Park'}</a>
    </nav>

    ${sync.conflict ? `<div class="notice bad">Cloud sync needs a decision: this phone and the cloud copy both changed. <a href="#backup">Choose which to keep</a></div>` : ''}

    ${
      parked
        ? `<a class="notice park" href="#parking" style="display:block;color:inherit;text-decoration:none">
            <b>Parked ${fmtSpan(Date.now() - parked.time)} ago</b>
            <div class="muted small">${esc(parked.address || 'Location saved')}${parked.note ? `. ${esc(parked.note)}` : ''}. Since ${fmtTime(parked.time)}.</div>
          </a>`
        : ''
    }

    <div class="card">
      <div class="row head"><h2>Needs attention</h2><a class="small" href="#service">Garage</a></div>
      ${
        attn.items.length
          ? `<ul class="attn">${attn.items
              .map(
                (a) => `<li><a href="${a.href}"><span class="dot ${a.state}"></span><span class="grow"><b>${esc(a.title)}</b><br><span class="muted small">${esc(a.text)}</span></span>${icon('chevron', 18)}</a></li>`
              )
              .join('')}</ul>`
          : '<p>Nothing is due. Everything you are tracking is in order.</p>'
      }
      ${
        attn.needSetup
          ? `<p class="muted small">${attn.needSetup} maintenance reminder${attn.needSetup > 1 ? 's' : ''} still need${attn.needSetup > 1 ? '' : 's'} an interval from your owner's manual before ${attn.needSetup > 1 ? 'they' : 'it'} can warn you.</p>`
          : ''
      }
    </div>

    <div class="tiles">
      <a class="tile" href="#fuel">
        <div class="lbl">${icon('drop', 16)} Mileage</div>
        <span class="big">${fs.avg == null ? '—' : num(fs.avg, 1)}</span><span class="unit">km/l</span>
        <div class="sub">${fs.avg == null ? 'Shows after two full-tank fill-ups' : 'Worked out from your fill-ups'}</div>
      </a>
      <a class="tile" href="#money">
        <div class="lbl">${icon('wallet', 16)} This month</div>
        <span class="big">${money(monthTotal)}</span>
        ${budget ? `<div class="bar ${budget.state}"><i style="width:${Math.min(100, Math.round(budget.pct * 100))}%"></i></div><div class="sub">${esc(budget.text)}</div>` : '<div class="sub">Fuel, service and other costs</div>'}
      </a>
      <a class="tile" href="#fuel">
        <div class="lbl">${icon('route', 16)} Since last fill-up</div>
        <span class="big">${since ? num(since.km, 1) : '—'}</span><span class="unit">km</span>
        <div class="sub">${
          since
            ? `GPS distance on tracked rides${range ? `. A full tank lasts about ${num(range)} km at your average.` : ''}`
            : 'Add a fill-up to start counting'
        }</div>
      </a>
      <a class="tile" href="#checklist">
        <div class="lbl">${icon('check', 16)} Pre-ride check</div>
        <span class="big">${checked}/${checklist.items.length}</span>
        <div class="sub">${checked === checklist.items.length && checked ? 'All checked' : 'Tap to run through it'}</div>
      </a>
    </div>

    <div class="card">
      <div class="row head"><h2>Weather where you are</h2><button class="btn sm" data-act="weather" ${wxBusy ? 'disabled' : ''}>${wxBusy ? 'Loading…' : wx ? 'Refresh' : 'Check'}</button></div>
      ${
        wx
          ? `<div><span class="big">${num(wx.temp)}</span><span class="unit">°C</span></div>
             <p>${esc(weatherText(wx.symbol))}</p>
             ${meta([`wind ${num(wx.wind)} km/h`, wx.rain != null ? `${num(wx.rain, 1)} mm rain expected in the next 6 hours` : ''])}
             <p class="muted small">Forecast from MET Norway, checked at ${fmtTime(wx.time)}.</p>`
          : '<p class="muted small">Check before you set off. Uses your approximate location.</p>'
      }
    </div>
  `;
  firstPaint = false;

  el.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'weather') loadWeather();
    if (act === 'odo') {
      openForm({
        title: 'Update odometer',
        note: "Type the reading shown on the bike's meter.",
        fields: [{ name: 'value', label: 'Odometer (km)', type: 'number', required: true }],
        values: { value: odo ?? '' },
        onSave: (v) => setOdo(v.value),
      });
    }
  };
}
