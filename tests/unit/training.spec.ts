import { describe, expect, it } from 'vitest';
import { encodePhrase } from '../../src/lib/braille';
import {
  OPTION_COUNT,
  SESSION_LENGTH,
  TRAINING_BANK,
  createTrainingService,
  describeDots,
  generateSession
} from '../../src/lib/training';

function questionCells(seed: number): string[] {
  const result = generateSession(seed);
  if (!result.ok) {
    throw new Error('expected generation to succeed');
  }
  return result.session.questions.map((question) => question.cell);
}

describe('题库与固定编码表一致', () => {
  it('题库条目全部由既有固定编码表生成', () => {
    expect(TRAINING_BANK.length).toBeGreaterThanOrEqual(SESSION_LENGTH);
    for (const entry of TRAINING_BANK) {
      const encoded = encodePhrase(entry.character);
      expect(encoded.errors).toEqual([]);
      expect(encoded.cells).toEqual([entry.cell]);
    }
  });

  it('题库编码互不重复（每个点号方只对应一个可识读字符）', () => {
    const cells = TRAINING_BANK.map((entry) => entry.cell);
    expect(new Set(cells).size).toBe(cells.length);
    // 空方（空格）不作为识读题
    expect(cells).not.toContain('');
  });
});

describe('题目生成：种子确定性', () => {
  it('同一种子生成完全相同的题序与选项顺序', () => {
    const first = generateSession(42);
    const second = generateSession(42);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.session).toEqual(first.session);
    }
  });

  it('不同种子生成不同题序', () => {
    const baseline = questionCells(1);
    const others = [2, 3, 4, 5].map(questionCells);
    // 至少绝大多数种子给出不同排列；逐个断言以保证确定性可复现
    for (const cells of others) {
      expect(cells).not.toEqual(baseline);
    }
  });

  it('一局固定十题且互不重复', () => {
    for (const seed of [7, 100, 20260915]) {
      const result = generateSession(seed);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const { questions } = result.session;
        expect(questions).toHaveLength(SESSION_LENGTH);
        expect(new Set(questions.map((question) => question.cell)).size).toBe(SESSION_LENGTH);
        expect(new Set(questions.map((question) => question.answer.character)).size).toBe(SESSION_LENGTH);
        questions.forEach((question, index) => {
          expect(question.index).toBe(index);
        });
      }
    }
  });

  it('任意整数种子生成的十张题卡都互不重复（不出现相同点号）', () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const result = generateSession(seed);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const cells = result.session.questions.map((question) => question.cell);
        expect(new Set(cells).size).toBe(SESSION_LENGTH);
      }
    }
  });

  it('每题四个互不重复的选项且恰好包含一个正确字符', () => {
    const result = generateSession(9);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const question of result.session.questions) {
        expect(question.options).toHaveLength(OPTION_COUNT);
        const characters = question.options.map((option) => option.character);
        expect(new Set(characters).size).toBe(OPTION_COUNT);
        expect(characters.filter((character) => character === question.answer.character)).toHaveLength(1);
        // 选项顺序同样确定：同种子重生成应逐项一致
        const regenerated = generateSession(9);
        if (regenerated.ok) {
          expect(regenerated.session.questions[question.index].options).toEqual(question.options);
        }
      }
    }
  });

  it('种子非法或题库不足时返回失败契约而不是抛出异常', () => {
    for (const badSeed of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const result = generateSession(badSeed);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain('无法开局');
      }
    }

    const tinyBank = TRAINING_BANK.slice(0, 3);
    const deficient = generateSession(1, tinyBank);
    expect(deficient.ok).toBe(false);
    if (!deficient.ok) {
      expect(deficient.message).toContain('无法开局');
    }
  });
});

describe('点号说明', () => {
  it('把点号方翻译为凸起点位描述', () => {
    expect(describeDots('14')).toBe('第 1、4 点凸起');
    expect(describeDots('3456')).toBe('第 3、4、5、6 点凸起');
    expect(describeDots('')).toBe('空方：六点均不凸起');
  });
});

