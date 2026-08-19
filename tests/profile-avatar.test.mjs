import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AVATAR_OUTPUT_SIZE,
  DEFAULT_PROFILE,
  PROFILE_PRESETS,
  calculateCoverCrop,
  normalizeProfile,
  renderAvatar,
} from '../js/profile-avatar.js';

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

test('uploaded avatar data and profile text are normalized at the markup boundary', () => {
  const dataUrl = 'data:image/webp;base64,AAAA';
  const normalized = normalizeProfile({
    name: '  An\u0000   <b>  ',
    avatarType: 'upload',
    avatarData: dataUrl,
  });
  assert.deepEqual(normalized, { name: 'An <b>', avatarType: 'upload', avatarData: dataUrl });
  const markup = renderAvatar(normalized, { decorative: false, className: 'account ok<script>', alt: 'Bạn <3' });
  assert.match(markup, /profile-avatar--upload/u);
  assert.match(markup, /class="profile-avatar account okscript profile-avatar--upload"/u);
  assert.match(markup, /alt="Bạn &lt;3"/u);
  assert.doesNotMatch(markup, /<script>/u);

  assert.deepEqual(normalizeProfile({ avatarType: 'upload', avatarData: 'data:image/svg+xml;base64,AAAA' }), {
    name: '', avatarType: 'preset', avatarData: 'fox',
  });
});
