/**
 * An on/off control. The visible label and the accessible name are the same text, and the
 * state is announced through aria-checked, with On/Off also written out for sighted users.
 */
export function Switch({ label, checked, disabled = false, onChange }: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span className="switch-row">
      <span className="switch-label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        aria-disabled={disabled}
        disabled={disabled}
        className="switch"
        onClick={() => onChange(!checked)}
      >
        <span className="switch-track" aria-hidden="true" />
        <span className="switch-state">{checked ? 'On' : 'Off'}</span>
      </button>
    </span>
  );
}
