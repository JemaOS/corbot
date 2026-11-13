import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, EngineInfo, EngineProvider } from '@shared/types';
import { configApi } from '../lib/configApi';
import { tn, tx, useT } from '../i18n';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Select } from './Select';

const KIND: Record<EngineProvider['kind'], string> = { subscription: tx('Subscription'), api_key: tx('API key') };
const STATUS: Record<EngineInfo['status'], string> = { ready: tx('ready'), starting: tx('starting'), stopped: tx('stopped'), error: tx('error') };

/** Connected providers first; otherwise the server's order. */
function sortProviders(list: EngineProvider[]): EngineProvider[] {
  return [...list].sort((a, b) => Number(b.connected) - Number(a.connected));
}

/** How many models the list shows at once; typing narrows it down. */
const SHOWN = 80;

/** Models whose id contains every word typed, in the provider's own order. */
function matching(models: string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? models.filter((m) => { const id = m.toLowerCase(); return words.every((w) => id.includes(w)); }) : models;
}

/**
 * "Engine" section of the details panel: which provider and model run this bot's agent, signing in to
 * a subscription, and the agent's status. Every call fails soft: if the engine endpoints are missing or
 * down, the section says so and the rest of the panel is unaffected.
 */
export function EngineSettings({ bot }: { bot: Bot }) {
  const t = useT();
  const viewerOpen = useStore((s) => s.viewerOpen);
  const set = useStore((s) => s.set);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<'save' | 'signin' | 'restart' | 'screen' | 'key' | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [editKey, setEditKey] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const dirty = useRef(false);
  const botId = bot.id;

  const apply = useCallback((e: EngineInfo, keepDraft = false) => {
    setEngine(e); setPhase('ok');
    if (!keepDraft || !dirty.current) { dirty.current = false; setProvider(e.provider ?? ''); setModel(e.model ?? ''); }
    // Keep the bot's model label in step without waiting for the server's `bot` event.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === e.botId && (b.model !== e.model || b.provider !== e.provider) ? { ...b, model: e.model, provider: e.provider } : b)) }));
  }, []);

  /** Quiet refreshes keep what is on screen if the call fails. */
  const load = useCallback((quiet = false) => {
    let alive = true;
    if (!quiet) setPhase('loading');
    configApi.engine(botId)
      .then((r) => { if (alive && r?.engine) apply(r.engine, quiet); else if (alive && !quiet) setPhase('unavailable'); })
      .catch(() => { if (alive && !quiet) setPhase('unavailable'); });
    return () => { alive = false; };
  }, [botId, apply]);

  useEffect(() => { dirty.current = false; setEngine(null); setNote(null); setSigningIn(false); setPicking(false); setQuery(''); setApiKey(''); setEditKey(false); return load(); }, [load]);

  // The agent takes a moment to come up after a change or a restart.
  const starting = engine?.status === 'starting';
  useEffect(() => {
    if (!starting) return;
    const timer = setInterval(() => load(true), 3000);
    return () => clearInterval(timer);
  }, [starting, load]);

  // Signing in happens on the bot's computer. Check while that view is open, and once more when it closes.
  useEffect(() => {
    if (!signingIn) return;
    if (!viewerOpen) { setSigningIn(false); load(true); return; }
    const timer = setInterval(() => load(true), 5000);
    return () => clearInterval(timer);
  }, [signingIn, viewerOpen, load]);

  if (phase !== 'ok' || !engine) {
    return (
      <div className="panel-card">
        <div className="panel-empty engine__empty">
          {phase === 'loading' ? t('Checking…') : (
            <>
              <span>{t('Engine unavailable')}</span>
              <button type="button" className="link-btn link-btn--small" onClick={() => load()}>{t('Try again')}</button>
            </>
          )}
        </div>
      </div>
    );
  }

  const providers = sortProviders(engine.providers ?? []);
  const selected = providers.find((p) => p.id === provider) ?? null;
  const models = selected?.models ?? [];
  const found = matching(models, query);
  // A provider connected with a key shows the key field until it is connected, and again on request.
  const keyProvider = selected && selected.kind === 'api_key' && selected.keyEnv ? selected : null;
  const askKey = !!keyProvider && (!keyProvider.connected || editKey);
  const wantProvider = provider && provider !== (engine.provider ?? '') ? provider : undefined;
  const wantModel = model.trim() && model.trim() !== (engine.model ?? '') ? model.trim() : undefined;
  const changed = !!wantProvider || !!wantModel;
  const openSubscriptions = providers.filter((p) => p.kind === 'subscription' && !p.connected);
  const signInTo = selected && selected.kind === 'subscription' && !selected.connected ? selected : null;
  const listId = `engine-models-${botId}`;

  const pickProvider = (id: string) => {
    dirty.current = true; setNote(null); setProvider(id); setQuery(''); setApiKey(''); setEditKey(false);
    const next = providers.find((p) => p.id === id);
    // A model from another provider will not work here, so start from this provider's first suggestion.
    if (next?.models.length && !next.models.includes(model.trim())) setModel(next.models[0]);
  };

  const pickModel = (id: string) => { dirty.current = true; setNote(null); setModel(id); setPicking(false); setQuery(''); };

  /** Save the pasted key (or, empty, remove it). The provider and model on screen are kept as the draft. */
  const saveKey = async (value: string) => {
    if (busy || !keyProvider) return;
    setBusy('key'); setNote(null);
    try {
      const r = await configApi.engineKey(botId, keyProvider.id, value);
      setEngine(r.engine); setApiKey(''); setEditKey(false);
      const now = r.engine.providers.find((p) => p.id === keyProvider.id);
      if (value && now?.models.length && !now.models.includes(model.trim())) { dirty.current = true; setModel(now.models[0]); }
    } catch (e) { setNote(t('Couldn’t save the key: {reason}', { reason: (e as Error).message || t('the engine did not answer') })); }
    finally { setBusy(null); }
  };

  const save = async () => {
    if (!changed || busy) return;
    setBusy('save'); setNote(null);
    try { const r = await configApi.setEngine(botId, { ...(wantProvider ? { provider: wantProvider } : {}), ...(wantModel ? { model: wantModel } : {}) }); dirty.current = false; apply(r.engine); }
    catch (e) { setNote(t('Couldn’t save: {reason}', { reason: (e as Error).message || t('the engine did not answer') })); }
    finally { setBusy(null); }
  };

  const signIn = async () => {
    if (busy) return;
    setBusy('signin'); setNote(null);
    try {
      await configApi.engineLogin(botId, signInTo?.id);
      // The sign-in runs in a terminal on the bot's screen, so take the person there with the mouse and keyboard.
      set({ viewerOpen: true, viewerMode: 'control', viewerHint: t('Finish signing in on {name}’s computer, then hand back.', { name: bot.name }) });
      setSigningIn(true);
    } catch (e) { setNote(t('Couldn’t start sign-in: {reason}', { reason: (e as Error).message || t('the engine did not answer') })); }
    finally { setBusy(null); }
  };

  const restart = async () => {
    if (busy) return;
    setBusy('restart'); setNote(null);
    try { const r = await configApi.restartEngine(botId); apply(r.engine, true); }
    catch (e) { setNote(t('Couldn’t restart: {reason}', { reason: (e as Error).message || t('the engine did not answer') })); }
    finally { setBusy(null); }
  };

  const useThisScreen = async () => {
    if (busy) return;
    setBusy('screen'); setNote(null);
    try { const r = await configApi.stopOwnScreen(botId); apply(r.engine, true); }
    catch (e) { setNote(t('Couldn’t switch screens: {reason}', { reason: (e as Error).message || t('the engine did not answer') })); }
    finally { setBusy(null); }
  };

  return (
    <div className="panel-card engine">
      <div className="panel-row panel-row--setting">
        <span>{t('Provider')}</span>
        <Select
          label={t('Provider')} className="mini-select engine__select" value={provider} onChange={pickProvider}
          display={selected?.name ?? (provider || t('Default'))}
          options={providers.map((p) => ({ value: p.id, label: p.name, hint: t(KIND[p.kind]), group: p.connected ? t('Connected') : t('Not connected') }))}
        />
      </div>
      {selected && (
        <div className={`engine__conn${selected.connected ? ' is-on' : ''}`}>
          <i aria-hidden />
          <span>{selected.connected ? t('Connected') : t('Not connected')} · {t(KIND[selected.kind])}</span>
          {keyProvider?.connected && !editKey && <button type="button" className="link-btn link-btn--small engine__conn-btn" onClick={() => { setEditKey(true); setNote(null); }}>{t('Change key')}</button>}
        </div>
      )}
      {askKey && keyProvider && (
        <form className="engine__key" onSubmit={(e) => { e.preventDefault(); if (apiKey.trim()) saveKey(apiKey.trim()); }}>
          <label htmlFor={`${listId}-key`}>{t('API key for {name}', { name: keyProvider.name })}</label>
          <div className="engine__key-row">
            <input
              id={`${listId}-key`} className="engine__model engine__key-input" type="password" value={apiKey} spellCheck={false} autoComplete="off"
              placeholder={keyProvider.keyEnv ?? ''} onChange={(e) => { setNote(null); setApiKey(e.target.value); }}
            />
            <button type="submit" className="btn btn--sm btn--bot" disabled={!apiKey.trim() || busy === 'key'}>{busy === 'key' ? t('Connecting…') : t('Connect')}</button>
          </div>
          <div className="engine__key-hint">
            <span>{t('The key is stored on the Bots’ computer and used by all your Bots.')}</span>
            {keyProvider.connected && (
              <span className="engine__key-links">
                <button type="button" className="link-btn link-btn--small" onClick={() => saveKey('')} disabled={busy === 'key'}>{t('Remove key')}</button>
                <button type="button" className="link-btn link-btn--small" onClick={() => { setEditKey(false); setApiKey(''); }}>{t('Cancel')}</button>
              </span>
            )}
          </div>
        </form>
      )}
      <div className="panel-row panel-row--setting">
        <label htmlFor={`${listId}-input`}>{t('Model')}</label>
        <input
          id={`${listId}-input`} className="engine__model" value={model} spellCheck={false} autoComplete="off"
          placeholder={models[0] ?? t('Model id')}
          onChange={(e) => { dirty.current = true; setNote(null); setModel(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
        />
      </div>
      {models.length > 0 && (
        <div className="engine__models">
          <button type="button" className="link-btn link-btn--small" aria-expanded={picking} aria-controls={listId} onClick={() => { setPicking(!picking); setQuery(''); }}>
            {picking ? t('Hide the list') : tn('Choose from {n} model', 'Choose from {n} models', models.length)}
          </button>
          {picking && (
            <div className="engine__picker" id={listId}>
              <input
                className="engine__model engine__search" type="search" value={query} autoFocus spellCheck={false} autoComplete="off"
                placeholder={t('Search models')} aria-label={t('Search models')} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && found.length) { e.preventDefault(); pickModel(found[0]); } else if (e.key === 'Escape') setPicking(false); }}
              />
              <ul className="engine__list" role="listbox" aria-label={t('Model')}>
                {found.slice(0, SHOWN).map((m) => (
                  <li key={m} role="option" aria-selected={m === model.trim()}>
                    <button type="button" className={`engine__option${m === model.trim() ? ' is-current' : ''}`} onClick={() => pickModel(m)} title={m}>{m}</button>
                  </li>
                ))}
              </ul>
              <div className="engine__count">
                {found.length === 0 ? t('No model matches. You can still type a model id above.')
                  : found.length > SHOWN ? t('Showing {shown} of {n}. Type to narrow the list.', { shown: SHOWN, n: found.length })
                    : tn('{n} model', '{n} models', found.length)}
              </div>
            </div>
          )}
        </div>
      )}
      <div className="engine__actions">
        <button type="button" className="btn btn--sm btn--bot" onClick={save} disabled={!changed || busy === 'save'}>{busy === 'save' ? t('Saving…') : t('Save')}</button>
        {changed && <button type="button" className="link-btn link-btn--small" onClick={() => { dirty.current = false; setNote(null); setProvider(engine.provider ?? ''); setModel(engine.model ?? ''); }}>{t('Undo')}</button>}
      </div>
      {(signInTo || openSubscriptions.length > 0) && (
        <button type="button" className="panel-row panel-row--action engine__signin" onClick={signIn} disabled={busy === 'signin'}>
          <Icon name="monitor" size={14} opacity={0.56} />
          {busy === 'signin' ? t('Opening sign-in…') : signInTo ? t('Sign in to {name}…', { name: signInTo.name }) : t('Sign in to a subscription…')}
        </button>
      )}
      {engine.ownScreen && (
        <div className="engine__notice">
          <span>{t('{name} also has a private screen of its own switched on. Desktop work it does there (clicking around apps) will not show on the screen here.', { name: bot.name })}</span>
          <button type="button" className="link-btn link-btn--small" onClick={useThisScreen} disabled={busy === 'screen'}>{busy === 'screen' ? t('Switching…') : t('Use this screen')}</button>
        </div>
      )}
      {note && <div className="voice-error" role="alert">{note}</div>}
      <div className="engine__meta">
        <span className={`engine__state is-${engine.status}`} title={engine.version ? `Hermes ${engine.version}` : undefined}>
          <i aria-hidden />
          {t('Hermes · profile {profile} · {status}', { profile: engine.profile, status: STATUS[engine.status] ? t(STATUS[engine.status]) : engine.status })}
        </span>
        {(engine.status === 'error' || engine.status === 'stopped') && (
          <button type="button" className="link-btn link-btn--small" onClick={restart} disabled={busy === 'restart'}>{busy === 'restart' ? t('Restarting…') : t('Restart agent')}</button>
        )}
      </div>
      {engine.status === 'error' && engine.error && <div className="engine__error">{engine.error}</div>}
    </div>
  );
}
