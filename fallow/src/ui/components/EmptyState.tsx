import type { ReactNode } from 'react';

/** What a page shows when there is genuinely nothing to list. Not a failure: see ErrorState. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-detail">{children}</div> : null}
    </div>
  );
}
