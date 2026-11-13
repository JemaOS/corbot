import { useEffect, useState } from 'react';

/** Keep these two in step with the breakpoints in styles/responsive.css. */
/** One pane at a time: the sidebar is a drawer and the details panel fills the screen. */
export const NARROW = '(max-width: 639.98px)';
/** The details panel floats over the chat instead of taking a column. */
export const OVERLAY_DETAILS = '(max-width: 1099.98px)';

/** Whether a media query matches, kept up to date. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/**
 * Keeps the app above the on-screen keyboard. Where the browser does not shrink the page for the
 * keyboard (iOS Safari), the visual viewport gets shorter instead: publish its height as --app-h,
 * which responsive.css uses for the app's height, so the composer stays in view.
 */
export function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const on = () => {
      // Pinch zoom also shrinks the visual viewport; only react to a keyboard-sized change at 1x.
      const covered = window.innerHeight - vv.height;
      if (Math.abs(vv.scale - 1) < 0.01 && covered > 120) {
        root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
        if (vv.offsetTop > 0) window.scrollTo(0, 0);
      } else root.style.removeProperty('--app-h');
    };
    on();
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    return () => { vv.removeEventListener('resize', on); vv.removeEventListener('scroll', on); root.style.removeProperty('--app-h'); };
  }, []);
}
