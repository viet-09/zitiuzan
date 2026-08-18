import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Three.js pet scene uses GLB, PBR lighting, soft shadows and delta-time interpolation', () => {
  const sourcePath = path.join(root, 'js', 'pet-scene.js');
  assert.ok(fs.existsSync(sourcePath), 'js/pet-scene.js must provide the WebGL scene');
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /GLTFLoader/);
  assert.match(source, /new WebGLRenderer\(\{[\s\S]*alpha:\s*true/);
  assert.match(source, /ACESFilmicToneMapping/);
  assert.match(source, /VSMShadowMap/);
  assert.doesNotMatch(source, /PCFSoftShadowMap/);
  assert.match(source, /new AmbientLight/);
  assert.match(source, /new HemisphereLight/);
  assert.match(source, /new DirectionalLight/);
  assert.match(source, /shadowMap\.enabled\s*=\s*true/);
  assert.match(source, /castShadow\s*=\s*true/);
  assert.match(source, /setClearColor\([^,]+,\s*0\)/);
  assert.match(source, /new Timer/);
  assert.match(source, /getDelta\(\)/);
  assert.match(source, /\.lerp\(/);
  assert.match(source, /\.slerp\(/);
  assert.match(source, /new ResizeObserver/);
  assert.match(source, /devicePixelRatio[\s\S]*2/);
});

test('fox and rabbit ship as real binary GLB assets and the scene bundle is built locally', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies?.three, '0.185.1');
  assert.match(read('scripts/build-vendor.mjs'), /pet-scene\.js/);
  assert.ok(fs.existsSync(path.join(root, 'vendor', 'pet-scene.js')));

  for (const type of ['fox', 'rabbit']) {
    const modelPath = path.join(root, 'assets', 'pets', `${type}-mascot.glb`);
    assert.ok(fs.existsSync(modelPath), `${type} GLB must exist`);
    const model = fs.readFileSync(modelPath);
    assert.equal(model.subarray(0, 4).toString('utf8'), 'glTF');
    assert.ok(model.byteLength > 20_000, `${type} GLB must contain modeled geometry`);
  }
});
