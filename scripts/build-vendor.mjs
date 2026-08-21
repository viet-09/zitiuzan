import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function stripTrailingWhitespace(outputPath) {
  const output = fs.readFileSync(outputPath, 'utf8');
  fs.writeFileSync(outputPath, output.replace(/[ \t]+$/gm, ''), 'utf8');
}

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

const supabaseOutputPath = path.join(root, 'vendor', 'supabase.js');
stripTrailingWhitespace(supabaseOutputPath);

console.log('Built vendor/supabase.js');
