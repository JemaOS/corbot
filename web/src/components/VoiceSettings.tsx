import { useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { tx, useT } from '../i18n';
import { useStore } from '../store';
import { voiceApi, type VoiceOptions } from '../voice/api';
import { endCall, isCallActive, previewVoice, startCall, useVoice } from '../voice/call';
import { Icon } from './Icon';
import { Select } from './Select';

const FALLBACK: VoiceOptions = {
  voices: ['ara', 'eve', 'leo', 'luna', 'rex', 'sal'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
  languages: [{ code: 'auto', name: tx('Auto-detect') }, { code: 'en', name: tx('English') }],
  speeds: [0.7, 0.85, 1, 1.15, 1.3, 1.5],
};

const speedLabel = (s: number) => `${Number(s.toFixed(2))}x`;

/** "Voice chat" section of the details panel: voice, speed, language (saved per bot), preview, start a call. */
/** The language names the server lists for voice, marked so they are translated where shown. */
export const VOICE_LANGUAGE_NAMES = [tx('Arabic (Egypt)'), tx('Arabic (Saudi Arabia)'), tx('Arabic (UAE)'), tx('Bengali'), tx('Chinese'), tx('French'), tx('German'), tx('Hindi'), tx('Indonesian'), tx('Italian'), tx('Japanese'), tx('Korean'), tx('Portuguese (Brazil)'), tx('Portuguese (Portugal)'), tx('Russian'), tx('Spanish (Mexico)'), tx('Spanish (Spain)'), tx('Turkish'), tx('Vietnamese')];

export function VoiceSettings({ bot }: { bot: Bot }) {
  const t = useT();
  const [opts, setOpts] = useState<VoiceOptions>(FALLBACK);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  useEffect(() => { voiceApi.options().then(setOpts).catch(() => {}); }, []);
  useEffect(() => setError(null), [bot.id]);

  const save = async (patch: Partial<Pick<Bot, 'voice' | 'voiceSpeed' | 'voiceLanguage'>>) => {
    const prev = useStore.getState().bots.find((b) => b.id === bot.id);
    // Optimistic; the server's `bot` event confirms.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, ...patch } : b)) }));
    setError(null);
    try {
      const res = await fetch(`/api/bots/${bot.id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      if (prev) useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, voice: prev.voice, voiceSpeed: prev.voiceSpeed, voiceLanguage: prev.voiceLanguage } : b)) }));
      setError(t('Couldn’t save that setting.'));
    }
  };

  const preview = async () => {
    if (previewing) return;
    setPreviewing(true); setError(null);
    try { await previewVoice({ botId: bot.id, voice: bot.voice, speed: bot.voiceSpeed, language: bot.voiceLanguage }); }
    catch (e) { setError((e as Error).message || t('Preview unavailable')); }
    finally { setPreviewing(false); }
  };

  const voices = opts.voices.some((v) => v.id === bot.voice) ? opts.voices : [{ id: bot.voice, name: bot.voice }, ...opts.voices];
  const speeds = opts.speeds.includes(bot.voiceSpeed) ? opts.speeds : [...opts.speeds, bot.voiceSpeed].sort((a, b) => a - b);

  return (
    <div className="panel-card">
      <div className="panel-row panel-row--setting">
        <span>{t('Voice')}</span>
        <span className="voice-setting__right">
          <button type="button" className="voice-preview" onClick={preview} disabled={previewing} title={t('Hear {name}\'s voice', { name: bot.name })}>{previewing ? t('Playing…') : t('Preview')}</button>
          <Select label={t('Voice')} value={bot.voice} options={voices.map((v) => ({ value: v.id, label: v.name }))} onChange={(voice) => save({ voice })} />
        </span>
      </div>
      <div className="panel-row panel-row--setting">
        <span>{t('Speed')}</span>
        <Select label={t('Speed')} value={bot.voiceSpeed} options={speeds.map((s) => ({ value: s, label: speedLabel(s) }))} onChange={(voiceSpeed) => save({ voiceSpeed })} />
      </div>
      <div className="panel-row panel-row--setting">
        <span>{t('Language')}</span>
        <Select label={t('Language')} value={bot.voiceLanguage} options={opts.languages.map((l) => ({ value: l.code, label: t(l.name) }))} onChange={(voiceLanguage) => save({ voiceLanguage })} />
      </div>
      <button type="button" className={`panel-row panel-row--action panel-row--call${inCall ? ' is-active' : ''}`} onClick={() => (inCall ? endCall() : startCall(bot.id))}>
        <Icon name="voice_a" size={14} opacity={inCall ? 1 : 0.56} /> {inCall ? t('End voice chat') : t('Start voice chat')}
      </button>
      {error && <div className="voice-error">{error}</div>}
    </div>
  );
}
