// js/app.js — application bootstrap
// Loads lesson data, wires the header/nav controls, and starts the hash router.

import { setLessons, resetBookContent, mergeBookContent, setTutorContext, setQuestionClassification, setLessonImages, setVietnameseExplanations, getStreak } from './store.js';
import { mountPet } from './pet.js?v=22';
import { getCurrentRoute, initRouter, navigate } from './router.js';
import { initFuriganaToggle } from './furigana.js';
import { openSettings } from './gemini.js';
import { renderDashboard } from './dashboard.js';
import { renderLesson } from './lesson.js';
import { renderTutor } from './tutor.js';
import { renderVoice } from './voice.js';
import { renderLeaderboard } from './leaderboard.js';
import { renderExam } from './exam.js';
import { renderProfilePage } from './profile-page.js';
import { renderReview } from './review.js';
import {
    mountProfile,
    markProfilePromptSeen,
    getProfile,
    renderAvatar,
    PROFILE_UPDATED_EVENT,
} from './profile.js';
import { openSignInGate } from './auth.js';
import { onAuthChange, ready as supabaseReady, currentUser } from './supabase.js';
import { flushCompletionQueue, flushReviewQueue, maybeMigrateLocalData, maybeSeedProfileFromGoogle, pullFromCloud, pushProfile, syncReviewRemote } from './sync.js';
import { REVIEW_RECORDED_EVENT } from './learning-state.js';
import { mountAppViewportFit } from './viewport-fit.js?v=22';

function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((error) => {
            console.warn('[pwa] service worker registration failed:', error);
        });
    }, { once: true });
}

function setCurrentDate() {
    const el = document.getElementById('current-date');
    if (!el) return;
    try {
        const formatted = new Date().toLocaleDateString('vi-VN', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
        });
        el.textContent = formatted.toUpperCase();
    } catch (err) {
        // Non-fatal: leave the date blank if Intl/date formatting fails.
    }
}

function wireSettingsButton() {
    const btn = document.getElementById('btn-settings');
    if (!btn) return;
    btn.addEventListener('click', () => {
        openSettings();
    });
}

function wireBottomNav() {
    const buttons = document.querySelectorAll('.bottom-nav .nav-btn');
    buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const route = btn.getAttribute('data-route');
            if (route === 'dashboard') navigate('#/');
            else if (route === 'tutor') {
                setTutorContext(null);
                navigate('#/tutor');
            }
            else if (route === 'voice') navigate('#/voice');
            else if (route === 'leaderboard') navigate('#/leaderboard');
            else if (route === 'exam') navigate('#/exam');
        });
    });
}

function wireAccountButton() {
    const btn = document.getElementById('btn-account');
    if (!btn) return;
    const paint = () => { btn.innerHTML = renderAvatar(getProfile(), { decorative: true }); };
    btn.addEventListener('click', () => navigate('#/profile'));
    window.addEventListener(PROFILE_UPDATED_EVENT, paint);
    paint();
}

/** Mounted once, globally — a small always-on corner companion rather than
 * a per-route dashboard card (js/dashboard.js no longer manages this). */
let petController = null;
function wirePetWidget() {
    const streak = Number((getStreak() || {}).streak) || 0;
    petController = mountPet('#pet-widget-mount', { streak });
}

function wireReviewSync() {
    window.addEventListener(REVIEW_RECORDED_EVENT, async (event) => {
        const review = event.detail?.review;
        if (!review) return;
        const user = await currentUser();
        if (!user?.id) return;
        try {
            await syncReviewRemote(review, user.id);
        } catch (error) {
            console.warn('[sync] review queued for retry:', error?.message || error);
        }
    });
}

async function loadLessons() {
    try {
        const res = await fetch('data/lessons.json');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setLessons(data);
    } catch (err) {
        console.error('Không thể nạp data/lessons.json:', err);
        setLessons(null);
    }
}

async function loadBookContent() {
    resetBookContent();
    try {
        const manifestResponse = await fetch('data/book/manifest.json');
        if (!manifestResponse.ok) throw new Error(`HTTP ${manifestResponse.status}`);
        const manifest = await manifestResponse.json();
        const categories = manifest.categories && typeof manifest.categories === 'object' ? manifest.categories : {};
        const files = Array.isArray(manifest.files)
            ? manifest.files
            : Object.values(categories).map((entry) => entry && entry.file).filter(Boolean);
        const payloads = await Promise.all(files.map(async (file) => {
            const response = await fetch(`data/book/${encodeURIComponent(file)}`);
            if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
            return response.json();
        }));
        payloads.forEach(mergeBookContent);
        // Load optional enrichment files (classification + images) per category.
        await loadEnrichment(categories);
    } catch (err) {
        // The checked-in W1 proof remains a useful development fallback while a
        // manifest is being regenerated, but production uses manifest.json only.
        try {
            const response = await fetch('data/book/kanji-w1.json');
            if (response.ok) mergeBookContent(await response.json());
        } catch (fallbackErr) {
            console.warn('Không thể nạp dữ liệu sách:', err);
        }
    }
}

