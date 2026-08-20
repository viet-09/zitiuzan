export const PET_COMPANION_STATES = Object.freeze([
  'wake', 'idle', 'look', 'walk', 'play', 'sleep', 'deep-sleep',
]);

// Only neighbouring poses are valid, so the mascot never snaps from sleep
// directly into a playful motion.
export const PET_STATE_TRANSITIONS = Object.freeze({
  wake: Object.freeze(['idle']),
  idle: Object.freeze(['look', 'walk', 'play', 'sleep']),
  look: Object.freeze(['idle']),
  walk: Object.freeze(['idle', 'play']),
  play: Object.freeze(['idle']),
  sleep: Object.freeze(['deep-sleep', 'wake']),
  'deep-sleep': Object.freeze(['wake']),
});

const GENERIC_ADVICE = Object.freeze([
  'Ôn lại một lỗi sai hôm nay sẽ nhẹ hơn học lại cả chương ngày mai.',
  'Đọc thành tiếng một câu Nhật giúp trí nhớ bám lâu hơn.',
  'Ba phút ôn đúng hạn vẫn có giá trị hơn một buổi học quá sức.',
  'Khi phân vân, hãy giải thích đáp án bằng lời của chính bạn.',
]);

function unitInterval(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(0.999999, Math.max(0, number));
}

function validState(state) {
  return PET_COMPANION_STATES.includes(state) ? state : 'idle';
}

export function chooseNextPetState(current = 'idle', randomValue = Math.random()) {
  const candidates = PET_STATE_TRANSITIONS[validState(current)] || PET_STATE_TRANSITIONS.idle;
  return candidates[Math.floor(unitInterval(randomValue) * candidates.length)];
}

export function getPetStatePath(from = 'idle', to = 'idle') {
  const start = validState(from);
  const target = validState(to);
  if (start === target) return [start];
  const queue = [[start]];
  const visited = new Set([start]);
  while (queue.length) {
    const path = queue.shift();
    const current = path[path.length - 1];
    for (const next of PET_STATE_TRANSITIONS[current]) {
      if (visited.has(next)) continue;
      const nextPath = [...path, next];
      if (next === target) return nextPath;
      visited.add(next);
      queue.push(nextPath);
    }
  }
  return ['idle'];
}

export function getContextualPetAdvice(coach = {}, randomValue = Math.random()) {
  const reason = String(coach?.quest?.reason || '').trim();
  if (reason) return reason;
  return GENERIC_ADVICE[Math.floor(unitInterval(randomValue) * GENERIC_ADVICE.length)];
}

export function clampPetPosition(position, viewport, petSize, options = {}) {
  const width = Math.max(1, Number(viewport?.width) || 1);
  const height = Math.max(1, Number(viewport?.height) || 1);
  const petWidth = Math.max(1, Number(petSize?.width) || 1);
  const petHeight = Math.max(1, Number(petSize?.height) || 1);
  const rightPanelWidth = Math.max(0, Number(options.rightPanelWidth) || 0);
  const bottomInset = Math.max(0, Number(options.bottomInset) || 0);
  const minX = -6;
  const maxX = Math.max(minX, width - petWidth - rightPanelWidth - 14);
  const minY = -petHeight - 40;
  const maxY = Math.max(minY, height - petHeight - bottomInset);
  return {
    x: Math.min(maxX, Math.max(minX, Number(position?.x) || 0)),
    y: Math.min(maxY, Math.max(minY, Number(position?.y) || 0)),
  };
}
