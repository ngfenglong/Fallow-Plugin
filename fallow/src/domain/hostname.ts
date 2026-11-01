// Pure domain helpers: no browser API access in this file.
import type { Settings } from './types';

const MAX_LABEL_LENGTH = 63;
// Characters that can never appear in a URL.hostname a tab would report. Any of
// these would be silently dropped or re-read by the URL parser, so a stored entry
// containing one could never match.
const FORBIDDEN = /[\s\/\\?#@%*:]/;

function stripOneTrailingDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

// Returns the hostname exactly as URL.hostname reports it for a real tab (lowercased,
// punycode for IDN, IPv6 in brackets), or null when the input cannot be one.
// A single trailing dot is accepted and removed. Single-label hosts such as
// 'localhost' are accepted.
export function normalizeHostname(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  // IPv6 literal: the blocklist cannot apply, because ':', '[' and ']' are legitimate
  // here, and the parser would otherwise drop trailing junk such as '@host' or '/path'.
  // So the input must survive a round-trip through URL unchanged, or it is rejected.
  if (trimmed.startsWith('[')) {
    const candidate = stripOneTrailingDot(trimmed.toLowerCase());
    try {
      return new URL(`http://${candidate}`).hostname === candidate ? candidate : null;
    } catch {
      return null;
    }
  }

  if (FORBIDDEN.test(trimmed)) return null;

  let host: string;
  try {
    host = new URL(`http://${trimmed}`).hostname;
  } catch {
    return null;
  }
  host = stripOneTrailingDot(host.toLowerCase());
  if (host === '' || host.startsWith('.')) return null;

  const labels = host.split('.');
  if (labels.some((label) => label === '' || label.length > MAX_LABEL_LENGTH)) return null;
  return host;
}

// Returns the normalised hostname of a tab URL, or null for anything that is not an
// http(s) URL with a host. Never throws: one unparseable tab must not break a scan.
export function hostnameOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // URL.hostname is already punycode and excludes the port. An empty hostname
  // (possible for some schemes) is guarded here rather than loosening normalizeHostname.
  if (parsed.hostname === '') return null;
  return normalizeHostname(parsed.hostname);
}

export function isSupportedUrl(url: string): boolean {
  return hostnameOf(url) !== null;
}

// Precondition: BOTH arguments must already be normalizeHostname output. `host` should
// come from hostnameOf; each site.hostname should come from parseSettings/readSites.
// This function does not re-normalize: a hand-written entry such as 'Example.com' or
// 'example.com.' would never match, silently leaving a site the owner protected
// unprotected. Callers and storage code must preserve that invariant.
// Dot-boundary matching only. Never substring or regex matching: 'notexample.com'
// must not match a protection for 'example.com'.
export function matchesProtectedSite(
  host: string,
  sites: readonly Settings['protectedSites'][number][],
): boolean {
  return sites.some((site) => {
    if (host === site.hostname) return true;
    return site.includeSubdomains && host.endsWith('.' + site.hostname);
  });
}