async function loadEnrichment(categories) {
    await Promise.all(Object.entries(categories).map(async ([category, entry]) => {
        if (!entry || typeof entry !== 'object') return;
        const files = Array.isArray(entry.enrichmentFiles) ? entry.enrichmentFiles : [];
        for (const suffix of files) {
            try {
                const response = await fetch(`data/book/${encodeURIComponent(category)}.${encodeURIComponent(suffix)}`);
                if (!response.ok) continue;
                const data = await response.json();
                if (suffix === 'classification.json' && data && typeof data === 'object') {
                    for (const [lessonId, body] of Object.entries(data)) {
                        if (body && Array.isArray(body.questions)) setQuestionClassification(lessonId, body.questions);
                    }
                } else if (suffix === 'images.json' && data && typeof data === 'object') {
                    for (const [lessonId, list] of Object.entries(data)) {
                        if (Array.isArray(list)) setLessonImages(lessonId, list);
                    }
                } else if (suffix === 'vietnamese.json' && data && typeof data === 'object') {
                    for (const [lessonId, list] of Object.entries(data)) {
                        if (Array.isArray(list)) setVietnameseExplanations(lessonId, list);
                    }
                }
            } catch (_err) {
                // enrichment is optional; skip silently
            }
        }
    }));
}

// Routes whose markup is built from the lazily loaded book payload.
const BOOK_CONTENT_ROUTES = new Set(['dashboard', 'lesson']);

async function bootstrap() {
    registerServiceWorker();
    setCurrentDate();
    initFuriganaToggle();
    wireSettingsButton();
    wireBottomNav();
    wireAccountButton();
    wirePetWidget();
    wireReviewSync();
    // Account setup is handled by the mandatory Google sign-in gate below.
    mountProfile('#profile-mount', { promptOnFirstVisit: false });

    // Auth sync — pull config, enforce the mandatory sign-in gate, listen
    // for sign-in, migrate legacy localStorage once, then pull cloud state
    // into the in-memory store.
    setTimeout(async () => {
        const sb = await supabaseReady();
        const user = sb ? await currentUser() : null;

        if (user) {
            markProfilePromptSeen();
        } else {
            openSignInGate();
            return;
        }

        if (!sb) return;

        // supabase-js re-emits SIGNED_IN / TOKEN_REFRESHED every time the tab
        // regains focus and whenever the access token rotates. Everything below
        // is idempotent, so replaying it for an account already synced buys
        // nothing and costs a full route re-render — which is what made pages
        // like the leaderboard blink back to their loading state at random.
        let syncedUserId = null;
        onAuthChange(async (authedUser) => {
            if (!authedUser) {
                syncedUserId = null;
                openSignInGate();
                return;
            }
            if (syncedUserId === authedUser.id) return;
            syncedUserId = authedUser.id;
            markProfilePromptSeen();
            try {
                const migrated = await maybeMigrateLocalData();
                if (migrated) console.info('[sync] localStorage migrated to Supabase');
                await maybeSeedProfileFromGoogle(authedUser);
                await pullFromCloud(authedUser.id);
                await flushCompletionQueue(authedUser.id);
                await flushReviewQueue(authedUser.id);
                petController?.update({ streak: Number((getStreak() || {}).streak) || 0 });
            } catch (err) {
                console.warn('[sync] bootstrap sync failed:', err);
            }
            // Refresh the current route so streak / leaderboard update.
            navigate(location.hash || '#/');
        });

        // Keep the leaderboard's display name/avatar current whenever the
        // profile dialog is saved while signed in. Uploaded photos are never
        // forwarded — see pushProfile in js/sync.js.
        window.addEventListener(PROFILE_UPDATED_EVENT, async (event) => {
            const profile = event.detail?.profile;
            if (!profile) return;
            const authedUser = await currentUser();
            if (!authedUser) return;
            try {
                await pushProfile(authedUser.id, {
                    displayName: profile.name,
                    avatarType: profile.avatarType,
                    avatarData: profile.avatarData,
                });
            } catch (err) {
                console.warn('[app] pushProfile failed:', err);
            }
        });
    }, 0);

    // Render the dashboard as soon as the tiny curriculum index is ready.
    // The multi-megabyte book payload enriches search and lesson bodies in the
    // background, then refreshes the active route once without blocking FCP.
    await loadLessons();

    const rootEl = document.getElementById('app');
    mountAppViewportFit(rootEl);
    initRouter(
        {
            dashboard: renderDashboard,
            lesson: renderLesson,
            tutor: renderTutor,
            voice: renderVoice,
            leaderboard: renderLeaderboard,
            exam: renderExam,
            profile: renderProfilePage,
            review: renderReview,
        },
        rootEl
    );

    void loadBookContent().then(() => {
        // Only these two routes read lesson bodies out of the book payload.
        // Repainting anything else once it lands throws away the page the user
        // is already reading — and re-runs its network calls — for no gain.
        if (BOOK_CONTENT_ROUTES.has(getCurrentRoute().name)) navigate(location.hash || '#/');
    });
}

document.addEventListener('DOMContentLoaded', bootstrap);
