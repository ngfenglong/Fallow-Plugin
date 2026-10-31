import { useId, type ReactNode } from 'react';

/** A titled section. Its heading names the region, so it is announced by name. */
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId} className="panel-title">{title}</h2>
      {children}
    </section>
  );
}
