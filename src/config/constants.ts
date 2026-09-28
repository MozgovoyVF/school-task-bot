export const DEFAULT_WORKSPACE_NAME = 'Школа';
export const TICK_INTERVAL_MS = 20_000;
export const HEARTBEAT_MAX_AGE_MS = 60_000;
export const BATCH_BACKOFF_MINUTES = [1, 5, 15, 15] as const; // после 1-й…4-й неудачи; 5-я → failed
export const BATCH_MAX_ATTEMPTS = 5;
export const STALE_RUNNING_BATCH_MS = 5 * 60_000;
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
