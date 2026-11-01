import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const m = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8'));

const htmlTitle = (rel: string): string => {
  const html = readFileSync(resolve(root, rel), 'utf8');
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';
};

describe('manifest', () => {
  it('declares manifest v3 and the Chrome 120 floor', () => {
    expect(m.manifest_version).toBe(3);
    expect(m.minimum_chrome_version).toBe('120');
  });
  it('requests exactly the four required permissions', () => {
    expect([...m.permissions].sort()).toEqual(['alarms', 'storage', 'tabGroups', 'tabs']);
  });
  it('keeps system.memory optional and declares no host permissions', () => {
    expect(m.optional_permissions).toEqual(['system.memory']);
    expect(m.host_permissions).toBeUndefined();
    expect(m.content_scripts).toBeUndefined();
  });
  it('disallows incognito and uses a module service worker', () => {
    expect(m.incognito).toBe('not_allowed');
    expect(m.background.type).toBe('module');
  });
  it('keeps the forbidden words out of the name', () => {
    expect(m.name).toBe('Fallow');
    expect(/chrome|suspend/i.test(m.name + ' ' + m.description)).toBe(false);
  });
  it('keeps the forbidden words out of all UI copy', () => {
    const copy = [
      m.action.default_title,
      htmlTitle('src/ui/dashboard/index.html'),
      htmlTitle('src/ui/popup/index.html'),
    ];
    for (const c of copy) {
      expect(c).not.toBe('');
      expect(/chrome|suspend/i.test(c)).toBe(false);
    }
  });
  it('has exactly the allowed top-level keys (any new key is a deliberate edit here)', () => {
    expect(Object.keys(m).sort()).toEqual(
      [
        'action',
        'background',
        'description',
        'icons',
        'incognito',
        'manifest_version',
        'minimum_chrome_version',
        'name',
        'optional_permissions',
        'permissions',
        'version',
      ].sort(),
    );
    expect(Object.keys(m.action).sort()).toEqual(['default_icon', 'default_popup', 'default_title']);
    expect(Object.keys(m.background).sort()).toEqual(['service_worker', 'type']);
  });
  it('references only files the build will produce', () => {
    // service worker is emitted from src/background/index.ts as dist/background.js (see vite.config.ts)
    expect(m.background.service_worker).toBe('background.js');
    expect(existsSync(resolve(root, 'src/background/index.ts'))).toBe(true);
    // popup html is emitted at popup/index.html from src/ui/popup/index.html
    expect(m.action.default_popup).toBe('popup/index.html');
    expect(existsSync(resolve(root, 'src/ui/popup/index.html'))).toBe(true);
    // icons are copied verbatim from public/
    const icons = [...Object.values(m.icons), ...Object.values(m.action.default_icon)] as string[];
    expect(icons.length).toBeGreaterThan(0);
    for (const i of icons) expect(existsSync(resolve(root, 'public', i)), i).toBe(true);
  });
});
