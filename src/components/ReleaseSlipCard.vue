<script setup lang="ts">
import { formatHeight } from '../lib/calibration';
import type { ReleaseSlip } from '../lib/release';
import CellView from './CellView.vue';

/**
 * 放行单卡片：完整展示来源快照（原文、行宽、逐方编码、排版、合格判定、六点读数）。
 * 所有内容只读——快照本身已被领域层递归冻结，组件也不提供任何编辑入口。
 */
const props = defineProps<{
  slip: ReleaseSlip;
}>();

function formatIssuedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

void props;
</script>

<template>
  <article class="slip-card" data-testid="slip-card">
    <header class="slip-head">
      <span class="slip-id" data-testid="slip-id">放行单号：{{ slip.id }}</span>
      <span class="slip-time" data-testid="slip-time">签发时间：{{ formatIssuedAt(slip.issuedAt) }}</span>
      <span class="slip-badge">不可变快照 · 只读</span>
    </header>

    <section class="slip-section slip-source">
      <h4>来源快照 · 单稿</h4>
      <p class="slip-text" data-testid="slip-draft-text">原文：{{ slip.snapshot.draft.text }}</p>
      <p class="slip-width" data-testid="slip-draft-width">
        每行方数：{{ slip.snapshot.draft.width }}；总方数：{{ slip.snapshot.draft.totalCells }}
      </p>
      <ol class="slip-lines" data-testid="slip-lines">
        <li
          v-for="line in slip.snapshot.draft.lines"
          :key="line.index"
          class="slip-line"
          data-testid="slip-line"
        >
          <span class="line-no">第 {{ line.index }} 行</span>
          <ol class="cells">
            <li v-for="(cell, cellIndex) in line.cells" :key="`${line.index}-${cellIndex}`" class="cell-item">
              <CellView :cell="cell" />
            </li>
          </ol>
        </li>
      </ol>
    </section>

    <section class="slip-section slip-calibration">
      <h4>来源快照 · 六点试压（合格）</h4>
      <table class="point-table">
        <thead>
          <tr>
            <th scope="col">点位</th>
            <th scope="col">原始读数</th>
            <th scope="col">实测（毫米）</th>
            <th scope="col">单点判定</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="point in slip.snapshot.calibration.readings" :key="point.index" data-testid="slip-point-row">
            <td>{{ point.label }}</td>
            <td class="point-raw" data-testid="slip-point-raw">{{ point.raw }}</td>
            <td class="point-value" data-testid="slip-point-value">{{ formatHeight(point.value) }}</td>
            <td>
              <span v-if="point.inRange" class="point-tag ok">合格</span>
              <span v-else class="point-tag bad">{{ point.outReason?.message }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="slip-threshold" data-testid="slip-threshold">
        最小 {{ formatHeight(slip.snapshot.calibration.threshold.min) }} 毫米，最大
        {{ formatHeight(slip.snapshot.calibration.threshold.max) }} 毫米，极差
        {{ formatHeight(slip.snapshot.calibration.threshold.spread) }} 毫米（限值
        {{ formatHeight(slip.snapshot.calibration.threshold.spreadLimit) }} 毫米）。
      </p>
      <p class="slip-conclusion" data-testid="slip-conclusion">{{ slip.snapshot.calibration.conclusion }}</p>
    </section>
  </article>
</template>
