import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('no permanent tick is pinned to the companion after a completion', () => {
  // A ✓ badge sat on the sprite from the moment the pet outgrew "hatchling"
  // and nothing ever hid it, so finishing a lesson looked like feedback that
  // had got stuck on. The evolution stage is named in the coach panel instead.
  const art = read('js/pet-art.js');
  const css = read('css/styles.css');

  assert.doesNotMatch(art, /evolution-mark/);
  assert.doesNotMatch(art, /[✓✔☑]/);
  assert.doesNotMatch(css, /evolution-mark/);
  assert.doesNotMatch(css, /pet--evolution-(hatchling|companion)/);
});

test('reaction and bubble timers clear whatever node is mounted now', () => {
  const pet = read('js/pet.js');

  // render() replaces the widget's markup wholesale, so a node captured when a
  // message was shown can already be detached by the time its timer fires —
  // clearing the class on that orphan would leave the live bubble up for good.
  assert.match(pet, /function hideBubble\(\)/);
  assert.match(pet, /mount\.querySelector\('\.pet-widget__bubble'\)\?\.classList\.remove\('is-visible'\)/);
  assert.match(pet, /mount\.querySelector\('\.pet-widget'\)\?\.setAttribute\('data-reaction', ''\)/);

  // …and render() drops both pending timers, since their targets are gone.
  const render = /function render\(\) \{[\s\S]*?const loadToken/.exec(pet)?.[0] ?? '';
  assert.match(render, /clearTimeout\(statusTimer\)/);
  assert.match(render, /clearTimeout\(reactionTimer\)/);
});
