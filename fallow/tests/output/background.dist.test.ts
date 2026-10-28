import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const dist = resolve(import.meta.dirname, '../../dist');

// Collect the entry plus every chunk it statically imports.
function collect(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  const re = /(?:\bfrom\s*|\bimport\s*)["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of src.matchAll(re)) {
    collect(resolve(dirname(file), match[1]!), seen);
  }
  return seen;
}

describe('built service worker', () => {
  const entry = resolve(dist, 'background.js');

  it('exists where the manifest points', () => {
    const m = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
    expect(existsSync(resolve(dist, m.background.service_worker))).toBe(true);
    expect(existsSync(resolve(dist, m.action.default_popup))).toBe(true);
  });

  it('and its static chunks have no dynamic import() and never touch document', () => {
    const files = collect(entry);
    expect(files.size, 'no built files collected; the guard would check nothing').toBeGreaterThan(0);
    expect(files.has(entry)).toBe(true);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/\bimport\s*\(/.test(src), `dynamic import in ${f}`).toBe(false);
      expect(/\bdocument\b/.test(src), `document reference in ${f}`).toBe(false);
    }
  });
});
