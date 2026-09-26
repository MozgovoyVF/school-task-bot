const ALLOWED = new Set(['src/bot/texts/ru.ts', 'src/config/constants.ts']);
const CYRILLIC = /[А-Яа-яЁё]/;

export function findForbiddenCyrillic(files: Array<{ path: string; content: string }>): string[] {
  return files
    .filter((f) => !ALLOWED.has(f.path.replaceAll('\\', '/')))
    .filter((f) => CYRILLIC.test(f.content))
    .map((f) => f.path);
}
