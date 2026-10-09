import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = join(__dirname, 'packages', 'adapter-apps-script');
const OUT_DIR = join(ADAPTER_DIR, 'dist');
const MAIN_TS = join(ADAPTER_DIR, 'src', 'main.ts');

// esbuild's IIFE only assigns these as properties of GLOBAL_NAME at
// runtime — Apps Script's editor dropdown and time-driven triggers need
// real top-level `function name() {}` declarations in the file, which the
// footer below provides. Only entry points main.ts actually exports get a
// wrapper, so removing one here doesn't need a matching edit there.
const GLOBAL_NAME = '__turoSync';
const CANDIDATE_ENTRY_POINTS = ['runSync', 'runBackfill', 'installTrigger', 'preflight', 'resetCalendarEvents'];

const mainSource = readFileSync(MAIN_TS, 'utf-8');
const entryPoints = CANDIDATE_ENTRY_POINTS.filter((name) =>
  new RegExp(`export function ${name}\\b`).test(mainSource),
);

const footer = entryPoints.map((name) => `function ${name}() { return ${GLOBAL_NAME}.${name}(); }`).join('\n');

mkdirSync(OUT_DIR, { recursive: true });

await build({
  entryPoints: [MAIN_TS],
  bundle: true,
  outfile: join(OUT_DIR, 'Code.js'),
  format: 'iife',
  globalName: GLOBAL_NAME,
  footer: { js: footer },
  target: 'es2019',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  logLevel: 'info',
});

copyFileSync(join(ADAPTER_DIR, 'appsscript.json'), join(OUT_DIR, 'appsscript.json'));

console.log(`Bundled to ${join(OUT_DIR, 'Code.js')} with entry points: ${entryPoints.join(', ')}`);
