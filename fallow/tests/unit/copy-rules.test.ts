import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Task 10 / plan "Task 21": every shipped word, in one place. Scans the real filesystem,
// recursively, under src/ -- so any new file (a future dashboard panel, Task 6's
// chrome-settings-copy.ts, etc.) is covered without editing this file -- plus the raw
// manifest.json text. See CLAUDE.md "Architecture rules the test suite enforces" and
// docs/design/LLD.md section 5 ("Copy rules") for the rules this pins.
//
// This matches the same raw-text-scan style as tests/unit/no-raw-html.test.ts and
// tests/unit/manifest.test.ts (scanning whole file contents, not just string literals) --
// deliberately, so a forbidden word is caught even if it ever migrated from a comment into
// a real shipped string without anyone updating this test's assumptions.
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

type MatchOptions = {
  /** Narrows the scan to just the manifest's name + description, instead of every shipped file. */
  only?: 'extension name and description';
};

/**
 * Returns every file (src/**\/*.{ts,tsx,css,html} plus public/manifest.json's raw text)
 * whose contents match `pattern` -- or, with `only: 'extension name and description'`,
 * checks just those two manifest fields instead (the one place the word "chrome" is
 * legitimately unrestricted everywhere else: the dashboard genuinely talks about Chrome's
 * own settings, Chrome's Task Manager, chrome://extensions, etc.).
 */
function matches(pattern: RegExp, options?: MatchOptions): string[] {
  if (options?.only === 'extension name and description') {
    const text = `${manifest.name} ${manifest.description}`;
    return pattern.test(text) ? ['public/manifest.json (name/description)'] : [];
  }
  const hits: string[] = [];
  for (const rel of SOURCE_FILES) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    if (pattern.test(text)) hits.push(rel);
  }
  const manifestText = readFileSync(MANIFEST_PATH, 'utf8');
  if (pattern.test(manifestText)) hits.push('public/manifest.json');
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
