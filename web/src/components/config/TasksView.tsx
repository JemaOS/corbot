import { useEffect, useMemo, useState } from 'react';
import { NavButton } from '../NavButton';
import type { Bot, Task } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi } from '../../lib/configApi';
import { useConfigUI, useVersion } from '../../configStore';
import { t, tx, useT } from '../../i18n';
import { useStore } from '../../store';
import { Glyph } from './glyphs';
import { agoLabel } from './ui';

type Filter = 'all' | 'open' | 'done';

const STATE_LABEL: Record<Task['state'], string> = { working: tx('Working on it'), needs_input: tx('Waiting on you'), done: tx('Done') };

function when(task: Task): string {
  const ago = agoLabel(task.updatedAt);
  return task.state === 'done' ? t('Completed {when}', { when: ago }) : task.state === 'needs_input' ? t('Asked {when}', { when: ago }) : t('Updated {when}', { when: ago });
}

function TaskRow({ t: task, bot, showBot }: { t: Task; bot?: Bot; showBot: boolean }) {
  const t = useT();
  const open = () => { if (bot) { useStore.getState().selectBot(bot.id); useConfigUI.getState().setView('chat'); } };
  return (
    <button type="button" className={`task-row is-${task.state}`} onClick={open} disabled={!bot} title={bot ? t('Open {name}', { name: bot.name }) : undefined}>
      <span className={`task-row__check is-${task.state}`} aria-hidden>{task.state === 'done' ? <Glyph name="check_circle" size={18} /> : <span className="task-row__ring" />}</span>
      <span className="task-row__text">
        <span className="task-row__title">{task.title}</span>
        {task.note && <span className="task-row__note">{task.note}</span>}
        <span className="task-row__meta">
          {showBot && bot && <><BotAvatarFor bot={bot} size={14} /><span>{bot.name}</span><span aria-hidden>·</span></>}
          <span>{when(task)}</span>
        </span>
      </span>
      <span className={`task-chip is-${task.state}`}>{t(STATE_LABEL[task.state])}</span>
    </button>
  );
}

function useTasks(botId?: string): Task[] | null {
  const v = useVersion(botId ? `tasks:${botId}` : 'tasks');
  const [tasks, setTasks] = useState<Task[] | null>(null);
  useEffect(() => {
    let alive = true;
    (botId ? configApi.botTasks(botId) : configApi.tasks()).then((r) => { if (alive) setTasks(r.tasks); }).catch(() => { if (alive) setTasks([]); });
    return () => { alive = false; };
  }, [botId, v]);
  return tasks;
}

function sortTasks(list: Task[]) {
  const rank = { needs_input: 0, working: 1, done: 2 } as const;
  return [...list].sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt);
}

/** Full Tasks view in the main column (sidebar → Tasks). */
export function TasksView() {
  const t = useT();
  const bots = useStore((s) => s.bots);
  const tasks = useTasks();
  const [filter, setFilter] = useState<Filter>('open');
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const counts = useMemo(() => ({ open: tasks?.filter((x) => x.state !== 'done').length ?? 0, done: tasks?.filter((x) => x.state === 'done').length ?? 0 }), [tasks]);
  const shown = useMemo(() => sortTasks((tasks ?? []).filter((x) => filter === 'all' || (filter === 'done' ? x.state === 'done' : x.state !== 'done'))), [tasks, filter]);

  return (
    <main className="chat tasks-view">
      <header className="tasks-view__header">
        <NavButton />
        <div className="tasks-view__title">{t('Tasks')}</div>
        <div className="segmented" role="tablist" aria-label={t('Filter tasks')}>
          {([['open', counts.open ? t('In progress {n}', { n: counts.open }) : t('In progress')], ['done', t('Done')], ['all', t('All')]] as [Filter, string][]).map(([f, label]) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? 'is-active' : ''} onClick={() => setFilter(f)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="tasks-view__scroll">
        <div className="tasks-view__inner">
          {tasks === null ? <div className="cfg-empty">{t('Loading…')}</div> : shown.length === 0 ? (
            <div className="tasks-empty">
              <Glyph name="tasks" size={28} opacity={0.35} />
              <div className="tasks-empty__title">{filter === 'done' ? t('Nothing finished yet') : t('Nothing in progress')}</div>
              <div className="tasks-empty__sub">{t('Give a Bot a multi-part request and every piece gets its own row here, so progress is easy to follow.')}</div>
            </div>
          ) : (
            <div className="task-list">{shown.map((x) => <TaskRow key={x.id} t={x} bot={byId.get(x.botId)} showBot />)}</div>
          )}
        </div>
      </div>
    </main>
  );
}

/** Sidebar entry for the Tasks view, with a count of tasks waiting on the user. */
export function TasksIsland() {
  const t = useT();
  const view = useConfigUI((s) => s.view);
  const tasks = useTasks();
  const waiting = tasks?.filter((x) => x.state === 'needs_input').length ?? 0;
  return (
    <button type="button" className={`sidebar-island${view === 'tasks' ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().setView(view === 'tasks' ? 'chat' : 'tasks')} title={t('Tasks')} aria-pressed={view === 'tasks'}>
      <span className="sidebar-island__icon"><Glyph name="tasks" size={18} /></span>
      <span className="sidebar-island__label">{t('Tasks')}</span>
      {waiting > 0 && <span className="sidebar-island__count" aria-label={t('{n} waiting on you', { n: waiting })}>{waiting}</span>}
    </button>
  );
}

/** Tasks for one bot (details panel → Tasks tab). */
export function BotTasks({ bot }: { bot: Bot }) {
  const t = useT();
  const tasks = useTasks(bot.id);
  const sorted = useMemo(() => sortTasks(tasks ?? []), [tasks]);
  return (
    <div className="details__sections">
      <section>
        <div className="section-label section-label--row">
          <span>{t('Tasks')}</span>
          <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().setView('tasks')}>{t('See all')}</button>
        </div>
        {tasks === null ? <div className="panel-card"><div className="panel-empty">{t('Loading…')}</div></div> : sorted.length === 0 ? (
          <div className="panel-card"><div className="panel-empty">{t('No tasks yet. Ask {name} for a few things at once and they’ll be tracked here.', { name: bot.name })}</div></div>
        ) : (
          <div className="panel-card task-list task-list--compact">{sorted.map((x) => <TaskRow key={x.id} t={x} bot={bot} showBot={false} />)}</div>
        )}
      </section>
    </div>
  );
}
