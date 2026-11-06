import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Task 10 / plan "Task 21": every SHIPPED word, in one place. Scans the real filesystem,
// recursively, under src/ -- so any new file (a future dashboard panel, Task 6's
// chrome-settings-copy.ts, etc.) is covered without editing this file -- plus the raw
// manifest.json text. See CLAUDE.md "Architecture rules the test suite enforces" and
// docs/design/LLD.md section 5 ("Copy rules") for the rules this pins: both scope the
// rule to shipped strings, not source comments, so a comment explaining this very rule
// (or a changelog note, or a design discussion) must never trip it. `matches()` strips
// comments before testing, below, specifically so that stays true -- a review of this
// test's first version flagged exactly this gap: a raw full-text scan (matching
// tests/unit/no-raw-html.test.ts / tests/unit/manifest.test.ts's house style for OTHER
// checks, where it's correct because a raw-HTML sink or a manifest field is never
// legitimately named in a comment) over-reached here, because comments ARE a legitimate
// place to name these words while explaining the rule itself.
const ROOT = join(import.meta.dirname, '../..');
const SRC_ROOT = join(ROOT, 'src');
const SOURCE_FILE = /\.(tsx?|jsx?|css|html)$/;
const MANIFEST_PATH = join(ROOT, 'public/manifest.json');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
  name: string;
  description: string;
  permissions: string[];
};

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return SOURCE_FILE.test(entry.name) ? [full] : [];
  });
}

const SOURCE_FILES = listSourceFiles(SRC_ROOT).map((f) => relative(ROOT, f).split(sep).join('/'));

/**
 * Strips `<!-- -->` HTML comments. Not used on .ts/.tsx/.css -- those go through
 * stripCodeComments instead.
 */
function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Strips `//` line comments and `/* *\/` block comments from ts/tsx/css source text,
 * while leaving string/template literal CONTENTS untouched -- so a URL containing `//`
 * inside a real string (e.g. `'https://example.com'`) is never mistaken for a comment
 * start, and a real shipped string is never accidentally stripped alongside a trailing
 * comment on the same line. This is a small hand-rolled scanner, not a full parser: it
 * doesn't need to be bulletproof against every pathological case (nested template
 * interpolation, regex literals containing `/`, etc.) -- only good enough that an
 * ordinary rule-explaining comment no longer trips the forbidden-word checks below,
 * which the two tests under "comment stripping" exist to prove.
 */
function stripCodeComments(text: string): string {
  // `charAt` (never `string | undefined` under noUncheckedIndexedAccess, unlike
  // bracket indexing) returns '' past the end, which every comparison below treats as
  // "not a match" -- exactly what an out-of-range read should mean here.
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charAt(i);
    const c2 = text.charAt(i + 1);
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      let j = i + 1;
      while (j < n) {
        const cj = text.charAt(j);
        if (cj === '\\' && j + 1 < n) {
          out += cj + text.charAt(j + 1);
          j += 2;
          continue;
        }
        out += cj;
        j += 1;
        if (cj === quote) break;
      }
      i = j;
      continue;
    }
    if (c === '/' && c2 === '/') {
      let j = i + 2;
      while (j < n && text.charAt(j) !== '\n') j += 1;
      i = j; // the newline itself (if any) is picked up by the normal path next iteration
      continue;
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(text.charAt(j) === '*' && text.charAt(j + 1) === '/')) j += 1;
      j = Math.min(j + 2, n);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function shippedTextOf(rel: string, raw: string): string {
  return rel.endsWith('.html') ? stripHtmlComments(raw) : stripCodeComments(raw);
}

type MatchOptions = {
  /** Narrows the scan to just the manifest's name + description, instead of every shipped file. */
  only?: 'extension name and description';
};

