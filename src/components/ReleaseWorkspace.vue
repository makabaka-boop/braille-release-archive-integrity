<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  createReleaseSlip,
  evaluateReleaseGate,
  type CalibrationGateView,
  type ReleaseBlocker
} from '../lib/release';
import { useDraftSession } from '../lib/draftSession';
import { useCalibrationSession } from '../lib/calibrationSession';
import { useReleaseSession } from '../lib/releaseSession';
import { formatHeight } from '../lib/calibration';
import ReleaseSlipCard from './ReleaseSlipCard.vue';

/**
 * 压点放行工作区：
 * 只读共享单稿预检的原文 / 行宽与试压校准会话，本身不录入任何数据。
 * 只有“预检合法 + 当前六点试压合格（新判定、读数未改动、版本相符）”才放行；
 * 放行后把单稿与校准固化为不可变快照。历史放行单只读复核，草稿改动立即让
 * 当前可放行状态失效，但不覆盖任何历史单据。当前授权放在单例会话中，
 * 切换模式（本组件卸载重挂）不丢失；刷新页面后才不自动恢复。
 */
const draft = useDraftSession();
const calibration = useCalibrationSession();
const session = useReleaseSession();

// 模板需要直接访问的响应式字段（顶层 ref 会自动解包；嵌套在对象里则不会）。
const { text: draftText, width: draftWidth } = draft;
const { result: calibrationResult } = calibration;
const { activeSlip, invalidatedSlip, archive } = session;

const storageWarning = computed(() => archive.value.warning?.message ?? null);
const writeError = ref<string | null>(null);

const gateView = computed<CalibrationGateView>(() => ({
  verdict: calibration.result.value?.verdict ?? null,
  result: calibration.result.value,
  judgedRaws: calibration.judgedRaws.value,
  currentReadings: calibration.readings.value,
  protected: calibration.isProtectedArchive.value,
  recordVersion: calibration.recordVersion.value
}));

const gate = computed(() => evaluateReleaseGate(draft.text.value, draft.width.value, gateView.value));
const canRelease = computed(() => gate.value.canRelease && !archive.value.protected);
const draftBlockers = computed(() => gate.value.blockers.filter((blocker) => blocker.scope === 'draft'));
const calibrationBlockers = computed(() =>
  gate.value.blockers.filter((blocker) => blocker.scope === 'calibration')
);

/** 历史放行单（最新在前），始终只读。 */
const historySlips = computed(() => archive.value.slips.slice().reverse());
/** 历史最新单据：刷新 / 跨标签恢复时据此提示“需重新签发”，不自动授权。 */
const latestHistory = computed(() =>
  archive.value.slips.length > 0 ? archive.value.slips[archive.value.slips.length - 1] : null
);

// 跨标签页放行存档更新时，只依据完整、版本相符的记录恢复历史展示。
function onReleaseStorage(event: StorageEvent) {
  if (event.key === null || event.key === 'braille-plate:release:v1') {
    session.reloadArchive();
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', onReleaseStorage);
}
onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('storage', onReleaseStorage);
  }
});

function issueSlip() {
  writeError.value = null;
  const created = createReleaseSlip({
    text: draft.text.value,
    rawWidth: draft.width.value,
    gate: gateView.value
  });
  if (!created.ok || !created.slip) {
    return;
  }
  const outcome = session.issue(created.slip);
  if (!outcome.ok) {
    // 写入失败 / 保护态：明确告警，原存档保留，不产生伪签发。
    writeError.value = outcome.error;
  }
}

function blockerText(blocker: ReleaseBlocker): string {
  return blocker.message;
}

// 闸门依据再次变化时，清除上一次的写入失败提示。
watch(canRelease, () => {
  if (writeError.value) {
    writeError.value = null;
  }
});

// 每次挂载重新读一次放行存档：跨标签页更新或外部损坏在进入本页时被完整恢复。
onMounted(() => {
  session.reloadArchive();
});
</script>

