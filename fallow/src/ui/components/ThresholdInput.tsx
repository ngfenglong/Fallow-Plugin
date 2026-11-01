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
export function ThresholdInput({ minutes, onCommit }: { minutes: number; onCommit: (next: number) => void }) {
  const [draft, setDraft] = useState(String(minutes));

  // Follow the saved value when it changes from elsewhere (e.g. a refresh after a commit).
  useEffect(() => {
    setDraft(String(minutes));
  }, [minutes]);

  const commit = (next: number) => {
    if (next !== minutes && isValidThreshold(next)) onCommit(next);
  };

  return (
    <div className="threshold-input">
      <label>
        Threshold (minutes)
        <input
          type="number"
          aria-label="Threshold in minutes"
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            const next = Number(draft);
            if (isValidThreshold(next)) {
              commit(next);
            } else {
              setDraft(String(minutes));
            }
          }}
        />
      </label>
      {THRESHOLD_PRESETS.map((preset) => (
        <Button
          key={preset}
          aria-label={`Set threshold to ${preset} minutes`}
          onClick={() => commit(preset)}
        >
          {preset} min
        </Button>
      ))}
    </div>
  );
}
