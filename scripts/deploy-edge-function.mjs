// scripts/deploy-edge-function.mjs
// Deploy all Edge Functions (assumes supabase link already done).
// Reads SUPABASE_PAT from .env.local.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((line) => {
    const idx = line.indexOf('=');
    return idx < 0 ? null : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }).filter(Boolean));

const ref = env.SUPABASE_PROJECT_REF;
const pat = env.SUPABASE_PAT;
const gemini = env.GEMINI_API_KEY?.trim();

if (!pat) throw new Error('SUPABASE_PAT missing in .env.local');
if (!ref) throw new Error('SUPABASE_PROJECT_REF missing in .env.local');

function sh(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, shell: true, stdio: 'inherit', env: { ...process.env, SUPABASE_ACCESS_TOKEN: pat } });
  if (res.status !== 0) throw new Error(`${cmd} exited ${res.status}`);
}

// 1. Link project (idempotent if already linked)
sh('supabase', ['link', '--project-ref', ref]);

// 2. Set Gemini secret (server-side only)
if (gemini) {
  sh('supabase', ['secrets', 'set', `GEMINI_API_KEY=${gemini}`, '--project-ref', ref]);
} else {
  console.log('[skip] GEMINI_API_KEY empty in .env.local — set it later via:');
  console.log(`  supabase secrets set GEMINI_API_KEY=<key> --project-ref ${ref}`);
}

// 3. Deploy functions. Supabase defaults to verify-jwt=true since 2024, so
// no flag needed; explicit --verify-jwt would be defensive but the CLI
// rejects the boolean-negation form `--no-verify-jwt=false` on some versions.
const FUNCTIONS = ['evaluate-ai', 'gemini-proxy', 'mint-live-token', 'exam-fetch', 'exam-review', 'exam-review-explain'];
for (const fn of FUNCTIONS) {
  sh('supabase', ['functions', 'deploy', fn, '--project-ref', ref]);
}

console.log('DONE.');