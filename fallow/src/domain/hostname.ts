// Pure domain helpers: no browser API access in this file.

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
