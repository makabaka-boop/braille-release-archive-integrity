/**
 * 双稿核对：把“审核稿”（基准）与“制版稿”（待核）分别复用固定编码器
 * 转成带来源索引的方序列，再用一套确定性的最短编辑对齐找出逐项差异。
 *
 * 核对结果只有三种，交给界面逐项展示：
 *  - identical：两稿方序列完全一致，给出明确结论；
 *  - different：存在差异，标出首个差异及后续插入、删除、替换；
 *  - blocked：任一稿为空或含非法字符，只携带各侧错误，停止比对。
 *
 * 本服务不做行宽排版，核对对象是一次双稿差异记录。
 */
import { encodePhraseWithSources, type EncodeError, type SourcedCell } from './braille';

/** 对齐操作：相同、插入（制版稿多出）、删除（制版稿缺失）、替换（同位不同方）。 */
export type DiffOp = 'equal' | 'insert' | 'delete' | 'replace';

/** 逐项对应关系中的一行：两侧至少有一方存在。 */
export interface DiffEntry {
  op: DiffOp;
  /** 审核稿一侧的方及其来源下标；insert 时为 null。 */
  base: SourcedCell | null;
  /** 制版稿一侧的方及其来源下标；delete 时为 null。 */
  target: SourcedCell | null;
}

export type CompareResult =
  | { verdict: 'identical'; cells: SourcedCell[] }
  | { verdict: 'different'; entries: DiffEntry[]; firstDiffIndex: number }
  | { verdict: 'blocked'; baseErrors: EncodeError[]; targetErrors: EncodeError[] };

/**
 * 确定性的最短编辑对齐（Levenshtein：插入、删除、替换代价均为 1）。
 *
 * 先求两侧方序列的最少操作数，再从末尾回溯。相同内容的方一定对齐为
 * “相同”；其余代价并列时固定按“删除 → 插入 → 替换”的顺序选择，
 * 同样的输入永远得到同样的逐项对应关系。
 */
export function alignCells(base: readonly SourcedCell[], target: readonly SourcedCell[]): DiffEntry[] {
  const m = base.length;
  const n = target.length;

  // dp[i][j]：base 前 i 方与 target 前 j 方对齐所需的最少操作数。
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    dp[i][0] = i;
  }
  for (let j = 1; j <= n; j += 1) {
    dp[0][j] = j;
  }
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const diagonal = dp[i - 1][j - 1] + (base[i - 1].cell === target[j - 1].cell ? 0 : 1);
      const deletion = dp[i - 1][j] + 1;
      const insertion = dp[i][j - 1] + 1;
      dp[i][j] = Math.min(diagonal, deletion, insertion);
    }
  }

  const entries: DiffEntry[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    // 相同内容的方优先对齐为“相同”（单位代价下这一定也是最短的）。
    if (i > 0 && j > 0 && base[i - 1].cell === target[j - 1].cell && dp[i][j] === dp[i - 1][j - 1]) {
      entries.push({ op: 'equal', base: base[i - 1], target: target[j - 1] });
      i -= 1;
      j -= 1;
      continue;
    }
    // 并列时代替换为删除、插入，更贴近“多了/少了哪一方”的核对直觉。
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      entries.push({ op: 'delete', base: base[i - 1], target: null });
      i -= 1;
      continue;
    }
    if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      entries.push({ op: 'insert', base: null, target: target[j - 1] });
      j -= 1;
      continue;
    }
    // 只剩替换一种可能（i、j 必然都大于 0 且两方不同）。
    entries.push({ op: 'replace', base: base[i - 1], target: target[j - 1] });
    i -= 1;
    j -= 1;
  }

  return entries.reverse();
}

/**
 * 核对两份短稿：先分别编码，任一稿为空或含非法字符即停止比对，
 * 只把各侧错误交给界面在对应输入旁反馈；两稿均合法时才做对齐。
 */
export function compareDrafts(baseText: string, targetText: string): CompareResult {
  const base = encodePhraseWithSources(baseText);
  const target = encodePhraseWithSources(targetText);

  if (base.errors.length > 0 || target.errors.length > 0) {
    return { verdict: 'blocked', baseErrors: base.errors, targetErrors: target.errors };
  }

  const entries = alignCells(base.cells, target.cells);
  const firstDiffIndex = entries.findIndex((entry) => entry.op !== 'equal');

  if (firstDiffIndex === -1) {
    return { verdict: 'identical', cells: base.cells };
  }
  return { verdict: 'different', entries, firstDiffIndex };
}
