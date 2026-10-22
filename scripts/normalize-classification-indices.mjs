// scripts/normalize-classification-indices.mjs
// Shifts 1-based question classifications to 0-based.
//
// In 111 of 225 lessons, Gemini output questions indexed from 1..N instead of
// 0..N-1. Since js/store.js's getQuestionClassification looks up by the
// question's 0-based array index, every 1-based lesson was off by one: question
// #0 had no classification badge at all, and question #1 showed the badge
// intended for question #0.
//
// This migration detects any lesson whose minimum index is 1 and shifts every
// question's index down by 1.

import fs from 'node:fs';
import path from 'node:path';

const BOOK_DIR = 'data/book';
const CATEGORIES = ['kanji', 'vocabulary', 'grammar', 'reading', 'listening'];

let totalShiftedLessons = 0;
let totalShiftedQuestions = 0;

for (const cat of CATEGORIES) {
  const filePath = path.join(BOOK_DIR, `${cat}.classification.json`);
  if (!fs.existsSync(filePath)) continue;

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let fileModified = false;

  for (const [lessonId, body] of Object.entries(data)) {
    if (!body || !Array.isArray(body.questions) || body.questions.length === 0) continue;
    const indices = body.questions.map((q) => Number(q.index)).sort((a, b) => a - b);
    const n = body.questions.length;

    // Detect pure 1-based: indices start at 1, end at n, with no duplicates.
    const isOneBased = indices[0] === 1 && indices[n - 1] === n && new Set(indices).size === n;
    if (isOneBased) {
      body.questions.forEach((q) => {
        q.index = Number(q.index) - 1;
        totalShiftedQuestions += 1;
      });
      totalShiftedLessons += 1;
      fileModified = true;
    }
  }

  if (fileModified) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`Updated ${filePath}`);
  }
}

console.log(`Normalized ${totalShiftedLessons} lessons (${totalShiftedQuestions} questions) to 0-based.`);