/**
 * Returns every file (src/**\/*.{ts,tsx,css,html} plus public/manifest.json's raw text)
 * whose SHIPPED text (comments stripped) matches `pattern` -- or, with `only:
 * 'extension name and description'`, checks just those two manifest fields instead (the
 * one place the word "chrome" is legitimately unrestricted everywhere else: the
 * dashboard genuinely talks about Chrome's own settings, Chrome's Task Manager,
 * chrome://extensions, etc.).
 */
function matches(pattern: RegExp, options?: MatchOptions): string[] {
  if (options?.only === 'extension name and description') {
    const text = `${manifest.name} ${manifest.description}`;
    return pattern.test(text) ? ['public/manifest.json (name/description)'] : [];
  }
  const hits: string[] = [];
  for (const rel of SOURCE_FILES) {
    const raw = readFileSync(join(ROOT, rel), 'utf8');
    if (pattern.test(shippedTextOf(rel, raw))) hits.push(rel);
  }
  // manifest.json is JSON, so it has no comment syntax of its own, but running it
  // through the same stripper is harmless (nothing to strip) and keeps this one path
  // for every scanned file.
  const manifestRaw = readFileSync(MANIFEST_PATH, 'utf8');
  if (pattern.test(stripCodeComments(manifestRaw))) hits.push('public/manifest.json');
  return hits;
}

describe('copy rules (shipped strings only)', () => {
  it('scans more than just the entry files, so a nested component is not silently skipped', () => {
    // A scan that found nothing would pass every case below vacuously.
    expect(SOURCE_FILES).toContain('src/ui/dashboard/main.tsx');
    expect(SOURCE_FILES).toContain('src/ui/dashboard/chrome-settings-copy.ts');
    expect(SOURCE_FILES.length).toBeGreaterThan(10);
  });

  it('keeps forbidden words out of every shipped string', () => {
    expect(matches(/suspend/i)).toEqual([]);
    expect(matches(/\bchrome\b/i, { only: 'extension name and description' })).toEqual([]);
  });

  it('never ships a zero where a measurement is unavailable', () => {
    expect(matches(/0 (MB|GB|GiB|bytes)/)).toEqual([]);
  });

  it('calls the add-on an add-on, never an extension', () => {
    expect(matches(/Probe extension/i)).toEqual([]);
  });

  it('describes reloading as a reload, never an undo', () => {
    expect(matches(/undo/i)).toEqual([]);
  });

  it('declares no permission beyond the agreed set', () => {
    expect(manifest.permissions).toEqual(['tabs', 'tabGroups', 'storage', 'alarms']);
  });
});

describe('comment stripping (so a rule-explaining comment cannot trip the scan above)', () => {
  it('a comment naming the forbidden words, to explain the rule itself, is not flagged', () => {
    const sample = [
      "// This file ships no string containing suspend or undo -- see the copy rules.",
      "/* Design note: we rejected an 'undo' affordance and a 'suspend' framing on",
      "   purpose; this block comment explains why, same as the one above it. */",
      "export const UNLOAD_NOW_LABEL = 'Unload now';",
    ].join('\n');
    const stripped = stripCodeComments(sample);
    expect(stripped).not.toMatch(/suspend/i);
    expect(stripped).not.toMatch(/undo/i);
    // The real shipped string on the last line must survive the strip untouched.
    expect(stripped).toContain("'Unload now'");
  });

  it('a forbidden word actually shipped in a real string still trips the scan', () => {
    const sample = "export const LABEL = 'Click here to undo this'; // ordinary trailing comment";
    expect(/undo/i.test(stripCodeComments(sample))).toBe(true);
  });

  it('a `//` inside a real URL string is not mistaken for a line comment', () => {
    const sample = "export const DOCS_URL = 'https://example.com/suspend-is-not-shipped-here';";
    const stripped = stripCodeComments(sample);
    // The URL string (including its forbidden-looking substring) must survive whole --
    // proof the stripper isn't truncating real string content at the first `//` it sees.
    expect(stripped).toContain("'https://example.com/suspend-is-not-shipped-here'");
  });
});
