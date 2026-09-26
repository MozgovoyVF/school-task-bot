import { bigint, bigserial, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { chatStatus, chatType } from './enums.js';
import { users } from './people.js';
import { workspaces } from './workspaces.js';

export const chats = pgTable('chats', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tgChatId: bigint('tg_chat_id', { mode: 'number' }).notNull().unique(),
  workspaceId: bigint('workspace_id', { mode: 'number' }).references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  title: text('title'),
  type: chatType('type').notNull(),
  status: chatStatus('status').notNull().default('pending'),
  analysisEnabled: boolean('analysis_enabled').notNull().default(true),
  reactionsEnabled: boolean('reactions_enabled').notNull().default(true),
  addedByUserId: bigint('added_by_user_id', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  noticeSentAt: timestamp('notice_sent_at', { withTimezone: true }),
  // D5: 72h pending-chat timeout — counted from the moment the owner was asked to approve the chat.
  pendingSince: timestamp('pending_since', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
