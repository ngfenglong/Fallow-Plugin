import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Smoke test for the owner-facing install/update tooling (docs/superpowers/specs/
// 2026-11-02-install-update-tooling-design.md): `npm run setup` (npm install + the
// build) must leave a dist/ whose manifest matches the package version, from a clean
// checkout. Run via `npm run test:dist`, which builds first, then runs this file.
const root = resolve(import.meta.dirname, '../..');

describe('install/update build output', () => {
  it('produces a dist/manifest.json the owner can load, with a version matching package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const manifestPath = resolve(root, 'dist/manifest.json');
    expect(existsSync(manifestPath), 'dist/manifest.json missing after build').toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.version).toBe(pkg.version);
  });
});
