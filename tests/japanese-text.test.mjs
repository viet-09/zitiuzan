import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFuriganaMarkup, renderFurigana } from '../js/furigana.js';

test('furigana aligns each kanji run with full-word readings', () => {
  assert.equal(
    buildFuriganaMarkup('引っ越しの荷造りをする', 'ひっこしのにづくりをする'),
    '{引|ひ}っ{越|こ}しの{荷造|にづく}りをする',
  );
  assert.equal(
    buildFuriganaMarkup('銀行でお金を下ろす / 引き出す', 'ぎんこう で おかね を おろす / ひきだす'),
    '{銀行|ぎんこう}でお{金|かね}を{下|お}ろす / {引|ひ}き{出|だ}す',
  );
});

test('space-delimited kanji readings stay directly over their own kanji', () => {
  assert.equal(
    buildFuriganaMarkup('＊人にお土産などをあげるときの謙譲した言い方。', 'ひと みやげ けんじょう い かた'),
    '＊{人|ひと}にお{土産|みやげ}などをあげるときの{謙譲|けんじょう}した{言|い}い{方|かた}。',
  );
});

test('legacy ruby data is normalized without allowing arbitrary HTML', () => {
  const html = renderFurigana('友人を家に[<ruby>招<rt>まね</rt></ruby>く] <script>alert(1)</script>');
  assert.match(html, /<ruby>招<rt>まね<\/rt><\/ruby>/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /&lt;script&gt;/u);
});
