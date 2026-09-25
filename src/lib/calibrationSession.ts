/**
 * 试压校准会话：工作区状态 + localStorage 快照持久化 + 跨标签页同步。
 *
 * 从 CalibrationWorkspace 抽离，以便压点放行页共享“当前六点试压”的同一份
 * 响应式状态：放行闸门只读这份会话，绝不自行判定或改写。
 *
 * 跨标签页收到校准更新时，只依据完整、版本相符的记录恢复展示：
 *  - 新的“合格”判定只在另一标签成为当前授权；
 *  - 旧版 / 损坏 / 不一致记录只产生告警与保护态，不会被当作当前授权。
 */
import { computed, effectScope, ref, watch, type ComputedRef, type Ref } from 'vue';
import {
  POINT_COUNT,
  createDraft,
  judgeCalibration,
  type CalibrationResult,
  type PointJudgmentView,
  type PointReadingView
} from './calibration';
import { clearCalibrationState, loadCalibrationState, saveCalibrationState } from './calibrationStorage';

const CALIBRATION_STORAGE_KEY = 'braille-plate:calibration:v1';

export interface CalibrationSession {
  readings: Ref<string[]>;
  result: Ref<CalibrationResult | null>;
  judgedRaws: Ref<string[] | null>;
  archiveWarning: Ref<string | null>;
  isProtectedArchive: Ref<boolean>;
  storageError: Ref<string | null>;
  /** 恢复来源的存档版本：旧版兼容记录为 1，当前版本为 2，无法辨认为 null。 */
  recordVersion: Ref<number | null>;
  pointIndices: number[];
  blockedReadings: ComputedRef<PointReadingView[]>;
  judgedPoints: ComputedRef<PointJudgmentView[]>;
  runJudge: () => void;
  resetAll: () => void;
  pointError: (index: number) => string | null;
  judgedPoint: (index: number) => PointJudgmentView | null;
  /** 用当前 localStorage 重新同步（供跨标签页更新后主动恢复展示）。 */
  reload: () => void;
  dispose: () => void;
}

let singleton: CalibrationSession | null = null;
let singletonScope: ReturnType<typeof effectScope> | null = null;

/** 进程内共享的校准会话：校准工作区与放行页看到同一次判定。 */
export function useCalibrationSession(): CalibrationSession {
  if (singleton) {
    return singleton;
  }

  // 单例的自动保存 / 失效监听必须独立于首个创建它的组件：
  // 组件 setup 中注册的 watch 会随该组件卸载而停止，反复进出工作区后就漏检改动。
  // 因此所有响应式状态与 watch 都在这个脱离组件生命周期的作用域内创建。
  singletonScope = effectScope(true);
  singleton = singletonScope.run(createSession) as CalibrationSession;
  return singleton;
}

