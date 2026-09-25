import { describe, expect, it } from 'vitest';
import {
  ASCII_DIGIT_CELLS,
  CHINESE_DIGIT_CELLS,
  NUMBER_SIGN,
  PUNCTUATION_CELLS,
  VISUAL_ORDER,
  encodePhrase,
  encodePhraseWithSources
} from '../../src/lib/braille';

describe('固定编码表', () => {
  it('中文数字一至九、零依次为规定点号', () => {
    expect([...CHINESE_DIGIT_CELLS]).toEqual([
      '1',
      '12',
      '14',
      '145',
      '15',
      '124',
      '1245',
      '125',
      '24',
      '245'
    ]);
  });

  it('半角数字 0-9 沿用对应中文数字编码', () => {
    // 0 沿用零，1 沿用一，……，9 沿用九。
    expect([...ASCII_DIGIT_CELLS]).toEqual([
      '245',
      '1',
      '12',
      '14',
      '145',
      '15',
      '124',
      '1245',
      '125',
      '24'
    ]);
  });

  it('数字符为点 3456，视觉顺序覆盖左列 1/2/3 与右列 4/5/6', () => {
    expect(NUMBER_SIGN).toBe('3456');
    expect([...VISUAL_ORDER]).toEqual([1, 4, 2, 5, 3, 6]);
  });

  it('逗号为 2、句号为 256、连字符为 36、空格为空方', () => {
    expect(PUNCTUATION_CELLS.get('，')).toBe('2');
    expect(PUNCTUATION_CELLS.get('。')).toBe('256');
    expect(PUNCTUATION_CELLS.get('-')).toBe('36');
    expect(PUNCTUATION_CELLS.get(' ')).toBe('');
  });
});

describe('encodePhrase 编码', () => {
  it('中文数字不插入数字符', () => {
    expect(encodePhrase('一二三四五六七八九零').cells).toEqual([
      '1',
      '12',
      '14',
      '145',
      '15',
      '124',
      '1245',
      '125',
      '24',
      '245'
    ]);
  });

  it('每段连续半角数字前只插入一方数字符 3456', () => {
    expect(encodePhrase('12').cells).toEqual(['3456', '1', '12']);
    expect(encodePhrase('0123456789').cells).toEqual([
      '3456',
      '245', // 0 -> 零
      '1',
      '12',
      '14',
      '145',
      '15',
      '124',
      '1245',
      '125',
      '24' // 9 -> 九
    ]);
  });

  it('数字串遇到任何非数字字符立即结束，后续数字重新加数字符', () => {
    // 全角逗号分隔两段
    expect(encodePhrase('1，2').cells).toEqual(['3456', '1', '2', '3456', '12']);
    // 空格分隔两段，空格本身占一空方
    expect(encodePhrase('1 2').cells).toEqual(['3456', '1', '', '3456', '12']);
    // 连字符分隔
    expect(encodePhrase('1-2').cells).toEqual(['3456', '1', '36', '3456', '12']);
    // 中文数字不是半角数字：数字串结束，且其后半角数字重新起段
    expect(encodePhrase('1二2').cells).toEqual(['3456', '1', '12', '3456', '12']);
    // 句号结束数字串
    expect(encodePhrase('10。').cells).toEqual(['3456', '1', '245', '256']);
  });

  it('标点与空格逐字成方', () => {
    expect(encodePhrase('，。- ').cells).toEqual(['2', '256', '36', '']);
  });

  it('空格为合法字符：仅空格不报错且生成空方', () => {
    const result = encodePhrase(' ');
    expect(result.errors).toEqual([]);
    expect(result.cells).toEqual(['']);
  });
});

describe('encodePhrase 非法字符边界', () => {
  it('英文与半角逗号等不在允许集合内的字符报错并给出下标', () => {
    const result = encodePhrase('1,2');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe('illegal-character');
    expect(result.errors[0].index).toBe(1);
    expect(result.errors[0].character).toBe(',');
  });

  it('汉字“楼”、换行、制表符均为非法字符并逐个收集', () => {
    const result = encodePhrase('三A\nB\t');
    expect(result.errors.map((e) => e.character)).toEqual(['A', '\n', 'B', '\t']);
    expect(result.errors.map((e) => e.index)).toEqual([1, 2, 3, 4]);
  });

  it('空文本报 empty-text，不产生任何方', () => {
    const result = encodePhrase('');
    expect(result.cells).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].kind).toBe('empty-text');
  });
});

describe('encodePhraseWithSources 带来源索引的编码', () => {
  it('每个方都记录来源字符下标（0 起）', () => {
    const result = encodePhraseWithSources('一，二');
    expect(result.errors).toEqual([]);
    expect(result.cells).toEqual([
      { cell: '1', sourceIndex: 0 },
      { cell: '2', sourceIndex: 1 },
      { cell: '12', sourceIndex: 2 }
    ]);
  });

  it('数字符归属于触发它的首个数字字符，空格来源为空方', () => {
    const result = encodePhraseWithSources('1 2');
    expect(result.cells).toEqual([
      { cell: '3456', sourceIndex: 0 }, // 数字符归属于第 1 个字符“1”
      { cell: '1', sourceIndex: 0 },
      { cell: '', sourceIndex: 1 }, // 空方来源于空格
      { cell: '3456', sourceIndex: 2 }, // 第二段数字的数字符归属于“2”
      { cell: '12', sourceIndex: 2 }
    ]);
  });

  it('与 encodePhrase 的方序列与错误完全一致，仅多出来源下标', () => {
    for (const text of ['12，三。', '1,2', '', '   ']) {
      const sourced = encodePhraseWithSources(text);
      const plain = encodePhrase(text);
      expect(sourced.cells.map((s) => s.cell)).toEqual(plain.cells);
      expect(sourced.errors).toEqual(plain.errors);
    }
  });
});
