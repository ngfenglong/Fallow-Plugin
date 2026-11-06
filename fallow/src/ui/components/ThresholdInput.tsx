import { useEffect, useState } from 'react';
import { THRESHOLD_MAX, THRESHOLD_MIN, THRESHOLD_PRESETS } from '../../domain/constants';
import { Button } from './Button';

/** Only a whole number of minutes inside the allowed range may reach the worker. */
function isValidThreshold(value: number): boolean {
  return Number.isInteger(value) && value >= THRESHOLD_MIN && value <= THRESHOLD_MAX;
}

/**
 * The idle threshold as an editable control. Free text commits on blur, never per keystroke;
 * an invalid entry is discarded and the saved value is shown again. Presets commit at once.
 */
export function ThresholdInput({ minutes, onCommit }: { minutes: number; onCommit: (next: number) => Promise<void> }) {
  const [draft, setDraft] = useState(String(minutes));

  // Follow the saved value when it changes from elsewhere (e.g. a refresh after a commit).
  useEffect(() => {
    setDraft(String(minutes));
  }, [minutes]);

  // Reverting the displayed value on a failed save is this component's own job (it owns
  // `draft`), not something a parent can do by changing `minutes` -- `minutes` never
  // changes on a failed save, so the effect above would never re-fire.
  const commit = async (next: number) => {
    if (next !== minutes && isValidThreshold(next)) {
      try {
        await onCommit(next);
      } catch {
        setDraft(String(minutes));
      }
    }
  };

  const commitDraft = () => {
    const next = Number(draft);
    if (isValidThreshold(next)) {
      void commit(next);
    } else {
      setDraft(String(minutes));
    }
  };

  return (
    <div className="threshold-input">
      <label>
        Threshold (minutes)
        <input
          type="number"
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitDraft();
          }}
        />
      </label>
      {THRESHOLD_PRESETS.map((preset) => (
        <Button
          key={preset}
          aria-label={`Set threshold to ${preset} minutes`}
          onClick={() => void commit(preset)}
        >
          {preset} min
        </Button>
      ))}
    </div>
  );
}
