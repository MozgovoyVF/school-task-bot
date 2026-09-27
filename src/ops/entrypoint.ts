import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * True when the module whose `import.meta.url` is `moduleUrl` is the script Node was started with
 * (`argv1`, i.e. `process.argv[1]`).
 *
 * Both sides are normalised to a `file://` URL: `import.meta.url` percent-encodes non-ASCII
 * characters (and spaces) while `process.argv[1]` is a raw filesystem path, so a naive
 * `` `file://${process.argv[1]}` `` comparison never matches on paths with non-ASCII (e.g.
 * Cyrillic) directory names, such as this repository's own checkout path. `argv1` is also
 * resolved through `realpath`, because Node's ESM loader reports the real (symlink-free) path in
 * `import.meta.url`.
 */
export function isEntrypoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  let resolved = argv1;
  try {
    resolved = realpathSync(argv1);
  } catch {
    // Path doesn't exist on disk (unusual for argv[1]): compare the path as given.
  }
  return moduleUrl === pathToFileURL(resolved).href;
}
