import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './Button';
import { cn } from './cn';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  expiry?: string | null;
  className?: string;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onOpenChange,
  expiry,
  className,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      dialog.removeAttribute('open');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onOpenChange(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onOpenChange]);

  return (
    <dialog
      ref={dialogRef}
      className={cn('motion-dialog z-dialog rounded bg-surface p-0 text-ink shadow-lg', className)}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onOpenChange(false);
        }
      }}
      onClose={() => onOpenChange(false)}
    >
      <div className="grid max-w-[calc(100vw-2rem)] gap-4 p-4">
        <div>
          <h2 className="text-lg font-medium text-balance" id={titleId}>
            {title}
          </h2>
          <div className="mt-2 text-sm text-ink-muted text-pretty">{children}</div>
        </div>
        {expiry ? (
          <p className="text-xs text-attention">
            This approval expires <time dateTime={expiry}>{new Date(expiry).toLocaleString()}</time>.
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