<template>
  <section
    v-if="storageWarning"
    class="panel errors release-archive-warning"
    role="alert"
    data-testid="release-archive-warning"
  >
    <h2>放行单存档无法安全恢复</h2>
    <p>{{ storageWarning }}</p>
  </section>

  <section
    v-if="writeError"
    class="panel errors release-write-error"
    role="alert"
    data-testid="release-write-error"
  >
    <h2>放行单写入失败</h2>
    <p>{{ writeError }}</p>
  </section>

  <section class="panel release-authorize" aria-label="压点放行签发">
    <p class="release-note">
      完成铭牌文字预检后，只有当前六点试压判定<strong>合格</strong>才能交付放行单。
      本页只读复核单稿预检与试压校准的当前结果：条件齐备时点击“签发压点放行单”，
      系统把单稿原文、行宽、逐方编码、排版结果与本次合格判定及六点读数固化为不可变快照。
    </p>

    <div class="release-gate" data-testid="release-gate">
      <div class="gate-block" data-testid="gate-draft">
        <h3>单稿预检</h3>
        <p class="gate-source">
          原文：<span class="gate-text" data-testid="gate-draft-text">{{ draftText || '（空）' }}</span>
          ｜每行 <span data-testid="gate-draft-width">{{ draftWidth }}</span> 方
        </p>
        <ul v-if="draftBlockers.length > 0" class="gate-blockers" data-testid="gate-draft-blockers">
          <li v-for="(blocker, i) in draftBlockers" :key="`d-${i}`" class="blocker">{{ blockerText(blocker) }}</li>
        </ul>
        <p v-else class="gate-ok" data-testid="gate-draft-ok">单稿预检通过，存在可压点的逐方排版结果。</p>
      </div>

      <div class="gate-block" data-testid="gate-calibration">
        <h3>六点试压校准</h3>
        <p
          v-if="calibrationResult?.verdict === 'pass'"
          class="gate-ok"
          data-testid="gate-calibration-pass"
        >
          最近判定：合格（极差 {{ formatHeight(calibrationResult.threshold.spread) }} 毫米）
        </p>
        <p v-else-if="calibrationResult?.verdict === 'adjust'" class="gate-muted">最近判定：需调机</p>
        <p v-else-if="calibrationResult?.verdict === 'blocked'" class="gate-muted">最近判定：读数受阻</p>
        <p v-else class="gate-muted">尚未执行判定</p>
        <ul v-if="calibrationBlockers.length > 0" class="gate-blockers" data-testid="gate-calibration-blockers">
          <li v-for="(blocker, i) in calibrationBlockers" :key="`c-${i}`" class="blocker">
            {{ blockerText(blocker) }}
          </li>
        </ul>
      </div>
    </div>

    <button
      type="button"
      class="compare-btn release-issue"
      data-testid="release-issue"
      :disabled="!canRelease"
      @click="issueSlip"
    >
      签发压点放行单
    </button>
    <p v-if="archive.protected" class="gate-blockers-note" role="alert" data-testid="release-protected-note">
      放行单存档处于保护态：在修复前不能签发新单据，历史完整记录仍可只读复核。
    </p>

    <div v-if="activeSlip" class="release-active" role="status" data-testid="release-active">
      <h2>当前可放行：放行单 {{ activeSlip.id }}</h2>
      <p class="release-active-meta">放行依据为本次新完成的合格判定；来源快照如下，可逐项复核。</p>
      <ReleaseSlipCard :slip="activeSlip" />
    </div>

    <div
      v-else-if="invalidatedSlip"
      class="release-invalidated"
      role="status"
      data-testid="release-invalidated"
    >
      <h2>当前可放行状态已失效</h2>
      <p>
        放行单 <strong>{{ invalidatedSlip.id }}</strong> 签发后，单稿文字、行宽或某一点读数已被改动，
        或校准不再是当前合格判定。该单据仍可在下方历史记录只读复核，但已不是当前授权；
        请核对后重新满足条件并签发新的放行单。
      </p>
    </div>

    <div v-else-if="latestHistory" class="release-history-note" data-testid="release-need-reissue">
      <p>
        历史最新放行单为 <strong>{{ latestHistory.id }}</strong>。刷新或跨标签页恢复的旧单据不自动作为当前授权；
        如需放行，请确认当前单稿合法且试压重新判定合格后，再签发新的放行单。
      </p>
    </div>
  </section>

  <section class="panel release-history" aria-label="历史放行单只读复核">
    <h2>历史放行单（只读复核，{{ historySlips.length }} 份）</h2>
    <p v-if="historySlips.length === 0" class="history-empty" data-testid="release-history-empty">
      尚无已签发的放行单。
    </p>
    <ol v-else class="history-list" data-testid="release-history-list">
      <li
        v-for="slip in historySlips"
        :key="slip.id"
        class="history-item"
        :class="{ 'is-active': activeSlip?.id === slip.id }"
        data-testid="release-history-item"
        :data-slip-id="slip.id"
      >
        <ReleaseSlipCard :slip="slip" />
      </li>
    </ol>
  </section>
</template>
