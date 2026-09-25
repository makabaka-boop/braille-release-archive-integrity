/**
 * 识读训练（点位识读练习）领域服务。
 *
 * 新上岗制版员独立操作前，先完成点位识读练习：页面按局组织训练，
 * 每局依次展示由既有固定编码表（braille.ts）生成的十张盲文方卡片，
 * 学员从四个字符选项中作答，提交后立即得到正确字符与点号说明，
 * 局末汇总答对数与错题。
 *
 * 题目生成使用可注入的种子：同一种子得到完全相同的题序与选项顺序，
 * 便于复现与核对；一局之内十题互不重复。训练服务维护当前题号、
 * 作答记录与成绩契约，只输出纯数据，不访问网络、存储或 DOM，
 * 也不读取、改写单稿预检、双稿核对与试压校准的任何数据。
 */
import {
  CHINESE_DIGIT_CELLS,
  PUNCTUATION_CELLS,
  type BrailleCell
} from './braille';

/** 每局题数，固定十张题卡。 */
export const SESSION_LENGTH = 10;

/** 每题选项数，固定四选一。 */
export const OPTION_COUNT = 4;

/** 题库条目：一个可识读字符及其在固定编码表中的点号方。 */
export interface BankEntry {
  /** 学员需要辨认出的字符，如 “三”。 */
  character: string;
  /** 该字符对应的点号方，如 "14"。 */
  cell: BrailleCell;
  /** 人类可读的字符说明，用于提交后的讲解。 */
  description: string;
}

const CHINESE_DIGIT_CHARACTERS: readonly string[] = [
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

const PUNCTUATION_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  ['，', '全角逗号“，”'],
  ['。', '全角句号“。”'],
  ['-', '半角连字符“-”']
]);

function requirePunctuationCell(character: string): BrailleCell {
  const cell = PUNCTUATION_CELLS.get(character);
  if (cell === undefined) {
    throw new Error(`固定编码表缺少标点 ${character} 的编码`);
  }
  return cell;
}

/**
 * 识读题库：直接由既有固定编码表生成。
 *
 * 只收录编码互不冲突的字符：十个中文数字与三个标点各占一方唯一的点号
 * 组合。半角数字与中文数字共用同一编码（如 1 与 一 都是点 1），
 * 空格是空方（无点位可识读），数字符 3456 不对应任何输入字符，
 * 三者都不适合作为识读答案，故不收入题库。
 */
export const TRAINING_BANK: readonly BankEntry[] = [
  ...CHINESE_DIGIT_CHARACTERS.map((character, index) => ({
    character,
    cell: CHINESE_DIGIT_CELLS[index],
    description: `中文数字“${character}”`
  })),
  ...Array.from(PUNCTUATION_DESCRIPTIONS.entries(), ([character, description]) => ({
    character,
    cell: requirePunctuationCell(character),
    description
  }))
];

/** 一题：一张点卡、四个字符选项与正确字符。 */
export interface TrainingQuestion {
  /** 题号（0 起），与局内顺序一致。 */
  index: number;
  /** 题卡展示的点号方。 */
  cell: BrailleCell;
  /** 四个字符选项，顺序由种子确定。 */
  options: BankEntry[];
  /** 正确字符（必在 options 中恰好出现一次）。 */
  answer: BankEntry;
}

/** 一局训练：生成所用种子与按序排列的十道题。 */
export interface TrainingSession {
  seed: number;
  questions: TrainingQuestion[];
}

export type GenerateSessionResult =
  | { ok: true; session: TrainingSession }
  | { ok: false; message: string };

/** mulberry32：小而确定性的伪随机源，同一种子产生同一序列。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates 洗牌：返回新数组，不改动入参；顺序完全由 rand 决定。 */
function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * 生成一局训练题目。
 *
 * 种子必须是整数（界面以当前时间戳传入，单元测试注入固定种子）；
 * 题库按字符去重后必须至少能提供 SESSION_LENGTH 个编码互不相同的字符，
 * 且不少于 OPTION_COUNT 个选项来源。任一条件不满足都返回失败契约，
 * 由界面给出“无法开局”反馈，绝不产生空白题卡。
 *
 * 生成过程不抛异常、不访问外部状态：同一种子永远得到同一局题目。
 */
export function generateSession(
  seed: number,
  bank: readonly BankEntry[] = TRAINING_BANK
): GenerateSessionResult {
  if (!Number.isInteger(seed)) {
    return { ok: false, message: '题目生成失败：随机种子无效，无法开局，请重试。' };
  }

  // 按字符去重，防御题库中出现重复条目。
  const candidates: BankEntry[] = [];
  const seenCharacters = new Set<string>();
  for (const entry of bank) {
    if (!seenCharacters.has(entry.character)) {
      seenCharacters.add(entry.character);
      candidates.push(entry);
    }
  }

  const uniqueCells = new Set(candidates.map((entry) => entry.cell));
  if (candidates.length < OPTION_COUNT || uniqueCells.size < SESSION_LENGTH) {
    return {
      ok: false,
      message: '题目生成失败：固定编码表可用字符不足，无法凑齐十张不重复题卡，无法开局。'
    };
  }

  const rand = mulberry32(seed);
  // 十题答案从题库中一次性不放回抽取，保证一局十题互不重复。
  const answers = shuffle(candidates, rand).slice(0, SESSION_LENGTH);

  const questions: TrainingQuestion[] = answers.map((answer, index) => {
    const distractorPool = candidates.filter((entry) => entry.character !== answer.character);
    const distractors = shuffle(distractorPool, rand).slice(0, OPTION_COUNT - 1);
    const options = shuffle([answer, ...distractors], rand);
    return { index, cell: answer.cell, options, answer };
  });

  return { ok: true, session: { seed, questions } };
}

