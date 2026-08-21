// Adaptive mini-test: turns the learner's own scheduled mistakes into a short
// focused check, records the result back into SRS, and immediately recalculates
// JLPT readiness from the same evidence model used by the dashboard.

import { getLessons, getProgressMap, setTutorContext, clearTutorHistory } from './store.js';
import { learningState } from './learning-state.js';
import { buildMiniTest, buildWeaknessProfile, calculateReadiness, formatWeaknessContext } from './learning-engine.js';
import { examHistoryStore } from './exam-history.js';
import { renderFurigana } from './furigana.js';
import { navigate } from './router.js';
import { recordPetMemory } from './pet.js?v=21';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function readiness() {
  return calculateReadiness({
    lessons: getLessons(),
    progress: getProgressMap(),
    reviews: learningState.getReviews(),
    examHistory: examHistoryStore.get(),
  });
}

export function renderReview(root) {
  const questions = buildMiniTest(learningState.getReviews(), { limit: 5 });
  const initialReadiness = readiness();
  let index = 0;
  let selectedIndex = -1;
  let score = 0;
  let finished = false;
  let memoryRecorded = false;

  const paintEmpty = () => {
    root.innerHTML = `
      <section class="review-session review-session--empty">
        <p class="eyebrow">Mini-test thích ứng</p>
        <h1 class="section-heading" data-route-heading>Chưa đủ dữ liệu lỗi</h1>
        <p>Hãy làm phần luyện tập trong một bài học. Câu bạn nhầm sẽ tự động xuất hiện ở đây đúng lịch ôn.</p>
        <button type="button" class="complete-modal-btn" data-review-home>Về lộ trình hôm nay</button>
      </section>`;
  };

  const paintResult = () => {
    const current = readiness();
    const delta = current.overall - initialReadiness.overall;
    const deltaLabel = delta > 0 ? `+${delta}` : String(delta);
    if (!memoryRecorded) {
      memoryRecorded = true;
      recordPetMemory({
        type: 'mini-test',
        title: `Hoàn thành mini-test ${score}/${questions.length}`,
        detail: `${deltaLabel} điểm mức sẵn sàng JLPT`,
      });
    }
    root.innerHTML = `
      <section class="review-session review-result">
        <p class="eyebrow">Vòng lặp đã cập nhật</p>
        <h1 class="section-heading" data-route-heading>${score}/${questions.length} câu đúng</h1>
        <div class="review-result__readiness" aria-label="Mức sẵn sàng hiện tại ${current.overall}%">
          <span>Mức sẵn sàng hiện tại</span><strong>${current.overall}%</strong><small>${deltaLabel} điểm sau mini-test · độ tin cậy ${current.confidence === 'high' ? 'cao' : current.confidence === 'medium' ? 'vừa' : 'thấp'}</small>
        </div>
        <p>Kết quả vừa được ghi lại vào lịch ôn. Gia sư cũng đã nhận hồ sơ điểm yếu mới nhất.</p>
        <div class="review-result__actions">
          <button type="button" class="complete-modal-btn" data-review-tutor>Hỏi gia sư về điểm yếu</button>
          <button type="button" class="tts-btn back-btn" data-review-home>Về lộ trình</button>
        </div>
      </section>`;
  };

  const paintQuestion = () => {
    const question = questions[index];
    const answered = selectedIndex >= 0;
    const options = question.options.map((option, optionIndex) => {
      const classes = ['quiz-option'];
      if (answered && optionIndex === question.correctIndex) classes.push('is-correct');
      else if (answered && optionIndex === selectedIndex) classes.push('is-incorrect');
      return `<button type="button" class="${classes.join(' ')}" data-review-option="${optionIndex}"${answered ? ' disabled' : ''} lang="ja">${renderFurigana(option)}</button>`;
    }).join('');
    const nextLabel = index === questions.length - 1 ? 'Xem kết quả' : 'Câu tiếp theo';
    root.innerHTML = `
      <section class="review-session">
        <header class="review-session__head">
          <button type="button" class="tts-btn back-btn" data-review-home>← Lộ trình</button>
          <span>Câu ${index + 1}/${questions.length}</span>
        </header>
        <progress class="review-session__progress" max="${questions.length}" value="${index + (answered ? 1 : 0)}" aria-label="Tiến độ mini-test"></progress>
        <p class="eyebrow">${escapeHtml(question.categoryId)} · lỗi đã ghi</p>
        <h1 class="section-heading" data-route-heading>Mini-test điểm yếu</h1>
        <article class="review-question quiz-question${answered ? ' is-answered' : ''}">
          <div class="quiz-q-text" lang="ja">${renderFurigana(question.prompt)}</div>
          <div class="quiz-options">${options}</div>
          ${answered ? `<div class="quiz-explain" role="status">${selectedIndex === question.correctIndex ? 'Chính xác — lịch ôn đã được giãn ra.' : `Đáp án đúng: ${escapeHtml(question.correctAnswer)}`}</div>` : ''}
        </article>
        ${answered ? `<button type="button" class="complete-modal-btn review-next" data-review-next>${nextLabel}</button>` : '<p class="review-hint">Chọn một đáp án để cập nhật lịch ôn.</p>'}
      </section>`;
  };

  const paint = () => {
    if (!questions.length) paintEmpty();
    else if (finished) paintResult();
    else paintQuestion();
  };

  const onClick = (event) => {
    if (event.target.closest('[data-review-home]')) {
      navigate('#/');
      return;
    }
    if (event.target.closest('[data-review-tutor]')) {
      const profile = buildWeaknessProfile(learningState.getReviews(), { limit: 5 });
      clearTutorHistory();
      setTutorContext({
        category: 'Ôn tập thích ứng',
        title: 'Mini-test điểm yếu',
        content: formatWeaknessContext(profile),
      });
      navigate('#/tutor');
      return;
    }
    const option = event.target.closest('[data-review-option]');
    if (option && selectedIndex < 0) {
      const question = questions[index];
      selectedIndex = Number(option.dataset.reviewOption);
      const correct = selectedIndex === question.correctIndex;
      if (correct) score += 1;
      learningState.recordReview({
        key: question.reviewKey,
        lessonId: question.lessonId,
        categoryId: question.categoryId,
        prompt: question.prompt,
        options: question.options,
        correctIndex: question.correctIndex,
        correctAnswer: question.correctAnswer,
        selectedAnswer: question.options[selectedIndex] || '',
        correct,
        source: 'mini-test',
        now: new Date(),
      });
      paint();
      return;
    }
    if (event.target.closest('[data-review-next]') && selectedIndex >= 0) {
      if (index >= questions.length - 1) finished = true;
      else {
        index += 1;
        selectedIndex = -1;
      }
      paint();
    }
  };

  root.addEventListener('click', onClick);
  paint();
  return {
    preserveScroll: false,
    cleanup() { root.removeEventListener('click', onClick); },
  };
}
