import { describe, it, expect } from 'vitest';
import { classifyForAnalysis } from '../../../src/ai/pipeline/heuristics.js';

describe('stage 0 heuristics (SPEC §7.3)', () => {
  it.each([
    'ок',
    'Ок.',
    'ОК!!',
    'ок👍',
    '👍',
    '👍👍🔥',
    '!!!',
    '+',
    '  ',
    'да',
    'нет',
    'спасибо!',
    'ok',
    '10',
  ])('skips %j', (t) => expect(classifyForAnalysis(t)).toBe('skipped'));
  it.each([
    'готово',
    'Сделала',
    'сделал ✅',
    'отправила',
    'Готова!',
    '15:00',
    'в 15',
    'Маша, подготовь расписание',
    'спасибо большое, сделаю завтра',
  ])('keeps %j', (t) => expect(classifyForAnalysis(t)).toBe('pending'));

  it('accepts a custom stopList/completionSignals override', () => {
    expect(classifyForAnalysis('yo', { stopList: ['yo'] })).toBe('skipped');
    expect(classifyForAnalysis('finished', { completionSignals: ['finished'] })).toBe('pending');
  });
});
