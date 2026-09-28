import type { Buttons } from '../../domain/messenger.js';
import type { MemberWithUser } from '../../domain/people/repo.js';
import type { WorkspaceRow, UserRow } from '../context.js';
import { userZone, zoneLabel } from '../../time/zones.js';
import { texts, formatZoneLabel } from '../texts/ru.js';
import { encodeCallback } from '../keyboards/callbackCodec.js';

export interface PeopleView {
  text: string;
  buttons: Buttons;
}

/** `formatZoneLabel(zoneLabel(...))` for `row.user`'s effective zone (their own preference, or the workspace default — `userZone`, same as reminders/due dates use, SPEC §10.1). */
function zoneText(user: UserRow, workspace: WorkspaceRow, at: Date): string {
  return formatZoneLabel(zoneLabel(userZone(user, workspace), at));
}

function aliasesText(aliases: string[]): string {
  return aliases.length === 0 ? texts.people.noAliases : aliases.join(', ');
}

function backButtonRow(): Buttons[number] {
  return [{ text: texts.people.backButton, data: encodeCallback({ entity: 'u', action: 'lst', id: 0 }) }];
}

/**
 * Pure render for `/people`'s list (Task 1.10): a text line per member
 * (name, aliases, timezone — deliberately no notification toggle, D40) plus
 * one button per member (`v1:u:opn:<membershipId>`) that opens
 * {@link renderPersonCard} for them. No DB, no I/O (CLAUDE.md §7) — the
 * caller (`bot/handlers/people.ts`) supplies the already-fetched rows and
 * `at` (`deps.clock.now()`, never read directly here).
 */
export function renderPeopleList(rows: MemberWithUser[], workspace: WorkspaceRow, at: Date): PeopleView {
  if (rows.length === 0) {
    return { text: texts.people.listEmpty, buttons: [] };
  }

  const lines = [
    texts.people.listHeader,
    '',
    ...rows.map((row) =>
      texts.people.listLine(
        row.membership.displayName,
        aliasesText(row.membership.aliases),
        zoneText(row.user, workspace, at),
      ),
    ),
  ];
  const buttons: Buttons = rows.map((row) => [
    {
      text: row.membership.displayName,
      data: encodeCallback({ entity: 'u', action: 'opn', id: row.membership.id }),
    },
  ]);

  return { text: lines.join('\n'), buttons };
}

/**
 * Pure render for a single member's `/people` card (Task 1.10): name,
 * aliases, timezone, an edit button (`v1:u:edt:<membershipId>`, which enters
 * `editPerson.ts`'s dialog) and a back button. No delete-data button yet —
 * that arrives in Task 3.12.
 */
export function renderPersonCard(row: MemberWithUser, workspace: WorkspaceRow, at: Date): PeopleView {
  const lines = [
    texts.people.cardTitle(row.membership.displayName),
    texts.people.cardAliasesLine(aliasesText(row.membership.aliases)),
    texts.people.cardZoneLine(zoneText(row.user, workspace, at)),
  ];

  return {
    text: lines.join('\n'),
    buttons: [
      [
        {
          text: texts.people.editButton,
          data: encodeCallback({ entity: 'u', action: 'edt', id: row.membership.id }),
        },
      ],
      backButtonRow(),
    ],
  };
}
