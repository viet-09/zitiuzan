# N2_web — TYPOGRAPHY-FIRST design system (authoritative restyle spec)

Goal: one cohesive, synchronized visual system across EVERY page & button (dashboard, lesson reader,
AI tutor, voice trainer, settings modal, nav). Style is **Typography First**: letterforms are the hero —
ink on warm paper, one vivid vermillion accent, dramatic type scale, editorial rhythm, restrained snappy motion.

DO NOT change any JS logic, element `id`s, `data-*` attributes, or event wiring. You MAY add `class` hooks and
MUST remove presentational inline `style="..."` from `js/tutor.js` and `js/voice.js` (move that presentation into
`css/styles.css`). Keep CSS **variable names** identical to today's (so any missed inline `var()` still inherits).

## 1. Google Fonts (replace the current `<link>` in index.html `<head>`)
```
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,900;1,9..144,400&family=Space+Grotesk:wght@400;500;600;700&family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap" rel="stylesheet">
```
- **Fraunces** = editorial high-contrast serif (Latin + Vietnamese). Use `font-optical-sizing:auto` so big sizes look display, small sizes look text.
- **Space Grotesk** = precise grotesque for labels/UI/nav/buttons (Latin + Vietnamese).
- **Zen Kaku Gothic New** = Japanese; supplies all JP/kanji glyphs (weight 900 for kanji hero).

## 2. Design tokens — KEEP THESE VARIABLE NAMES, use these NEW values
```css
:root{
  --bg-page:#F6F3EC;            /* warm paper */
  --bg-card:#FCFBF7;            /* raised paper */
  --paper-2:#EEE9DD;            /* subtle inset panel */
  --text-primary:#141210;      /* ink */
  --text-muted:#6C665B;        /* warm grey ink */
  --accent-red:#C52620;        /* 朱 vermillion — the single vivid accent (name kept) */
  --accent-red-bg:#FBE9E6;     /* vermillion wash */
  --accent-gold:#141210;       /* repurposed to ink (used by old focus outlines/tts active) */
  --border-color:#E3DCCB;      /* hairline */
  --border-dark:#141210;       /* ink rule */
  --danger:#B3261E;
  --accent-green:#1E7A4D; --accent-green-bg:#E9F1EA; --accent-green-border:#9DBCA6;

  /* category accents (tasteful color; hooked via [data-cat]/[data-cat-id]) */
  --cat-grammar:#C52620; --cat-vocabulary:#1F5FD0; --cat-kanji:#7A3CC0;
  --cat-reading:#1E7A4D; --cat-listening:#8A4B08;

  --font-display:'Fraunces','Zen Kaku Gothic New',Georgia,serif;
  --font-serif:'Fraunces','Zen Kaku Gothic New',Georgia,serif;   /* body/reading */
  --font-jp:'Zen Kaku Gothic New','Fraunces',sans-serif;         /* JP display / kanji hero */
  --font-sans:'Space Grotesk','Zen Kaku Gothic New',system-ui,sans-serif; /* labels/UI/nav/buttons */

  --shadow-subtle:0 1px 0 var(--border-color);
  --shadow-card:0 2px 0 var(--border-color);   /* Typography-first = flat + hairlines, NOT soft drop shadows */
  --radius:3px; --radius-lg:4px; --bottom-nav-height:76px;
}
```
Base: `body{background:var(--bg-page);color:var(--text-primary);font-family:var(--font-serif);font-optical-sizing:auto;font-size:18px;line-height:1.65;padding-bottom:calc(var(--bottom-nav-height) + env(safe-area-inset-bottom,0));}`
Reduce chrome: prefer hairline rules + flat fills over drop shadows. Rounded corners minimal (≤4px). Selection color = vermillion.

## 3. Typographic voice (the point of the whole style)
- **UI labels / meta / nav / buttons / tabs / stat-labels**: `--font-sans`, UPPERCASE, `letter-spacing:.08–.14em`, 11–13px, weight 600.
- **Big numerals** (stat-value, review score): `--font-display`, weight 900, huge, `font-variant-numeric:lining-nums`.
- **Headlines / lesson & section titles / kanji**: display weight 900, tight `line-height:1.02`, `letter-spacing:-0.015em`.
- **Reading text** (VI explanations, JP examples): `--font-serif`, 17–18px, generous line-height.
- Furigana `rt`: `--font-sans`, `.55em`, muted, `user-select:none`.

