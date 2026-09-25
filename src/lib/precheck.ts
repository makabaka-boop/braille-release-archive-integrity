/**
 * 预检总入口：文本编码 + 行宽校验 + 逐方排版。
 * 非法字符、空文本或非法行宽都会阻止全部输出（errors 非空时 lines 为空）。
 */
import { type BrailleCell, encodePhrase } from './braille';
import { layoutLines, validateWidth } from './layout';

export interface PlateLine {
  index: number;
  cells: BrailleCell[];
}

export interface PlatePlan {
  errors: string[];
  lines: PlateLine[];
  totalCells: number;
  width: number;
}

export function planPlate(text: string, rawWidth: string | number | null | undefined): PlatePlan {
  const { cells, errors: encodeErrors } = encodePhrase(text);
  const widthError = validateWidth(rawWidth);

  const errors: string[] = [...encodeErrors.map((error) => error.message)];
  if (widthError) {
    errors.push(widthError.message);
  }

  // 任何非法情况都阻止全部输出。
  if (errors.length > 0) {
    return { errors, lines: [], totalCells: 0, width: 0 };
  }

  const width = typeof rawWidth === 'number' ? rawWidth : Number(String(rawWidth).trim());
  const lines = layoutLines<BrailleCell>(cells, width).map((lineCells, lineIndex) => ({
    index: lineIndex + 1,
    cells: lineCells
  }));

  return { errors: [], lines, totalCells: cells.length, width };
}
