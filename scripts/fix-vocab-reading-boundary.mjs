// scripts/fix-vocab-reading-boundary.mjs
// Root-cause fix for a systemic extraction bug: the vocab_grammar and reading
// answer-key extraction calls read the SAME single answer-key page image
// (see extract_exam_v2.py's answer_task_for_v2 / extract_exam.py's
// answer_task_for), each told to "extract ONLY this section's items, ignore
// the rest" — but Gemini sometimes misjudges exactly where one section's
// item numbers end and the other's begin, collapses a section's part groups
// into fewer/wrong groups, or double-counts a boundary item once per
// mis-split group (producing two candidate answer rows for the same
// question number, one of them usually carrying a corrupted, out-of-range
// answerIndex — an artifact of the same mis-split, not independent noise).
//
// Fix: pool every item from BOTH answer:vocab_grammar and answer:reading,
// regroup by NUMBER alone (ignoring whatever bogus part/section label each
// carries), reassign the correct section+part from a ground-truth
// number->{section,part} map built off the ALREADY-CORRECT exam:vocab_grammar
// + exam:reading structure (question numbers are globally unique and
// contiguous across both sections, never restarting, unlike listening).
// When a number has multiple candidate answer rows, keep the one(s) whose
// answerIndex actually falls in that question's valid option range and
// discard the rest; a number with zero valid candidates is left as a gap
// for the AI-resolve fallback (scripts/resolve_answer_gaps.py) to handle.
//
// Usage: node scripts/fix-vocab-reading-boundary.mjs 2014-07 [2017-12 ...]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAM_DATA_DIR = path.join(ROOT, 'data', 'exams');

function partNumber(label) {
  const m = /(\d+)/.exec(String(label ?? ''));
  return m ? Number(m[1]) : -1;
}

function fixSitting(sitting) {
  const draftPath = path.join(EXAM_DATA_DIR, `n2-${sitting}.draft.json`);
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));

  // number -> {section, part, numOptions}
  const numberToTruth = new Map();
  for (const sectionId of ['vocab_grammar', 'reading']) {
    for (const part of draft[`exam:${sectionId}`].parts) {
      for (const q of part.questions) {
        numberToTruth.set(q.number, {
          section: sectionId,
          part: `問題${partNumber(part.part)}`,
          numOptions: Array.isArray(q.options) ? q.options.length : 4,
        });
      }
    }
  }

  const pooled = [
    ...draft['answer:vocab_grammar'].items,
    ...draft['answer:reading'].items,
  ];

  // Group candidates by number, ignoring their (possibly bogus) part/section.
  const byNumber = new Map();
  const orphans = [];
  for (const item of pooled) {
    const truth = numberToTruth.get(item.number);
    if (!truth) { orphans.push(item); continue; }
    if (!byNumber.has(item.number)) byNumber.set(item.number, []);
    byNumber.get(item.number).push(item);
  }
  if (orphans.length > 0) {
    console.log(`${sitting}: ${orphans.length} orphan item(s) (number not in either section's exam) — left unfixed: ${orphans.map((o) => o.number).join(',')}`);
  }

  const bySection = { vocab_grammar: [], reading: [] };
  let deduped = 0;
  let stillGapped = 0;
  for (const [number, candidates] of byNumber) {
    const truth = numberToTruth.get(number);
    const valid = candidates.filter((c) => Number.isInteger(c.answerIndex) && c.answerIndex >= 0 && c.answerIndex < truth.numOptions);
    let chosen;
    if (valid.length === 1) {
      chosen = valid[0];
      if (candidates.length > 1) deduped += 1;
    } else if (valid.length > 1) {
      // Ambiguous — multiple in-range candidates disagree. Keep the first
      // but flag it; resolve_answer_gaps.py's AI pass double-checks it below
      // by treating it as gapped only if the disagreement is a real split.
      chosen = valid[0];
    } else {
      chosen = candidates[0] ?? { number, answerIndex: -1, referenceNote: '' };
      stillGapped += 1;
    }
    bySection[truth.section].push({ ...chosen, part: truth.part, number });
  }

  const expectedVg = draft['exam:vocab_grammar'].parts.reduce((s, p) => s + p.questions.length, 0);
  const expectedRd = draft['exam:reading'].parts.reduce((s, p) => s + p.questions.length, 0);
  bySection.vocab_grammar.sort((a, b) => a.number - b.number);
  bySection.reading.sort((a, b) => a.number - b.number);

  draft['answer:vocab_grammar'].items = bySection.vocab_grammar;
  draft['answer:reading'].items = bySection.reading;
  fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2));
  console.log(`${sitting}: vocab_grammar=${bySection.vocab_grammar.length}/${expectedVg} reading=${bySection.reading.length}/${expectedRd} — deduped ${deduped}, still gapped ${stillGapped}`);
}

const sittings = process.argv.slice(2);
if (sittings.length === 0) throw new Error('usage: node scripts/fix-vocab-reading-boundary.mjs <sitting> [sitting...]');
for (const sitting of sittings) fixSitting(sitting);
