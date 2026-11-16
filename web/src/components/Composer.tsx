import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Attachment, Bot } from '@shared/types';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { useDictation } from '../voice/dictation';
import { useT } from '../i18n';
import { fileSize } from '../lib/files';

const MAX_H = 200;
const drafts = new Map<string, string>();
const MAX_FILES = 10;
const MAX_BYTES = 500 * 1024 * 1024;

/** A file picked for the next message: on its way to the bot's computer, there, or refused. */
interface Pending { id: number; botId: string; name: string; size: number; state: 'uploading' | 'ready' | 'failed'; attachment?: Attachment; abort: AbortController }
let nextPending = 0;

export function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  const t = useT();
  const [text, setText] = useState(() => drafts.get(bot.id) ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const mine = files.filter((f) => f.botId === bot.id);
  const ready = mine.filter((f) => f.state === 'ready');
  const uploading = mine.some((f) => f.state === 'uploading');

  const addFiles = (list: FileList | File[] | null | undefined) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    const room = MAX_FILES - mine.length;
    if (picked.length > room) setError(t('You can add up to {n} files to a message.', { n: MAX_FILES }));
    for (const file of picked.slice(0, Math.max(0, room))) {
      if (file.size > MAX_BYTES) { setError(t('{name} is too big (the limit is 500 MB).', { name: file.name })); continue; }
      const p: Pending = { id: ++nextPending, botId: bot.id, name: file.name || 'file', size: file.size, state: 'uploading', abort: new AbortController() };
      setFiles((cur) => [...cur, p]);
      api.attach(bot.id, file, p.abort.signal).then(
        (attachment) => setFiles((cur) => cur.map((f) => (f.id === p.id ? { ...f, state: 'ready', attachment, name: attachment.name } : f))),
        (e) => {
          if (p.abort.signal.aborted) return;
          setFiles((cur) => cur.map((f) => (f.id === p.id ? { ...f, state: 'failed' } : f)));
          setError(`${p.name}: ${(e as Error).message || t('The file could not be added')}`);
        },
      );
    }
  };
  const removeFile = (p: Pending) => { p.abort.abort(); setFiles((cur) => cur.filter((f) => f.id !== p.id)); };
  const setModal = useStore((s) => s.setModal);

  // Per-bot drafts.
  useEffect(() => { setText(drafts.get(bot.id) ?? ''); setError(null); ref.current?.focus(); }, [bot.id]);
  useEffect(() => { drafts.set(bot.id, text); }, [bot.id, text]);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
  }, [text]);

  // Ctrl+I (Command+I on a Mac) focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const send = async () => {
    const msg = text.trim();
    if ((!msg && !ready.length) || sending || uploading) return;
    setSending(true); setError(null);
    try {
      await api.send(bot.id, msg, ready.map((f) => f.attachment!));
      setFiles((cur) => cur.filter((f) => f.botId !== bot.id));
      setText('');
      drafts.delete(bot.id);
    } catch (e) {
      setError((e as Error).message || t('Message failed to send'));
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const stop = () => api.interrupt(bot.id).catch((e) => setError(e.message));
  const fresh = () => api.fresh(bot.id).catch((e) => setError(e.message));

  // Dictation: insert the transcript at the cursor.
  const insertText = (said: string) => {
    const el = ref.current;
    setText((cur) => {
      const start = el && document.activeElement === el ? el.selectionStart : cur.length;
      const end = el && document.activeElement === el ? el.selectionEnd : cur.length;
      const before = cur.slice(0, start);
      const after = cur.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && !/^\s/.test(after) ? ' ' : '';
      requestAnimationFrame(() => { if (el) { const pos = before.length + pre.length + said.length; el.focus(); el.setSelectionRange(pos, pos); } });
      return before + pre + said + post + after;
    });
  };
  const dictation = useDictation(insertText, setError, bot.voiceLanguage);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  const hasText = text.trim().length > 0 || ready.length > 0 || uploading;
  const multiline = text.includes('\n') || (ref.current?.scrollHeight ?? 0) > 30;

  return (
    <div className="composer-area">
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>{t('Dismiss')}</button></div>}
      <div
        className={`composer${multiline ? ' is-multiline' : ''}${mine.length ? ' has-files' : ''}${dragging ? ' is-dragging' : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } setDragging(false); }}
      >
        <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; ref.current?.focus(); }} />
        {mine.length > 0 && (
          <ul className="composer__files">
            {mine.map((f) => (
              <li key={f.id} className={`file-chip is-${f.state}`} title={f.name}>
                <Icon name="file" size={14} opacity={0.56} />
                <span className="file-chip__name">{f.name}</span>
                <span className="file-chip__meta">{f.state === 'uploading' ? t('Adding…') : f.state === 'failed' ? t('Not added') : fileSize(f.size)}</span>
                <button type="button" className="file-chip__x" onClick={() => removeFile(f)} aria-label={t('Remove {name}', { name: f.name })}>
                  <Icon name="close" size={10} opacity={0.72} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer__left">
          <span className="composer__plus-anchor">
            <button type="button" className="composer__btn" onClick={() => setMenu(!menu)} aria-label={t('More actions')} aria-expanded={menu}>
              <Icon name="composer_plus" opacity={0.56} />
            </button>
            {menu && (
              <Menu
                placement="above"
                onClose={() => setMenu(false)}
                items={[
                  { label: t('Add photos and files'), onSelect: () => picker.current?.click() },
                  { label: t('New conversation'), onSelect: fresh },
                  { label: t('Connect apps'), onSelect: () => setModal('apps') },
                ]}
              />
            )}
          </span>
          <textarea
            ref={ref}
            className="composer__input"
            rows={1}
            value={text}
            placeholder={t('Message {name}', { name: displayName(bot) })}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            aria-label={t('Message {name}', { name: bot.name })}
          />
        </div>
        <div className="composer__right">
          <button
            type="button"
            className={`composer__btn${dictation.state === 'recording' ? ' is-recording' : dictation.state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={dictation.state === 'recording' ? t('Stop dictation') : t('Dictate')}
            aria-pressed={dictation.state === 'recording'}
            title={dictation.state === 'recording' ? t('Release or click to stop · Esc cancels') : dictation.state === 'transcribing' ? t('Transcribing…') : t('Hold to dictate, or click to start')}
            disabled={dictation.state === 'transcribing'}
            onPointerDown={dictation.onPointerDown}
            onPointerUp={dictation.onPointerUp}
            onKeyDown={dictation.onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Icon name="mic" opacity={0.56} />
          </button>
          {inCall && !hasText ? (
            <button type="button" className="composer__cta is-in-call" onClick={endCall} aria-label={t('End voice call')} title={t('End voice call')}>
              <Icon name="voice_a" size={16} />
            </button>
          ) : running && !hasText ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label={t('Stop')} title={t('Stop')}>
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="composer__cta"
              onClick={hasText ? send : () => startCall(bot.id)}
              disabled={hasText && (sending || uploading)}
              aria-label={hasText ? t('Send') : t('Start voice chat with {name}', { name: bot.name })}
              title={hasText ? t('Send (Enter)') : t('Start voice chat')}
            >
              <Icon name={hasText ? 'arrow_up' : 'voice_a'} size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
