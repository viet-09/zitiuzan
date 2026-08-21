import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the study companion is sized from a single scale knob', () => {
  const css = read('css/styles.css');

  const scale = css.match(/--pet-scale:\s*([\d.]+);/)?.[1];
  assert.equal(scale, '.75', 'the companion renders at three quarters of its drawn size');

  // Mount box, sprite frame and drop shadow all have to follow the same knob,
  // or the pet shrinks out of a box that stays put (or vice versa).
  for (const declaration of [
    /\.streak-pet-mount[\s\S]*?width: calc\(74\.4px \* var\(--pet-scale\)\)/,
    /\.streak-pet-mount[\s\S]*?height: calc\(110\.4px \* var\(--pet-scale\)\)/,
    /\.pixel-pet__sprite[\s\S]*?width: calc\(116px \* var\(--pet-scale, 1\)\)/,
    /\.pixel-pet__sprite[\s\S]*?height: calc\(112px \* var\(--pet-scale, 1\)\)/,
    /\.pixel-pet--fox \.pixel-pet__sprite \{\s*width: calc\(121px \* var\(--pet-scale, 1\)\)/,
    /\.pixel-pet--rabbit \.pixel-pet__sprite \{\s*width: calc\(111px \* var\(--pet-scale, 1\)\)/,
  ]) {
    assert.match(css, declaration);
  }

  // No stray absolute size may survive alongside the scaled ones.
  assert.doesNotMatch(css, /\.streak-pet-mount \{[\s\S]*?width: 74\.4px/);
  assert.doesNotMatch(css, /\.streak-pet-mount \{ width: 64\.8px/);
});

test('chat surfaces are sized from the measured space under the masthead', () => {
  const css = read('css/styles.css');
  const fit = read('js/viewport-fit.js');
  const router = read('js/router.js');
  const app = read('js/app.js');

  // A vh guess overflows the fold and produces two nested scrollbars; the
  // measured value is what keeps one conversation inside one viewport.
  assert.match(css, /\.chat-wrap \{[\s\S]*?height: calc\(var\(--app-viewport-height[^)]*\) - 16px\)/);
  assert.doesNotMatch(css, /\.chat-wrap \{[\s\S]*?height: calc\(100vh - 220px\)/);

  assert.match(fit, /--app-viewport-height/);
  assert.match(fit, /window\.innerHeight - top - readBottomNavHeight/);
  // requestAnimationFrame never fires in a background tab, where the first
  // render often happens — the measure has to be synchronous.
  assert.doesNotMatch(fit, /window\.requestAnimationFrame\(/);

  assert.match(router, /export const ROUTE_CHANGED_EVENT/);
  assert.match(router, /document\.documentElement\.dataset\.route = routeName/);
  assert.match(fit, /addEventListener\(ROUTE_CHANGED_EVENT, measure\)/);
  assert.match(app, /mountAppViewportFit\(rootEl\)/);
});

test('conversation routes trade the display masthead for the chat itself', () => {
  const css = read('css/styles.css');
  const voice = read('js/voice.js');

  for (const route of ['tutor', 'voice']) {
    assert.match(css, new RegExp(`:root\\[data-route='${route}'\\] \\.masthead-title`));
  }
  assert.match(css, /:root\[data-route='tutor'\] \.masthead-tools,\s*\n:root\[data-route='voice'\] \.masthead-tools \{ display: none; \}/);

  // Collapsing the masthead tools removes the only settings entry point on the
  // voice route, so each of its views has to carry its own.
  assert.equal((voice.match(/class="chat-settings-btn" data-voice-settings>/g) || []).length, 2,
    'both the topic picker and the conversation view need a settings button');
  assert.match(voice, /openSettings/);

  // The topic picker is not a chat column; only the conversation view is.
  assert.match(css, /:root\[data-route='voice'\] \.voice-page:has\(> \.chat-wrap\)/);
});

test('the leaderboard shows each learner the avatar their account renders', () => {
  const leaderboard = read('js/leaderboard.js');
  const css = read('css/styles.css');

  assert.match(leaderboard, /import \{ renderAvatar \} from '\.\/profile-avatar\.js'/);
  assert.match(leaderboard, /renderAvatar\(\s*\{ avatarType: row\?\.avatar_type, avatarData: row\?\.avatar_data \}/);
  // The old emoji table drifted from the fox/rabbit presets the account uses.
  assert.doesNotMatch(leaderboard, /PRESET_SYMBOLS/);
  assert.doesNotMatch(leaderboard, /🐱|🦊|🐰|🌸/);
  assert.match(css, /\.profile-avatar\.lb-avatar \{/);
});

test('the leaderboard reports time studied today and no longer ranks by level', () => {
  const leaderboard = read('js/leaderboard.js');

  assert.match(leaderboard, /<th>Hôm nay<\/th>/);
  assert.doesNotMatch(leaderboard, /TB\/buổi/);
  assert.doesNotMatch(leaderboard, /avg_study_ms/);
  assert.match(leaderboard, /formatToday\(row\.today_study_ms\)/);

  // The course is N2 only, so a per-learner level column said nothing.
  assert.doesNotMatch(leaderboard, /lb-level|ai_level|<th>Level<\/th>/);
  const headers = (leaderboard.match(/<th>/g) || []).length;
  assert.equal(headers, 6);
  assert.match(leaderboard, /colspan="6"/);
  assert.doesNotMatch(leaderboard, /colspan="7"/);
});
