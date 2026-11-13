import { useMemo, useState } from 'react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { displayName, sortedRows, useSelectedBot, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { useT } from '../i18n';
import { shortcut } from '../lib/keys';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { NavButton } from './NavButton';
import { Transcript } from './Transcript';
import { VoiceCallBar } from './VoiceCallBar';

export function ChatView() {
  const t = useT();
  const bot = useSelectedBot();
  const transcript = useStore((s) => (bot ? s.transcripts[bot.id] : undefined));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const detailsOpen = useStore((s) => s.detailsOpen);
  const set = useStore((s) => s.set);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const rows = useMemo(() => sortedRows(transcript), [transcript]);

  if (!bot) {
    return (
      <main className="chat chat--empty">
        <header className="chat__header"><NavButton /></header>
        <div className="empty-chat"><div className="empty-chat__sub">{t('No Bot selected.')}</div></div>
      </main>
    );
  }

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2000); };

  return (
    <main className="chat" style={botVars(bot.avatarColor)}>
      <Transcript bot={bot} rows={rows} live={live} loaded={!!transcript?.loaded} />
      <VoiceCallBar />
      <Composer bot={bot} running={!!live?.isRunning} />
      <header className="chat__header">
        <NavButton />
        <span className="chat__pill-anchor">
          <button type="button" className="chat__pill" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
            <BotAvatarFor bot={bot} size={24} />
            <span className="chat__pill-name">{displayName(bot)}</span>
          </button>
          {menu && (
            <Menu
              align="center"
              onClose={() => setMenu(false)}
              items={[
                { label: detailsOpen ? t('Hide details') : t('Show details'), hint: shortcut(',', { shift: true }), onSelect: () => set({ detailsOpen: !detailsOpen }) },
                { label: t('Open computer'), onSelect: () => set({ viewerOpen: true, viewerMode: 'watch', viewerHint: null }) },
                { label: t('New conversation'), onSelect: () => api.fresh(bot.id).then(() => flash(t('Started a new conversation'))).catch((e) => flash(e.message)) },
                { label: t('Bot settings'), onSelect: () => useConfigUI.getState().openBotSettings(bot.id) },
              ]}
            />
          )}
        </span>
        <div className="chat__header-right">
          {!detailsOpen && (
            <button type="button" className="icon-btn icon-btn--bordered" onClick={() => set({ detailsOpen: true })} aria-label={t('Show details')} title={t('Show details')}>
              <Icon name="sidebar" opacity={0.66} style={{ transform: 'scaleX(-1)' }} />
            </button>
          )}
          <button type="button" className="share-btn" onClick={() => flash(t('Sharing isn’t available in Corbot yet'))}>{t('Share')}</button>
        </div>
      </header>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
