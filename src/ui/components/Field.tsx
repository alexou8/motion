import { createContext, useContext, type ReactNode } from 'react';
import { cn } from './cn';

interface FieldContextValue {
  describedBy: string | undefined;
  error: string | undefined;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, error, hint, children, className }: FieldProps) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <FieldContext.Provider value={{ describedBy, error }}>
      <div className={cn('grid gap-1', className)}>
        <label className="text-sm font-medium text-ink" htmlFor={htmlFor}>
          {label}
        </label>
        {hint ? (
          <p className="text-xs text-ink-muted" id={hintId}>
            {hint}
          </p>
        ) : null}
        {children}
        {error ? (
          <p className="text-xs text-danger" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

export function useFieldContext() {
  return useContext(FieldContext);
}
