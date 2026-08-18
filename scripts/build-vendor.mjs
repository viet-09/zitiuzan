import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  stdin: {
    contents: "export { createClient } from '@supabase/supabase-js';",
    resolveDir: root,
    sourcefile: 'supabase-entry.js',
  },
  outfile: path.join(root, 'vendor', 'supabase.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  target: ['es2022'],
  legalComments: 'none',
});

console.log('Built vendor/supabase.js');
