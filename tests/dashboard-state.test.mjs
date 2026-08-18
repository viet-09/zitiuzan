import test from 'node:test';
import assert from 'node:assert/strict';

import { initialExpandedWeeks } from '../js/dashboard-state.js';

const lessons = {
  categories: [
    {
      id: 'kanji',
      weeks: [
        { week: 1, lessons: [{ id: 'k1d1' }, { id: 'k1d2' }] },
        { week: 2, lessons: [{ id: 'k2d1' }] },
      ],
    },
    {
      id: 'grammar',
      weeks: [
        { week: 1, lessons: [{ id: 'g1d1' }] },
        { week: 2, lessons: [{ id: 'g2d1' }] },
      ],
    },
  ],
};

test('dashboard expands only the first unfinished week in every skill', () => {
  const expanded = initialExpandedWeeks(lessons, (id) => id === 'k1d1' || id === 'k1d2');
  assert.deepEqual([...expanded], ['kanji:2', 'grammar:1']);
});

test('completed skills keep their final week available without expanding everything', () => {
  const expanded = initialExpandedWeeks(lessons, () => true);
  assert.deepEqual([...expanded], ['kanji:2', 'grammar:2']);
});
