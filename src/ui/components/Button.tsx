import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export const buttonVariants = ['primary', 'secondary', 'quiet', 'danger'] as const;
export type ButtonVariant = (typeof buttonVariants)[number];

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-signal text-on-signal hover:opacity-90',
  secondary: 'border border-edge bg-surface text-ink hover:bg-sunken',
  quiet: 'bg-transparent text-ink-muted hover:bg-sunken hover:text-ink',
  danger: 'border border-danger bg-surface text-danger hover:bg-sunken',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: ReactNode;
}

export function Button({ variant = 'secondary', className, type = 'button', children, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cn(
        'inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm px-3 py-2 text-sm font-medium leading-tight focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50',
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}
