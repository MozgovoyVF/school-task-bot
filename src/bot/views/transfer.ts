import type { Buttons } from '../../domain/messenger.js';
import { texts } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';

export interface TransferView {
  text: string;
  buttons: Buttons;
}

export interface TransferCodeView {
  text: string;
}

/**
 * Pure render for `/transfer`'s two-button choice: "prior owner becomes a
 * member" (`v1:o:dem:0`) vs. "prior owner is removed" (`v1:o:rem:0`) — the
 * `id` is unused (always `0`), the codec just requires one (CLAUDE.md §8).
 * No DB, no I/O (CLAUDE.md §7).
 */
export function renderTransferPrompt(): TransferView {
  return {
    text: texts.transfer.prompt,
    buttons: [
      [
        { text: texts.transfer.demoteButton, data: encodeCallback({ entity: 'o', action: 'dem', id: 0 }) },
        { text: texts.transfer.removeButton, data: encodeCallback({ entity: 'o', action: 'rem', id: 0 }) },
      ],
    ],
  };
}

/** Pure render for the generated claim code message, sent after either `/transfer` choice or `/admin`'s button. */
export function renderTransferCode(code: string): TransferCodeView {
  return { text: texts.transfer.code(code) };
}

/**
 * The single-button keyboard `/admin`'s panel offers a superadmin (`v1:o:adm:0`,
 * distinct from `/transfer`'s `dem`/`rem` — issuing a code this way skips the
 * demote/remove choice, since it exists for the empty-workspace bootstrap case
 * where there is no current owner to demote or remove — SPEC §10).
 */
export function renderAdminOwnerCodeButton(): Buttons {
  return [
    [{ text: texts.admin.ownerCodeButton, data: encodeCallback({ entity: 'o', action: 'adm', id: 0 }) }],
  ];
}
