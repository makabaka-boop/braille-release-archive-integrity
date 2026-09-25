import { describe, expect, it } from 'vitest';
import { planPlate } from '../../src/lib/precheck';

describe('planPlate 预检总入口', () => {
  it('完整短句按行逐方填充，数字符计入总方数', () => {
    // 12，三。 -> 数字符 1 2，逗号2 三14 句号256
    const plan = planPlate('12，三。', 4);
    expect(plan.errors).toEqual([]);
    expect(plan.totalCells).toBe(6);
    expect(plan.lines.map((line) => line.cells)).toEqual([
      ['3456', '1', '12', '2'],
      ['14', '256']
    ]);
    expect(plan.lines.map((line) => line.index)).toEqual([1, 2]);
  });

  it('行宽 20 时全部排在一行，末行不补齐', () => {
    const plan = planPlate('12，三。', 20);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].cells).toEqual(['3456', '1', '12', '2', '14', '256']);
  });

  it('非法字符阻止全部输出', () => {
    const plan = planPlate('12楼', 12);
    expect(plan.errors.join(' ')).toContain('楼');
    expect(plan.lines).toEqual([]);
    expect(plan.totalCells).toBe(0);
  });

  it('空文本阻止全部输出', () => {
    const plan = planPlate('', 12);
    expect(plan.errors.join(' ')).toContain('空文本');
    expect(plan.lines).toEqual([]);
  });

  it('非法行宽阻止全部输出（边界 3 与 21）', () => {
    for (const width of [3, 21] as never[]) {
      const plan = planPlate('一二', width);
      expect(plan.errors.join(' ')).toContain('非法行宽');
      expect(plan.lines).toEqual([]);
    }
  });

  it('非法字符与非法行宽同时存在时两条错误都报告', () => {
    const plan = planPlate('A', 3);
    expect(plan.errors).toHaveLength(2);
    expect(plan.lines).toEqual([]);
  });

  it('纯空格短句合法并按空方排版', () => {
    const plan = planPlate('   ', 4);
    expect(plan.errors).toEqual([]);
    expect(plan.totalCells).toBe(3);
    expect(plan.lines[0].cells).toEqual(['', '', '']);
  });
});
