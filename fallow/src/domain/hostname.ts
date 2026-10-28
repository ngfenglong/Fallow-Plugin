// Pure domain helpers: no browser API access in this file.

// Lowercases, strips one trailing dot, and rejects anything that is not a bare
// hostname (path/port separators, whitespace, or an empty label).
export function normalizeHostname(input: string): string | null {
  let host = input.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '' || /[/:\s]/.test(host)) return null;
  if (host.split('.').some((label) => label === '')) return null;
  return host;
}
