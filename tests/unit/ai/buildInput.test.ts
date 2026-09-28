import { describe, it, expect } from 'vitest';
import {
  buildExtractionInput,
  type MessageForLlm,
  type OpenProposalForLlm,
  type OpenTaskForLlm,
} from '../../../src/ai/pipeline/buildInput.js';
import type { ParticipantForLlm } from '../../../src/ai/pseudonymize.js';
import type { PromptBundle } from '../../../src/ai/prompts.js';
import { loadPrompt } from '../../../src/ai/prompts.js';

const NOW = new Date('2026-09-23T09:00:00.000Z'); // 2026-09-23T12:00+03:00, Europe/Moscow
const WORKSPACE_TZ = 'Europe/Moscow';

const P0: ParticipantForLlm = {
  code: 'P0',
  userId: 100200301,
  displayName: 'Анна',
  aliases: [],
  username: 'anna_p',
  lastName: 'Петрова',
  isOwner: true,
};
const P1: ParticipantForLlm = {
  code: 'P1',
  userId: 100200302,
  displayName: 'Мария',
  aliases: ['Маша'],
  username: 'maria_t',
  lastName: 'Иванова',
  isOwner: false,
};
const P2: ParticipantForLlm = {
  code: 'P2',
  userId: 100200303,
  displayName: 'Олег',
  aliases: [],
  username: null,
  lastName: null,
  isOwner: false,
};
const PARTICIPANTS = [P0, P1, P2];

const STUB_PROMPT: PromptBundle = {
  version: 'extractor.v1',
  system: 'SYSTEM INSTRUCTIONS',
  userTemplate:
    'Сейчас: {now_local}, {weekday}. Часовой пояс школы: {workspace_tz}.\n' +
    'Участники: {participants}\n' +
    'Открытые задачи: {open_tasks}\n' +
    'Неразобранные предложения: {open_proposals}\n' +
    'Контекст (уже обработан, только для понимания): {context_messages}\n' +
    'Новые сообщения (анализируй только их): {new_messages}',
  examples: [
    { user: 'FEWSHOT USER 1', assistant: '{"actions":[]}' },
    { user: 'FEWSHOT USER 2', assistant: '{"actions":[]}' },
  ],
};

function baseMessage(
  overrides: Partial<MessageForLlm> & { id: number; sentAt: Date; authorUserId: number; text: string },
): MessageForLlm {
  return {
    replyToMessageId: null,
    replyQuote: null,
    isForward: false,
    forwardOriginName: null,
    forwardOriginUserId: null,
    authorTz: null,
    ...overrides,
  };
}

const M1 = baseMessage({
  id: 101,
  sentAt: new Date('2026-09-23T08:58:00.000Z'), // 11:58 Moscow
  authorUserId: P0.userId,
  text: 'Маша, подготовь расписание к пятнице',
});
const M2 = baseMessage({
  id: 102,
  sentAt: new Date('2026-09-23T09:01:00.000Z'), // 12:01 Moscow
  authorUserId: P1.userId,
  text: 'хорошо',
  replyToMessageId: M1.id,
});
const M3_UNKNOWN_REPLY = baseMessage({
  id: 103,
  sentAt: new Date('2026-09-23T09:05:00.000Z'),
  authorUserId: P1.userId,
  text: 'да, помню',
  replyToMessageId: 999999, // not in context or new messages
  replyQuote: 'подготовь расписание',
});
const M4_FORWARD_PARTICIPANT = baseMessage({
  id: 104,
  sentAt: new Date('2026-09-23T09:10:00.000Z'),
  authorUserId: P0.userId,
  text: 'важно',
  isForward: true,
  forwardOriginUserId: P2.userId,
});
const M5_FORWARD_STRANGER = baseMessage({
  id: 105,
  sentAt: new Date('2026-09-23T09:11:00.000Z'),
  authorUserId: P0.userId,
  text: 'от родителя',
  isForward: true,
  forwardOriginName: 'Ольга',
});
const M6_OTHER_TZ = baseMessage({
  id: 106,
  sentAt: new Date('2026-09-23T09:15:00.000Z'),
  authorUserId: P2.userId,
  text: 'принял',
  authorTz: 'Asia/Yekaterinburg',
});
const M7_PHONE = baseMessage({
  id: 107,
  sentAt: new Date('2026-09-23T09:20:00.000Z'),
  authorUserId: P0.userId,
  text: 'позвоните мне: 8 912 345 67 89',
});
const LONG_TEXT = 'ф'.repeat(2500);
const M8_LONG = baseMessage({
  id: 108,
  sentAt: new Date('2026-09-23T09:25:00.000Z'),
  authorUserId: P0.userId,
  text: LONG_TEXT,
});

