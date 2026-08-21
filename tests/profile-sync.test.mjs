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
const syncSource = read('js/sync.js');
const helperSource = [
  `import { isSafeImageDataUrl } from ${JSON.stringify(new URL('../js/profile-avatar.js', import.meta.url).href)};`,
  syncSource.slice(syncSource.indexOf('export function mergeProfileFromCloud')).split('\n\n')[0],
].join('\n');
const { mergeProfileFromCloud } = await import(`data:text/javascript,${encodeURIComponent(helperSource)}`);

const PHOTO = 'data:image/webp;base64,AAAA';
const OTHER_PHOTO = 'data:image/webp;base64,BBBB';

test('a photo chosen on another device replaces what this one is showing', () => {
  // The whole point of syncing: sign in anywhere and the same avatar follows.
  const merged = mergeProfileFromCloud(
    { display_name: 'Việt', avatar_type: 'upload', avatar_data: OTHER_PHOTO },
    { name: 'Việt', avatarType: 'upload', avatarData: PHOTO }
  );
  assert.equal(normalizeProfile(merged).avatarData, OTHER_PHOTO);
});

test('a device that has never seen the photo now receives it', () => {
  const merged = mergeProfileFromCloud(
    { display_name: 'Việt', avatar_type: 'upload', avatar_data: PHOTO },
    { name: 'Việt', avatarType: 'preset', avatarData: 'rabbit' }
  );
  assert.deepEqual(normalizeProfile(merged), { name: 'Việt', avatarType: 'upload', avatarData: PHOTO });
});

test('a row that says upload but carries no bytes cannot wipe the fresh photo', () => {
  // saveProfile writes locally and pushProfile lands a moment later; a pull
  // racing through that window used to snap the picture back to the pet.
  const merged = mergeProfileFromCloud(
    { display_name: 'Việt', avatar_type: 'upload', avatar_data: null },
    { name: 'Việt', avatarType: 'upload', avatarData: PHOTO }
  );
  assert.equal(normalizeProfile(merged).avatarData, PHOTO);
});

test('switching to a preset elsewhere still propagates here', () => {
  const merged = mergeProfileFromCloud(
    { display_name: 'Việt', avatar_type: 'preset', avatar_data: 'rabbit' },
    { name: 'Việt', avatarType: 'upload', avatarData: PHOTO }
  );
  assert.deepEqual(normalizeProfile(merged), { name: 'Việt', avatarType: 'preset', avatarData: 'rabbit' });
});

test('the photo actually reaches the row, within a bounded size', () => {
  // Previously only preset ids were forwarded, so every account looked like a
  // fox to everyone else no matter what picture its owner had chosen.
  assert.match(syncSource, /avatarType === 'upload' && isSafeImageDataUrl\(avatarData\) && avatarData\.length <= AVATAR_DATA_MAX/);
  assert.match(syncSource, /export const AVATAR_DATA_MAX = 200_000;/);

  const schema = read('supabase/schema.sql');
  assert.match(schema, /check \(char_length\(avatar_data\) <= 200000\)/);
  // The board is what shows one learner's avatar to another.
  assert.doesNotMatch(schema, /case when up\.avatar_type = 'upload' then null/);
});

test('the profile dialog no longer promises the photo stays on the device', () => {
  const profile = read('js/profile.js');
  assert.doesNotMatch(profile, /không bao giờ được tải lên|chỉ lưu trên thiết bị này/);
  assert.match(profile, /đồng bộ với tài khoản/);
});
