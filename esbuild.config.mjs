import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = join(__dirname, 'packages', 'adapter-apps-script');
const OUT_DIR = join(ADAPTER_DIR, 'dist');

mkdirSync(OUT_DIR, { recursive: true });

await build({
  entryPoints: [join(ADAPTER_DIR, 'src', 'main.ts')],
  bundle: true,
  outfile: join(OUT_DIR, 'Code.js'),
  format: 'iife',
  target: 'es2019',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  logLevel: 'info',
});

copyFileSync(join(ADAPTER_DIR, 'appsscript.json'), join(OUT_DIR, 'appsscript.json'));

console.log(`Bundled to ${join(OUT_DIR, 'Code.js')}`);
