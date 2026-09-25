import { describe, expect, it } from 'vitest';
import { MAX_WIDTH, MIN_WIDTH, layoutLines, validateWidth } from '../../src/lib/layout';

describe('validateWidth 行宽边界', () => {
  it('4 至 20 的整数合法', () => {
    for (const width of [MIN_WIDTH, 7, 12, MAX_WIDTH]) {
      expect(validateWidth(width)).toBeNull();
      expect(validateWidth(String(width))).toBeNull();
      expect(validateWidth(` ${width} `)).toBeNull();
    }
  });

  it('小于 4、大于 20、0、负数均非法', () => {
    for (const raw of [3, 21, 0, -1, 100]) {
      expect(validateWidth(raw)?.kind).toBe('illegal-width');
    }
  });

  it('小数、空串、缺失值、含字母的字符串非法', () => {
    const invalid: Array<string | number | null | undefined> = [12.5, 4.0001, '', ' ', 'abc', null, undefined];
    for (const raw of invalid) {
      expect(validateWidth(raw)?.kind).toBe('illegal-width');
    }
  });

  it('字符串两端空格会被忽略', () => {
    expect(validateWidth(' 12 ')).toBeNull();
  });
});

describe('layoutLines 逐方排版', () => {
  it('达到行宽换行，不拆分编码方', () => {
    expect(layoutLines(['a', 'b', 'c', 'd', 'e'], 4)).toEqual([['a', 'b', 'c', 'd'], ['e']]);
  });

  it('末行不足不补齐空方', () => {
    const lines = layoutLines([1, 2, 3], 20);
    expect(lines).toEqual([[1, 2, 3]]);
    expect(lines[0]).toHaveLength(3);
  });

  it('恰好整除时不产生空末行', () => {
    expect(layoutLines([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('空方列表不产生任何行', () => {
    expect(layoutLines([], 4)).toEqual([]);
  });

  it('最小行宽 4 与最大行宽 20 都正确切分', () => {
    const cells = Array.from({ length: 21 }, (_, i) => String(i));
    expect(layoutLines(cells, 4).map((line) => line.length)).toEqual([4, 4, 4, 4, 4, 1]);
    expect(layoutLines(cells, 20).map((line) => line.length)).toEqual([20, 1]);
  });
});
