// Copies the web app (the repo root) into native/www for Capacitor.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// The native bridge only provides a bare window.Capacitor; registerPlugin and the rest come from
// @capacitor/core. The web app has no bundler, so load core's browser build before the app.
cpSync(join(here, 'node_modules/@capacitor/core/dist/capacitor.js'), join(out, 'vendor/capacitor.js'));
const indexPath = join(out, 'index.html');
const html = readFileSync(indexPath, 'utf8');
const appScript = '<script type="module" src="js/app.js"></script>';
if (!html.includes(appScript)) throw new Error('index.html: app script tag not found');
writeFileSync(indexPath, html.replace(appScript, `<script src="vendor/capacitor.js"></script>\n  ${appScript}`));

console.log('Copied web app to', out);
