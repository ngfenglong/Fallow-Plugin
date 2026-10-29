import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DOMAIN_DIR = join(import.meta.dirname, '../../src/domain');

// Guard: a scan over an empty listing would pass vacuously, so the directory must
// yield real files, and the known domain modules must be among them.
const FILES = readdirSync(DOMAIN_DIR).filter((name) => statSync(join(DOMAIN_DIR, name)).isFile());

describe('src/domain purity', () => {
  it('scans a non-empty set of domain files', () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(FILES).toContain('eligibility.ts');
    expect(FILES).toContain('types.ts');
  });

  it.each(FILES)('%s does not reference the chrome. API', (name) => {
    const source = readFileSync(join(DOMAIN_DIR, name), 'utf8');
    expect(source).not.toContain('chrome.');
  });
});
