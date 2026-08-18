// js/supabase.js
// Supabase client + auth glue.
// Public anon key is shipped to the browser; row-level security keeps every
// per-user table locked to its owner (see supabase/schema.sql).

import { createClient } from '../vendor/supabase.js';

let _client = null;
let _readyPromise = null;

/** Fetch /config.json and lazily build the Supabase client. Resolves the
 *  client on success, or `null` if config is missing / fetch failed. */
async function init() {
  if (_client || _readyPromise) return _readyPromise;
  _readyPromise = (async () => {
    let cfg = null;
    try {
      const res = await fetch('./config.json', { cache: 'no-store' });
      if (res.ok) cfg = await res.json();
    } catch {
      cfg = null;
    }
    if (!cfg || typeof cfg.url !== 'string' || typeof cfg.anonKey !== 'string') {
      console.warn('[supabase] URL/anon key not configured — running offline-only.');
      _client = null;
      return null;
    }
    _client = createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: localStorage,
        storageKey: 'n2_sb_session',
        detectSessionInUrl: true,
      },
    });
    return _client;
  })();
  return _readyPromise;
}

/** Resolve the Supabase client once credentials are available. */
export async function getClient() {
  if (_client) return _client;
  return init();
}

/** Resolve to true once the client has been built (or init has determined
 *  we're offline). Use this before calling dashboard / auth flows that need
 *  to know whether Supabase is reachable. */
export async function ready() {
  return init();
}

/** Trigger Google OAuth flow. Resolves once the redirect has been initiated. */
export async function signInWithGoogle() {
  const sb = await getClient();
  if (!sb) throw new Error('Supabase not configured');
  const redirectTo = `${location.origin}${location.pathname}`;
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  });
  if (error) throw error;
}

export async function signOut() {
  const sb = await getClient();
  if (!sb) return;
  await sb.auth.signOut();
}

export async function currentUser() {
  const sb = await getClient();
  if (!sb) return null;
  const { data, error } = await sb.auth.getUser();
  if (error) return null;
  return data.user ?? null;
}

/** Subscribe to auth state changes. Returns the subscription handle. */
export async function onAuthChange(handler) {
  const sb = await getClient();
  if (!sb) {
    handler(null);
    return { data: { subscription: { unsubscribe: () => {} } } };
  }
  return sb.auth.onAuthStateChange((_event, session) => handler(session?.user ?? null));
}

/** Look up the sanitized, authenticated leaderboard projection. */
export async function fetchLeaderboard(limit = 50) {
  const sb = await getClient();
  if (!sb) return [];
  const { data, error } = await sb.rpc('get_leaderboard', {
    p_limit: Math.max(1, Math.min(100, Number(limit) || 50)),
  });
  if (error) {
    console.warn('[supabase] leaderboard query failed:', error.message);
    return [];
  }
  return data || [];
}
