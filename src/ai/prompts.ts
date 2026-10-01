import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// D27 — prompt files live under `prompts/*.md`, split by a `<!-- DATA -->`
// marker: above is `system` (instructions + profile, a stable prefix so the
// provider can cache it), below is `userTemplate` (the per-request data
// block, filled in by `renderTemplate`). Changing a prompt after its first
// eval means a new versioned file (`extractor.v2.md`) — the old one is never
// edited in place.
export interface PromptBundle {
  version: string;
  system: string;
  userTemplate: string;
  examples: Array<{ user: string; assistant: string }>;
}

const DATA_MARKER = '<!-- DATA -->';
const DEFAULT_PROMPTS_DIR = 'prompts';
const PLACEHOLDER_RE = /\{(\w+)\}/g;

// Only these prompts share `examples.<profile>.json`'s ExtractionResult-shaped
// few-shot pairs — `parseDate` returns a differently-shaped `Due`, so it never
// gets them even when a profile is passed for it.
const NAMES_WITH_EXAMPLES = new Set(['extractor', 'extractor.single']);

/**
 * Fills `{name}` placeholders in `tpl` from `vars`, throwing as soon as it
 * meets one with no matching key in `vars` (a missing variable and a leftover
 * unfilled `{name}` are the same failure here). Only the template itself is
 * scanned for placeholders — never the substituted values — so a message's
 * text that happens to contain a literal `{...}` (or a JSON snippet like
 * `{"actions": []}` in the prompt's own instructions) can never be
 * misread as a placeholder or trigger a false positive after substitution.
 */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(PLACEHOLDER_RE, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new Error(`renderTemplate: missing variable "${key}"`);
    }
    return vars[key] as string;
  });
}

function splitOnDataMarker(content: string, filePath: string): { above: string; below: string } {
  const index = content.indexOf(DATA_MARKER);
  if (index === -1) {
    throw new Error(`Prompt file ${filePath} is missing the ${DATA_MARKER} marker (plan.md D27)`);
  }
  return {
    above: content.slice(0, index).trim(),
    below: content.slice(index + DATA_MARKER.length).trim(),
  };
}

interface RawExample {
  user: string;
  assistant: string;
}

function isRawExampleArray(value: unknown): value is RawExample[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const record = item as Record<string, unknown>;
      return typeof record.user === 'string' && typeof record.assistant === 'string';
    })
  );
}

function loadExamples(dir: string, profile: string): Array<{ user: string; assistant: string }> {
  const filePath = join(dir, `examples.${profile}.json`);
  if (!existsSync(filePath)) return [];
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isRawExampleArray(parsed)) {
    throw new Error(`${filePath} must contain an array of { user, assistant } examples`);
  }
  return parsed;
}

/**
 * Loads a versioned prompt file and its profile (D27). `version` names the
 * file (`prompts/<version>.md`, e.g. `extractor.v1` → `extractor.v1.md`) and
 * must start with `name` — a mismatch (wrong file loaded under the wrong
 * name) is a bug, not something to guess past. The profile
 * (`prompts/profiles/<profile>.md`) is substituted into `{profile}` in the
 * system part when that placeholder is present; prompts that do not
 * reference `{profile}` (e.g. `parseDate`) simply ignore it.
 */
export function loadPrompt(opts: {
  name: 'extractor' | 'extractor.single' | 'parseDate';
  version: string;
  profile: string;
  dir?: string;
}): PromptBundle {
  if (!opts.version.startsWith(opts.name)) {
    throw new Error(`loadPrompt: version "${opts.version}" does not match name "${opts.name}"`);
  }
  const dir = opts.dir ?? DEFAULT_PROMPTS_DIR;

  const promptPath = join(dir, `${opts.version}.md`);
  const raw = readFileSync(promptPath, 'utf8');
  const { above, below } = splitOnDataMarker(raw, promptPath);

  const profilePath = join(dir, 'profiles', `${opts.profile}.md`);
  const profileContent = existsSync(profilePath) ? readFileSync(profilePath, 'utf8').trim() : '';
  const system = above.includes('{profile}') ? renderTemplate(above, { profile: profileContent }) : above;

  return {
    version: opts.version,
    system,
    userTemplate: below,
    examples: NAMES_WITH_EXAMPLES.has(opts.name) ? loadExamples(dir, opts.profile) : [],
  };
}
