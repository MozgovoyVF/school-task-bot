import { describe, it, expect } from 'vitest';
import { pseudonymizeText, type ParticipantForLlm } from '../../../src/ai/pseudonymize.js';

const P: ParticipantForLlm[] = [
  {
    code: 'P0',
    userId: 1,
    displayName: 'Анна',
    aliases: [],
    username: 'anna_p',
    lastName: 'Петрова',
    isOwner: true,
  },
  {
    code: 'P1',
    userId: 2,
    displayName: 'Мария',
    aliases: ['Маша'],
    username: 'maria_t',
    lastName: 'Иванова',
    isOwner: false,
  },
];
const ps = (t: string) => pseudonymizeText(t, P);

describe('pseudonymize (SPEC §19.3.2)', () => {
  it.each([
    ['@maria_t подготовь', 'P1 подготовь'],
    ['@unknown_user привет', '@user привет'],
    ['позвони +7 (912) 345-67-89', 'позвони [телефон]'],
    ['89123456789', '[телефон]'],
    ['8 912 345 67 89 мама Пети', '[телефон] мама Пети'],
    ['+79123456789', '[телефон]'],
    ['912-345-67-89', '[телефон]'],
    ['+33 6 12 34 56 78', '[телефон]'],
    ['пиши на anna@school.ru', 'пиши на [email]'],
    ['карта 2202 2024 1234 5678', 'карта [реквизиты]'],
    ['счёт 40702810900000012345', 'счёт [реквизиты]'],
    ['смотри https://docs.google.com/x?id=1', 'смотри [ссылка]'],
    ['https://t.me/maria_t', '[ссылка]'],
    ['www.school.ru/price', '[ссылка]'],
    ['Мария Иванова сделает', 'Мария сделает'],
    ['Иванова, отчёт готов?', 'P1, отчёт готов?'],
    ['ИВАНОВА!', 'P1!'],
  ])('%j → %j', (input, out) => expect(ps(input)).toBe(out));

  it.each([
    'созвон 15.10 в 14:00',
    'оплата 15 000 ₽ до 01.11',
    'урок в каб. 3',
    'дата 2026-10-03',
    'ученик Петя Сидоров',
    'Ивановка — это деревня',
  ])('keeps %j unchanged', (t) => expect(ps(t)).toBe(t));

  it('is idempotent', () => {
    const t = 'Мария Иванова, @maria_t, +7 912 345-67-89, https://x.ru';
    expect(ps(ps(t))).toBe(ps(t));
  });
});
