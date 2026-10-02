import { describe, it, expect } from 'vitest';
import { createBotHarness, type BotHarness } from '../../helpers/botHarness.js';
import { dmText, callback, botKeyboardMessage } from '../../helpers/updates.js';
import { encodeCallback } from '../../../src/bot/keyboards/callbackCodec.js';
import { texts } from '../../../src/bot/texts/ru.js';
import { upsertTelegramUser } from '../../../src/domain/people/repo.js';
import { getSettings } from '../../../src/domain/workspaces/repo.js';
import { memberships } from '../../../src/db/schema/index.js';

// plan.md Task 3.11: `/settings`'s button-driven menu (Owner-only) and `/admin`'s "AI settings" free-text
// REPL (superadmin-only). Every change applies immediately through `updateSettings`/
// `setWorkspaceTimezone` — this suite checks that wiring end to end (callback → conversation →
// `SettingsSchema` validation → DB), not every screen's wording (that's `src/bot/views/settings.ts`'s own
// concern, already covered by `texts.settings`'s own call sites compiling).

const OWNER = { id: 100, firstName: 'Anna' };
const SUPERADMIN = { id: 900000001, firstName: 'Admin' };

async function makeOwner(harness: BotHarness, tgUser: { id: number; firstName: string }) {
  const userRow = await upsertTelegramUser(harness.db, { id: tgUser.id, first_name: tgUser.firstName });
  await harness.db.insert(memberships).values({
    workspaceId: harness.deps.workspace.id,
    userId: userRow.id,
    role: 'owner',
    displayName: tgUser.firstName,
  });
  return userRow;
}

/** `src/bot/views/settings.ts`'s fixed placeholder id — `/settings` is a workspace-level singleton. */
function a(action: string, arg?: string): string {
  return arg === undefined
    ? encodeCallback({ entity: 'a', action, id: 0 })
    : encodeCallback({ entity: 'a', action, id: 0, arg });
}

describe('/settings (plan.md Task 3.11)', () => {
  it('toggles the summary on/off and edits its time, rejecting an invalid one', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/settings'));
    await harness.send(callback(OWNER, a('osm'), botKeyboardMessage(OWNER)));

    await harness.send(callback(OWNER, a('sof'), botKeyboardMessage(OWNER)));
    expect((await getSettings(harness.db, harness.deps.workspace.id)).summary.enabled).toBe(false);

    await harness.send(callback(OWNER, a('son'), botKeyboardMessage(OWNER)));
    expect((await getSettings(harness.db, harness.deps.workspace.id)).summary.enabled).toBe(true);

    await harness.send(callback(OWNER, a('stm'), botKeyboardMessage(OWNER)));
    await harness.send(dmText(OWNER, '25:99'));
    // The dialog replies with the error and then re-prompts (it loops until a valid time is given), so
    // the error is the second-to-last reply, not necessarily the last one.
    expect(harness.replies(OWNER.id)).toContain(texts.settings.timeInvalid);
    expect((await getSettings(harness.db, harness.deps.workspace.id)).summary.time).toBe('09:00');

    await harness.send(dmText(OWNER, '08:15'));
    expect((await getSettings(harness.db, harness.deps.workspace.id)).summary.time).toBe('08:15');
  });

  it('adds and removes a quiet-hours date range', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/settings'));
    await harness.send(callback(OWNER, a('oqt'), botKeyboardMessage(OWNER)));
    await harness.send(callback(OWNER, a('qdr'), botKeyboardMessage(OWNER)));

    await harness.send(callback(OWNER, a('dad'), botKeyboardMessage(OWNER)));
    await harness.send(dmText(OWNER, 'с 01.01.2027 по 10.01.2027'));

    let settings = await getSettings(harness.db, harness.deps.workspace.id);
    expect(settings.quiet.dateRanges).toEqual([{ from: '2027-01-01', to: '2027-01-10' }]);

    await harness.send(callback(OWNER, a('ddl', '0'), botKeyboardMessage(OWNER)));
    settings = await getSettings(harness.db, harness.deps.workspace.id);
    expect(settings.quiet.dateRanges).toEqual([]);
  });

  it('turns the "on detect" reaction off and back on', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/settings'));
    await harness.send(callback(OWNER, a('orc'), botKeyboardMessage(OWNER)));

    await harness.send(callback(OWNER, a('eof'), botKeyboardMessage(OWNER)));
    expect((await getSettings(harness.db, harness.deps.workspace.id)).reactions.onDetect).toBeNull();

    await harness.send(callback(OWNER, a('eon'), botKeyboardMessage(OWNER)));
    expect((await getSettings(harness.db, harness.deps.workspace.id)).reactions.onDetect).toBe('👀');
  });

  it('edits and resets the chat notice text', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/settings'));
    await harness.send(callback(OWNER, a('ont'), botKeyboardMessage(OWNER)));
    await harness.send(callback(OWNER, a('ted'), botKeyboardMessage(OWNER)));
    await harness.send(dmText(OWNER, 'Custom notice text'));

    expect((await getSettings(harness.db, harness.deps.workspace.id)).privacyNoticeText).toBe(
      'Custom notice text',
    );

    await harness.send(callback(OWNER, a('trs'), botKeyboardMessage(OWNER)));
    expect((await getSettings(harness.db, harness.deps.workspace.id)).privacyNoticeText).toBeNull();
  });

  // Review round I1: a notice containing `<`/`>`/`&` must not break Telegram's HTML parser — stored
  // as-is (the raw Owner-typed text, so `/admin`'s own debug views etc. still see the real value), but
  // escaped by `renderNoticeSection` (`src/bot/views/settings.ts`) every time it re-renders the section.
  it('escapes the stored notice text when re-rendering the section', async () => {
    const harness = await createBotHarness();
    await makeOwner(harness, OWNER);

    await harness.send(dmText(OWNER, '/settings'));
    await harness.send(callback(OWNER, a('ont'), botKeyboardMessage(OWNER)));
    await harness.send(callback(OWNER, a('ted'), botKeyboardMessage(OWNER)));
    await harness.send(dmText(OWNER, 'Keep <b>calm</b> & read /privacy'));

    expect((await getSettings(harness.db, harness.deps.workspace.id)).privacyNoticeText).toBe(
      'Keep <b>calm</b> & read /privacy',
    );

    // Re-open the section: its header embeds the stored text directly into an HTML-parsed message, so it
    // must come back escaped, not as the raw, Telegram-breaking markup.
    await harness.send(callback(OWNER, a('ont'), botKeyboardMessage(OWNER)));
    const lastReply = harness.replies(OWNER.id).at(-1);
    expect(lastReply).toContain('Keep &lt;b&gt;calm&lt;/b&gt; &amp; read /privacy');
    expect(lastReply).not.toContain('Keep <b>calm</b> & read /privacy');
  });
});

