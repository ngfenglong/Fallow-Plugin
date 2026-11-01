import type { ButtonHTMLAttributes, Ref } from 'react';

/** A native button: keyboard and screen-reader behaviour come from the element itself. */
export function Button({ variant = 'secondary', className, ref, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary';
  ref?: Ref<HTMLButtonElement>;
}) {
  const classes = ['btn', `btn-${variant}`, className].filter(Boolean).join(' ');
  return <button type="button" className={classes} ref={ref} {...rest} />;
}
