import type { SVGProps } from 'react';

const canonicalMark = new URL('../../assets/brand/motion-mark.svg', import.meta.url).href;

/** Motion's canonical track mark. Keep geometry in sync with assets/brand/motion-mark.svg. */
export function MotionMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" {...props}>
      <use href={`${canonicalMark}#motion-mark`} />
    </svg>
  );
}
