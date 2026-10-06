import type { AiLast7Stats } from '../../domain/ai/stats.js';
import type { RecentErrorRow } from '../../domain/system/errorReports.js';
import { formatDue } from '../../time/format.js';
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
  /** `listRecentErrors`'s output (`src/domain/system/errorReports.ts`, SPEC §12.2's "/admin" row's last-errors column), newest first. */
  recentErrors: RecentErrorRow[];
  /** Workspace timezone, used only to render each `recentErrors[].lastAt` (same `formatDue`/viewer-zone convention `/debug`'s `whenLabel` uses). */
  viewerZone: string;
}

/** `row.lastAt` rendered the same one-line way `/debug`'s own `whenLabel` renders a batch's `createdAt` — reused here purely for its display shape, not an actual task due date. */
function whenLabel(at: Date, viewerZone: string): string {
  return texts.formatDue(formatDue({ at, allDay: false, tz: null }, viewerZone));
}

/** Pure render for `/admin`: no DB, no I/O (CLAUDE.md §7). */
export function renderAdminPanel(info: AdminPanelInfo): AdminView {
  const recentErrors = info.recentErrors.map((e) => ({
    name: e.name,
    message: e.message,
    count: e.count,
    when: whenLabel(e.lastAt, info.viewerZone),
  }));
  return {
    text: texts.admin.panel(info.gitSha, info.uptimeSec, info.ai, info.pendingByChat, recentErrors),
  };
}
