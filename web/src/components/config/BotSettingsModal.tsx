import { useCallback, useEffect, useMemo, useState } from 'react';
import { scheduleLabel } from '../../lib/time';
import type { AvatarColor, AvatarShape, Bot, Memory, Routine, Skill } from '@shared/types';
import { BotAvatar, BotAvatarFor, PICKER_SHAPES, SHAPE_LABELS } from '../../avatar/BotAvatar';
import { COLOR_ORDER, botVars, palette, COLOR_LABELS } from '../../lib/colors';
import { configApi, type BotSettingsBundle } from '../../lib/configApi';
import { useConfigUI, useVersion, type BotSettingsTab } from '../../configStore';
import { tx, useT } from '../../i18n';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Modal } from '../modals/Modal';
import { Glyph } from './glyphs';
import { ConfirmButton, Field, Segmented, Switch, nextRunLabel, shortDate } from './ui';

const EFFORTS: { value: Bot['effort']; label: string }[] = [
  { value: 'low', label: tx('Low') },
  { value: 'medium', label: tx('Medium') },
  { value: 'high', label: tx('High') },
  { value: 'xhigh', label: tx('Max') },
];

const EFFORT_HINT: Record<Bot['effort'], string> = {
  low: tx('Fastest replies. Good for quick lookups and chit-chat.'),
  medium: tx('A good balance for most work.'),
  high: tx('Thinks longer before acting. Better for tricky, multi-step work.'),
  xhigh: tx('Thinks the longest. Slowest, for the hardest problems.'),
};

