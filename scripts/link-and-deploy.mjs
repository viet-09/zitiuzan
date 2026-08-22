// scripts/link-and-deploy.mjs
// Deploys all Edge Functions + the Gemini secret directly against the cloud
// project via --project-ref. Does NOT run `supabase link` — that command's
// "fetch API keys" step hits a CLI schema-validation bug against projects
// using Supabase's newer publishable/secret key format (SchemaError on
// inserted_at), and it isn't actually needed: every command below already
// takes --project-ref explicitly, which is the documented way to target a
// project without linking (see supabase functions deploy --help).
// Reads SUPABASE_PAT / SUPABASE_PROJECT_REF / GEMINI_API_KEY from .env.local.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((line) => {
    const idx = line.indexOf('=');
    return idx < 0 ? null : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }).filter(Boolean));

const ref = env.SUPABASE_PROJECT_REF;
const pat = env.SUPABASE_PAT;

if (!ref) throw new Error('missing SUPABASE_PROJECT_REF in .env.local');
if (!pat) throw new Error('missing SUPABASE_PAT in .env.local — required to authenticate `secrets set` / `functions deploy`');

function run(cmd, args, label) {
  console.log(`\n=== ${label} ===`);
  try {
    execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: true, env: { ...process.env, SUPABASE_ACCESS_TOKEN: pat } });
  } catch (err) {
    console.error(`[${label}] failed:`, err.message);
    throw err;
  }
}

const SUPABASE_BIN = process.env.SUPABASE_BIN || 'supabase';
const supabase = (args, label) => run(SUPABASE_BIN, args, label);

// 1. Set Gemini secret (Edge Function env). Skip if GEMINI_API_KEY empty.
const gemini = env.GEMINI_API_KEY?.trim();
if (gemini) {
  supabase(['secrets', 'set', `GEMINI_API_KEY=${gemini}`, '--project-ref', ref], 'secrets set GEMINI_API_KEY');
} else {
  console.log('\n[skip] GEMINI_API_KEY empty in .env.local — set it later via:');
  console.log(`  supabase secrets set GEMINI_API_KEY=<key> --project-ref ${ref}`);
}

// 2. Deploy Edge Functions
const FUNCTIONS = ['gemini-proxy', 'mint-live-token', 'exam-fetch', 'exam-review', 'exam-review-explain', 'lesson-review-quiz'];
for (const fn of FUNCTIONS) {
  supabase(['functions', 'deploy', fn, '--project-ref', ref, '--no-verify-jwt=false'], `functions deploy ${fn}`);
}

console.log('\nDONE.');