// js/leaderboard.js — public leaderboard page: top 50 theo % hoàn thành/streak.
// Read-only page (no router cleanup needed) mirroring dashboard.js/tutor.js
// conventions. Sign-in here is a single Google button, no modal — the
// first-visit choice (Google vs. offline) lives in js/auth.js instead.

import { fetchLeaderboard, currentUser, signInWithGoogle, ready as supabaseReady } from './supabase.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

const PRESET_SYMBOLS = {
  neko: '🐱', kitsune: '🦊', usagi: '🐰', sakura: '🌸',
};

function formatHours(ms) {
  const value = Number(ms) || 0;
  const hours = value / 3_600_000;
  if (hours < 1) return `${Math.round(value / 60_000)} phút`;
  return `${hours.toFixed(1)}h`;
}

function formatAverage(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return '—';
  const minutes = value / 60_000;
  if (minutes < 1) return `${Math.round(value / 1000)}s`;
  return `${Math.round(minutes)} phút`;
}

function avatarCell(row) {
  if (row?.avatar_type === 'preset') {
    const sym = PRESET_SYMBOLS[row.avatar_data] || '🐱';
    return `<span class="lb-avatar">${escapeHtml(sym)}</span>`;
  }
  if (row?.avatar_type === 'upload' && typeof row.avatar_data === 'string') {
    return `<img class="lb-avatar lb-avatar-img" alt="" src="${escapeHtml(row.avatar_data)}">`;
  }
  return `<span class="lb-avatar">👤</span>`;
}

/** Render the leaderboard page into `root`. */
export function renderLeaderboard(root) {
  root.innerHTML = `
    <h2 class="sr-only" data-route-heading>Bảng xếp hạng</h2>
    <section class="leaderboard leaderboard-page" id="leaderboard-page" aria-label="Bảng xếp hạng">
      <p class="dash-empty-state">Đang tải…</p>
    </section>
  `;
  paint(root.querySelector('#leaderboard-page'));
  return { preserveScroll: false };
}

async function paint(el) {
  if (!el) return;
  await supabaseReady();  // let config fetch settle so the auth button renders
  const user = await currentUser();
  const authBlock = user
    ? `<p class="lb-signedin">Đã đăng nhập: <strong>${escapeHtml(user.email || user.id)}</strong></p>`
    : `<button type="button" class="auth-pill" data-action="sign-in-google">Đăng nhập bằng Google để đồng bộ</button>`;

  // Anonymous reads are rejected by RLS (leaderboard is authenticated-only) —
  // skip the doomed request instead of showing a misleading "no one yet".
  const rows = user ? await fetchLeaderboard(50) : [];
  const body = !user
    ? '<tr><td colspan="7" class="lb-empty">Đăng nhập để xem bảng xếp hạng cùng bạn bè.</td></tr>'
    : rows.length === 0
    ? '<tr><td colspan="7" class="lb-empty">Chưa có ai trên bảng xếp hạng — hoàn thành bài học đầu tiên để lên hạng!</td></tr>'
    : rows.map((row) => `
        <tr${user && row.user_id === user.id ? ' class="lb-self"' : ''}>
          <td class="lb-rank">${escapeHtml(String(row.rank ?? '—'))}</td>
          <td class="lb-id">
            <div class="lb-id-cell">${avatarCell(row)}<span>${escapeHtml(row.display_name || 'Học viên')}</span></div>
          </td>
          <td class="lb-completion">${escapeHtml(String(row.completion_percent ?? 0))}%</td>
          <td class="lb-hours">${escapeHtml(formatHours(row.total_study_ms))}</td>
          <td class="lb-avg">${escapeHtml(formatAverage(row.avg_study_ms))}</td>
          <td class="lb-streak">${escapeHtml(String(row.streak ?? 0))} 🔥</td>
          <td class="lb-level">${escapeHtml(row.ai_level || '—')}</td>
        </tr>
      `).join('');

  el.innerHTML = `
    <header class="lb-head">
      <h3 class="subheading">Bảng xếp hạng</h3>
      <div class="lb-auth">${authBlock}</div>
    </header>
    <div class="lb-table-wrap">
      <table class="lb-table">
        <thead>
          <tr><th>#</th><th>Học viên</th><th>Hoàn thành</th><th>Tổng giờ học</th><th>TB/buổi</th><th>Streak</th><th>Level</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
  const btn = el.querySelector('[data-action="sign-in-google"]');
  if (btn) {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      signInWithGoogle().catch((err) => {
        console.warn('[leaderboard] sign-in failed:', err);
        btn.disabled = false;
      });
    });
  }
}