## 4. Masthead — rewrite index.html header markup (keep #current-date, #btn-settings)
```html
<header class="masthead container">
  <div class="masthead-bar">
    <span class="masthead-brand">日本語総まとめ · N2 STUDY JOURNAL</span>
    <span class="masthead-date" id="current-date"></span>
  </div>
  <h1 class="masthead-title"><span class="mt-jp">日本語総まとめ</span> <span class="mt-n2">N2</span></h1>
  <p class="masthead-sub">Học &amp; theo dõi tiến độ N2 — ngữ pháp · từ vựng · hán tự · đọc · nghe, cùng gia sư AI.</p>
  <div class="masthead-tools"><button id="btn-settings" class="settings-btn" type="button" aria-label="Cài đặt">⚙ <span>Cài đặt</span></button></div>
</header>
```
Treatment: `.masthead-bar` = Space Grotesk uppercase micro, space-between, with a HAIRLINE under it. `.masthead-title` enormous `clamp(2.8rem,10vw,6rem)`, `.mt-jp` in `--font-jp` weight 900 ink, `.mt-n2` in `--font-display` weight 900 vermillion. Thick 3px ink rule under the whole masthead. `.masthead-sub` Fraunces italic, muted. `.settings-btn` = ghost pill, Space Grotesk uppercase, ≥44px.

## 5. Bottom nav (fixed) — classes: .bottom-nav .nav-btn(.active) .nav-btn-jp .nav-btn-vi
Flat top hairline; active tab shows a 3px vermillion top bar + vermillion text; `.nav-btn-jp` in `--font-jp` 15px, `.nav-btn-vi` Space Grotesk uppercase 9px. ≥76px tall incl safe-area.

## 6. Component treatments — target the REAL class names below (grep JS to confirm none missed)
**Dashboard** `.stats-bar`(3-col grid; each `.stat-item` divided by hairlines, big Fraunces `.stat-value`, uppercase `.stat-label`, thin ink `.progress-bar-fill`), `.category-tabs`+`.tab-btn`(.active) = uppercase Space Grotesk chips; color the ACTIVE tab per category via `.tab-btn[data-cat="grammar"].active{background:var(--cat-grammar);border-color:var(--cat-grammar);color:#fff}` (and vocabulary/kanji/reading/listening). `.category-block[data-cat-id]` → color its `.category-header` left border/label per matching `--cat-*`. `.category-header`(ink bar or paper w/ heavy bottom rule + big uppercase h3 + `.category-progress-text`), `.week-card`(paper, hairline, `.week-title` uppercase vermillion + `.week-count`), `.lessons-grid`, `.lesson-item`(.completed → ink `.custom-checkbox` ✓ + strikethrough `.lesson-title`), `.lesson-meta`(uppercase micro), `.lesson-title`(serif), `.study-btn`("HỌC →" uppercase, drawn-underline ghost).

**Lesson page** `.lesson-page .lesson-toolbar .lesson-toolbar-actions .back-btn`(ghost "← Quay lại") `.furigana-toggle-btn`(square 44px, shows あ/ア, active look) `.complete-toggle-btn`(.is-done)(primary→ghost when done) `.lesson-header .lesson-header-meta`(uppercase micro, tint per category if easy) `.lesson-header-title`(huge display) `.lesson-body` `.content-section`(paper, hairline, generous padding) `.section-heading`(h2, big display or uppercase) `.subheading`(h3 uppercase Space Grotesk) `.section-intro` `.grammar-point`(thick vermillion left rule) `.grammar-title`(display) `.grammar-meaning .grammar-formation .grammar-explain .lesson-notes` `.example-box`(inset `--paper-2`, hairline; `.jp-sentence` flex w/ `.jp-text` + `.tts-btn`; `.vi-sentence` muted) `.vocab-item .vocab-word`(display 20px) `.vocab-meaning` `.kanji-item .kanji-char`(display 40px+) `.kanji-readings .kanji-on .kanji-kun`(uppercase micro chips) `.kanji-meaning` `.reading-vocab .reading-vocab-list .passage-title .passage-block .transcript-block` `.quiz-block .quiz-question(.is-answered) .quiz-q-text .quiz-options .quiz-option` and states **`.quiz-option.is-correct`** (green) / **`.quiz-option.is-incorrect`** (vermillion) + `:disabled`; `.quiz-explain[hidden]` hidden, shown as inset note w/ vermillion left rule; `.quiz-answer .quiz-explain-vi`. Empty/gen states: `.lesson-empty-state .lesson-loading .lesson-error` **`.ai-generate-btn`**(big vermillion CTA "✨ Tạo bài học bằng AI"). `.lesson-not-found`. `.tts-btn`(round 40px, ink icon, `:active` vermillion).

