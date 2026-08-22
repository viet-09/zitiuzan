// Sino-Vietnamese (âm Hán Việt) readings for the kanji the curriculum teaches.
//
// Built by scripts/build-kanji-hanviet.mjs, which only ships a reading two
// independent sources agree on — see that script for why Unihan alone was not
// enough. Characters nobody could agree on are simply absent, so callers must
// cope with a miss rather than expect full coverage.
//
// Loaded lazily: 24 KB is small, but only the kanji pages ever need it.

let readingsPromise = null;
let readings = null;

export function loadHanViet() {
  if (!readingsPromise) {
    readingsPromise = fetch('data/kanji-hanviet.json')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        readings = data?.readings && typeof data.readings === 'object' ? data.readings : {};
        return readings;
      })
      .catch(() => {
        readings = {};
        return readings;
      });
  }
  return readingsPromise;
}

/**
 * The reading for one character, or '' when none was confirmed.
 * Synchronous: returns '' until loadHanViet() has resolved.
 * @param {string} character
 */
export function hanVietOf(character) {
  const key = [...String(character || '')][0] || '';
  return (readings && readings[key]) || '';
}

/** Title-case for display next to the character, e.g. "Cấm". */
export function formatHanViet(reading) {
  const value = String(reading || '').trim();
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}
