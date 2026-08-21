// js/leaderboard.js — public leaderboard page: top 50 theo % hoàn thành/streak.
// Read-only page (no router cleanup needed) mirroring dashboard.js/tutor.js
// conventions. Sign-in here is a single Google button, no modal — the
// first-visit choice (Google vs. offline) lives in js/auth.js instead.

import { fetchLeaderboard, currentUser, signInWithGoogle, ready as supabaseReady } from './supabase.js';
import { renderAvatar } from './profile-avatar.js';
import { getProfile } from './profile.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function formatHours(ms) {
  const value = Number(ms) || 0;
  const hours = value / 3_600_000;
  if (hours < 1) return `${Math.round(value / 60_000)} phút`;
  return `${hours.toFixed(1)}h`;
}

function formatToday(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return '—';
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} phút`;
  return `${(value / 3_600_000).toFixed(1)}h`;
}

// The same renderer as the account button and the profile page, so a learner's
// row on the board shows exactly the pet they picked.
//
// Your own row reads the local profile instead of the server row, so it
// matches the account button the moment you change it rather than after the
// push lands. Everyone else's avatar comes straight off the board, which now
// carries real photos as well as preset pets.
function avatarCell(row, selfId) {
  const isSelf = selfId && row?.user_id === selfId;
  const source = isSelf
    ? getProfile()
    : { avatarType: row?.avatar_type, avatarData: row?.avatar_data };
  return renderAvatar(source, { className: 'lb-avatar' });
}

// Last standings this session, so returning to the page — or any re-render
// the shell triggers — paints the board immediately and refreshes underneath,
// instead of blinking through "Đang tải…" while the same request runs again.
let cachedBoard = null;

function boardTemplate({ user, rows }) {
  const authBlock = user
    ? `<p class="lb-signedin">Đã đăng nhập: <strong>${escapeHtml(user.email || user.id)}</strong></p>`
    : `<button type="button" class="auth-pill" data-action="sign-in-google">Đăng nhập bằng Google để đồng bộ</button>`;

  const body = !user
    ? '<tr><td colspan="6" class="lb-empty">Đăng nhập để xem bảng xếp hạng cùng bạn bè.</td></tr>'
    : rows.length === 0
    ? '<tr><td colspan="6" class="lb-empty">Chưa có ai trên bảng xếp hạng — hoàn thành bài học đầu tiên để lên hạng!</td></tr>'
    : rows.map((row) => `
        <tr${row.user_id === user.id ? ' class="lb-self"' : ''}>
          <td class="lb-rank">${escapeHtml(String(row.rank ?? '—'))}</td>
          <td class="lb-id">
            <div class="lb-id-cell">${avatarCell(row, user.id)}<span>${escapeHtml(row.display_name || 'Học viên')}</span></div>
          </td>
          <td class="lb-completion">${escapeHtml(String(row.completion_percent ?? 0))}%</td>
          <td class="lb-hours">${escapeHtml(formatHours(row.total_study_ms))}</td>
          <td class="lb-today">${escapeHtml(formatToday(row.today_study_ms))}</td>
          <td class="lb-streak">${escapeHtml(String(row.streak ?? 0))} 🔥</td>
        </tr>
      `).join('');

  return `
    <header class="lb-head">
      <h3 class="subheading">Bảng xếp hạng</h3>
      <div class="lb-auth">${authBlock}</div>
    </header>
    <div class="lb-table-wrap">
      <table class="lb-table">
        <thead>
          <tr><th>#</th><th>Học viên</th><th>Hoàn thành</th><th>Tổng giờ học</th><th>Hôm nay</th><th>Streak</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function bindAuthButton(el) {
  const btn = el.querySelector('[data-action="sign-in-google"]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    signInWithGoogle().catch((err) => {
      console.warn('[leaderboard] sign-in failed:', err);
      btn.disabled = false;
    });
  });
}

/** Render the leaderboard page into `root`. */
export function renderLeaderboard(root) {
  root.innerHTML = `
    <h2 class="sr-only" data-route-heading>Bảng xếp hạng</h2>
    <section class="leaderboard leaderboard-page" id="leaderboard-page" aria-label="Bảng xếp hạng">
      ${cachedBoard ? boardTemplate(cachedBoard) : '<p class="dash-empty-state">Đang tải…</p>'}
    </section>
  `;
  const el = root.querySelector('#leaderboard-page');
  if (cachedBoard) bindAuthButton(el);
  paint(el);
  return { preserveScroll: false };
}

async function paint(el) {
  if (!el) return;
  await supabaseReady();  // let config fetch settle so the auth button renders
  const user = await currentUser();
  // Anonymous reads are rejected by RLS (leaderboard is authenticated-only) —
  // skip the doomed request instead of showing a misleading "no one yet".
  const rows = user ? await fetchLeaderboard(50) : [];
  // The learner may have left while those two round trips were in flight;
  // writing into a detached node would only resurrect a stale board.
  if (!el.isConnected) return;
  cachedBoard = { user, rows };
  el.innerHTML = boardTemplate(cachedBoard);
  bindAuthButton(el);
}
