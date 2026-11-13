import { memo, useCallback, useState } from 'react';
import { useConfigUI } from '../configStore';
import { TasksIsland } from './config/TasksView';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { displayName, useStore } from '../store';
import { api } from '../lib/api';
import { t, useT } from '../i18n';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { NARROW, useMediaQuery } from '../lib/responsive';
import { shortcut } from '../lib/keys';

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

function previewFor(bot: Bot, running: boolean, awaiting: string | null) {
  if (awaiting) return t('Waiting for you: {what}', { what: awaiting });
  if (running && !bot.lastPreview) return t('Working…');
  return bot.lastPreview ?? t('No messages yet');
}

const BotRow = memo(function BotRow({ bot, selected, running, awaiting, onSelect }: { bot: Bot; selected: boolean; running: boolean; awaiting: string | null; onSelect: (id: string) => void }) {
  const t = useT();
  return (
    <button type="button" className={`bot-row${selected ? ' is-selected' : ''}`} onClick={() => onSelect(bot.id)} aria-current={selected || undefined}>
      <span className="bot-row__avatar">
        <BotAvatarFor bot={bot} size={36} />
        {(running || awaiting || bot.unread > 0) && (
          <span className={`status-dot ${awaiting ? 'is-attention' : running ? 'is-working' : 'is-unread'}`} aria-label={awaiting ? t('Needs attention') : running ? t('Working') : t('Unread activity')} />
        )}
      </span>
      <span className="bot-row__text">
        <span className="bot-row__name">{displayName(bot)}</span>
        <span className="bot-row__preview">{previewFor(bot, running, awaiting)}</span>
      </span>
    </button>
  );
});

export function Sidebar() {
  const t = useT();
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  const storeSelectedBotId = useStore((s) => s.selectedBotId);
  const inTasks = useConfigUI((s) => s.view === 'tasks');
  const selectedBotId = inTasks ? null : storeSelectedBotId; // nothing highlighted while the Tasks view is open
  const user = useStore((s) => s.user);
  // On narrow screens the sidebar is a drawer: always full size, and the toggle closes it.
  const narrow = useMediaQuery(NARROW);
  const collapsed = useStore((s) => s.sidebarCollapsed) && !narrow;
  const set = useStore((s) => s.set);
  const storeSelectBot = useStore((s) => s.selectBot);
  // Picking a bot (even the one already selected) leaves the Tasks view.
  const selectBot = useCallback((id: string) => { useConfigUI.getState().setView('chat'); storeSelectBot(id); useStore.setState({ navOpen: false }); }, [storeSelectBot]);
  const setModal = useStore((s) => s.setModal);
  const [accountMenu, setAccountMenu] = useState(false);
  const logout = async () => { await api.logout().catch(() => {}); location.reload(); };

  const primary = bots.find((b) => b.isPrimary);
  const others = bots.filter((b) => !b.isPrimary).sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="sidebar__titlebar">
        <div className="sidebar__controls">
          {narrow ? (
            <button type="button" className="icon-btn icon-btn--plain" onClick={() => set({ navOpen: false })} aria-label={t('Close menu')} title={t('Close menu')}>
              <Icon name="close" opacity={0.66} />
            </button>
          ) : (
            <button type="button" className="icon-btn icon-btn--plain" onClick={() => set({ sidebarCollapsed: !collapsed })} aria-label={collapsed ? t('Expand sidebar') : t('Collapse sidebar')} title={t('Toggle sidebar ({keys})', { keys: shortcut('B') })}>
              <Icon name="sidebar" opacity={0.66} />
            </button>
          )}
          {!collapsed && (
            <>
              <button type="button" className="icon-btn" onClick={() => setModal('search')} aria-label={t('Search')} title={t('Search ({keys})', { keys: shortcut('K') })}>
                <Icon name="search" opacity={0.66} />
              </button>
              <button type="button" className="icon-btn" onClick={() => setModal('create')} aria-label={t('New Bot')} title={t('New Bot')}>
                <Icon name="plus" opacity={0.66} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="sidebar__scroll">
        <TasksIsland />
        {primary && (
          <div className="pinned">
            <button type="button" className={`pinned__tile${selectedBotId === primary.id ? ' is-selected' : ''}`} onClick={() => selectBot(primary.id)} title={displayName(primary)}>
              <span className="pinned__avatar">
                <BotAvatarFor bot={primary} size={collapsed ? 44 : 60} star />
                {live[primary.id]?.isRunning && <span className="status-dot is-working pinned__dot" />}
              </span>
              {!collapsed && <span className="pinned__label">{displayName(primary)}</span>}
            </button>
          </div>
        )}
        <div className="bot-list">
          {others.map((b) =>
            collapsed ? (
              <button key={b.id} type="button" className={`bot-rail-item${selectedBotId === b.id ? ' is-selected' : ''}`} onClick={() => selectBot(b.id)} title={displayName(b)}>
                <BotAvatarFor bot={b} size={36} />
              </button>
            ) : (
              <BotRow key={b.id} bot={b} selected={selectedBotId === b.id} running={!!live[b.id]?.isRunning} awaiting={live[b.id]?.awaiting?.reason ?? null} onSelect={selectBot} />
            ),
          )}
          {!collapsed && others.length === 0 && (
            <button type="button" className="bot-list__empty" onClick={() => setModal('create')}>
              <span className="bot-list__empty-plus"><Icon name="plus" size={14} opacity={0.66} /></span>
              <span>
                <span className="bot-row__name">{t('Create a Bot')}</span>
                <span className="bot-row__preview">{t('Give it a job, like research or inbox triage')}</span>
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="sidebar__footer">
        <div className="sidebar__fade" />
        {!collapsed && (
          <div className="account">
            <button type="button" className="account__btn" onClick={() => setAccountMenu(!accountMenu)} aria-haspopup="menu" aria-expanded={accountMenu} title={user?.email}>
              <span className="account__initials">{initials(user?.name ?? user?.email ?? '')}</span>
              <span className="account__name">{user?.name ?? user?.email}</span>
            </button>
            {accountMenu && (
              <Menu
                placement="above"
                onClose={() => setAccountMenu(false)}
                items={[
                  { label: t('Settings'), hint: shortcut(','), onSelect: () => useConfigUI.getState().openAppSettings() },
                  { label: t('Connect apps'), onSelect: () => setModal('apps') },
                  { label: t('Log out'), danger: true, onSelect: logout },
                ]}
              >
                <div className="menu__header">{user?.email}</div>
              </Menu>
            )}
          </div>
        )}
        <button type="button" className="icon-btn icon-btn--bordered" onClick={() => setModal('apps')} aria-label={t('Connect apps')} title={t('Connect apps')}>
          <Icon name="apps" />
        </button>
      </div>
    </aside>
  );
}
