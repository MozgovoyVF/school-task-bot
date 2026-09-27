import { bigserial, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const workspaces = pgTable('workspaces', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  profile: text('profile').notNull().default('school_ru'),
  timezone: text('timezone').notNull().default('Europe/Moscow'),
  settings: jsonb('settings'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
