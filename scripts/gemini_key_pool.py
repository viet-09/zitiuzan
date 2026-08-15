"""Shared multi-key pool + automatic failover for local Python batch scripts
that call the Gemini API directly. One key hitting its free-tier daily quota
no longer stalls the whole batch — the next key in the pool is tried
automatically. Mirrors scripts/lib/gemini-key-pool.mjs and
supabase/functions/_shared/gemini-key-pool.ts.

Usage:
    from gemini_key_pool import load_key_pool, KeyRotator, GeminiKeyError

    keys = load_key_pool()  # reads GEMINI_API_KEYS (comma-separated) or GEMINI_API_KEY
    rotator = KeyRotator(keys)
    result = rotator.run(lambda key: do_the_actual_call(key))
"""

from __future__ import annotations

import os
import time
from typing import Callable, TypeVar

T = TypeVar("T")

# Invalid/revoked key (401/403), quota exhausted (429), or a transient
# upstream error (5xx) are worth trying the next key for. A genuine 400
# (bad request shape) would fail identically on every key.
RETRYABLE_STATUSES = {401, 403, 429, 500, 502, 503, 504}
COOLDOWN_SECONDS = 60 * 60  # 1 hour; daily quotas reset once/day anyway


class GeminiKeyError(Exception):
    """Raised by an attempt(key) callback to signal a retryable failure."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def load_key_pool() -> list[str]:
    multi = os.environ.get("GEMINI_API_KEYS", "")
    keys = list(dict.fromkeys(k.strip() for k in multi.split(",") if k.strip()))
    if keys:
        return keys
    single = os.environ.get("GEMINI_API_KEY", "").strip()
    return [single] if single else []


class KeyRotator:
    """Tries each key in the pool, starting from the last key that
    succeeded, skipping any currently in cooldown."""

    def __init__(self, keys: list[str]) -> None:
        self._keys = keys
        self._index = 0
        self._cooldown_until: dict[str, float] = {}

    def has_keys(self) -> bool:
        return len(self._keys) > 0

    def run(self, attempt: Callable[[str], T]) -> T:
        if not self._keys:
            raise RuntimeError("No Gemini API key configured (set GEMINI_API_KEY or GEMINI_API_KEYS).")

        now = time.monotonic()
        order = [(self._index + i) % len(self._keys) for i in range(len(self._keys))]
        last_err: Exception | None = None

        for idx in order:
            key = self._keys[idx]
            if self._cooldown_until.get(key, 0.0) > now:
                continue
            try:
                result = attempt(key)
                self._index = idx
                return result
            except GeminiKeyError as err:
                last_err = err
                if err.status not in RETRYABLE_STATUSES:
                    raise
                self._cooldown_until[key] = now + COOLDOWN_SECONDS
                print(f"Gemini key #{idx} failed (status {err.status}) — trying next key in pool")

        raise last_err or RuntimeError("All Gemini API keys exhausted or invalid")
