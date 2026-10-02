export const DEFAULT_WORKSPACE_NAME = 'Школа';
export const TICK_INTERVAL_MS = 20_000;
export const HEARTBEAT_MAX_AGE_MS = 60_000;
export const BATCH_BACKOFF_MINUTES = [1, 5, 15, 15] as const; // после 1-й…4-й неудачи; 5-я → failed
export const BATCH_MAX_ATTEMPTS = 5;
export const STALE_RUNNING_BATCH_MS = 5 * 60_000;
// How many queued batches one analyzeJob tick claims and processes at most (plan.md Task 2.9).
export const MAX_BATCHES_PER_TICK = 5;
// analysis_batches.prompt_version for the current extractor prompt file (prompts/extractor.v2.md, D45).
// extractor.v1.md stays on disk unedited (D27) and is still used by fixtures/tests that pin it deliberately.
export const EXTRACTOR_PROMPT_VERSION = 'extractor.v2';
// analysis_batches.prompt_version for the free-text date parser (plan.md Task 2.14, prompts/parseDate.v1.md).
export const PARSE_DATE_PROMPT_VERSION = 'parseDate.v1';
// analysis_batches.prompt_version for the manual single-message extractor (plan.md Task 3.10, D19,
// prompts/extractor.single.v1.md) — used by `/task`, DM free text and DM forwards.
export const EXTRACTOR_SINGLE_PROMPT_VERSION = 'extractor.single.v1';
// D19 — the manual-creation fallback title ("the first N characters of the text") when the model found no
// action, or the LLM is unavailable entirely.
export const MANUAL_FALLBACK_TITLE_MAX_CHARS = 80;
// SPEC §12.1 — the acknowledgement reaction on a `/task` command in a group (the bot never replies with
// text there). Independent of `settings.reactions.*` (a fixed emoji, not configurable per workspace).
export const TASK_COMMAND_REACTION_EMOJI = '✍';
// SPEC §8/§9.2 — consecutive LLM-call failures (across batches) before superadmin is alerted.
export const LLM_CONSECUTIVE_FAILURES_ALERT_THRESHOLD = 5;
export const MAX_ANALYSIS_TEXT_CHARS = 2000;
export const QUOTE_MAX_CHARS = 200;
export const TELEGRAM_TEXT_LIMIT = 4096;
export const CALLBACK_DATA_MAX_BYTES = 64;
export const CONTEXT_MESSAGES = 20;
export const PROMPT_MAX_OPEN_TASKS = 50;
export const PROMPT_MAX_OPEN_PROPOSALS = 20;
export const DEDUP_SIMILARITY = 0.6;
export const DEDUP_WINDOW_DAYS = 14;
export const MAX_CARDS_PER_BATCH = 10;
// Task title/name cap (plan.md Task 2.13, tasks.title's DB comment) — enforced by TaskService.create/update,
// the domain boundary for task writes, mirroring QUOTE_MAX_CHARS's role for tasks.source_quote.
export const TASK_TITLE_MAX_CHARS = 120;
export const PENDING_CHAT_TIMEOUT_HOURS = 72;
export const CLAIM_CODE_TTL_HOURS = 24;
export const CONVERSATION_TIMEOUT_MS = 10 * 60_000;
export const PAGE_SIZE = 5;
export const MAX_ALIASES_PER_PERSON = 10;
export const MAX_ALIAS_LENGTH = 30;
export const FORWARD_BURST_MS = 3000;
export const DEFAULT_STOP_LIST = [
  'ок',
  'ok',
  'окей',
  'ок👍',
  'спасибо',
  'спс',
  'да',
  'нет',
  '+',
  '👍',
  'ага',
  'угу',
  'понял',
  'поняла',
  'хорошо',
  'ясно',
];
export const MSK_TOKENS = ['мск', 'msk'];
// SPEC §19.3.2 — pseudonymization markers substituted into LLM input.
export const PII_MARKERS = {
  phone: '[телефон]',
  email: '[email]',
  requisites: '[реквизиты]',
  link: '[ссылка]',
  unknownUser: '@user',
} as const;
// Labels used by `src/ai/pipeline/buildInput.ts` when it renders the extractor's
// input lines (participants, open tasks/proposals, messages) — kept here rather
// than as string literals in `buildInput.ts` (CLAUDE.md §8's Cyrillic rule).
export const PROMPT_LABELS = {
  replyTo: 'ответ на',
  forwardedFrom: 'переслано от',
  due: 'срок',
  noDue: 'без срока',
  zone: 'пояс',
  owner: 'руководитель',
  aliases: 'алиасы',
} as const;
export const COMPLETION_SIGNALS = [
  'готово',
  'сделала',
  'сделал',
  'сделано',
  'отправила',
  'отправил',
  'выполнила',
  'выполнил',
  'готова',
  'готов',
];
