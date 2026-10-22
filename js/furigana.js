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

// "(な)", "（の）", "(口・目・本を)" — the bracketed part of a headword is an
// annotation for the learner ("this takes な", "these are the objects"), not
// something that is read aloud.
const ANNOTATION_PATTERN = /[（(][^（()）]*[)）]/gu;

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

function kindOf(character) {
  if (KANJI_RE.test(character)) return 'kanji';
  if (KANA_RE.test(character)) return 'kana';
  return 'other';
}

/**
 * Split a headword into runs of kanji, kana and everything else, flagging the
 * ones that sit inside a bracketed annotation.
 *
 *   "(口・目・本を)閉じる" -> other "(口・目・本を)" / kanji "閉じる"
 *
 * @param {string} text
 * @returns {{text:string, kind:string, annotated:boolean}[]}
 */
function splitRuns(text) {
  const characters = [];
  let depth = 0;
  for (const character of text) {
    let annotated = depth > 0;
    if (character === '(' || character === '（') {
      depth += 1;
      annotated = true;
    } else if (character === ')' || character === '）') {
      depth = Math.max(0, depth - 1);
      annotated = depth > 0;
    }
    characters.push({ character, kind: kindOf(character), annotated });
  }

  const runs = [];
  for (const entry of characters) {
    const last = runs[runs.length - 1];
    if (last && last.kind === entry.kind && last.annotated === entry.annotated) {
      last.text += entry.character;
    } else {
      runs.push({ text: entry.character, kind: entry.kind, annotated: entry.annotated });
    }
  }
  return runs;
}

/**
 * Place a reading over the kanji runs of a headword.
 *
 * Kana runs are anchors: the reading spells them out, and the reading
 * between two anchors belongs to the kanji run between them. A headword whose
 * reading leaves its own okurigana out (贈り物 / おくもの, where the り is
 * missing) has no anchor to go by, so the reading is split between the kanji
 * runs in proportion to their size.
 *
 * The search is a small dynamic program over (slot, reading position). It
 * prefers the placement that matches the most kana anchors, then gives every
 * kanji a reading, then splits the reading most evenly.
 *
 * @param {{text:string, kind:string, annotated:boolean}[]} runs
 * @param {string} reading
 * @param {boolean} treatAnnotatedAsText  kanji inside a bracketed annotation
 *   is not read aloud, so it gets no ruby
 * @returns {string|null} the markup, or null when the reading cannot be placed
 */
function alignRuns(runs, reading, treatAnnotatedAsText) {
  const alignedReading = kanaAlignmentKey(reading);
  const displayReading = kanaCharacters(reading);
  if (!alignedReading) return null;

  const slots = runs.map((run) => {
    if (run.kind === 'kanji') {
      return treatAnnotatedAsText && run.annotated
        ? { type: 'text' }
        : { type: 'kanji', chars: [...run.text].length };
    }
    if (run.kind === 'kana') {
      return run.annotated
        ? { type: 'text' }
        : { type: 'anchor', anchor: kanaAlignmentKey(run.text) };
    }
    return { type: 'text' };
  });

  if (!slots.some((slot) => slot.type === 'kanji')) return null;

  // How much kana the kanji slots and the anchors after a given slot still
  // have to share, so the split can stay proportional instead of arbitrary.
  const remaining = [];
  let kanjiChars = 0;
  let anchorKana = 0;
  for (let index = slots.length - 1; index >= 0; index -= 1) {
    remaining[index] = { kanjiChars, anchorKana };
    const slot = slots[index];
    if (slot.type === 'kanji') kanjiChars += slot.chars;
    if (slot.type === 'anchor') anchorKana += slot.anchor.length;
  }

  const memo = new Map();
  const better = (a, b) => {
    if (!b) return true;
    if (a.matched !== b.matched) return a.matched > b.matched;
    if (a.filled !== b.filled) return a.filled > b.filled;
    return a.deviation < b.deviation;
  };

  const solve = (slotIndex, position) => {
    if (slotIndex >= slots.length) {
      return position === alignedReading.length
        ? { matched: 0, deviation: 0, filled: 0, lengths: [], anchors: [] }
        : null;
    }
    const key = `${slotIndex}:${position}`;
    if (memo.has(key)) return memo.get(key);

    let best = null;
    const slot = slots[slotIndex];

    if (slot.type === 'anchor') {
      if (alignedReading.startsWith(slot.anchor, position)) {
        const rest = solve(slotIndex + 1, position + slot.anchor.length);
        if (rest) {
          best = {
            matched: rest.matched + 1,
            deviation: rest.deviation,
            filled: rest.filled,
            lengths: [null, ...rest.lengths],
            anchors: [true, ...rest.anchors],
          };
        }
      }
      // The reading list does not spell this kana out (贈り物 / おくもの has no
      // り). The anchor is then just text and consumes nothing.
      const skipped = solve(slotIndex + 1, position);
      if (skipped && better(skipped, best)) {
        best = { ...skipped, lengths: [null, ...skipped.lengths], anchors: [false, ...skipped.anchors] };
      }
    } else if (slot.type === 'text') {
      const rest = solve(slotIndex + 1, position);
      if (rest) best = { ...rest, lengths: [null, ...rest.lengths], anchors: [false, ...rest.anchors] };
    } else {
      const available = alignedReading.length - position;
      const budget = Math.max(0, available - remaining[slotIndex].anchorKana);
      const kanjiTotal = remaining[slotIndex].kanjiChars + slot.chars;
      const perChar = kanjiTotal ? budget / kanjiTotal : 0;
      const preferred = Math.round(perChar * slot.chars);
      const options = [];
      for (let length = 0; length <= available; length += 1) options.push(length);
      options.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || b - a);

      for (const length of options) {
        const rest = solve(slotIndex + 1, position + length);
        if (!rest) continue;
        const candidate = {
          matched: rest.matched,
          deviation: rest.deviation + Math.abs(length - preferred),
          filled: rest.filled + (length > 0 ? slot.chars : 0),
          lengths: [length, ...rest.lengths],
          anchors: [false, ...rest.anchors],
        };
        if (better(candidate, best)) best = candidate;
      }
    }

    memo.set(key, best);
    return best;
  };

  const solution = solve(0, 0);
  if (!solution) return null;

  let slotIndex = 0;
  let position = 0;
  const output = [];
  for (const run of runs) {
    const slot = slots[slotIndex];
    slotIndex += 1;
    if (slot.type !== 'kanji') {
      if (slot.type === 'anchor' && solution.anchors[slotIndex - 1]) {
        position += slot.anchor.length;
      }
      output.push(run.text);
      continue;
    }
    const length = solution.lengths[slotIndex - 1] || 0;
    const rubyReading = displayReading.slice(position, position + length);
    position += length;
    output.push(rubyReading ? `{${run.text}|${rubyReading}}` : run.text);
  }
  return output.join('');
}