describe('/admin "AI settings" (plan.md Task 3.11)', () => {
  it('saves a valid ai.* value and rejects an out-of-range one, leaving settings unchanged', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/admin'));
    await harness.send(callback(SUPERADMIN, a('ais'), botKeyboardMessage(SUPERADMIN)));

    await harness.send(dmText(SUPERADMIN, 'ai.thresholds.low 0.3'));
    expect((await getSettings(harness.db, harness.deps.workspace.id)).ai.thresholds.low).toBe(0.3);

    await harness.send(dmText(SUPERADMIN, 'ai.thresholds.low 2'));
    expect(harness.replies(SUPERADMIN.id).at(-1)).toBe(texts.adminSettings.rejected('ai.thresholds.low'));
    expect((await getSettings(harness.db, harness.deps.workspace.id)).ai.thresholds.low).toBe(0.3);

    await harness.send(dmText(SUPERADMIN, 'batch.maxMessages 10'));
    expect((await getSettings(harness.db, harness.deps.workspace.id)).batch.maxMessages).toBe(10);

    await harness.send(dmText(SUPERADMIN, '/done'));
    expect(harness.replies(SUPERADMIN.id).at(-1)).toBe(texts.adminSettings.done);
  });

  it('rejects an unknown settings path without changing anything', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/admin'));
    await harness.send(callback(SUPERADMIN, a('ais'), botKeyboardMessage(SUPERADMIN)));

    await harness.send(dmText(SUPERADMIN, 'ai.thresholds.unknown 0.3'));
    expect(harness.replies(SUPERADMIN.id).at(-1)).toBe(
      texts.adminSettings.unknownKey('ai.thresholds.unknown'),
    );
  });

  // Review round I2: SPEC §16 only grants a superadmin ai.*/batch.* via /admin — every other settings
  // path must be rejected here even though it exists on `Settings` and would otherwise be a perfectly
  // valid patch (the Owner's own /settings menu is where those belong).
  it('rejects a path outside ai.*/batch.*, even one that exists on Settings', async () => {
    const harness = await createBotHarness();

    await harness.send(dmText(SUPERADMIN, '/admin'));
    await harness.send(callback(SUPERADMIN, a('ais'), botKeyboardMessage(SUPERADMIN)));

    await harness.send(dmText(SUPERADMIN, 'quiet.enabled true'));
    expect(harness.replies(SUPERADMIN.id).at(-1)).toBe(texts.adminSettings.outOfScope('quiet.enabled'));
    expect((await getSettings(harness.db, harness.deps.workspace.id)).quiet.enabled).toBe(false);
  });
});
