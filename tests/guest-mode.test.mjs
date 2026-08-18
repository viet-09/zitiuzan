import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeStorage } from './helpers/fake-storage.mjs';
import { createGuestPreference, GUEST_MODE_KEY } from '../js/guest-mode.js';

test('guest choice is explicit, persistent and reversible', () => {
  const storage = createFakeStorage();
  const guest = createGuestPreference(storage);
  assert.equal(guest.isEnabled(), false);
  guest.enable();
  assert.equal(guest.isEnabled(), true);
  assert.equal(storage.getItem(GUEST_MODE_KEY), '1');
  guest.disable();
  assert.equal(guest.isEnabled(), false);
  assert.equal(storage.getItem(GUEST_MODE_KEY), null);
});