**Tutor (js/tutor.js — REMOVE inline styles, use these classes)**: `.chat-wrap`(column, hairline frame, flat) `.chat-toolbar`(space-between) `.chat-clear-btn .chat-settings-btn`(ghost uppercase) `.chat-messages`(scroll, gap) `.chat-msg`(row wrapper; `.user`→align right, `.model`→left) `.chat-msg-bubble`(model = paper + hairline + thin vermillion LEFT rule like a margin note, radius 4px; user = ink bg, paper text, radius 4px) `.chat-loading .chat-error`(vermillion-wash bubble) `.chat-empty` `.tts-btn` `.chat-input-row`(hairline top; `#tutor-input` serif 16px, ink caret; `.chat-send-btn` = vermillion block uppercase "GỬI"). Keep ids `#tutor-form #tutor-input #tutor-messages #tutor-clear-btn #tutor-settings-btn #tutor-send-btn` and the `.tts-btn[data-tts-idx]` hook.

**Voice (js/voice.js — REMOVE inline styles, use classes)**: `.voice-page` `.section-title`(display headline) `.topic-grid`(responsive grid) `.voice-topic-btn`(also `.tab-btn`; card-like chip: label serif + JP muted; give each a subtle category-free vermillion hover) `.lesson-toolbar .lesson-meta` `.chat-wrap`(reused) `.chat-msg .user/.model` `.jp-sentence .vi-sentence .tts-btn` `.chat-input-row` `#voice-text-input`(serif 16px) `.record-btn`(.recording → pulsing vermillion; big 64px circle) `.study-btn`(used for record/send/end/back/retry — uppercase; the "🔚 Kết thúc & Đánh giá" is full-width primary) `.review-card`(paper, hairline; h3 display headline; h4 uppercase subheads; big Fraunces score) `.example-box .vocab-item .quiz-option`(reused). Keep ids `#voice-back-btn #voice-record-btn #voice-text-input #voice-send-btn #voice-end-btn #voice-review-retry #voice-review-back #voice-chat-wrap` and `[data-speak]`, `[data-topic-id]` hooks.

**Settings modal (shell reused by gemini.js)**: style `.modal-overlay .modal-card`(flat paper, 2px ink border, no big blur) `.modal-header`(h3 uppercase) `.modal-close`(44px) `.modal-body .modal-footer` `.complete-modal-btn`(vermillion primary "Lưu"). gemini.js injects its own field CSS via var() so it inherits — just make the shell match.

## 7. Motion & a11y
- Transition `all .14s cubic-bezier(.2,.7,.2,1)`. Buttons `:active{transform:translateY(1px)}`. Ghost/underline buttons: animate an underline via `background-image:linear-gradient` with `background-size:0 2px→100% 2px`.
- `:focus-visible{outline:2px solid var(--accent-red);outline-offset:2px}` on all interactive elements.
- Keep `@keyframes n2-spin` and `n2-pulse`. Add `@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`.
- All touch targets ≥44px. Keep `body.furigana-off rt{display:none}`. Keep `.hidden{display:none!important}` and `.text-muted`.
- `@media (max-width:600px)`: masthead title smaller, stats 1-col, lessons-grid 1-col, topic-grid 1-col, reduce paddings. Never allow horizontal body scroll.

## 8. Definition of done
Every class listed in §6 is styled; no element renders unstyled. No presentational inline `style=` remains in tutor.js/voice.js. All JS ids/data-*/logic unchanged. Vietnamese diacritics + Japanese + furigana all render correctly. Looks like ONE deliberate typographic system end to end.
