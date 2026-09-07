import { useId, type InputHTMLAttributes } from 'react';
import { useFieldContext } from './Field';
import { cn } from './cn';

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function TextInput({ id, label, error, className, 'aria-describedby': ariaDescribedBy, ...props }: TextInputProps) {
  const field = useFieldContext();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const directErrorId = error ? `${inputId}-error` : undefined;
  const describedBy = ariaDescribedBy ?? field?.describedBy ?? directErrorId;
  const fieldError = error ?? field?.error;

  return (
    <>
      {label ? (
        <label className="text-sm font-medium text-ink" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        {...props}
        id={inputId}
        aria-describedby={describedBy}
        aria-invalid={fieldError ? true : undefined}
        className={cn(
          'min-h-6 w-full rounded-sm border border-edge bg-surface px-2 py-2 text-sm text-ink placeholder:text-ink-muted focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
          fieldError ? 'border-danger' : undefined,
          className,
        )}
      />
      {label && error ? (
        <p className="text-xs text-danger" id={directErrorId} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
