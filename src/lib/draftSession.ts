/**
 * 单稿预检输入的共享会话（原文 + 行宽）。
 *
 * 单稿预检页与压点放行页必须看到的是**同一份**单稿：放行页只读复核这份草稿，
 * 放行后任一处修改文字或行宽，当前可放行状态立即失效。为让刷新与跨标签页
 * 行为一致，草稿持久化到 localStorage 并监听跨标签页 storage 事件。
 *
 * 既有“原单稿预检的输入与结论不变”：默认值、校验与逐方预览仍由 precheck.ts
 * 负责，本模块只共享输入字符串，不引入任何新校验或新结论。
 */
import { effectScope, ref, watch, type Ref } from 'vue';

const STORAGE_KEY = 'braille-plate:draft:v1';
const CURRENT_STORAGE_VERSION = 1;
const DEFAULT_WIDTH = '12';

export interface DraftSession {
  text: Ref<string>;
  width: Ref<string>;
  /** 用当前 localStorage 内容重新同步（刷新恢复 / 跨标签页更新）。 */
  reload: () => void;
  /** 供测试销毁跨标签页监听。 */
  dispose: () => void;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

interface VersionedDraft {
  version?: unknown;
  text?: unknown;
  width?: unknown;
}

interface StoredDraftValue {
  text: string;
  width: string;
}

/**
 * 读取单稿草稿。仅当记录完整、版本相符时返回可信内容；
 * 旧版 / 损坏 / 缺字段一律返回 ok=false，调用方必须保留当前展示，不得用默认值覆盖。
 */
function readStored(): { ok: true; value: StoredDraftValue } | { ok: false } {
  const fallback = { text: '', width: DEFAULT_WIDTH };
  const store = storage();
  if (!store) {
    return { ok: false };
  }
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { ok: false };
  }
  if (!raw) {
    return { ok: true, value: fallback };
  }
  let parsed: VersionedDraft;
  try {
    parsed = JSON.parse(raw) as VersionedDraft;
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }
  // 只接受当前版本且两字段均为字符串；任何异常都不覆盖当前展示。
  if (parsed.version !== CURRENT_STORAGE_VERSION) {
    return { ok: false };
  }
  if (typeof parsed.text !== 'string') {
    return { ok: false };
  }
  // 行宽输入框是 type=number，个别浏览器 / 旧写入可能落库为数值；恢复时统一为字符串，
  // 行宽本身的合法性（4–20 的整数）仍完全交给既有 validateWidth 判断。
  let width: string;
  if (typeof parsed.width === 'string') {
    width = parsed.width;
  } else if (typeof parsed.width === 'number' && Number.isFinite(parsed.width)) {
    width = String(parsed.width);
  } else {
    return { ok: false };
  }
  return { ok: true, value: { text: parsed.text, width } };
}

function writeStored(text: string, width: string): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ version: CURRENT_STORAGE_VERSION, text, width }));
  } catch {
    // 配额或权限失败时退化为仅内存态，不打断录入。
  }
}

let singleton: DraftSession | null = null;
let singletonScope: ReturnType<typeof effectScope> | null = null;

/**
 * 进程内共享的单稿会话：单稿预检与放行页拿到同一份响应式状态。
 * 跨标签页收到其它标签写入时，只依据完整、版本相符的记录同步，
 * 同标签页的本地写入不触发 storage 事件，不产生回环。
 */
export function useDraftSession(): DraftSession {
  if (singleton) {
    return singleton;
  }

  // 自动保存的 watch 在脱离组件生命周期的作用域内创建，避免首个创建单例的
  // 组件卸载后持久化监听被停止（反复切换模式后草稿仍要持续保存）。
  singletonScope = effectScope(true);
  singleton = singletonScope.run(createDraftSession) as DraftSession;
  return singleton;
}

function createDraftSession(): DraftSession {
  // 初次进入（相当于刷新恢复）：无记录时用默认输入；损坏旧记录也回落默认值。
  const initial = readStored();
  const text = ref(initial.ok ? initial.value.text : '');
  const width = ref(initial.ok ? initial.value.width : DEFAULT_WIDTH);

  function reload() {
    // 跨标签页更新：只依据完整、版本相符的记录恢复；记录不可信时保留当前展示。
    const stored = readStored();
    if (stored.ok) {
      text.value = stored.value.text;
      width.value = stored.value.width;
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY) {
      reload();
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }

  watch([text, width], () => {
    writeStored(text.value, width.value);
  });

  return {
    text,
    width,
    reload,
    dispose() {
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', onStorage);
      }
    }
  };
}

/** 测试辅助：丢弃共享会话单例（下一次 useDraftSession 重新从存储恢复）。 */
export function __resetDraftSessionForTests(): void {
  if (singleton) {
    singleton.dispose();
  }
  singletonScope?.stop();
  singletonScope = null;
  singleton = null;
}
