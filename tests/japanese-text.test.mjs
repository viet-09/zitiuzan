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
  assert.equal(
    buildFuriganaMarkup('「お元気でしたか。／お元気でいらっしゃいましたか。」', 'おげんきでしたか / おげんきでいらっしゃいましたか'),
    '「お{元気|げんき}でしたか。／お{元気|げんき}でいらっしゃいましたか。」',
  );
});

test('space-delimited kanji readings stay directly over their own kanji', () => {
  assert.equal(
    buildFuriganaMarkup('＊人にお土産などをあげるときの謙譲した言い方。', 'ひと みやげ けんじょう い かた'),
    '＊{人|ひと}にお{土産|みやげ}などをあげるときの{謙譲|けんじょう}した{言|い}い{方|かた}。',
  );
});

test('mixed kanji and kana words only annotate the kanji', () => {
  // The reading of a word that ends in okurigana belongs over the kanji
  // alone — {書|かきます}きます would print "かきます" over kana that are
  // already on the line.
  assert.equal(buildFuriganaMarkup('書きます', 'かきます'), '{書|か}きます');
  assert.equal(buildFuriganaMarkup('静まる', 'しずまる'), '{静|しず}まる');
  assert.equal(buildFuriganaMarkup('危ない', 'あぶない'), '{危|あぶ}ない');
  assert.equal(buildFuriganaMarkup('読み書き', 'よみかき'), '{読|よ}み{書|か}き');
  assert.equal(buildFuriganaMarkup('伺う', 'うかが.う'), '{伺|うかが}う');
  assert.equal(buildFuriganaMarkup('失う', 'うしな.う'), '{失|うしな}う');
  assert.equal(buildFuriganaMarkup('承る', 'うけたまわる'), '{承|うけたまわ}る');
});

test('a reading that stops at the kanji still goes over that kanji', () => {
  // These scanned entries list only the kanji reading, so the trailing kana
  // has nothing to sit on and must not drag the ruby onto itself.
  assert.equal(buildFuriganaMarkup('触る', 'さわ'), '{触|さわ}る');
  assert.equal(buildFuriganaMarkup('悩む', 'なや'), '{悩|なや}む');
  assert.equal(buildFuriganaMarkup('畳む', 'たたみ'), '{畳|たたみ}む');
  assert.equal(buildFuriganaMarkup('幸い', 'さいわい'), '{幸|さいわ}い');
  assert.equal(buildFuriganaMarkup('その他', 'ほか'), 'その{他|ほか}');
  assert.equal(buildFuriganaMarkup('学校のグラウンド', 'がっこう'), '{学校|がっこう}のグラウンド');
  assert.equal(buildFuriganaMarkup('プライドが高い', 'たか'), 'プライドが{高|たか}い');
});

test('a reading is split over two kanji when its own kana is missing', () => {
  // 贈り物 / おくもの drops the り, so there is no kana anchor to cut at.
  assert.equal(buildFuriganaMarkup('贈り物', 'おくもの'), '{贈|おく}り{物|もの}');
});

test('per-kanji token lists win over guessing', () => {
  assert.equal(buildFuriganaMarkup('超忙しい', 'ちょう いそが'), '{超|ちょう}{忙|いそが}しい');
  // But a token that swallows the word's own kana is not a token list.
  assert.equal(
    buildFuriganaMarkup('電話を取り次ぐ', 'でんわ を とりつぐ'),
    '{電話|でんわ}を{取|と}り{次|つ}ぐ',
  );
});

test('bracketed annotations do not block alignment', () => {
  assert.equal(buildFuriganaMarkup('(車の)ハンドル', 'くるま'), '({車|くるま}の)ハンドル');
  assert.equal(buildFuriganaMarkup('確か（な）', 'たしか'), '{確|たし}か（な）');
});

test('a multi-line headword aligns line by line', () => {
  assert.equal(
    buildFuriganaMarkup('生じる\n問題が生じる', 'しょうじる\nもんだい が しょうじる'),
    '{生|しょう}じる\n{問題|もんだい}が{生|しょう}じる',
  );
});

test('legacy ruby data is normalized without allowing arbitrary HTML', () => {
  const html = renderFurigana('友人を家に[<ruby>招<rt>まね</rt></ruby>く] <script>alert(1)</script>');
  assert.match(html, /<ruby>招<rt>まね<\/rt><\/ruby>/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /&lt;script&gt;/u);
});
