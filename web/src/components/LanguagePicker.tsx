import { LANGUAGES, useLang, useT, type Lang } from '../i18n';
import { Select } from './Select';

/** Choose the language of the app. `compact` is the small form used on the sign-in screen. */
export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const t = useT();
  return (
    <Select<Lang>
      label={t('Language')} className={`lang-picker${compact ? ' lang-picker--compact' : ''}`}
      value={lang} onChange={setLang} options={LANGUAGES.map((l) => ({ value: l.code, label: l.name }))}
    />
  );
}
