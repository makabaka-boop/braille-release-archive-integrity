/**
 * 行宽校验与逐方排版。
 * 每行 4 至 20 方：达到行宽即换行，不拆分编码方，也不补齐末行。
 */

export const MIN_WIDTH = 4;
export const MAX_WIDTH = 20;

export interface WidthError {
  kind: 'illegal-width';
  message: string;
}

/**
 * 校验行宽。制版员每行只能选择 4 至 20 方，且必须为整数。
 * 输入为字符串（来自输入框），任何非整数值都视为非法行宽。
 */
export function validateWidth(rawWidth: string | number | null | undefined): WidthError | null {
  const shown = rawWidth === null || rawWidth === undefined || rawWidth === '' ? '（未填写）' : String(rawWidth);

  if (typeof rawWidth === 'string') {
    if (!/^\d+$/.test(rawWidth.trim())) {
      return {
        kind: 'illegal-width',
        message: `非法行宽：${shown} 不是整数，每行方数必须为 ${MIN_WIDTH} 至 ${MAX_WIDTH} 之间的整数。`
      };
    }
    return validateWidth(Number(rawWidth.trim()));
  }

  if (typeof rawWidth !== 'number' || !Number.isInteger(rawWidth) || rawWidth < MIN_WIDTH || rawWidth > MAX_WIDTH) {
    return {
      kind: 'illegal-width',
      message: `非法行宽：${shown}，每行方数必须为 ${MIN_WIDTH} 至 ${MAX_WIDTH} 之间的整数。`
    };
  }

  return null;
}

/**
 * 逐方填充：按行宽顺序切分，编码方（含数字符）绝不拆分；
 * 达到行宽后换行，末行不足不补空方。
 */
export function layoutLines<Cell>(cells: readonly Cell[], width: number): Cell[][] {
  const lines: Cell[][] = [];
  for (let start = 0; start < cells.length; start += width) {
    lines.push(cells.slice(start, start + width));
  }
  return lines;
}
