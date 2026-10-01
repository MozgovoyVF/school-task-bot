import type { Buttons } from '../../domain/messenger.js';
import type { BatchDebugRow } from '../../domain/ai/stats.js';
import { TELEGRAM_TEXT_LIMIT } from '../../config/constants.js';
import { formatDue } from '../../time/format.js';
import { texts } from '../texts/ru.js';
import { escapeHtml } from './escape.js';

export interface DebugView {
  text: string;
  buttons: Buttons;
}

const STATUS_LABEL: Record<BatchDebugRow['status'], string> = {
  queued: texts.debug.statusQueued,
  running: texts.debug.statusRunning,
  done: texts.debug.statusDone,
  failed: texts.debug.statusFailed,
};

/** `row.createdAt` rendered as `formatDue`'s usual one-line display (SPEC §10.9's format, reused here purely for its "weekday, day month, HH:mm" shape — not an actual task due date). */
function whenLabel(at: Date, viewerZone: string): string {
  return texts.formatDue(formatDue({ at, allDay: false, tz: null }, viewerZone));
}

/** `reasons` sorted by count desc, then reason name, so the most common suppression reason always leads. */
function reasonsLabel(reasons: BatchDebugRow['suppressedReasons']): string {
  return [...reasons]
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .map((r) => `${escapeHtml(r.reason)}: ${String(r.count)}`)
    .join(', ');
}

function renderBatch(row: BatchDebugRow, viewerZone: string): string {
  const chatLabel = row.chatTitle === null ? null : escapeHtml(row.chatTitle);
  const lines = [
    texts.debug.batchHeader(row.id, whenLabel(row.createdAt, viewerZone), chatLabel),
    texts.debug.countsLine(row.messageCount, STATUS_LABEL[row.status]),
    texts.debug.decisionLine(row.shown, row.suppressed, reasonsLabel(row.suppressedReasons)),
    texts.debug.costLine(row.model === null ? null : escapeHtml(row.model), row.costUsd),
  ];
  if (row.error !== null) lines.push(texts.debug.errorLine(escapeHtml(row.error)));
  return lines.join('\n');
}

/**
 * Pure render for `/debug [chat]` (plan.md Task 2.15, SPEC §12.2's row): the last `rows.length` (≤10,
 * the caller's `listRecentBatches` limit) `analysis_batches`, newest first, each as its own block. No DB,
 * no I/O (CLAUDE.md §7) — the caller (`bot/handlers/admin.ts`) supplies the already-fetched rows and the
 * viewer's own timezone for `whenLabel`.
 */
export function renderDebugPanel(rows: BatchDebugRow[], viewerZone: string): DebugView {
  if (rows.length === 0) return { text: texts.debug.empty, buttons: [] };

  const blocks = rows.map((row) => renderBatch(row, viewerZone));
  // Defensive backstop only (mirrors `renderProposalCard`'s own): with each block's error text already a
  // short static string (`summarizeError`, never raw message text — CLAUDE.md §8), 10 blocks never
  // actually approaches Telegram's 4096-char limit in practice.
  const text = [texts.debug.header, ...blocks].join('\n\n').slice(0, TELEGRAM_TEXT_LIMIT);
  return { text, buttons: [] };
}
