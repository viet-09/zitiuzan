// Rebuilds assets/pets/<pet>-motion-atlas.png from the hand-drawn concept
// sheets. Run after touching the concept art: `npm run build:pets`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePNG } from './lib/png.mjs';
import { buildPetAtlas, PET_SOURCE_LAYOUT } from './lib/pet-sprite-slicer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const [pet, layout] of Object.entries(PET_SOURCE_LAYOUT)) {
  const source = path.join(root, 'assets', 'pets', `${pet}-motion-sprites.png`);
  const target = path.join(root, 'assets', 'pets', `${pet}-motion-atlas.png`);
  const { atlas, cellWidth, cellHeight } = buildPetAtlas(source, layout);
  fs.writeFileSync(target, encodePNG(atlas));
  console.log(`${pet}: ${atlas.width}x${atlas.height} atlas, cell ${cellWidth}x${cellHeight}`);
}
