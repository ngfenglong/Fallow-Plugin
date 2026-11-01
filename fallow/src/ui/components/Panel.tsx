import { useId, type ReactNode } from 'react';

/** A titled section. Its heading names the region, so it is announced by name. `id`, when
 * given, lets another page element (e.g. a header anchor) jump straight to this panel. */
export function Panel({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  const headingId = useId();
  return (
    <section id={id} className="panel" aria-labelledby={headingId}>
      <h2 id={headingId} className="panel-title">{title}</h2>
      {children}
    </section>
  );
}
