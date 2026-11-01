import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Review Focus 4: nothing under src/ui/ may render markup from a string. Hostile tab and
// group titles must reach the DOM as text, so no raw-HTML sink may appear anywhere in the
// UI tree. This scans the REAL filesystem, recursively, so every component Tasks 17-19 add
// is covered without editing this file. (import.meta.dirname: the jsdom environment does
// not give a file: import.meta.url, so URL-to-path conversion would throw.)
const UI_ROOT = join(import.meta.dirname, '../../src/ui');
const SOURCE_FILE = /\.(tsx?|jsx?|html|css)$/;
const SINKS = ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write'];

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return SOURCE_FILE.test(entry.name) ? [full] : [];
  });
}

describe('no raw html sink under src/ui', () => {
  it('uses no raw html sink anywhere in the ui tree', () => {
    expect(existsSync(UI_ROOT)).toBe(true);
    const files = listSourceFiles(UI_ROOT).map((f) => relative(UI_ROOT, f).split(sep).join('/'));
    // A scan that found nothing would pass vacuously: the known entry must be seen.
    expect(files).toContain('dashboard/main.tsx');
    // A nested component must be seen too: an entry-file-only scan would miss it.
    expect(files).toContain('components/Table.tsx');
    const offendingFiles = files.filter((rel) => {
      const text = readFileSync(join(UI_ROOT, rel), 'utf8');
      return SINKS.some((sink) => text.includes(sink));
    });
    expect(offendingFiles).toEqual([]);
  });
});
