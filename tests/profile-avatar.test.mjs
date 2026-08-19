import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AVATAR_OUTPUT_SIZE,
  DEFAULT_PROFILE,
  PROFILE_PRESETS,
  calculateCoverCrop,
  normalizeProfile,
  renderAvatar,
} from '../js/profile.js';

test('profile presets are the same fox and rabbit used by the study pet', () => {
  assert.deepEqual(PROFILE_PRESETS.map(({ id }) => id), ['fox', 'rabbit']);
  assert.equal(DEFAULT_PROFILE.avatarData, 'fox');
  assert.equal(normalizeProfile({ avatarType: 'preset', avatarData: 'kitsune' }).avatarData, 'fox');
  assert.equal(normalizeProfile({ avatarType: 'preset', avatarData: 'usagi' }).avatarData, 'rabbit');

  const fox = renderAvatar({ avatarType: 'preset', avatarData: 'fox' });
  const rabbit = renderAvatar({ avatarType: 'preset', avatarData: 'rabbit' });
  assert.match(fox, /profile-avatar--fox/u);
  assert.match(fox, /profile-avatar__pet/u);
  assert.match(rabbit, /profile-avatar--rabbit/u);
  assert.doesNotMatch(`${fox}${rabbit}`, /🐱|🦊|🐰|🌸/u);
});

test('oversized avatar sources are center-cropped to a compact square output', () => {
  assert.equal(AVATAR_OUTPUT_SIZE, 256);
  assert.deepEqual(calculateCoverCrop(4000, 2000), {
    sourceX: 1000,
    sourceY: 0,
    sourceSize: 2000,
  });
  assert.deepEqual(calculateCoverCrop(1200, 2400), {
    sourceX: 0,
    sourceY: 600,
    sourceSize: 1200,
  });
});
