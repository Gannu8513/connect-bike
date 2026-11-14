// Builds the PDF service report (for your own records or to hand to a buyer).
// Everything in it is what the owner entered; unverified entries are marked as such.
import { db } from './db.js';
import { odoReadings, fuelSummary, maintStatus, statusText, partStatus } from './data.js';
import { fmtDate, num, money, today, shareFile } from './ui.js';

async function loadJsPdf() {
  if (!window.jspdf) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/jspdf/jspdf.umd.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('pdf library'));
      document.head.append(s);
    });
  }
  return window.jspdf.jsPDF;
}

// The built-in PDF fonts only cover Western European characters.
const clean = (s) =>
  String(s ?? '')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF]/g, '?');

export async function serviceReport() {
  const JsPDF = await loadJsPdf();
  const [profile, readings, services, maint, parts, fills] = await Promise.all([
    db.kvGet('profile', []), odoReadings(), db.all('services'), db.all('maintenance'), db.all('parts'), db.all('fuel'),
  ]);
  const odo = readings.length ? Math.max(...readings.map((r) => r.value)) : null;
  const latest = readings.find((r) => r.value === odo);
  const val = (k) => profile.find((f) => f.key === k)?.value || '';

  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 16, MAXW = W - 2 * M;
  let y = 20;

  const room = (h) => { if (y + h > 280) { doc.addPage(); y = 20; } };
  const text = (str, { size = 10, bold = false, color = 30, indent = 0, gap = 1.6 } = {}) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(color);
    const lines = doc.splitTextToSize(clean(str), MAXW - indent);
    const lh = size * 0.42;
    for (const line of lines) { room(lh); doc.text(line, M + indent, y); y += lh; }
    y += gap;
  };
  const heading = (str) => {
    y += 3; room(12);
    text(str, { size: 13, bold: true, gap: 1 });
    doc.setDrawColor(200); doc.line(M, y, W - M, y); y += 5;
  };

  text(`${val('manufacturer')} ${val('model')}`.trim() || 'Motorcycle', { size: 20, bold: true, gap: 1 });
  text('Service and ownership report', { size: 12, color: 90, gap: 1 });
  text(`Generated ${fmtDate(today())} from the owner's own records.`, { size: 9, color: 120, gap: 2 });

  heading('Motorcycle');
  for (const f of profile) {
    if (f.value) text(`${f.label}: ${f.value}${f.verified ? '' : '  (unverified)'}`);
  }
  text(`Odometer: ${odo == null ? 'not recorded' : `${num(odo)} km, entered by the owner${latest?.date ? ' on ' + fmtDate(latest.date) : ''}`}`, { bold: true });

  heading('Service history');
  const history = [...services].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.odo || 0) - (b.odo || 0));
  if (!history.length) text('No service records.');
  for (const s of history) {
    room(14);
    text(`${s.title}${s.verified ? '' : '  (unverified)'}`, { bold: true, gap: 0.6 });
    text(`${fmtDate(s.date)}   |   ${s.odo != null ? num(s.odo) + ' km' : s.odoText || 'odometer not recorded'}${s.cost ? '   |   ' + money(s.cost) : ''}`, { size: 9, color: 90, gap: 0.6 });
    if (s.work) text(`Work: ${s.work.replace(/\n/g, '; ')}`, { indent: 3, gap: 0.6 });
    if (s.parts) text(`Parts and fluids: ${s.parts.replace(/\n/g, '; ')}`, { indent: 3, gap: 0.6 });
    if (s.notes) text(`Notes: ${s.notes.replace(/\n/g, '; ')}`, { indent: 3, gap: 0.6 });
    y += 2;
  }

  heading('Maintenance schedule');
  const active = maint.filter((m) => m.intervalKm || m.intervalDays);
  if (!active.length) text('No maintenance intervals have been set.');
  for (const m of active) {
    const every = [m.intervalKm ? `every ${num(m.intervalKm)} km` : '', m.intervalDays ? `every ${num(m.intervalDays)} days` : ''].filter(Boolean).join(' or ');
    const last = [m.lastOdo != null ? `${num(m.lastOdo)} km` : '', m.lastDate ? fmtDate(m.lastDate) : ''].filter(Boolean).join(', ');
    text(`${m.name}: ${every}. Last done: ${last || 'not recorded'}. Status: ${statusText(maintStatus(m, odo))}.`);
  }

  heading('Parts fitted');
  const fitted = parts.filter((p) => !p.retired && (p.installedDate || p.installedOdo != null || p.brand));
  if (!fitted.length) text('No part details have been recorded.');
  for (const p of fitted) {
    const s = partStatus(p, odo);
    const when = [p.installedDate ? fmtDate(p.installedDate) : '', p.installedOdo != null ? `at ${num(p.installedOdo)} km` : ''].filter(Boolean).join(' ');
    text(`${p.name}${p.brand ? ` (${p.brand})` : ''}: fitted ${when || 'date not recorded'}${s.kmUsed != null ? `, ${num(s.kmUsed)} km in use` : ''}.`);
  }
  for (const p of parts.filter((x) => x.retired)) {
    text(`${p.name}${p.brand ? ` (${p.brand})` : ''}: replaced ${p.removedDate ? fmtDate(p.removedDate) : ''}${
      p.removedOdo != null && p.installedOdo != null ? ` after ${num(p.removedOdo - p.installedOdo)} km` : ''
    }.`, { color: 90 });
  }

  heading('Fuel');
  const fs = fuelSummary(fills);
  text(`${fills.length} fill-up${fills.length === 1 ? '' : 's'} recorded, ${num(fs.litres, 1)} litres in total.`);
  if (fs.avg != null) text(`Average mileage: ${num(fs.avg, 1)} km/l, calculated from odometer readings between full-tank fill-ups.`);

  y += 4;
  text('This report lists what the owner recorded in the Bike Companion app. Entries marked "unverified" have not been confirmed against a bill or service record. No figures were read from the motorcycle itself.', { size: 8.5, color: 120 });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(140);
    doc.text(`Page ${i} of ${pages}`, W - M, 290, { align: 'right' });
  }

  await shareFile(`service-report-${today()}.pdf`, doc.output('arraybuffer'), 'application/pdf');
}
