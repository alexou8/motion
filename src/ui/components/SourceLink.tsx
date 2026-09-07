import { useMemo } from 'react';
import { cn } from './cn';

export interface SourceLinkProps {
  href: string;
  pageTitle: string;
  className?: string;
}

export function SourceLink({ href, pageTitle, className }: SourceLinkProps) {
  const source = useMemo(() => {
    try {
      const url = new URL(href);
      if (url.protocol !== 'https:') return null;
      return { href: url.toString(), origin: url.origin };
    } catch {
      return null;
    }
  }, [href]);

  if (!source) return null;

  return (
    <a
      className={cn('inline-flex min-h-6 max-w-full flex-wrap gap-x-1 text-xs text-signal underline underline-offset-2 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus', className)}
      href={source.href}
      target="_blank"
      rel="noreferrer"
    >
      <span className="truncate">{pageTitle || 'Source page'}</span>
      <span>{source.origin}</span>
    </a>
  );
}
