import { t } from '../i18n';

/** Apple keyboards have a Command key and their own symbols; every other keyboard has Ctrl. */
const APPLE = typeof navigator !== 'undefined'
  && /mac|iphone|ipad|ipod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '');

/**
 * A keyboard shortcut as this person's keyboard names it: "⌘K" on a Mac, "Ctrl+K" elsewhere
 * (with the key names in the app's language, e.g. "Strg+K", "Ctrl+Maj+,").
 * The shortcuts themselves answer to both Ctrl and Command (see App.tsx).
 */
export function shortcut(key: string, opts: { shift?: boolean } = {}): string {
  if (APPLE) return `${opts.shift ? '⇧' : ''}⌘${key}`;
  return [t('Ctrl'), ...(opts.shift ? [t('Shift')] : []), key].join('+');
}
