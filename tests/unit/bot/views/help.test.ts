import { describe, it, expect } from 'vitest';
import { renderStart, renderHelp, formatCommandList } from '../../../../src/bot/views/help.js';
import { texts } from '../../../../src/bot/texts/ru.js';
import { SUPERADMIN_COMMANDS } from '../../../../src/bot/commands.js';
import type { Actor } from '../../../../src/bot/context.js';

const SUPERADMIN: Actor = { userId: 1, isSuperadmin: true, role: null, dmStarted: true };
const OWNER: Actor = { userId: 2, isSuperadmin: false, role: 'owner', dmStarted: true };
const MEMBER: Actor = { userId: 3, isSuperadmin: false, role: 'member', dmStarted: true };
const STRANGER: Actor = { userId: null, isSuperadmin: false, role: null, dmStarted: false };

/**
 * Final Phase 1 review's I2 fix: `renderStart`/`renderHelp` used to
 * distinguish only superadmin vs. everyone else, so an Owner or Member got
 * `texts.start.stranger()`/`texts.help.stranger()` — an Owner told to
 * "contact the Owner" for access they already have, and a `/help` listing
 * only `/timezone`/`/help` despite this phase adding `/people`, `/chats`,
 * `/transfer`, `/privacy`. Each role must now get its own text, reflecting
 * the commands `src/bot/commands.ts`'s `syncCommands` actually gives it.
 */
describe('renderStart (I2 fix)', () => {
  it('gives the Owner their own welcome text listing every OWNER_COMMANDS entry, not the stranger text', () => {
    const view = renderStart(OWNER);

    expect(view.text).not.toBe(texts.start.stranger());
    for (const cmd of ['/people', '/chats', '/transfer', '/privacy', '/timezone', '/help']) {
      expect(view.text).toContain(cmd);
    }
  });

  it('gives a Member their own welcome text (DM_COMMANDS only), not the stranger text and not the Owner’s', () => {
    const view = renderStart(MEMBER);

    expect(view.text).not.toBe(texts.start.stranger());
    expect(view.text).not.toBe(renderStart(OWNER).text);
    for (const cmd of ['/start', '/help', '/timezone', '/privacy']) {
      expect(view.text).toContain(cmd);
    }
    expect(view.text).not.toContain('/people');
  });

  it('leaves the superadmin and stranger texts unchanged', () => {
    expect(renderStart(SUPERADMIN).text).toBe(texts.start.superadmin(formatCommandList(SUPERADMIN_COMMANDS)));
    expect(renderStart(STRANGER).text).toBe(texts.start.stranger());
  });
});

describe('renderHelp (I2 fix)', () => {
  it('gives the Owner a command reference covering every command this phase added them', () => {
    const view = renderHelp(OWNER);

    expect(view.text).not.toBe(texts.help.stranger());
    for (const cmd of ['/people', '/chats', '/transfer', '/privacy']) {
      expect(view.text).toContain(cmd);
    }
  });

  it('gives a Member a command reference distinct from the Owner’s, without Owner-only commands', () => {
    const view = renderHelp(MEMBER);

    expect(view.text).not.toBe(renderHelp(OWNER).text);
    expect(view.text).not.toContain('/people');
    expect(view.text).not.toContain('/chats');
    expect(view.text).toContain('/timezone');
  });

  it('leaves the superadmin and stranger texts unchanged', () => {
    expect(renderHelp(SUPERADMIN).text).toBe(texts.help.superadmin(formatCommandList(SUPERADMIN_COMMANDS)));
    expect(renderHelp(STRANGER).text).toBe(texts.help.stranger());
  });
});