export function BotSettingsModal() {
  const target = useConfigUI((s) => s.botSettings);
  const close = useConfigUI((s) => s.closeBotSettings);
  const t = useT();
  const setTab = (tab: BotSettingsTab) => target && useConfigUI.setState({ botSettings: { ...target, tab } });
  const bot = useStore((s) => s.bots.find((b) => b.id === target?.botId));
  const routines = useStore((s) => (target ? s.routines[target.botId] : undefined));
  const memVersion = useVersion(`memories:${target?.botId ?? ''}`);
  const [data, setData] = useState<BotSettingsBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const onClose = useCallback(() => close(), [close]);

  const reload = useCallback(() => {
    if (!target) return;
    configApi.settings(target.botId).then((d) => { setData(d); setLoadError(null); }).catch((e) => setLoadError(e.message));
  }, [target?.botId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reload(); }, [reload, memVersion]);
  useEffect(() => { if (target) useStore.getState().loadRoutines(target.botId).catch(() => {}); }, [target?.botId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bot deleted while open (or bad id): close.
  useEffect(() => { if (target && !bot && useStore.getState().bots.length) close(); }, [bot, target, close]);
  if (!target || !bot) return null;

  const tabs: { id: BotSettingsTab; label: string; count?: number }[] = [
    { id: 'general', label: t('General') },
    { id: 'skills', label: t('Skills'), count: data?.skills.length },
    { id: 'memories', label: t('Memories'), count: data?.memories.length },
    { id: 'routines', label: t('Routines'), count: (routines ?? data?.routines)?.length },
  ];

  return (
    <Modal onClose={onClose} className="bot-settings" label={t('{name} settings', { name: bot.name })}>
      <div className="modal__header">
        <div className="bot-settings__title">
          <BotAvatarFor bot={bot} size={24} />
          <span className="modal__title">{bot.name}</span>
        </div>
        <button type="button" className="modal__close" onClick={onClose} aria-label={t('Close')}><Icon name="close" size={14} opacity={0.68} /></button>
      </div>
      <div className="bot-settings__body" style={botVars(bot.avatarColor)}>
        <nav className="cfg-nav" aria-label={t('Bot settings sections')}>
          {tabs.map((tab) => (
            <button key={tab.id} type="button" className={`cfg-nav__item${target.tab === tab.id ? ' is-active' : ''}`} onClick={() => setTab(tab.id)} aria-current={target.tab === tab.id || undefined}>
              <span>{tab.label}</span>
              {tab.count ? <span className="cfg-nav__count">{tab.count}</span> : null}
            </button>
          ))}
        </nav>
        <div className="cfg-content">
          {loadError && <div className="cfg-error">{t('Couldn’t load settings: {error}', { error: loadError })}</div>}
          {target.tab === 'general' && <GeneralTab bot={bot} onClose={onClose} />}
          {target.tab === 'skills' && <SkillsTab bot={bot} skills={data?.skills} onChange={reload} />}
          {target.tab === 'memories' && <MemoriesTab bot={bot} data={data} onChange={reload} />}
          {target.tab === 'routines' && <RoutinesTab bot={bot} routines={routines ?? data?.routines} />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

type Draft = Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'effort' | 'mode'>;
const draftOf = (b: Bot): Draft => ({ name: b.name, label: b.label, description: b.description, instructions: b.instructions, avatarShape: b.avatarShape, avatarColor: b.avatarColor, effort: b.effort, mode: b.mode });

function GeneralTab({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(() => draftOf(bot));
  const [picker, setPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  useEffect(() => { setDraft(draftOf(bot)); }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const base = draftOf(bot);
  const changed = (Object.keys(draft) as (keyof Draft)[]).filter((k) => draft[k] !== base[k]);
  const dirty = changed.length > 0;
  const nameOk = draft.name.trim().length > 0;
  const put = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const flash = (text: string, tone: 'ok' | 'error' = 'ok') => { setNote({ text, tone }); setTimeout(() => setNote(null), 2400); };

  const save = async () => {
    if (!dirty || !nameOk) return;
    setSaving(true);
    try {
      const patch: Partial<Draft> = {};
      for (const k of changed) (patch as Record<string, unknown>)[k] = k === 'name' ? draft.name.trim() : draft[k];
      const { bot: next } = await configApi.updateBot(bot.id, patch);
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
      flash(t('Saved'));
    } catch (e) {
      flash((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cfg-page">
      <section className="cfg-section">
        <div className="cfg-look">
          <BotAvatar shape={draft.avatarShape} color={draft.avatarColor} size={72} />
          <div className="cfg-look__text">
            <div className="cfg-look__name">{draft.name || t('New Bot')}</div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPicker(!picker)} aria-expanded={picker}>
              {picker ? t('Done') : t('Change look')}
            </button>
          </div>
        </div>
        {picker && <LookPicker shape={draft.avatarShape} color={draft.avatarColor} onShape={(s) => put('avatarShape', s)} onColor={(c) => put('avatarColor', c)} />}
      </section>

      <section className="cfg-section cfg-grid">
        <Field label={t('Name')} htmlFor="cfg-name">
          <input id="cfg-name" className="text-input" value={draft.name} maxLength={60} onChange={(e) => put('name', e.target.value)} aria-invalid={!nameOk} />
        </Field>
        <Field label={t('Label')} htmlFor="cfg-label" hint={t('Shown next to the name, like “Research” or “Inbox”.')}>
          <input id="cfg-label" className="text-input" value={draft.label} maxLength={60} placeholder={t('Add a label')} onChange={(e) => put('label', e.target.value)} />
        </Field>
      </section>

      <section className="cfg-section">
        <Field label={t('About')} htmlFor="cfg-about">
          <textarea id="cfg-about" className="text-input cfg-textarea" rows={2} value={draft.description} maxLength={500} placeholder={t('What is this Bot for?')} onChange={(e) => put('description', e.target.value)} />
        </Field>
        <Field label={t('Instructions')} htmlFor="cfg-instructions" hint={draft.name ? t('Standing guidance {name} always follows, like tone, priorities or things to avoid. It also learns from chat, skills and memories.', { name: draft.name }) : t('Standing guidance this Bot always follows, like tone, priorities or things to avoid. It also learns from chat, skills and memories.')}>
          <textarea id="cfg-instructions" className="text-input cfg-textarea cfg-textarea--tall" rows={7} value={draft.instructions} maxLength={8000} placeholder={t('e.g. Keep updates to three bullets. Never email anyone outside the team without asking.')} onChange={(e) => put('instructions', e.target.value)} />
        </Field>
        <Field label={t('Thinking effort')} hint={t(EFFORT_HINT[draft.effort])}>
          <Segmented label={t('Thinking effort')} value={draft.effort} options={EFFORTS.map((o) => ({ value: o.value, label: t(o.label) }))} onChange={(v) => put('effort', v)} />
        </Field>
        <Field label={t('Used as')}>
          <Segmented label={t('Bot type')} value={draft.mode} options={[{ value: 'personal', label: t('Personal assistant') }, { value: 'teammate', label: t('Teammate') }]} onChange={(v) => put('mode', v)} />
        </Field>
      </section>

      <div className={`cfg-savebar${dirty ? ' is-dirty' : ''}`}>
        <span className={`cfg-savebar__note${note?.tone === 'error' ? ' is-error' : ''}`} role="status">{note?.text ?? (dirty ? t('Unsaved changes') : '')}</span>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!dirty || saving} onClick={() => setDraft(draftOf(bot))}>{t('Discard')}</button>
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={!dirty || saving || !nameOk} onClick={save}>{saving ? t('Saving…') : t('Save changes')}</button>
      </div>

      <section className="cfg-section">
        <div className="cfg-section__label">{t('Conversation')}</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{t('New conversation')}</div>
              <div className="cfg-row__sub">{t('Clears the chat. Memories, skills and routines stay.')}</div>
            </div>
            <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel={t('Start fresh')} onConfirm={async () => { await configApi.fresh(bot.id); flash(t('Started a new conversation')); }}>
              {t('Start new')}
            </ConfirmButton>
          </div>
          {!bot.isPrimary && (
            <div className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">{t('Make primary')}</div>
                <div className="cfg-row__sub">{t('Your go-to Bot. It reaches out first and keeps the others on track.')}</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.makePrimary(bot.id).then(() => flash(t('{name} is now your primary Bot', { name: bot.name }))).catch((e) => flash(e.message, 'error'))}>{t('Make primary')}</button>
            </div>
          )}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">{t('Danger zone')}</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{t('Delete {name}', { name: bot.name })}</div>
              <div className="cfg-row__sub">{bot.isPrimary ? t('Make another Bot primary first.') : t('Removes its chat, memories, skills and routines for good.')}</div>
            </div>
            <ConfirmButton
              disabled={bot.isPrimary}
              confirmLabel={t('Delete {name}', { name: bot.name })}
              onConfirm={async () => {
                try {
                  await configApi.deleteBot(bot.id);
                  onClose();
                  const st = useStore.getState();
                  st.set({ bots: st.bots.filter((b) => b.id !== bot.id) });
                  st.loadBots().catch(() => {});
                } catch (e) { flash((e as Error).message, 'error'); }
              }}
            >
              {t('Delete…')}
            </ConfirmButton>
          </div>
        </div>
      </section>
    </div>
  );
}

const SHAPE_ROWS = [PICKER_SHAPES.slice(0, 7), PICKER_SHAPES.slice(7)];

function LookPicker({ shape, color, onShape, onColor }: { shape: AvatarShape; color: AvatarColor; onShape: (s: AvatarShape) => void; onColor: (c: AvatarColor) => void }) {
  const t = useT();
  return (
    <div className="cfg-picker">
      <div className="shape-grid" role="radiogroup" aria-label={t('Character shape')}>
        {SHAPE_ROWS.map((row, i) => (
          <div key={i} className="shape-grid__row">
            {row.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={shape === s} aria-label={t(SHAPE_LABELS[s] ?? s)} className="shape-cell" onClick={() => onShape(s)}>
                <BotAvatar shape={s} color={color} size={34} ring={shape === s} />
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="swatches" role="radiogroup" aria-label={t('Character color')}>
        <div className="swatches__row">
          {COLOR_ORDER.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={t(COLOR_LABELS[c])} className="swatch-cell" onClick={() => onColor(c)}>
              <span className={`swatch${color === c ? ' is-selected' : ''}`} style={{ background: palette(c).fill }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SkillsTab({ bot, skills, onChange }: { bot: Bot; skills: Skill[] | undefined; onChange: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">{t('Skills')}</div>
          <div className="cfg-page__sub">{t('Step-by-step how-tos {name} follows for specific jobs. Ask for one by name in chat.', { name: bot.name })}</div>
        </div>
        {editing !== 'new' && <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setEditing('new')}><Icon name="plus" size={12} /> {t('New skill')}</button>}
      </div>
      {editing === 'new' && <SkillEditor botId={bot.id} onDone={() => { setEditing(null); onChange(); }} />}
      {!skills ? <div className="cfg-empty">{t('Loading…')}</div> : skills.length === 0 && editing !== 'new' ? (
        <div className="cfg-empty">
          {t('No skills yet. Write down how you like something done, like “Prep for a sales call”, and {name} will follow it every time.', { name: bot.name })}
        </div>
      ) : (
        <div className="cfg-list">
          {skills.map((s) => editing === s.id ? (
            <SkillEditor key={s.id} botId={bot.id} skill={s} onDone={() => { setEditing(null); onChange(); }} />
          ) : (
            <div key={s.id} className="cfg-item">
              <span className="cfg-item__icon"><Glyph name="spark" size={14} /></span>
              <div className="cfg-item__text">
                <div className="cfg-item__title">{s.name}</div>
                <div className="cfg-item__sub">{s.description || s.body.split('\n')[0]}</div>
              </div>
              <div className="cfg-item__actions">
                <button type="button" className="cfg-icon-btn" onClick={() => setEditing(s.id)} aria-label={t('Edit {name}', { name: s.name })} title={t('Edit')}><Icon name="edit" size={14} /></button>
                <ConfirmButton className="cfg-icon-btn" title={t('Delete')} onConfirm={async () => { await configApi.deleteSkill(s.id); onChange(); }}><Glyph name="trash" size={14} /></ConfirmButton>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillEditor({ botId, skill, onDone }: { botId: string; skill?: Skill; onDone: () => void }) {
  const t = useT();
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = name.trim() && body.trim() && !busy;
  const save = async () => {
    if (!can) return;
    setBusy(true); setError(null);
    try {
      if (skill) await configApi.updateSkill(skill.id, { name, description, body });
      else await configApi.createSkill(botId, { name, description, body });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <form className="cfg-editor" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <input className="text-input" placeholder={t('Skill name, e.g. Weekly report')} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus aria-label={t('Skill name')} />
      <input className="text-input" placeholder={t('When to use it (optional)')} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} aria-label={t('Skill description')} />
      <textarea className="text-input cfg-textarea cfg-textarea--tall" rows={8} placeholder={t('Write the steps to follow:\n1. …\n2. …')} value={body} onChange={(e) => setBody(e.target.value)} aria-label={t('Skill steps')} />
      {error && <div className="cfg-error">{error}</div>}
      <div className="cfg-editor__actions">
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onDone}>{t('Cancel')}</button>
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!can}>{busy ? t('Saving…') : skill ? t('Save skill') : t('Add skill')}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

function MemoriesTab({ bot, data, onChange }: { bot: Bot; data: BotSettingsBundle | null; onChange: () => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const memories = useMemo(() => (data?.memories ?? []).filter((m) => !hidden.has(m.id) && (!q || m.text.toLowerCase().includes(q.toLowerCase()))), [data, hidden, q]);
  const remove = async (m: Memory) => {
    setHidden((h) => new Set(h).add(m.id));
    try { await configApi.deleteMemory(m.id); onChange(); } catch { setHidden((h) => { const n = new Set(h); n.delete(m.id); return n; }); }
  };
  // How full the agent's context is, against the point where it summarizes. No gauge before the Bot's first turn.
  const measured = !!data && data.memory.compactAtTokens > 0 && data.memory.usedTokens > 0;
  const fill = measured ? Math.min(100, Math.max(0, Math.round((data.memory.usedTokens / data.memory.compactAtTokens) * 100))) : 0;
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">{t('Memories')}</div>
          <div className="cfg-page__sub">{t('What {name} remembers about you. It saves things when you share them, and picks up more on its own once a chat goes quiet.', { name: bot.name })}</div>
        </div>
      </div>
      {(data?.memories.length ?? 0) > 6 && (
        <input className="text-input" placeholder={t('Search memories')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search memories')} />
      )}
      {!data ? <div className="cfg-empty">{t('Loading…')}</div> : memories.length === 0 ? (
        <div className="cfg-empty">{q ? t('No memories match.') : t('Nothing yet. Tell {name} about yourself, or just chat. It’ll pick things up.', { name: bot.name })}</div>
      ) : (
        <div className="cfg-list">
          {memories.map((m) => (
            <div key={m.id} className="cfg-item">
              <div className="cfg-item__text">
                <div className="cfg-item__body">{m.text}</div>
                <div className="cfg-item__meta">
                  {m.source === 'learned' ? <span className="cfg-chip">{t('Picked up')}</span> : <span className="cfg-chip cfg-chip--muted">{t('Saved in chat')}</span>}
                  <span>{shortDate(m.createdAt)}</span>
                </div>
              </div>
              <div className="cfg-item__actions">
                <button type="button" className="cfg-icon-btn" onClick={() => remove(m)} aria-label={t('Forget this')} title={t('Forget')}><Glyph name="trash" size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {data && (
        <div className="cfg-meter" title={t('Older messages are summarized automatically when this fills up.')}>
          <div className="cfg-meter__label"><span>{t('Conversation memory')}</span>{measured && <span>{t('{n}% full', { n: fill })}</span>}</div>
          {measured && <div className="cfg-meter__track"><span style={{ width: `${Math.max(2, fill)}%` }} /></div>}
          <div className="cfg-field__hint">
            {t('When it fills up, older messages get summarized so {name} can keep going.', { name: bot.name })}
            {data.memory.lastCompaction ? ` ${t('Last summarized {date}.', { date: shortDate(data.memory.lastCompaction.created_at) })}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RoutinesTab({ bot, routines }: { bot: Bot; routines: Routine[] | undefined }) {
  const t = useT();
  const [flash, setFlash] = useState<string | null>(null);
  const say = (text: string) => { setFlash(text); setTimeout(() => setFlash(null), 2200); };
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">{t('Routines')}</div>
          <div className="cfg-page__sub">{t('Recurring jobs {name} runs on a schedule. To add or change one, ask in chat.', { name: bot.name })}</div>
        </div>
        {flash && <span className="cfg-savebar__note" role="status">{flash}</span>}
      </div>
      {!routines ? <div className="cfg-empty">{t('Loading…')}</div> : routines.length === 0 ? (
        <div className="cfg-empty">{t('No routines yet. Try asking {name}: “every Friday at 4pm, recap my week”.', { name: bot.name })}</div>
      ) : (
        <div className="cfg-list">
          {routines.map((r) => <RoutineItem key={r.id} r={r} onFlash={say} />)}
        </div>
      )}
    </div>
  );
}

function RoutineItem({ r, onFlash }: { r: Routine; onFlash: (text: string) => void }) {
  const t = useT();
  const [enabled, setEnabled] = useState(r.enabled);
  useEffect(() => setEnabled(r.enabled), [r.enabled]);
  const toggle = async (v: boolean) => {
    setEnabled(v);
    try { await configApi.setRoutine(r.id, v); onFlash(v ? t('Resumed') : t('Paused')); } catch { setEnabled(!v); }
  };
  return (
    <div className="cfg-item cfg-item--routine">
      <span className="cfg-item__icon"><Icon name="clock" size={14} /></span>
      <div className="cfg-item__text">
        <div className="cfg-item__title">{r.name}</div>
        <div className="cfg-item__sub">{enabled ? [scheduleLabel(r.schedule) ?? (r.description || r.schedule), nextRunLabel(r.nextRunAt, r.timezone)].filter(Boolean).join(' · ') : t('Paused')}</div>
        <div className="cfg-item__prompt">{r.prompt}</div>
      </div>
      <div className="cfg-item__actions">
        <button type="button" className="cfg-icon-btn" title={t('Run now')} aria-label={t('Run {name} now', { name: r.name })} onClick={() => configApi.runRoutine(r.id).then(() => onFlash(t('Running now'))).catch((e) => onFlash(e.message))}>
          <Glyph name="play" size={13} />
        </button>
        <ConfirmButton className="cfg-icon-btn" title={t('Delete')} onConfirm={() => configApi.deleteRoutine(r.id).then(() => onFlash(t('Deleted')))}><Glyph name="trash" size={14} /></ConfirmButton>
        <Switch on={enabled} onChange={toggle} label={enabled ? t('{name} on', { name: r.name }) : t('{name} paused', { name: r.name })} />
      </div>
    </div>
  );
}
