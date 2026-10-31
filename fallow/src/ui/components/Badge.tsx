export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger';

/**
 * A status tag. The tone only sets colour; the label is the text, so the state is never
 * carried by colour alone (plan section 6). Any label renders as a text child.
 */
export function Badge({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return <span className={`badge badge-${tone}`} data-tone={tone}>{label}</span>;
}
