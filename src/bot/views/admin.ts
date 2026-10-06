import type { AiLast7Stats } from '../../domain/ai/stats.js';
import { texts } from '../texts/ru.js';

export interface AdminView {
  text: string;
}

export interface AdminPanelInfo {
  gitSha: string;
  uptimeSec: number;
  /** `aiStats`'s output (`src/domain/ai/stats.ts`, plan.md Task 2.15) — today's/this month's LLM spend, the last 7 days' proposal counts, and their derived precision. */
  ai: {
    costToday: number;
    costMonth: number;
    last7: AiLast7Stats;
    precision: number | null;
  };
  /** `aiStats`'s `pendingByChat` — the pending-proposals queue by chat (SPEC §18/§12.2). */
  pendingByChat: Array<{ chatId: number; title: string; count: number }>;
}

/** Pure render for `/admin`: no DB, no I/O (CLAUDE.md §7). */
export function renderAdminPanel(info: AdminPanelInfo): AdminView {
  return { text: texts.admin.panel(info.gitSha, info.uptimeSec, info.ai, info.pendingByChat) };
}