/**
 * Align a full-word reading with individual kanji runs so each reading sits
 * directly over the characters it belongs to.
 *
 *   {書|か}きます  — NOT  {書|かきます}きます, which would put "かきます"
 *                   over three kana that are already printed below.
 *
 * A reading that cannot be placed at all falls back to one ruby over the
 * whole word, which is still correct — just coarser.
 *
 * @param {string} wordValue
 * @param {string} readingValue
 * @returns {string} furigana markup, or the bare word when unalignable
 */
export function buildFuriganaMarkup(wordValue, readingValue) {
  const word = String(wordValue ?? '');
  const reading = String(readingValue ?? '').trim();
  if (!reading || reading === word) return word;

  // A vocabulary headword often carries an example sentence on the next line,
  // and the reading list mirrors that shape. Align each line against its own
  // reading instead of trying to line up the whole block at once.
  const wordLines = word.split('\n');
  if (wordLines.length > 1) {
    const readingLines = reading.split('\n');
    if (readingLines.length === wordLines.length) {
      return wordLines
        .map((line, index) => buildFuriganaMarkup(line, readingLines[index]))
        .join('\n');
    }
  }

  const runs = splitRuns(word);
  if (!runs.some((run) => run.kind === 'kanji')) return word;

  const tokens = reading.split(/\s+/u).filter(Boolean);
  const cleanReading = (tokens.length > 1 ? tokens.join('') : reading).replace(ANNOTATION_PATTERN, '');

  // A scanned reading list may be a whole phrase's worth of tokens against a
  // sentence that has no kana anchors between its kanji runs (e.g. a grammar
  // note), or one token per kanji character (超忙しい / ちょう いそが). Both
  // shapes already know the boundary the aligner would otherwise have to
  // guess, so honour them — but only when the token count matches exactly and
  // no token swallows the headword's own kana. 取り次ぐ / とりつぐ breaks that
  // rule: the token covers 取り次 AND its kana り, so the tokens are not one
  // per kanji run and the aligner has to work it out.
  const wordKana = runs
    .filter((run) => run.kind === 'kana' && !run.annotated)
    .map((run) => kanaAlignmentKey(run.text))
    .filter(Boolean);
  const tokensAreReadings = !wordKana.some((kana) => tokens.some((token) => token.length > kana.length && token.includes(kana)));

  if (tokens.length > 1 && tokensAreReadings && tokens.every((token) => KANA_RE.test(token))) {
    const kanjiRuns = runs.filter((run) => run.kind === 'kanji');
    const kanjiCharacters = kanjiRuns.flatMap((run) => [...run.text]);
    const perRun = tokens.length === kanjiRuns.length;
    const perCharacter = !perRun && tokens.length === kanjiCharacters.length;
    if (perRun || perCharacter) {
      let tokenIndex = 0;
      return runs
        .map((run) => {
          if (run.kind !== 'kanji') return run.text;
          const characters = perRun ? [run.text] : [...run.text];
          return characters
            .map((character) => {
              const token = tokens[tokenIndex];
              tokenIndex += 1;
              return `{${character}|${token}}`;
            })
            .join('');
        })
        .join('');
    }
  }

  // Two passes: first treat the bracketed annotation as plain text, then as
  // part of the headword. "(口・目・本を)閉じる" has no reading for the
  // objects in brackets, while "(車の)ハンドル" does list くるま for 車.
  const asText = alignRuns(runs, cleanReading, true);
  const asWord = alignRuns(runs, cleanReading, false);
  if (asText) return asText;
  if (asWord) return asWord;
  return `{${word}|${reading}}`;
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
