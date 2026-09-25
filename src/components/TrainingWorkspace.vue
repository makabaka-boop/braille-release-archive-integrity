<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import {
  SESSION_LENGTH,
  createTrainingService,
  type BankEntry
} from '../lib/training';
import CellView from './CellView.vue';

/**
 * 识读训练工作区：只消费训练领域服务输出的快照契约，
 * 不读取也不改写单稿预检、双稿核对或试压校准的任何状态。
 * 局次不做本地保存：刷新页面或离开本工作区即直接结束未完成局次。
 */
const service = createTrainingService();
const snapshot = ref(service.getSnapshot());

// 题目生成失败（如种子异常）时的“无法开局”反馈；此时不出现任何题卡。
const startError = ref<string | null>(null);
// 当前题已选中的选项字符；提交后保留用于标记，下一题时清空。
const picked = ref<string | null>(null);

const phase = computed(() => snapshot.value.phase);
const question = computed(() => snapshot.value.currentQuestion);
const feedback = computed(() => snapshot.value.lastSubmit);
const score = computed(() => snapshot.value.score);
const inSession = computed(() => phase.value === 'answering' || phase.value === 'reviewing');
const isLastQuestion = computed(() => snapshot.value.currentIndex >= SESSION_LENGTH - 1);

function sync() {
  snapshot.value = service.getSnapshot();
}

function startSession() {
  startError.value = null;
  picked.value = null;
  // 种子取自当前时间戳；题序与选项顺序由领域层按种子确定。
  const result = service.start(Date.now());
  if (!result.ok) {
    startError.value = result.message;
  }
  sync();
}

function choose(option: BankEntry) {
  if (phase.value !== 'answering') {
    return;
  }
  picked.value = option.character;
}

function submit() {
  if (picked.value === null || phase.value !== 'answering') {
    return;
  }
  service.submit(picked.value);
  sync();
}

function next() {
  picked.value = null;
  service.next();
  sync();
}

// 离开工作区（切换到其他模式）即结束未完成局次，不做本地保存。
onUnmounted(() => {
  service.abort();
});
</script>

<template>
  <section class="panel training-panel" aria-label="识读训练">
    <p class="training-note">
      点位识读练习：每局依次展示 {{ SESSION_LENGTH }} 张盲文方卡片，从四个字符选项中选出正确字符，
      提交后立即显示正确字符与点号说明，局末汇总答对数与错题。
      训练局次不读取也不改写单稿预检、双稿核对与试压校准的数据；刷新或离开本工作区即结束未完成局次，不做本地保存。
    </p>
    <div class="training-toolbar">
      <button
        type="button"
        class="compare-btn training-start"
        data-testid="training-start"
        :disabled="inSession"
        @click="startSession"
      >
        {{ phase === 'finished' ? '再练一局' : '开始训练' }}
      </button>
      <span v-if="inSession" class="training-hint" data-testid="training-hint">
        局次进行中，完成本局后才能再次开局
      </span>
    </div>
  </section>

  <section v-if="startError" class="panel errors" role="alert" data-testid="training-error">
    <h2>无法开局</h2>
    <p>{{ startError }}</p>
  </section>

  <section
    v-if="question && inSession"
    class="panel training-card"
    data-testid="training-question"
    aria-label="识读题卡"
  >
    <h2 class="training-progress" data-testid="training-progress">
      第 {{ snapshot.currentIndex + 1 }} / {{ SESSION_LENGTH }} 题
    </h2>

    <div class="training-cell" data-testid="training-cell">
      <CellView :cell="question.cell" />
    </div>

    <div class="training-options" role="group" aria-label="字符选项">
      <button
        v-for="option in question.options"
        :key="option.character"
        type="button"
        class="training-option"
        :class="{
          picked: picked === option.character,
          'is-correct': phase === 'reviewing' && feedback?.answer.character === option.character,
          'is-wrong': phase === 'reviewing' && feedback?.picked.character === option.character && !feedback?.correct
        }"
        :disabled="phase !== 'answering'"
        :aria-pressed="picked === option.character"
        :data-char="option.character"
        data-testid="training-option"
        @click="choose(option)"
      >
        {{ option.character }}
      </button>
    </div>

    <button
      type="button"
      class="compare-btn training-submit"
      data-testid="training-submit"
      :disabled="phase !== 'answering' || picked === null"
      @click="submit"
    >
      提交答案
    </button>

    <div
      v-if="phase === 'reviewing' && feedback"
      class="training-feedback"
      :class="feedback.correct ? 'verdict-right' : 'verdict-wrong'"
      :data-correct="feedback.correct ? 'true' : 'false'"
      role="status"
      data-testid="training-feedback"
    >
      <p class="feedback-verdict" data-testid="training-verdict">
        {{ feedback.correct ? '回答正确' : '回答错误' }}
      </p>
      <p data-testid="training-answer">
        正确字符：{{ feedback.answer.character }}（{{ feedback.answer.description }}）
      </p>
      <p data-testid="training-dots">点号说明：{{ feedback.dotNote }}（点号 {{ feedback.answer.cell }}）</p>
      <button type="button" class="compare-btn training-next" data-testid="training-next" @click="next">
        {{ isLastQuestion ? '查看成绩' : '下一题' }}
      </button>
    </div>
  </section>

  <section
    v-if="phase === 'finished' && score"
    class="panel training-score"
    role="status"
    data-testid="training-score"
    aria-label="本局成绩"
  >
    <h2>本局成绩</h2>
    <p class="score-summary" data-testid="training-score-summary">
      共 {{ score.total }} 题，答对 {{ score.correct }} 题，答错 {{ score.wrong.length }} 题。
    </p>
    <p v-if="score.wrong.length === 0" class="score-perfect" data-testid="training-all-correct">
      全部答对，没有错题。
    </p>
    <ul v-else class="wrong-list" data-testid="training-wrong-list">
      <li v-for="record in score.wrong" :key="record.question.index" class="wrong-item" data-testid="training-wrong-item">
        <span class="wrong-text">
          第 {{ record.question.index + 1 }} 题：正确字符 {{ record.question.answer.character }}（点号
          {{ record.question.answer.cell }}），你选择了 {{ record.picked.character }}
        </span>
        <CellView :cell="record.question.cell" />
      </li>
    </ul>
  </section>
</template>
