import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeProfile } from '../js/profile-avatar.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// js/sync.js pulls in the Supabase client at import time, so load the pure
// helper on its own rather than standing up a browser environment for it.
const { mergeProfileFromCloud } = await import(
  `data:text/javascript,${encodeURIComponent(
    read('js/sync.js').slice(read('js/sync.js').indexOf('export function mergeProfileFromCloud'))
      .split('\n/**')[0]
  )}`
);

const PHOTO = 'data:image/webp;base64,AAAA';

test('a cloud pull cannot replace this device\u2019s uploaded photo with a preset', () => {
  // The server only ever stores that the learner picked an upload — the bytes
  // stay local — so the row it sends back must not overwrite the real image.
  const merged = mergeProfileFromCloud(
    { display_name: 'Việt', avatar_type: 'upload', avatar_data: null },
    { name: 'Việt', avatarType: 'upload', avatarData: PHOTO }
  );
  assert.deepEqual(merged, { name: 'Việt', avatarType: 'upload', avatarData: PHOTO });
  assert.equal(normalizeProfile(merged).avatarData, PHOTO);
});

test('a stale preset row cannot undo an upload the push has not landed yet', () => {
  // saveProfile writes locally and pushProfile fires afterwards; a pull racing
  // in between still sees the old preset row.
  const merged = mergeProfileFromCloud(
    { display_name: 'Việt', avatar_type: 'preset', avatar_data: 'fox' },
    { name: 'Việt', avatarType: 'upload', avatarData: PHOTO }
  );
  assert.equal(normalizeProfile(merged).avatarType, 'upload');
  assert.equal(normalizeProfile(merged).avatarData, PHOTO);
});

test('preset avatars still follow the server so a second device stays in sync', () => {
  const merged = mergeProfileFromCloud(
    { display_name: 'Việt', avatar_type: 'preset', avatar_data: 'rabbit' },
    { name: 'Việt', avatarType: 'preset', avatarData: 'fox' }
  );
  assert.deepEqual(normalizeProfile(merged), { name: 'Việt', avatarType: 'preset', avatarData: 'rabbit' });
});

test('a device without the photo falls back to a preset instead of a broken image', () => {
  const merged = mergeProfileFromCloud(
    { display_name: 'Việt', avatar_type: 'upload', avatar_data: null },
    { name: 'Việt', avatarType: 'preset', avatarData: 'rabbit' }
  );
  assert.equal(normalizeProfile(merged).avatarType, 'preset');
});
