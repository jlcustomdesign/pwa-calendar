// Verifică derivarea financiară (src/lib/finance.ts) fără browser/Supabase.
// Rulează: node scripts/finance-check.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '..', 'node_modules', '.cache', 'finance-check.mjs');

await build({
  entryPoints: [path.join(here, '..', 'src', 'lib', 'finance.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  logLevel: 'silent',
});

const { demo } = await import(outfile);
console.log(demo());
