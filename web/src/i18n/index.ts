import { create } from 'zustand';
import de from './de';
import es from './es';
import fr from './fr';
import it from './it';
import pt from './pt';

/**
 * The interface in six languages. English is the source: the English sentence is the key, so the
 * code reads as plain text and a sentence with no translation yet simply shows in English.
 *
 *   t('Save')                                   a sentence
 *   t('{n} of {max} screens', { n, max })       with values
 *   tn('{n} bot', '{n} bots', n)                singular or plural
 *   tx('Thinking it through')                   marks a sentence kept in a table and translated later with t()
 *
 * Components call useT() so they redraw when the language changes. tools/i18n-check.mjs checks
 * that every sentence in the code has a translation in every language.
 */

export const LANGUAGES = [
  { code: 'en', name: 'English', locale: 'en-US' },
  { code: 'fr', name: 'Français', locale: 'fr-FR' },
  { code: 'es', name: 'Español', locale: 'es-ES' },
  { code: 'it', name: 'Italiano', locale: 'it-IT' },
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
  { code: 'pt', name: 'Português', locale: 'pt-PT' },
] as const;

export type Lang = (typeof LANGUAGES)[number]['code'];
export type Vars = Record<string, string | number>;

const DICTS: Record<Exclude<Lang, 'en'>, Record<string, string>> = { fr, es, it, de, pt };
const STORE_KEY = 'corbot.lang';
const isLang = (v: unknown): v is Lang => LANGUAGES.some((l) => l.code === v);

/** The language chosen before, else the browser's first language we have, else English. */
function initial(): Lang {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (isLang(saved)) return saved;
  } catch { /* storage is off */ }
  for (const tag of typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []) {
    const code = tag.toLowerCase().split('-')[0];
    if (isLang(code)) return code;
  }
  return 'en';
}

interface LangState { lang: Lang; setLang: (lang: Lang) => void }

export const useLang = create<LangState>((set) => ({
  lang: initial(),
  setLang: (lang) => {
    try { localStorage.setItem(STORE_KEY, lang); } catch { /* storage is off */ }
    document.documentElement.lang = lang;
    set({ lang });
  },
}));

if (typeof document !== 'undefined') document.documentElement.lang = useLang.getState().lang;

const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

/** The sentence in the current language. */
export function t(text: string, vars?: Vars): string {
  const lang = useLang.getState().lang;
  return fill(lang === 'en' ? text : DICTS[lang][text] ?? text, vars);
}

/** Singular or plural, with `n` available as {n}. */
export function tn(one: string, other: string, n: number, vars?: Vars): string {
  return t(n === 1 ? one : other, { n, ...vars });
}

/** Marks a sentence for translation without translating it here (tables of labels, translated with t() when shown). */
export const tx = (text: string) => text;

/** `t`, for components: they redraw when the language changes. */
export function useT() {
  useLang((s) => s.lang);
  return t;
}

/** BCP 47 tag of the current language, for dates and numbers. */
export function locale(): string {
  const lang = useLang.getState().lang;
  return LANGUAGES.find((l) => l.code === lang)?.locale ?? 'en-US';
}
