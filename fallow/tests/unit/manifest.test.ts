import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const m = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../public/manifest.json'), 'utf8'),
);

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
});
