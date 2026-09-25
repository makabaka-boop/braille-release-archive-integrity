import { describe, expect, it } from 'vitest';
import { alignCells, compareDrafts, type DiffOp } from '../../src/lib/compare';
import { encodePhraseWithSources } from '../../src/lib/braille';

function opsOf(result: ReturnType<typeof compareDrafts>): DiffOp[] {
  if (result.verdict !== 'different') {
    throw new Error(`期望存在差异，实际为 ${result.verdict}`);
  }
  return result.entries.map((entry) => entry.op);
}

describe('compareDrafts 双稿核对', () => {
  it('完全一致：给出明确结论，不产生差异项', () => {
    const result = compareDrafts('12，三。', '12，三。');
    expect(result.verdict).toBe('identical');
    if (result.verdict !== 'identical') {
      return;
    }
    // 3456 1 12 2 14 256，共 6 方
    expect(result.cells.map((sourced) => sourced.cell)).toEqual(['3456', '1', '12', '2', '14', '256']);
    expect(result.cells.map((sourced) => sourced.sourceIndex)).toEqual([0, 0, 1, 2, 3, 4]);
  });

  it('数字段被拆开：插入的空方与数字符都带来源下标', () => {
    // 审核稿“12”为一段数字；制版稿“1 2”被空格拆成两段，多出一方数字符。
    const result = compareDrafts('12', '1 2');
    expect(result.verdict).toBe('different');
    if (result.verdict !== 'different') {
      return;
    }
    expect(opsOf(result)).toEqual(['equal', 'equal', 'insert', 'insert', 'equal']);
    expect(result.firstDiffIndex).toBe(2);

    const [sign, one, space, secondSign, two] = result.entries;
    expect(sign.base?.cell).toBe('3456');
    expect(sign.target?.cell).toBe('3456');
    expect(one.target?.sourceIndex).toBe(0);

    // 首个差异：制版稿第 2 个字符（空格）插入的空方。
    const firstDiff = result.entries[result.firstDiffIndex];
    expect(firstDiff.op).toBe('insert');
    expect(firstDiff.base).toBeNull();
    expect(firstDiff.target).toEqual({ cell: '', sourceIndex: 1 });

    // 拆段后重新插入的数字符归属于制版稿第 3 个字符“2”。
    expect(secondSign.op).toBe('insert');
    expect(secondSign.target).toEqual({ cell: '3456', sourceIndex: 2 });
    expect(two.op).toBe('equal');
    expect(two.base?.sourceIndex).toBe(1);
    expect(two.target?.sourceIndex).toBe(2);
    expect(space).toBe(firstDiff);
  });

  it('单字符删除：缺失方带来源下标，其余逐项相同', () => {
    const result = compareDrafts('一二三', '一三');
    expect(result.verdict).toBe('different');
    if (result.verdict !== 'different') {
      return;
    }
    expect(opsOf(result)).toEqual(['equal', 'delete', 'equal']);
    expect(result.firstDiffIndex).toBe(1);

    const deleted = result.entries[1];
    expect(deleted.base).toEqual({ cell: '12', sourceIndex: 1 });
    expect(deleted.target).toBeNull();

    // “三”在制版稿中下标前移一位，但方相同。
    const tail = result.entries[2];
    expect(tail.base).toEqual({ cell: '14', sourceIndex: 2 });
    expect(tail.target).toEqual({ cell: '14', sourceIndex: 1 });
  });

  it('同位不同方记为替换', () => {
    const result = compareDrafts('一', '二');
    expect(result.verdict).toBe('different');
    if (result.verdict !== 'different') {
      return;
    }
    expect(opsOf(result)).toEqual(['replace']);
    expect(result.firstDiffIndex).toBe(0);
    expect(result.entries[0].base).toEqual({ cell: '1', sourceIndex: 0 });
    expect(result.entries[0].target).toEqual({ cell: '12', sourceIndex: 0 });
  });

  it('任一稿为空：只携带该侧 empty-text 错误并停止比对', () => {
    const result = compareDrafts('', '一');
    expect(result.verdict).toBe('blocked');
    if (result.verdict !== 'blocked') {
      return;
    }
    expect(result.baseErrors).toHaveLength(1);
    expect(result.baseErrors[0].kind).toBe('empty-text');
    expect(result.targetErrors).toEqual([]);
  });

  it('任一稿含非法字符：报告字符位置并停止比对，不产生差异记录', () => {
    const result = compareDrafts('12楼', '12');
    expect(result.verdict).toBe('blocked');
    if (result.verdict !== 'blocked') {
      return;
    }
    expect(result.baseErrors).toHaveLength(1);
    expect(result.baseErrors[0].kind).toBe('illegal-character');
    expect(result.baseErrors[0].index).toBe(2);
    expect(result.baseErrors[0].character).toBe('楼');
    expect(result.targetErrors).toEqual([]);
  });

  it('两稿均有非法字符时两侧错误分别报告', () => {
    const result = compareDrafts('A', '一B');
    expect(result.verdict).toBe('blocked');
    if (result.verdict !== 'blocked') {
      return;
    }
    expect(result.baseErrors.map((error) => error.character)).toEqual(['A']);
    expect(result.targetErrors.map((error) => error.character)).toEqual(['B']);
    expect(result.targetErrors[0].index).toBe(1);
  });
});

describe('alignCells 确定性的最短编辑对齐', () => {
  it('同样输入永远得到同样的逐项对应关系', () => {
    const base = encodePhraseWithSources('1 2，三').cells;
    const target = encodePhraseWithSources('12，三。').cells;
    const first = alignCells(base, target);
    const second = alignCells(base, target);
    expect(first).toEqual(second);
  });

  it('对齐结果达到最少操作数（编辑距离）', () => {
    // “一 二 三” 对 “一二三。”：删两个空方、插入一个句号，最少 3 步。
    const base = encodePhraseWithSources('一 二 三').cells;
    const target = encodePhraseWithSources('一二三。').cells;
    const entries = alignCells(base, target);
    expect(entries.filter((entry) => entry.op !== 'equal')).toHaveLength(3);
    expect(entries.map((entry) => entry.op)).toEqual([
      'equal',
      'delete',
      'equal',
      'delete',
      'equal',
      'insert'
    ]);
  });

  it('空方与数字符按普通方参与对齐且保持可辨认', () => {
    const base = encodePhraseWithSources('1 2').cells;
    const target = encodePhraseWithSources('1 2').cells;
    const entries = alignCells(base, target);
    expect(entries.every((entry) => entry.op === 'equal')).toBe(true);
    expect(entries.map((entry) => entry.base?.cell)).toEqual(['3456', '1', '', '3456', '12']);
  });
});
