export const PET_COMPANION_STATES = Object.freeze([
  'idle', 'look', 'walk', 'sleep', 'deep-sleep', 'advice',
]);

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

export function chooseNextPetState(current = 'idle', randomValue = Math.random()) {
  const candidates = PET_COMPANION_STATES.filter((state) => state !== current);
  return candidates[Math.floor(unitInterval(randomValue) * candidates.length)];
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
