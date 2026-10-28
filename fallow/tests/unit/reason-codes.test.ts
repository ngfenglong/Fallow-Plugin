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

  describe('sortReasons', () => {
    it('orders reasons for display deterministically', () => {
      expect(sortReasons(['USED_RECENTLY', 'SELECTED', 'SITE_PROTECTED']))
        .toEqual(['SELECTED', 'SITE_PROTECTED', 'USED_RECENTLY']);
    });

    it('uses canonical display rank, not alphabetical order', () => {
      // Alphabetical would put AUDIBLE first.
      expect(sortReasons(['TAB_GONE', 'AUDIBLE', 'SELECTED']))
        .toEqual(['SELECTED', 'AUDIBLE', 'TAB_GONE']);
    });

    it('sorts a fully reversed canonical list back into canonical order', () => {
      expect(sortReasons([...REASON_CODES].reverse())).toEqual([...REASON_CODES]);
    });

    it('keeps duplicates adjacent', () => {
      expect(sortReasons(['AUDIBLE', 'SELECTED', 'AUDIBLE']))
        .toEqual(['SELECTED', 'AUDIBLE', 'AUDIBLE']);
    });

    it('returns an empty array for empty input', () => {
      expect(sortReasons([])).toEqual([]);
    });

    it('does not mutate its input', () => {
      const input = ['TAB_GONE', 'AUDIBLE', 'SELECTED'] as const;
      const copy = [...input];
      const out = sortReasons(input);
      expect(input).toEqual(copy);
      expect(out).not.toBe(input);
    });
  });
});
