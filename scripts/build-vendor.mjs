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

await build({
  entryPoints: [path.join(root, 'js', 'pet-scene.js')],
  outfile: path.join(root, 'vendor', 'pet-scene.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  target: ['es2022'],
  legalComments: 'none',
  treeShaking: true,
});

const petSceneOutputPath = path.join(root, 'vendor', 'pet-scene.js');
stripTrailingWhitespace(petSceneOutputPath);

console.log('Built vendor/supabase.js and vendor/pet-scene.js');
