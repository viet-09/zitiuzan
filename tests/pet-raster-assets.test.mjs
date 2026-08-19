import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('fox and rabbit use transparent RGBA concept sprite sheets', () => {
  for (const name of ['fox-sprites.png', 'rabbit-sprites.png']) {
    const asset = fs.readFileSync(path.join(root, 'assets', 'pets', name));
    assert.deepEqual([...asset.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(asset.readUInt32BE(16), 1536);
    assert.equal(asset.readUInt32BE(20), 1024);
    assert.equal(asset[25], 6, `${name} must be RGBA, not a baked checkerboard RGB image`);
  }
});
