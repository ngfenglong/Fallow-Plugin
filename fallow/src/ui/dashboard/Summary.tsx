// Type-only: erased at build time (same layering rule App.tsx documents in full).
import type { Counts } from '../../background/inventory';

/**
 * The four lifecycle counts (A18) plus Protected, named here as overlapping rather than as
 * a fifth slice of the same total: a pinned tab that is also loaded is counted in BOTH
 * Loaded and Protected, so Total is never Loaded + Unloaded + Protected and must not be
 * presented as if it were. `data-overlapping` on the Protected line is what a test (and a
 * future reviewer) can check without having to trust a comment.
 */
export function Summary({ counts }: { counts: Counts }) {
  return (
    <section className="panel" aria-label="Tab counts">
      <p>
        Total tabs: <span data-testid="count-total">{counts.total}</span>
      </p>
      <p>
        Loaded: <span data-testid="count-loaded">{counts.loaded}</span>
      </p>
      <p>
        Unloaded: <span data-testid="count-unloaded">{counts.unloaded}</span>
      </p>
      <p>
        Eligible to unload: <span data-testid="count-eligible">{counts.eligible}</span>
      </p>
      <p data-overlapping="true">
        {counts.protected} protected — this overlaps the counts above, not a slice of them
      </p>
    </section>
  );
}
