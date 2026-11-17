// Copies the web app (the repo root) into native/www for Capacitor.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'www');

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const item of ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'vendor', 'icons']) {
  cpSync(join(root, item), join(out, item), { recursive: true });
}
console.log('Copied web app to', out);
