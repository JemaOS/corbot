import { useState } from 'react';
import { BotAvatar } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { useT } from '../i18n';
import { useStore } from '../store';
import { LanguagePicker } from './LanguagePicker';

/**
 * The door in front of the app when it is reachable from the internet: one password, then the normal
 * sign-in (Google or e-mail) chooses the account.
 */
export function Gate() {
  const t = useT();
  const checkAuth = useStore((s) => s.checkAuth);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) { setError(t('Enter the password')); return; }
    setBusy(true); setError(null);
    try {
      await api.openGate(password);
      await checkAuth();
    } catch (err) {
      const code = (err as Error).message;
      setError(code === 'wrong_password' ? t('Wrong password.') : code === 'too_many' ? t('Too many attempts. Try again in a few minutes.') : code);
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <div className="signin__lang"><LanguagePicker compact /></div>
      <div className="signin__card">
        <div className="signin__hero">
          <BotAvatar shape="disc" color="black" size={84} />
        </div>
        <h1 className="signin__title">Corbot</h1>
        <p className="signin__sub">{t('This app is private. Enter its access password to continue.')}</p>
        <form className="signin__dev" onSubmit={submit}>
          <input
            className="text-input"
            type="password"
            placeholder={t('Password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label={t('Password')}
            autoComplete="current-password"
            autoFocus
          />
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? t('Signing in…') : t('Enter')}</button>
        </form>
        {error && <div className="card__error signin__error">{error}</div>}
        <p className="signin__foot">{t('Your team. Their own computers.')}</p>
      </div>
    </div>
  );
}
