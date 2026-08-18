export const GUEST_MODE_KEY = 'n2_guest_mode_v1';

export function createGuestPreference(storage = globalThis.localStorage) {
  return {
    isEnabled() {
      try { return storage?.getItem(GUEST_MODE_KEY) === '1'; } catch { return false; }
    },
    enable() {
      try { storage?.setItem(GUEST_MODE_KEY, '1'); } catch { /* best effort */ }
    },
    disable() {
      try { storage?.removeItem(GUEST_MODE_KEY); } catch { /* best effort */ }
    },
  };
}

export const guestPreference = createGuestPreference();
