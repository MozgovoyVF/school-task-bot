import { texts } from '../texts/ru.js';

export interface AdminView {
  text: string;
}

export interface AdminPanelInfo {
  gitSha: string;
  uptimeSec: number;
}

/** Pure render for `/admin`: no DB, no I/O (CLAUDE.md §7). */
export function renderAdminPanel(info: AdminPanelInfo): AdminView {
  return { text: texts.admin.panel(info.gitSha, info.uptimeSec) };
}
