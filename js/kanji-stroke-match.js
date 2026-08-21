// Compares a hand-drawn stroke against the stroke KanjiVG says comes next.
//
// Everything works in the character's own 0..1 box, NOT in each stroke's own
// bounding box. Normalising per stroke would make every horizontal line match
// every other horizontal line, and 一 written across the bottom of 三 would be
// accepted as its first stroke — position is half of what stroke order means.
//
// Pure module: no DOM, no canvas. js/kanji-writing.js samples the SVG paths and
// hands the polylines in.

export const STROKE_SAMPLES = 16;

export const STROKE_TOLERANCE = Object.freeze({
  // Mean distance between paired sample points, in units of the character box.
  // 0.14 is roughly 72px on the 512px pad: forgiving of wobbly handwriting,
  // still tight enough that a stroke in the wrong place fails.
  meanDistance: 0.14,
  // No single sample point may wander this far, so a stroke cannot pass by
  // being right on average while one end is somewhere else entirely.
  maxDistance: 0.26,
  // A drawn stroke shorter than this fraction of the expected one is a dab
  // rather than a stroke.
  minLengthRatio: 0.45,
  // How near the expected start the pen must land before a short stroke is
  // read as "you stopped early" rather than "that is a different stroke".
  // Deliberately tighter than maxDistance: neighbouring strokes inside one
  // radical begin close together, and telling someone to finish a stroke they
  // never started sends them looking in the wrong place.
  startProximity: 0.12,
  // How much better the reversed fit has to be before the verdict changes from
  // "wrong place" to the more useful "right shape, drawn backwards".
  reversalMargin: 0.04,
});

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Total length along a polyline. */
export function polylineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index]);
  return total;
}

/**
 * Resample a polyline to `count` evenly spaced points.
 *
 * Raw pointer input bunches up where the hand slowed down, so comparing raw
 * samples would score speed as much as shape.
 */
export function resamplePolyline(points, count = STROKE_SAMPLES) {
  const source = (points || []).filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
  if (source.length === 0) return [];
  if (source.length === 1 || count < 2) return Array.from({ length: count }, () => ({ ...source[0] }));

  const total = polylineLength(source);
  if (total === 0) return Array.from({ length: count }, () => ({ ...source[0] }));

  const step = total / (count - 1);
  const output = [{ ...source[0] }];
  let segment = 1;
  let walked = 0;

  for (let index = 1; index < count - 1; index += 1) {
    const target = step * index;
    while (segment < source.length - 1 && walked + distance(source[segment - 1], source[segment]) < target) {
      walked += distance(source[segment - 1], source[segment]);
      segment += 1;
    }
    const from = source[segment - 1];
    const to = source[segment];
    const span = distance(from, to) || 1;
    const ratio = Math.min(1, Math.max(0, (target - walked) / span));
    output.push({ x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio });
  }
  output.push({ ...source[source.length - 1] });
  return output;
}

/** Mean and worst paired-point distance between two equal-length polylines. */
function compare(drawn, expected) {
  let sum = 0;
  let worst = 0;
  for (let index = 0; index < drawn.length; index += 1) {
    const gap = distance(drawn[index], expected[index]);
    sum += gap;
    if (gap > worst) worst = gap;
  }
  return { mean: sum / drawn.length, worst };
}

/**
 * Judge one drawn stroke.
 *
 * @param {{x:number,y:number}[]} drawnPoints pointer path in 0..1 character space
 * @param {{x:number,y:number}[]} expectedPoints the KanjiVG stroke, same space
 * @param {object} [tolerance] override for {@link STROKE_TOLERANCE}
 * @returns {{ok: boolean, reason: string, mean: number, worst: number}}
 *   `reason` is '' when accepted, else 'too-short' | 'backwards' | 'wrong-place'
 */
export function matchStroke(drawnPoints, expectedPoints, tolerance = {}) {
  const limits = { ...STROKE_TOLERANCE, ...tolerance };
  const drawn = resamplePolyline(drawnPoints);
  const expected = resamplePolyline(expectedPoints);
  if (drawn.length !== expected.length || !drawn.length) {
    return { ok: false, reason: 'wrong-place', mean: Infinity, worst: Infinity };
  }

  const forward = compare(drawn, expected);
  const backward = compare(drawn, [...expected].reverse());
  const verdict = (ok, reason) => ({ ok, reason, mean: forward.mean, worst: forward.worst });

  // Stopping early. Only counts as "too short" when the pen did start where
  // this stroke starts — otherwise the learner is drawing a different stroke
  // altogether and being told to finish it would send them the wrong way.
  const drawnLength = polylineLength(drawn);
  const expectedLength = polylineLength(expected);
  const startedHere = distance(drawn[0], expected[0]) <= limits.startProximity;
  if (expectedLength > 0 && drawnLength / expectedLength < limits.minLengthRatio) {
    return verdict(false, startedHere ? 'too-short' : 'wrong-place');
  }

  // Direction is checked BEFORE accepting, not as a fallback. A short stroke
  // written backwards still lands within tolerance of itself — its two ends are
  // closer together than the tolerance — so testing the forward fit first
  // accepted plenty of strokes drawn the wrong way round. Whenever the reverse
  // is the better explanation of what was drawn, that is what happened.
  const reversedFitsBetter = backward.mean + limits.reversalMargin < forward.mean
    && backward.mean <= limits.meanDistance
    && backward.worst <= limits.maxDistance;
  if (reversedFitsBetter) return verdict(false, 'backwards');

  if (forward.mean <= limits.meanDistance && forward.worst <= limits.maxDistance) {
    return verdict(true, '');
  }
  return verdict(false, 'wrong-place');
}

export const STROKE_FEEDBACK = Object.freeze({
  'too-short': 'Nét còn quá ngắn — viết trọn nét rồi thả bút.',
  backwards: 'Đúng nét nhưng sai chiều — viết theo hướng mũi tên.',
  'wrong-place': 'Chưa đúng nét này. Xem nét mờ được gợi ý rồi viết lại.',
});
