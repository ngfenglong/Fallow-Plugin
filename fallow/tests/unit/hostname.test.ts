import { normalizeHostname, hostnameOf, isSupportedUrl, matchesProtectedSite } from '../../src/domain/hostname';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';

describe('hostnameOf and isSupportedUrl refuse unsupported input', () => {
  it.each(['', 'not a url', 'about:blank', 'chrome://settings', 'file:///tmp/a.html',
           'chrome-extension://abc/page.html', 'javascript:void 0', '//example.com'])
    ('returns no hostname and refuses support for %p', (url) => {
      expect(() => hostnameOf(url)).not.toThrow();
      expect(hostnameOf(url)).toBeNull();
      expect(isSupportedUrl(url)).toBe(false);
    });

  it('rejects websocket, data, blob and view-source URLs', () => {
    for (const url of ['ws://example.com', 'wss://example.com', 'data:text/plain,hi',
                       'blob:https://example.com/uuid', 'view-source:http://example.com']) {
      expect(isSupportedUrl(url)).toBe(false);
      expect(hostnameOf(url)).toBeNull();
    }
  });

  it('accepts uppercase scheme because URL parsing lowercases the protocol', () => {
    expect(isSupportedUrl('HTTP://EXAMPLE.COM')).toBe(true);
    expect(hostnameOf('HTTP://EXAMPLE.COM')).toBe('example.com');
  });
});

describe('hostnameOf', () => {
  it('accepts ordinary http and https pages only', () => {
    expect(isSupportedUrl('https://example.com/a?b=1')).toBe(true);
    expect(isSupportedUrl('http://example.com')).toBe(true);
    expect(hostnameOf('https://Example.COM./a')).toBe('example.com');
  });

  it('lowercases the host', () => {
    expect(hostnameOf('https://EXAMPLE.COM/')).toBe('example.com');
  });

  it('drops the port', () => {
    expect(hostnameOf('https://example.com:8443/x')).toBe('example.com');
  });

  it('returns the bracketed IPv6 literal', () => {
    expect(hostnameOf('http://[::1]:8080/')).toBe('[::1]');
  });

  it('returns punycode for internationalised hosts', () => {
    expect(hostnameOf('https://münchen.de/page')).toBe('xn--mnchen-3ya.de');
  });
});

describe('matchesProtectedSite', () => {
  it('matches an exact hostname and nothing adjacent to it', () => {
    const sites = [{ hostname: 'example.com', includeSubdomains: false }];
    expect(matchesProtectedSite('example.com', sites)).toBe(true);
    expect(matchesProtectedSite('notexample.com', sites)).toBe(false);   // A22
    expect(matchesProtectedSite('example.com.evil.com', sites)).toBe(false);
    expect(matchesProtectedSite('sub.example.com', sites)).toBe(false);
  });

  it('matches subdomains only on a dot boundary when asked', () => {
    const sites = [{ hostname: 'example.com', includeSubdomains: true }];
    expect(matchesProtectedSite('sub.example.com', sites)).toBe(true);
    expect(matchesProtectedSite('a.b.example.com', sites)).toBe(true);
    expect(matchesProtectedSite('a.b.c.example.com', sites)).toBe(true);
    expect(matchesProtectedSite('example.com', sites)).toBe(true);
    expect(matchesProtectedSite('notexample.com', sites)).toBe(false);
    expect(matchesProtectedSite('example.com.evil.com', sites)).toBe(false);
  });

  it('returns false for an empty site list', () => {
    expect(matchesProtectedSite('example.com', [])).toBe(false);
  });

  it('returns true when any one of several sites matches', () => {
    const sites = [
      { hostname: 'other.org', includeSubdomains: false },
      { hostname: 'example.com', includeSubdomains: false },
    ];
    expect(matchesProtectedSite('example.com', sites)).toBe(true);
    expect(matchesProtectedSite('unrelated.net', sites)).toBe(false);
  });

  it('matches a stored IDN protection against a live tab on that site', () => {
    const sites = [{ hostname: normalizeHostname('münchen.de')!, includeSubdomains: false }];
    expect(sites[0]!.hostname).toBe('xn--mnchen-3ya.de');
    expect(matchesProtectedSite(hostnameOf('https://münchen.de/page')!, sites)).toBe(true);
  });

  it('matches a stored IPv6 protection against a live tab on that host', () => {
    const sites = [{ hostname: '[::1]', includeSubdomains: false }];
    expect(matchesProtectedSite(hostnameOf('http://[::1]:8080/')!, sites)).toBe(true);
  });

  it('protects Docs and Sheets through the one default hostname', () => {
    const sites = DEFAULT_SETTINGS.protectedSites;
    expect(matchesProtectedSite('docs.google.com', sites)).toBe(true);   // A17
    expect(matchesProtectedSite('chatgpt.com', sites)).toBe(true);
    expect(matchesProtectedSite('mail.google.com', sites)).toBe(false);
  });
});

describe('live tab URL through hostnameOf into matchesProtectedSite (DEFAULT_SETTINGS)', () => {
  const matchesDefaults = (url: string) =>
    matchesProtectedSite(hostnameOf(url)!, DEFAULT_SETTINGS.protectedSites);

  it.each([
    'https://docs.google.com/spreadsheets/d/abc123/edit#gid=0',
    'https://docs.google.com/document/d/abc123/edit',
    'https://chatgpt.com/c/some-conversation-id',
    'https://meet.google.com/abc-defg-hij',
  ])('protects %s', (url) => {
    expect(matchesDefaults(url)).toBe(true);
  });

  it.each([
    'https://mail.google.com/mail/u/0/#inbox',
    'https://drive.google.com/drive/my-drive',
  ])('does not protect sibling Google property %s', (url) => {
    expect(matchesDefaults(url)).toBe(false);
  });
});
