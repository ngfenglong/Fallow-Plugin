import { Button } from './Button';

/**
 * Shown when the worker did not give a usable answer. It states what happened and the next
 * step, and never reads as an empty result. The retry button appears only when a retry is
 * wired, so it never offers an action that does nothing.
 */
export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <p className="error-title">Fallow could not read its state from the extension.</p>
      <p>Retry. If it keeps failing, reload Fallow from chrome://extensions.</p>
      {onRetry ? <Button variant="primary" onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}