const NEW_MESSAGES = [
  M1,
  M2,
  M3_UNKNOWN_REPLY,
  M4_FORWARD_PARTICIPANT,
  M5_FORWARD_STRANGER,
  M6_OTHER_TZ,
  M7_PHONE,
  M8_LONG,
];

const T12: OpenTaskForLlm = {
  id: 12,
  title: 'Подготовить расписание',
  assignee: { kind: 'participant', code: 'P1' },
  dueAt: new Date('2026-10-02T15:00:00.000Z'), // 18:00 Moscow
  dueAllDay: false,
};
const T13_ALL_DAY: OpenTaskForLlm = {
  id: 13,
  title: 'Отчёт за квартал',
  assignee: { kind: 'owner' },
  dueAt: new Date('2026-10-05T10:00:00.000Z'), // 2026-10-05 Moscow
  dueAllDay: true,
};
const T14_NO_DUE: OpenTaskForLlm = {
  id: 14,
  title: 'Закупить канцтовары',
  assignee: { kind: 'none' },
  dueAt: null,
  dueAllDay: false,
};
const T15_ALL: OpenTaskForLlm = {
  id: 15,
  title: 'Убрать зал',
  assignee: { kind: 'all' },
  dueAt: null,
  dueAllDay: false,
};
const OPEN_TASKS = [T12, T13_ALL_DAY, T14_NO_DUE, T15_ALL];

const OPEN_PROPOSALS: OpenProposalForLlm[] = [
  { id: 5, title: 'Купить канцтовары', kind: 'create', targetTaskId: null },
];

function buildBase() {
  return buildExtractionInput(
    {
      now: NOW,
      workspaceTz: WORKSPACE_TZ,
      participants: PARTICIPANTS,
      openTasks: OPEN_TASKS,
      openProposals: OPEN_PROPOSALS,
      context: [],
      messages: NEW_MESSAGES,
    },
    STUB_PROMPT,
  );
}

function finalUserContent(input: ReturnType<typeof buildExtractionInput>): string {
  const last = input.messages[input.messages.length - 1];
  if (!last) throw new Error('no messages');
  return last.content;
}

