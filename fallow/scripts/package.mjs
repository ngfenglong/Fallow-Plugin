#!/usr/bin/env node
// Zips the built dist/ folder into fallow-<version>.zip at the project root. The version
// comes from package.json at run time -- never hardcoded here -- so this never drifts from
// whatever `npm version` last set. Run via `npm run package`, which builds first.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const distDir = resolve(root, 'dist');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const zipName = `fallow-${pkg.version}.zip`;
const zipPath = resolve(root, zipName);

if (!existsSync(distDir)) {
  console.error('dist/ not found. Run `npm run build` first (or `npm run package`, which does this for you).');
  process.exit(1);
}

// A stale zip from a previous run must not survive as leftover entries alongside the new
// build's files, so it is removed before `zip` ever runs rather than relying on `zip -r`'s
// own update-in-place behaviour.
if (existsSync(zipPath)) rmSync(zipPath);

try {
  // Zipped from inside dist/ (cwd), with '.' as the source, so manifest.json etc. land at
  // the zip's own root rather than nested under a 'dist/' path -- the shape Chrome expects
  // for a store upload or a straight unzip-and-load-unpacked.
  execFileSync('zip', ['-r', '-X', zipPath, '.'], { cwd: distDir, stdio: 'inherit' });
} catch (err) {
  console.error('Zipping failed. Is the `zip` command available on this machine?');
  throw err;
}

console.log(`Packaged ${zipName}`);