function createSession(): CalibrationSession {
  const restored = loadCalibrationState();

  const readings = ref<string[]>(restored.draft.readings.slice());
  const result = ref<CalibrationResult | null>(restored.result);
  const judgedRaws = ref<string[] | null>(restored.judgedRaws);
  const archiveWarning = ref(restored.warning?.message ?? null);
  const isProtectedArchive = ref(restored.protected);
  const storageError = ref<string | null>(null);
  const recordVersion = ref<number | null>(restored.recordVersion);
  let skipNextDraftWatch = false;

  const pointIndices = Array.from({ length: POINT_COUNT }, (_, index) => index);

  const blockedReadings = computed<PointReadingView[]>(() =>
    result.value?.verdict === 'blocked' ? result.value.readings : []
  );

  const judgedPoints = computed<PointJudgmentView[]>(() =>
    result.value?.verdict === 'pass' || result.value?.verdict === 'adjust' ? result.value.readings : []
  );

  function pointError(index: number): string | null {
    return blockedReadings.value[index]?.error?.message ?? null;
  }

  function judgedPoint(index: number): PointJudgmentView | null {
    return judgedPoints.value[index] ?? null;
  }

  /** 从当前 localStorage 完整恢复一份会话（刷新 / 跨标签页都走同一条安全路径）。 */
  function reload() {
    const state = loadCalibrationState();
    skipNextDraftWatch = true;
    readings.value = state.draft.readings.slice();
    result.value = state.result;
    judgedRaws.value = state.judgedRaws;
    archiveWarning.value = state.warning?.message ?? null;
    isProtectedArchive.value = state.protected;
    recordVersion.value = state.recordVersion;
  }

  function runJudge() {
    const judged = judgeCalibration(readings.value);
    result.value = judged;
    if (judged.verdict === 'blocked') {
      // 无效读数只构成输入受阻，不保留为本次判定结果，也不覆盖受保护原存档。
      judgedRaws.value = null;
      return;
    }

    const snapshot = readings.value.slice();
    const saved = saveCalibrationState({ readings: snapshot }, snapshot);
    if (saved) {
      judgedRaws.value = snapshot;
      archiveWarning.value = null;
      storageError.value = null;
      isProtectedArchive.value = false;
      recordVersion.value = 2;
    } else {
      judgedRaws.value = snapshot;
      isProtectedArchive.value = true;
      storageError.value =
        '浏览器本地存储写入失败（可能是配额不足或权限受限）：本次判定未写入，原始存档仍保留。修复存储问题后请重新执行判定；在此之前任何修改都不会覆盖原存档。';
    }
  }

  function resetAll() {
    if (isProtectedArchive.value) {
      storageError.value = '原始校准存档仍在保护中：请核对并重新执行判定；在新的有效判定写入前不能清空覆盖。';
      return;
    }

    const cleared = clearCalibrationState();
    if (!cleared) {
      storageError.value = '清空本地校准存档失败：原存档仍保留，请检查浏览器存储权限。';
      return;
    }

    skipNextDraftWatch = true;
    readings.value = createDraft().readings;
    result.value = null;
    judgedRaws.value = null;
    archiveWarning.value = null;
    storageError.value = null;
    recordVersion.value = null;
  }

  // 判定之后只要任一读数再被改动，上次结论立即失效。
  // 异常存档处于保护态时，用户修改只保留在内存取证，不自动覆盖 localStorage。
  watch(
    readings,
    (values) => {
      if (skipNextDraftWatch) {
        skipNextDraftWatch = false;
        return;
      }

      if (result.value !== null) {
        result.value = null;
        judgedRaws.value = null;
      }
      if (isProtectedArchive.value) {
        storageError.value = '原存档异常且处于保护中：当前修改仅用于本次核对，重新执行有效判定前不会写入或覆盖原存档。';
        return;
      }

      const saved = saveCalibrationState({ readings: values.slice() }, null);
      if (saved) {
        storageError.value = null;
      } else {
        isProtectedArchive.value = true;
        storageError.value =
          '草稿保存失败（可能是配额不足或权限受限）：浏览器仍保留最近一次可恢复的本地记录；后续修改将继续留在本次会话，不会覆盖原存档。';
      }
    },
    { deep: true }
  );

  function onStorage(event: StorageEvent) {
    if (event.key === null || event.key === CALIBRATION_STORAGE_KEY) {
      // 另一标签页写入（或清空，key=null）了校准存档：只按完整、版本相符的记录恢复。
      reload();
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }

  return {
    readings,
    result,
    judgedRaws,
    archiveWarning,
    isProtectedArchive,
    storageError,
    recordVersion,
    pointIndices,
    blockedReadings,
    judgedPoints,
    runJudge,
    resetAll,
    pointError,
    judgedPoint,
    reload,
    dispose() {
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', onStorage);
      }
    }
  };
}

/** 测试辅助：丢弃共享会话单例（下一次 useCalibrationSession 重新从存储恢复）。 */
export function __resetCalibrationSessionForTests(): void {
  if (singleton) {
    singleton.dispose();
  }
  singletonScope?.stop();
  singletonScope = null;
  singleton = null;
}