/** 点号说明：把点号方翻译为“第几点凸起”的口语化描述。 */
export function describeDots(cell: BrailleCell): string {
  if (cell === '') {
    return '空方：六点均不凸起';
  }
  return `第 ${cell.split('').join('、')} 点凸起`;
}

/** 局次阶段：空闲 / 作答中 / 已提交待下一题 / 已结束。 */
export type TrainingPhase = 'idle' | 'answering' | 'reviewing' | 'finished';

/** 一题的作答记录。 */
export interface AnsweredRecord {
  question: TrainingQuestion;
  /** 学员实际选择的选项。 */
  picked: BankEntry;
  correct: boolean;
}

/** 提交后的即时反馈：正确字符与点号说明。 */
export interface SubmitFeedback {
  picked: BankEntry;
  correct: boolean;
  answer: BankEntry;
  /** 正确字符的点号说明，如 “第 1、4 点凸起”。 */
  dotNote: string;
}

/** 局末成绩契约。 */
export interface TrainingScore {
  total: number;
  correct: number;
  /** 错题记录（含学员所选），按作答顺序排列。 */
  wrong: AnsweredRecord[];
}

/** 训练服务对外快照：界面只读取该契约渲染。 */
export interface TrainingSnapshot {
  phase: TrainingPhase;
  session: TrainingSession | null;
  /** 当前题号（0 起）。 */
  currentIndex: number;
  /** 当前题；空闲或已结束时为 null。 */
  currentQuestion: TrainingQuestion | null;
  records: AnsweredRecord[];
  /** 最近一次提交的反馈，仅在 reviewing 阶段存在。 */
  lastSubmit: SubmitFeedback | null;
  /** 成绩契约，仅在 finished 阶段存在。 */
  score: TrainingScore | null;
}

export type StartResult = { ok: true; session: TrainingSession } | { ok: false; message: string };
export type SubmitAnswerResult = { ok: true; feedback: SubmitFeedback } | { ok: false; message: string };
export type NextResult = { ok: true } | { ok: false; message: string };

export interface TrainingService {
  start: (seed: number) => StartResult;
  submit: (character: string) => SubmitAnswerResult;
  next: () => NextResult;
  /** 直接结束当前局次（刷新或离开工作区时调用），不保留任何状态。 */
  abort: () => void;
  getSnapshot: () => TrainingSnapshot;
}

/**
 * 创建训练服务：维护当前题号、作答记录与成绩契约。
 *
 * 规则：
 *  - 一局进行中（作答中或已提交待下一题）不允许再次开局；
 *  - 每题只允许提交一次，提交后进入 reviewing，须推进到下一题；
 *  - 十题全部作答后进入 finished，成绩契约此时才可读取；
 *  - abort 立即丢弃整局，不做任何本地保存。
 */
export function createTrainingService(): TrainingService {
  let phase: TrainingPhase = 'idle';
  let session: TrainingSession | null = null;
  let currentIndex = 0;
  let records: AnsweredRecord[] = [];
  let lastSubmit: SubmitFeedback | null = null;

  function start(seed: number): StartResult {
    if (phase === 'answering' || phase === 'reviewing') {
      return { ok: false, message: '当前局次尚未完成，不能重复开局。' };
    }
    const generated = generateSession(seed);
    if (!generated.ok) {
      return generated;
    }
    session = generated.session;
    currentIndex = 0;
    records = [];
    lastSubmit = null;
    phase = 'answering';
    return { ok: true, session };
  }

  function submit(character: string): SubmitAnswerResult {
    if (!session || (phase !== 'answering' && phase !== 'reviewing')) {
      return { ok: false, message: '当前没有进行中的局次，请先开始训练。' };
    }
    if (phase === 'reviewing') {
      return { ok: false, message: '本题已提交，不能重复作答。' };
    }
    const question = session.questions[currentIndex];
    const option = question.options.find((entry) => entry.character === character);
    if (!option) {
      return { ok: false, message: `选项“${character}”不在本题四个字符选项中。` };
    }
    const correct = option.character === question.answer.character;
    records.push({ question, picked: option, correct });
    lastSubmit = {
      picked: option,
      correct,
      answer: question.answer,
      dotNote: describeDots(question.answer.cell)
    };
    phase = 'reviewing';
    return { ok: true, feedback: lastSubmit };
  }

  function next(): NextResult {
    if (!session || phase !== 'reviewing') {
      return { ok: false, message: '请先提交本题答案，再进入下一题。' };
    }
    if (currentIndex >= session.questions.length - 1) {
      phase = 'finished';
    } else {
      currentIndex += 1;
      phase = 'answering';
    }
    lastSubmit = null;
    return { ok: true };
  }

  function abort(): void {
    phase = 'idle';
    session = null;
    currentIndex = 0;
    records = [];
    lastSubmit = null;
  }

  function getSnapshot(): TrainingSnapshot {
    const activeQuestion =
      session && (phase === 'answering' || phase === 'reviewing') ? session.questions[currentIndex] : null;
    const score: TrainingScore | null =
      session && phase === 'finished'
        ? {
            total: session.questions.length,
            correct: records.filter((record) => record.correct).length,
            wrong: records.filter((record) => !record.correct)
          }
        : null;
    return {
      phase,
      session,
      currentIndex,
      currentQuestion: activeQuestion,
      records: records.slice(),
      lastSubmit,
      score
    };
  }

  return { start, submit, next, abort, getSnapshot };
}
