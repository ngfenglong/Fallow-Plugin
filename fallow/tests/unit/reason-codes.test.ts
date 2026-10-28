import { REASON_CODES, reasonLabel, sortReasons } from '../../src/domain/reason-codes';

describe('reason codes', () => {
  it('exposes every reason code the spec names', () => {
    expect([...REASON_CODES].sort()).toEqual([
      'ALREADY_UNLOADED','API_REJECTED','AUDIBLE','BROWSER_PROTECTED','DASHBOARD_ORIGIN',
      'LOADING','NOT_OLD_ENOUGH','PINNED','SELECTED','SITE_PROTECTED','STARTUP_GRACE',
      'TAB_GONE','TAB_PROTECTED','UNSUPPORTED_URL','USED_RECENTLY',
    ]);
  });

  it('gives every reason code owner-facing text with no forbidden words', () => {
    for (const c of REASON_CODES) {
      expect(reasonLabel(c)).toBeTruthy();
      expect(/suspend/i.test(reasonLabel(c))).toBe(false);
    }
  });

  it('labels the two codes whose wording the spec fixes', () => {
    expect(reasonLabel('DASHBOARD_ORIGIN')).toBe('Recently opened dashboard from this tab');
    expect(reasonLabel('USED_RECENTLY')).toBe('Used just now');
  });

  it('orders reasons for display deterministically', () => {
    expect(sortReasons(['USED_RECENTLY', 'SELECTED', 'SITE_PROTECTED']))
      .toEqual(['SELECTED', 'SITE_PROTECTED', 'USED_RECENTLY']);
  });
});
