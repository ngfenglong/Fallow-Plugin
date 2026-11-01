import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DOMAIN_DIR = join(import.meta.dirname, '../../src/domain');

// Recursively lists every regular file under a directory, as paths relative to it.
function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full, base) : [relative(base, full)];
  });
}

// Each rule is a way domain code could reach a browser API, read the clock, or draw
// randomness. Purity is what makes the engine testable, so each one is forbidden.
// `sample` is a known violation the rule must catch: a rule that cannot match is no guard.
const FORBIDDEN: Array<{ name: string; pattern: RegExp; sample: string }> = [
  { name: 'chrome. API', pattern: /\bchrome\./, sample: 'chrome.tabs.get(1)' },
  { name: 'globalThis.chrome', pattern: /globalThis\s*\.\s*chrome\b/, sample: 'const x = globalThis.chrome;' },
  { name: 'chrome[...] access', pattern: /\bchrome\s*\[/, sample: 'const y = chrome["tabs"];' },
  {
    name: 'import from a chrome module',
    pattern: /\b(?:from|import|require)\s*\(?\s*['"][^'"\n]*chrome[^'"\n]*['"]/,
    sample: "import { tabs } from 'chrome';",
  },
  { name: 'Date.now()', pattern: /\bDate\.now\s*\(/, sample: 'const now = Date.now();' },
  { name: 'Math.random()', pattern: /\bMath\.random\s*\(/, sample: 'const r = Math.random();' },
  { name: 'performance.now()', pattern: /\bperformance\.now\s*\(/, sample: 'const p = performance.now();' },
];

const FILES = listFiles(DOMAIN_DIR);

describe('src/domain purity', () => {
  it('scans a non-empty set of domain files, including the known modules', () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(FILES).toContain('eligibility.ts');
    expect(FILES).toContain('types.ts');
  });

  it.each(FORBIDDEN)('the $name rule fires on its known violation', ({ pattern, sample }) => {
    expect(pattern.test(sample)).toBe(true);
  });

  it.each(FILES)('%s is free of browser, clock and randomness access', (name) => {
    const source = readFileSync(join(DOMAIN_DIR, name), 'utf8');
    for (const { name: rule, pattern } of FORBIDDEN) {
      if (pattern.test(source)) {
        throw new Error(`${name} violates the purity rule: ${rule}`);
      }
    }
  });
});
