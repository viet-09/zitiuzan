// js/furigana.js
// Furigana + underlined-word markup renderer, plus the furigana on/off toggle.
// Markup conventions:
//   {漢字|かんじ} -> <ruby>漢字<rt>かんじ</rt></ruby>
//   《下旬》      -> <u>下旬</u>  (JLPT 問題1 "reading of the underlined word"
//                    questions — the underline is the only way to tell which
//                    word the question is actually about; see
//                    scripts/fix_underlined_words.py for how these markers
//                    get added to exam data)
// Plain text passes through untouched (aside from HTML-escaping). "\n" becomes <br>.

import { getSettings, setSettings } from './store.js';

const FURIGANA_OFF_CLASS = 'furigana-off';

// Matches {base|reading} (base/reading may not contain '{', '}' or '|') OR
// 《underlined word》 (word may not contain '《'/'》') — whichever appears
// first wins at each position, same combined left-to-right scan.
const MARKUP_PATTERN = /\{([^{}|]+)\|([^{}|]+)\}|《([^《》]+)》/g;
const NEWLINE_PATTERN = /\r\n|\r|\n/g;
const KANJI_RE = /[一-龥㐀-䶿々]/u;
const KANA_RE = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
const LEGACY_RUBY_PATTERN = /<ruby>([^<>]+)<rt>([^<>]+)<\/rt><\/ruby>/giu;

/**
 * Escape a string for safe insertion as HTML text content.
 * @param {*} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function kanaCharacters(value) {
  return [...String(value)].filter((character) => {
    const code = character.codePointAt(0);
    return (code >= 0x30A1 && code <= 0x30F6)
      || (code >= 0x3041 && code <= 0x3096)
      || character === 'ー';
  }).join('');
}

function kanaAlignmentKey(value) {
  return [...kanaCharacters(value)].map((character) => {
    const code = character.codePointAt(0);
    return code >= 0x30A1 && code <= 0x30F6 ? String.fromCodePoint(code - 0x60) : character;
  }).join('');
}

/**
 * Align a full-word reading with individual kanji runs so each reading sits
 * directly over the characters it belongs to. Space-delimited reading lists
 * (common in scanned notes) are mapped one token per kanji run.
 */
export function buildFuriganaMarkup(wordValue, readingValue) {
  const word = String(wordValue ?? '');
  const reading = String(readingValue ?? '').trim();
  if (!reading || reading === word) return word;

  const segments = [];
  for (let index = 0; index < word.length;) {
    const isKanji = KANJI_RE.test(word[index]);
    let end = index + 1;
    while (end < word.length && KANJI_RE.test(word[end]) === isKanji) end += 1;
    segments.push({ text: word.slice(index, end), isKanji });
    index = end;
  }
  const kanjiSegments = segments.filter((segment) => segment.isKanji);
  if (kanjiSegments.length === 0) return word;

  const tokens = reading.split(/\s+/u).filter(Boolean);
  if (tokens.length === kanjiSegments.length && tokens.every((token) => KANA_RE.test(token))) {
    let tokenIndex = 0;
    return segments.map((segment) => {
      if (!segment.isKanji) return segment.text;
      const token = tokens[tokenIndex];
      tokenIndex += 1;
      return `{${segment.text}|${token}}`;
    }).join('');
  }

  const alignedReading = kanaAlignmentKey(reading);
  const displayReading = kanaCharacters(reading);
  if (segments.length === 1) return `{${word}|${reading}}`;
  const fallback = `{${word}|${reading}}`;
  let readingPosition = 0;
  let output = '';

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment.isKanji) {
      const anchor = kanaAlignmentKey(segment.text);
      if (anchor && !alignedReading.startsWith(anchor, readingPosition)) return fallback;
      output += segment.text;
      readingPosition += anchor.length;
      continue;
    }

    const nextAnchor = segments.slice(index + 1)
      .filter((candidate) => !candidate.isKanji)
      .map((candidate) => kanaAlignmentKey(candidate.text))
      .find(Boolean);
    const end = nextAnchor
      ? alignedReading.indexOf(nextAnchor, readingPosition)
      : alignedReading.length;
    if (end < readingPosition) return fallback;
    const rubyReading = displayReading.slice(readingPosition, end);
    output += rubyReading ? `{${segment.text}|${rubyReading}}` : segment.text;
    readingPosition = end;
  }

  return readingPosition === alignedReading.length ? output : fallback;
}

/**
 * Render furigana markup into trusted HTML.
 * `{base|reading}` becomes `<ruby>base<rt>reading</rt></ruby>` (base & reading escaped).
 * Any text outside the markup is HTML-escaped and passes through as-is.
 * Newlines become `<br>`.
 * @param {string|null|undefined} text
 * @returns {string} trusted HTML string
 */
export function renderFurigana(text) {
  if (text == null) return '';
  // Import data once contained literal ruby tags. Accept only this exact,
  // text-only legacy form; every other HTML tag remains escaped below.
  const str = String(text).replace(LEGACY_RUBY_PATTERN, '{$1|$2}');

  let html = '';
  let lastIndex = 0;
  let match;

  MARKUP_PATTERN.lastIndex = 0;
  while ((match = MARKUP_PATTERN.exec(str)) !== null) {
    const plain = str.slice(lastIndex, match.index);
    html += escapeHtml(plain);

    const [, base, reading, underlined] = match;
    html += base !== undefined
      ? `<ruby>${escapeHtml(base)}<rt>${escapeHtml(reading)}</rt></ruby>`
      : `<u>${escapeHtml(underlined)}</u>`;

    lastIndex = match.index + match[0].length;
  }
  html += escapeHtml(str.slice(lastIndex));

  return html.replace(NEWLINE_PATTERN, '<br>');
}

/**
 * Apply (or remove) the body-level furigana-off class.
 * @param {boolean} isOn
 */
function applyFuriganaClass(isOn) {
  if (typeof document === 'undefined' || !document.body) return;
  document.body.classList.toggle(FURIGANA_OFF_CLASS, !isOn);
}

/**
 * Read the persisted furigana setting and apply the body class accordingly.
 * Does not create any toggle button — callers own their own UI.
 */
export function initFuriganaToggle() {
  const { furigana } = getSettings();
  applyFuriganaClass(!!furigana);
}

/**
 * Turn furigana rendering on/off globally: toggles body.furigana-off and persists the choice.
 * @param {boolean} on
 */
export function setFurigana(on) {
  const isOn = !!on;
  applyFuriganaClass(isOn);
  setSettings({ furigana: isOn });
}

/**
 * @returns {boolean} current furigana setting
 */
export function getFurigana() {
  return !!getSettings().furigana;
}