describe('训练服务：局次流程与计分', () => {
  it('开局后维护当前题号，逐题推进直至结束', () => {
    const service = createTrainingService();
    expect(service.getSnapshot().phase).toBe('idle');
    expect(service.getSnapshot().currentQuestion).toBeNull();

    const started = service.start(42);
    expect(started.ok).toBe(true);

    for (let index = 0; index < SESSION_LENGTH; index += 1) {
      const snapshot = service.getSnapshot();
      expect(snapshot.phase).toBe('answering');
      expect(snapshot.currentIndex).toBe(index);
      expect(snapshot.currentQuestion?.index).toBe(index);

      const answer = snapshot.currentQuestion!.answer.character;
      const submitted = service.submit(answer);
      expect(submitted.ok).toBe(true);
      expect(service.getSnapshot().phase).toBe('reviewing');

      const advanced = service.next();
      expect(advanced.ok).toBe(true);
    }

    const finalSnapshot = service.getSnapshot();
    expect(finalSnapshot.phase).toBe('finished');
    expect(finalSnapshot.currentQuestion).toBeNull();
    expect(finalSnapshot.score).toEqual({ total: SESSION_LENGTH, correct: SESSION_LENGTH, wrong: [] });
  });

  it('全部答对得满分，答错计入错题并保留所选字符', () => {
    const service = createTrainingService();
    service.start(7);

    // 第 1 题故意答错：选一个非正确字符
    const first = service.getSnapshot().currentQuestion!;
    const wrongOption = first.options.find((option) => option.character !== first.answer.character)!;
    const wrongSubmit = service.submit(wrongOption.character);
    expect(wrongSubmit.ok).toBe(true);
    if (wrongSubmit.ok) {
      expect(wrongSubmit.feedback.correct).toBe(false);
      expect(wrongSubmit.feedback.answer.character).toBe(first.answer.character);
      expect(wrongSubmit.feedback.dotNote).toBe(describeDots(first.cell));
    }
    service.next();

    // 其余九题全部答对
    for (let index = 1; index < SESSION_LENGTH; index += 1) {
      const question = service.getSnapshot().currentQuestion!;
      service.submit(question.answer.character);
      service.next();
    }

    const score = service.getSnapshot().score!;
    expect(score.total).toBe(SESSION_LENGTH);
    expect(score.correct).toBe(SESSION_LENGTH - 1);
    expect(score.wrong).toHaveLength(1);
    expect(score.wrong[0].question.index).toBe(0);
    expect(score.wrong[0].picked.character).toBe(wrongOption.character);
    expect(score.wrong[0].question.answer.character).toBe(first.answer.character);
  });

  it('前九题答对、末题答错时成绩如实显示 9 对 1 错并列出末题', () => {
    const service = createTrainingService();
    service.start(7);

    for (let index = 0; index < SESSION_LENGTH - 1; index += 1) {
      const question = service.getSnapshot().currentQuestion!;
      expect(service.submit(question.answer.character).ok).toBe(true);
      service.next();
    }

    // 最后一题故意答错
    const last = service.getSnapshot().currentQuestion!;
    const wrongOption = last.options.find((option) => option.character !== last.answer.character)!;
    expect(service.submit(wrongOption.character).ok).toBe(true);
    service.next();

    const score = service.getSnapshot().score!;
    expect(score.total).toBe(SESSION_LENGTH);
    expect(score.correct).toBe(SESSION_LENGTH - 1);
    expect(score.wrong).toHaveLength(1);
    expect(score.wrong[0].question.index).toBe(SESSION_LENGTH - 1);
    expect(score.wrong[0].picked.character).toBe(wrongOption.character);
  });

  it('每题只允许提交一次，重复提交被拦截且不计分', () => {
    const service = createTrainingService();
    service.start(11);

    const question = service.getSnapshot().currentQuestion!;
    const first = service.submit(question.answer.character);
    expect(first.ok).toBe(true);

    const again = service.submit(question.answer.character);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.message).toContain('不能重复作答');
    }

    // 作答记录仍只有一条；推进后答完其余题目，成绩不受重复提交影响
    expect(service.getSnapshot().records).toHaveLength(1);
    service.next();
    for (let index = 1; index < SESSION_LENGTH; index += 1) {
      const current = service.getSnapshot().currentQuestion!;
      service.submit(current.answer.character);
      service.next();
    }
    const score = service.getSnapshot().score!;
    expect(score.correct).toBe(SESSION_LENGTH);
    expect(service.getSnapshot().records).toHaveLength(SESSION_LENGTH);
  });
});

describe('训练服务：开局与结束约束', () => {
  it('局次进行中阻止重复开局', () => {
    const service = createTrainingService();
    service.start(3);
    const again = service.start(4);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.message).toContain('不能重复开局');
    }
    // 原局次仍在第 1 题
    expect(service.getSnapshot().currentIndex).toBe(0);
    expect(service.getSnapshot().phase).toBe('answering');
  });

  it('生成异常时不开局：保持空闲且无题卡', () => {
    const service = createTrainingService();
    const result = service.start(Number.NaN);
    expect(result.ok).toBe(false);
    const snapshot = service.getSnapshot();
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.currentQuestion).toBeNull();
    expect(snapshot.session).toBeNull();
  });

  it('未提交不能进入下一题；结束后不能再作答', () => {
    const service = createTrainingService();
    expect(service.next().ok).toBe(false);

    service.start(5);
    expect(service.next().ok).toBe(false);

    // 答完全部十题
    for (let index = 0; index < SESSION_LENGTH; index += 1) {
      const question = service.getSnapshot().currentQuestion!;
      service.submit(question.answer.character);
      service.next();
    }
    expect(service.getSnapshot().phase).toBe('finished');

    const lateSubmit = service.submit('一');
    expect(lateSubmit.ok).toBe(false);
    expect(service.next().ok).toBe(false);
  });

  it('abort 直接结束局次：状态清空且不保留成绩', () => {
    const service = createTrainingService();
    service.start(8);
    const question = service.getSnapshot().currentQuestion!;
    service.submit(question.answer.character);

    service.abort();
    const snapshot = service.getSnapshot();
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.session).toBeNull();
    expect(snapshot.records).toEqual([]);
    expect(snapshot.score).toBeNull();

    // 可以重新开局
    expect(service.start(9).ok).toBe(true);
  });

  it('提交不在四个选项中的字符被拒绝', () => {
    const service = createTrainingService();
    service.start(13);
    const result = service.submit('不存在');
    expect(result.ok).toBe(false);
    expect(service.getSnapshot().records).toHaveLength(0);
    expect(service.getSnapshot().phase).toBe('answering');
  });
});
