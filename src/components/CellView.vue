<script setup lang="ts">
import { computed } from 'vue';
import { NUMBER_SIGN, VISUAL_ORDER, type BrailleCell } from '../lib/braille';

const props = defineProps<{ cell: BrailleCell }>();

const isNumberSign = computed(() => props.cell === NUMBER_SIGN);

function raised(dot: number): boolean {
  return props.cell.split('').includes(String(dot));
}
</script>

<template>
  <span
    class="cell"
    :class="{ 'is-number-sign': isNumberSign, 'is-empty': cell === '' }"
    :data-dots="cell"
    :data-number-sign="isNumberSign ? 'true' : 'false'"
  >
    <span class="dot-grid" aria-hidden="true">
      <span
        v-for="dot in VISUAL_ORDER"
        :key="dot"
        class="dot"
        :class="{ raised: raised(dot) }"
        :data-dot="dot"
      ></span>
    </span>
    <span class="dots-label">{{ cell === '' ? '空方' : cell }}</span>
  </span>
</template>
