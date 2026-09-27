import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { analysisBatches } from './ai.js';
import { chats } from './chats.js';
import { messageAnalysisStatus } from './enums.js';
import { users } from './people.js';

export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    chatId: bigint('chat_id', { mode: 'number' })
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    tgMessageId: integer('tg_message_id').notNull(),
    authorUserId: bigint('author_user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    text: text('text'),
    replyToTgMessageId: integer('reply_to_tg_message_id'),
    // D5 (SPEC §7.2 requires storing the quoted text, but the SPEC §6 column list is missing it).
    replyToQuote: text('reply_to_quote'),
    forwardOriginName: text('forward_origin_name'),
    isForward: boolean('is_forward').notNull().default(false),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    analysisStatus: messageAnalysisStatus('analysis_status').notNull().default('pending'),
    // Explicit return type breaks the messages <-> analysis_batches circular type inference (Drizzle FAQ).
    batchId: bigint('batch_id', { mode: 'number' }).references((): AnyPgColumn => analysisBatches.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('messages_chat_tg_message').on(t.chatId, t.tgMessageId),
    index('messages_chat_status_sent_at').on(t.chatId, t.analysisStatus, t.sentAt),
  ],
);