describe('buildExtractionInput (Task 2.3)', () => {
  it('formats participant lines: owner and alias', () => {
    const content = finalUserContent(buildBase());
    expect(content).toContain('P0/OWNER: Анна (руководитель)');
    expect(content).toContain('P1: Мария (алиасы: Маша)');
  });

  it('never leaks surnames, usernames or telegram IDs into any message content', () => {
    const input = buildBase();
    const forbidden = [
      'Петрова',
      'Иванова',
      'anna_p',
      'maria_t',
      String(P0.userId),
      String(P1.userId),
      String(P2.userId),
    ];
    for (const message of input.messages) {
      for (const needle of forbidden) {
        expect(message.content).not.toContain(needle);
      }
    }
  });

  it('formats a plain new message line', () => {
    const content = finalUserContent(buildBase());
    expect(content).toContain('M1 [2026-09-23 11:58, P0]: Маша, подготовь расписание к пятнице');
  });

  it('formats a reply to a new message by its M# ref', () => {
    const content = finalUserContent(buildBase());
    expect(content).toContain('M2 [2026-09-23 12:01, P1, ответ на M1]: хорошо');
  });

  it('formats a reply to a context message by its M-ctx-# ref', () => {
    const context = [
      baseMessage({
        id: 50,
        sentAt: new Date('2026-09-22T09:00:00.000Z'),
        authorUserId: P0.userId,
        text: 'контекстное сообщение',
      }),
    ];
    const input = buildExtractionInput(
      {
        now: NOW,
        workspaceTz: WORKSPACE_TZ,
        participants: PARTICIPANTS,
        openTasks: [],
        openProposals: [],
        context,
        messages: [
          baseMessage({
            id: 200,
            sentAt: NOW,
            authorUserId: P1.userId,
            text: 'принято',
            replyToMessageId: 50,
          }),
        ],
      },
      STUB_PROMPT,
    );
    expect(finalUserContent(input)).toContain('ответ на M-ctx-1');
    expect(input.refs.messages.get('M-ctx-1')).toBe(50);
  });

  it('quotes the reply text when the original message is not in the DB', () => {
    const content = finalUserContent(buildBase());
    expect(content).toContain('ответ на «подготовь расписание»');
  });

  it('formats a forward from a known participant by their code', () => {
    const content = finalUserContent(buildBase());
    expect(content).toContain('переслано от P2');
  });

  it('formats a forward from a stranger by their quoted name', () => {
    const content = finalUserContent(buildBase());
    expect(content).toContain('переслано от «Ольга»');
  });

  it('omits the reply segment entirely when neither a ref nor a quote is available', () => {
    const input = buildExtractionInput(
      {
        now: NOW,
        workspaceTz: WORKSPACE_TZ,
        participants: PARTICIPANTS,
        openTasks: [],
        openProposals: [],
        context: [],
        messages: [
          baseMessage({
            id: 300,
            sentAt: NOW,
            authorUserId: P0.userId,
            text: 'без цитаты',
            replyToMessageId: 999999,
          }),
        ],
      },
      STUB_PROMPT,
    );
    expect(finalUserContent(input)).not.toContain('ответ на');
  });

  it('omits the forward segment when neither the origin user nor a name is known', () => {
    const input = buildExtractionInput(
      {
        now: NOW,
        workspaceTz: WORKSPACE_TZ,
        participants: PARTICIPANTS,
        openTasks: [],
        openProposals: [],
        context: [],
        messages: [
          baseMessage({
            id: 301,
            sentAt: NOW,
            authorUserId: P0.userId,
            text: 'переслано без источника',
            isForward: true,
          }),
        ],
      },
      STUB_PROMPT,
    );
    expect(finalUserContent(input)).not.toContain('переслано от');
  });

  it('throws when a message is authored by someone missing from the participant projection', () => {
    expect(() =>
      buildExtractionInput(
        {
          now: NOW,
          workspaceTz: WORKSPACE_TZ,
          participants: [P0],
          openTasks: [],
          openProposals: [],
          context: [],
          messages: [baseMessage({ id: 302, sentAt: NOW, authorUserId: 999999999, text: 'кто это?' })],
        },
        STUB_PROMPT,
      ),
    ).toThrow();
  });

  it("appends the author's timezone only when it differs from the workspace's", () => {
    const content = finalUserContent(buildBase());
    expect(content).toContain('P2, пояс Asia/Yekaterinburg]');
    expect(content).not.toContain('P0, пояс');
    expect(content).not.toContain('P1, пояс');
  });

  it('formats open tasks: due with time, all-day, no due, and ALL assignee', () => {
    const content = finalUserContent(buildBase());
    expect(content).toContain('T12: «Подготовить расписание» · P1 · срок 2026-10-02 18:00');
    expect(content).toContain('T13: «Отчёт за квартал» · OWNER · срок 2026-10-05');
    expect(content).toContain('T14: «Закупить канцтовары» · без срока');
    expect(content).toContain('T15: «Убрать зал» · ALL · без срока');
  });

  it('turns a phone number into the [телефон] marker', () => {
    const content = finalUserContent(buildBase());
    expect(content).toContain('[телефон]');
    expect(content).not.toContain('912 345');
  });

  it('maps M# and P# refs to their real DB IDs', () => {
    const input = buildBase();
    expect(input.refs.messages.get('M1')).toBe(101);
    expect(input.refs.participants.get('P1')).toBe(P1.userId);
    expect(input.refs.tasks.get('T12')).toBe(12);
    expect(input.refs.proposals.get('R5')).toBe(5);
  });

  it('orders the chat messages as: system, few-shot pairs, final user', () => {
    const input = buildBase();
    expect(input.messages).toHaveLength(2 * STUB_PROMPT.examples.length + 2);
    expect(input.messages[0]).toEqual({ role: 'system', content: STUB_PROMPT.system });
    STUB_PROMPT.examples.forEach((example, index) => {
      expect(input.messages[1 + 2 * index]).toEqual({ role: 'user', content: example.user });
      expect(input.messages[2 + 2 * index]).toEqual({ role: 'assistant', content: example.assistant });
    });
    const last = input.messages[input.messages.length - 1];
    expect(last?.role).toBe('user');
  });

  it('truncates message text to 2000 characters with an ellipsis', () => {
    const content = finalUserContent(buildBase());
    const truncated = `${'ф'.repeat(2000)}…`;
    expect(content).toContain(truncated);
    expect(content).not.toContain('ф'.repeat(2001));
  });

  it('caches promptVersion from the bundle', () => {
    expect(buildBase().promptVersion).toBe('extractor.v1');
  });

  describe('limits', () => {
    const owner: ParticipantForLlm = { ...P0 };

    function makeTasks(count: number): OpenTaskForLlm[] {
      return Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        title: `Задача ${i + 1}`,
        assignee: { kind: 'none' },
        dueAt: null,
        dueAllDay: false,
      }));
    }
    function makeProposals(count: number): OpenProposalForLlm[] {
      return Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        title: `Предложение ${i + 1}`,
        kind: 'create',
        targetTaskId: null,
      }));
    }
    function makeContext(count: number): MessageForLlm[] {
      return Array.from({ length: count }, (_, i) =>
        baseMessage({
          id: 1000 + i,
          sentAt: new Date(NOW.getTime() - (count - i) * 60_000),
          authorUserId: owner.userId,
          text: `контекст ${i + 1}`,
        }),
      );
    }

    it('keeps at most 50 open tasks, 20 proposals and 20 context messages', () => {
      const input = buildExtractionInput(
        {
          now: NOW,
          workspaceTz: WORKSPACE_TZ,
          participants: [owner],
          openTasks: makeTasks(60),
          openProposals: makeProposals(25),
          context: makeContext(25),
          messages: [],
        },
        STUB_PROMPT,
      );
      expect(input.refs.tasks.size).toBe(50);
      expect(input.refs.proposals.size).toBe(20);
      const contextRefs = Array.from(input.refs.messages.keys()).filter((k) => k.startsWith('M-ctx-'));
      expect(contextRefs).toHaveLength(20);
    });
  });

  describe('with the real extractor.v1 prompt', () => {
    it('composes end to end without throwing', () => {
      const prompt = loadPrompt({ name: 'extractor', version: 'extractor.v1', profile: 'school_ru' });
      const input = buildExtractionInput(
        {
          now: NOW,
          workspaceTz: WORKSPACE_TZ,
          participants: PARTICIPANTS,
          openTasks: OPEN_TASKS,
          openProposals: OPEN_PROPOSALS,
          context: [],
          messages: NEW_MESSAGES,
        },
        prompt,
      );
      expect(input.promptVersion).toBe('extractor.v1');
      expect(input.messages[0]).toMatchObject({ role: 'system' });
      expect(input.messages.at(-1)).toMatchObject({ role: 'user' });
    });
  });
});
