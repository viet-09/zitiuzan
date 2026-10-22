import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// js/gemini.js imports browser-only modules at load time (store.js touches
// localStorage, supabase.js pulls the CDN client), so the timeout classifier
// is exercised through a tiny extraction rather than a DOM shim. Keep the
// function body byte-identical to the source and fail loudly if it drifts.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'js/gemini.js'), 'utf8');

const match = source.match(/export function isInvokeTimeout\(error\) \{[\s\S]*?\n\}/);
assert.ok(match, 'js/gemini.js must export isInvokeTimeout(error)');
const isInvokeTimeout = new Function(`${match[0].replace('export ', '')}; return isInvokeTimeout;`)();

/** supabase-js wraps the original fetch rejection in `.context`. */
function functionsFetchError(context) {
  const err = new Error('Failed to send a request to the Edge Function');
  err.name = 'FunctionsFetchError';
  err.context = context;
  return err;
}

function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

test('a supabase-js FunctionsFetchError wrapping an AbortError counts as a timeout', () => {
  // The error's own message never mentions a timeout — the only signal is the
  // wrapped AbortError in .context.
  assert.equal(isInvokeTimeout(functionsFetchError(abortError())), true);
});

test('a DOMException-style TimeoutError counts as a timeout', () => {
  const err = new Error('signal timed out');
  err.name = 'TimeoutError';
  assert.equal(isInvokeTimeout(err), true);
});

test('an HTTP error carrying a Response context is not a timeout', () => {
  const httpError = new Error('Edge Function returned a non-2xx status code');
  httpError.name = 'FunctionsHttpError';
  httpError.context = { status: 502, clone: () => ({ json: async () => ({ error: 'Gemini request failed' }) }) };
  assert.equal(isInvokeTimeout(httpError), false);
});

test('a plain network failure is not reported as a timeout', () => {
  assert.equal(isInvokeTimeout(functionsFetchError(new TypeError('Failed to fetch'))), false);
});

test('a bare timeout message is still recognized', () => {
  assert.equal(isInvokeTimeout(new Error('request timed out')), true);
  assert.equal(isInvokeTimeout(null), false);
});

test('the client timeout outlasts one server-side model attempt', () => {
  const clientTimeout = Number(source.match(/CLIENT_TIMEOUT_MS = ([\d_]+)/)[1].replace(/_/g, ''));
  const serverSource = fs.readFileSync(
    path.join(root, 'supabase/functions/_shared/gemini-models.js'), 'utf8');
  const serverTimeout = Number(serverSource.match(/REQUEST_TIMEOUT_MS = ([\d_]+)/)[1].replace(/_/g, ''));
  assert.ok(
    clientTimeout > serverTimeout,
    `client timeout (${clientTimeout}ms) must exceed one server model attempt (${serverTimeout}ms)`
  );
});
