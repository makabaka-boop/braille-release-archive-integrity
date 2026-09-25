/**
 * 触觉盲文固定编码表。
 *
 * 六点按左列 1、2、3，右列 4、5、6 编号：
 *
 *   1 ─ 4
 *   2 ─ 5
 *   3 ─ 6
 *
 * 一个“方”（盲符）由若干点号组成；空方为不含任何点的空字符串。
 * 本模块只做纯函数式编码，不访问网络，供单元测试与界面共同使用。
 */

/** 单个盲文点号：左列 1、2、3，右列 4、5、6。 */
export type BrailleDot = 1 | 2 | 3 | 4 | 5 | 6;

/** 一方盲文：点号升序拼接，例如 "145"；空方为 ""。 */
export type BrailleCell = string;

/** 六点在点字板上的视觉顺序：上行 1、4，中行 2、5，下行 3、6。 */
export const VISUAL_ORDER: readonly BrailleDot[] = [1, 4, 2, 5, 3, 6] as const;

/** 数字符：每段连续半角数字开始前额外插入的一方，点 3、4、5、6。 */
export const NUMBER_SIGN: BrailleCell = '3456';

/** 中文数字（一至九、零）依次对应的六点编码。 */
export const CHINESE_DIGIT_CELLS: readonly BrailleCell[] = [
  '1', // 一
  '12', // 二
  '14', // 三
  '145', // 四
  '15', // 五
  '124', // 六
  '1245', // 七
  '125', // 八
  '24', // 九
  '245' // 零
] as const;

const CHINESE_DIGITS: readonly string[] = [
  '一',
  '二',
  '三',
  '四',
  '五',
  '六',
  '七',
  '八',
  '九',
  '零'
] as const;

/** 中文数字字符到点号方的查找表。 */
export const CHINESE_DIGIT_MAP: ReadonlyMap<string, BrailleCell> = new Map(
  CHINESE_DIGITS.map((ch, index) => [ch, CHINESE_DIGIT_CELLS[index]])
);

/** 半角数字 0-9：沿用“零、一……九”的对应中文数字编码。 */
export const ASCII_DIGIT_CELLS: readonly BrailleCell[] = [
  CHINESE_DIGIT_CELLS[9], // 0 -> 零 245
  CHINESE_DIGIT_CELLS[0], // 1 -> 一 1
  CHINESE_DIGIT_CELLS[1], // 2 -> 二 12
  CHINESE_DIGIT_CELLS[2], // 3 -> 三 14
  CHINESE_DIGIT_CELLS[3], // 4 -> 四 145
  CHINESE_DIGIT_CELLS[4], // 5 -> 五 15
  CHINESE_DIGIT_CELLS[5], // 6 -> 六 124
  CHINESE_DIGIT_CELLS[6], // 7 -> 七 1245
  CHINESE_DIGIT_CELLS[7], // 8 -> 八 125
  CHINESE_DIGIT_CELLS[8] // 9 -> 九 24
] as const;

/** 标点与空格的固定编码：逗号 2，句号 256，连字符 36，空格为空方。 */
export const PUNCTUATION_CELLS: ReadonlyMap<string, BrailleCell> = new Map([
  ['，', '2'],
  ['。', '256'],
  ['-', '36'],
  [' ', '']
]);

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** 编码阶段错误：携带出错字符在短句中的下标，便于定位。 */
export interface EncodeError {
  kind: 'illegal-character' | 'empty-text';
  index: number;
  character: string;
  message: string;
}

export interface EncodeResult {
  cells: BrailleCell[];
  errors: EncodeError[];
}

/**
 * 带来源索引的一方：记录该方由短句中第几个字符（0 起）产生。
 * 双稿核对按此把每个差异回溯到原字符位置。
 */
export interface SourcedCell {
  cell: BrailleCell;
  /**
   * 来源字符在短句中的下标（0 起）。
   * 数字符 3456 本身不对应输入字符，归属于触发它的首个数字字符。
   */
  sourceIndex: number;
}

export interface SourcedEncodeResult {
  cells: SourcedCell[];
  errors: EncodeError[];
}

/**
 * 将制版员键入的短句逐字符编码为点号方，并记录每一方的来源字符下标。
 *
 * 允许的字符：中文数字“一二三四五六七八九零”、半角数字 0-9、
 * 半角空格及全角逗号“，”、全角句号“。”、半角连字符“-”。
 *
 * 半角数字按最长连续段落处理：每段连续数字前额外插入一方数字符 3456，
 * 该方归属于触发它的首个数字字符；数字串遇到任何非数字字符
 * （中文数字、标点、空格等）立即结束。
 *
 * 出现非法字符时照常收集错误但不生成对应方；调用方必须在 errors 为空时
 * 才允许使用 cells，保证“非法字符阻止全部输出”。
 */
export function encodePhraseWithSources(text: string): SourcedEncodeResult {
  const errors: EncodeError[] = [];

  if (text.length === 0) {
    errors.push({
      kind: 'empty-text',
      index: 0,
      character: '',
      message: '空文本：请输入需要制版的短句。'
    });
    return { cells: [], errors };
  }

  const cells: SourcedCell[] = [];
  const chars = Array.from(text);
  let inNumber = false;

  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index];

    if (isAsciiDigit(ch)) {
      if (!inNumber) {
        // 每段连续数字前插入数字符（3456），归属于触发它的首个数字字符。
        cells.push({ cell: NUMBER_SIGN, sourceIndex: index });
        inNumber = true;
      }
      cells.push({ cell: ASCII_DIGIT_CELLS[Number(ch)], sourceIndex: index });
      continue;
    }

    // 遇到任何非半角数字字符，连续数字串立即结束。
    inNumber = false;

    const chineseCell = CHINESE_DIGIT_MAP.get(ch);
    if (chineseCell !== undefined) {
      cells.push({ cell: chineseCell, sourceIndex: index });
      continue;
    }

    const punctuationCell = PUNCTUATION_CELLS.get(ch);
    if (punctuationCell !== undefined) {
      cells.push({ cell: punctuationCell, sourceIndex: index });
      continue;
    }

    errors.push({
      kind: 'illegal-character',
      index,
      character: ch,
      message:
        ch === '\n' || ch === '\t'
          ? `第 ${index + 1} 个字符为不允许的控制字符，仅允许中文数字、半角数字、空格、“，”“。”“-”。`
          : `第 ${index + 1} 个字符“${ch}”不在允许范围内，仅允许中文数字、半角数字、空格、“，”“。”“-”。`
    });
  }

  return { cells, errors };
}

/**
 * 不带来源信息的编码结果，供单稿预检等既有调用继续使用。
 * 与 encodePhraseWithSources 共用同一编码过程，仅剥离去源下标。
 */
export function encodePhrase(text: string): EncodeResult {
  const { cells, errors } = encodePhraseWithSources(text);
  return { cells: cells.map((sourced) => sourced.cell), errors };
}
