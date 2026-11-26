import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type RFBType from '@novnc/novnc';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { computerStatusText, screenSize, screensFull } from '../lib/computer';
import { configApi } from '../lib/configApi';
import { useT } from '../i18n';
import { useSelectedBot, useStore } from '../store';
import { Icon } from './Icon';
import { TouchDrive, focusKeys } from './TouchDrive';

export type ScreenMode = 'watch' | 'control';
type Conn = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
/** Picture mode: the pause between two pictures once one has arrived. */
const PICTURE_EVERY_MS = 700;

/** True on touch-first devices (phones, tablets), where the screen is watched through pictures. */
function usePictureMode(): boolean {
  const [on] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);
  return on;
}

/** How long "waking" may last before it is reported as a failure instead of a spinner. */
const WAKING_TIMEOUT_MS = 15_000;

type Phase = 'live' | 'switching' | 'waking' | 'asleep' | 'idle' | 'paused' | 'error';

interface ScreenProps {
  bot: Bot;
  /** 'panel' is the small live view in the details panel; 'stage' is the large view. */
  variant: 'panel' | 'stage';
  initialMode?: ScreenMode;
  /** Replaces "You're driving" under the frame, e.g. a sign-in the person has to finish. */
  hint?: string | null;
  /** Stop streaming and show a placeholder (the large view has this screen). */
  paused?: boolean;
  /** Panel only: the person asked for the large view, in this mode. */
  onExpand?: (mode: ScreenMode) => void;
  onModeChange?: (mode: ScreenMode) => void;
}

/**
 * A bot's screen on the shared computer: noVNC over our relay inside a rounded frame that keeps the
 * screen's aspect ratio. Watching is view-only. Taking control reconnects with mode=control and shows
 * a chin under the frame with the way back.
 */
export function ComputerScreen({ bot, variant, initialMode = 'watch', hint, paused = false, onExpand, onModeChange }: ScreenProps) {
  const t = useT();
  const computer = useStore((s) => s.computer);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFBType | null>(null);
  const hadFrame = useRef(false);
  const autoWoke = useRef(false);

  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const [conn, setConn] = useState<Conn>('idle');
  const [attempt, setAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [opened, setOpened] = useState(variant === 'stage');
  const [waking, setWaking] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const [resetAsk, setResetAsk] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The last connection failure, so a screen that never shows a picture says why instead of spinning.
  const [lastFailure, setLastFailure] = useState<string | null>(null);
  const [wakingSince, setWakingSince] = useState<number | null>(null);

  const status = computer?.status;
  const running = status === 'running';
  const busy = status === 'creating' || status === 'starting' || status === 'resuming';
  const hasScreen = !!computer?.screens.some((s) => s.botId === bot.id);
  const { width, height } = screenSize(computer, bot.id, bot.isPrimary);
  const driving = mode === 'control';
  const large = variant === 'stage' || fullscreen;
  // The small panel view only streams a screen that already exists, so browsing bots never uses up screens.
  const wantLive = running && !paused && (variant === 'stage' || visible) && (opened || hasScreen);
  // Phones and tablets watch through pictures: the live stream reaches them but their browser drops
  // it within a second, while plain HTTP works everywhere the rest of the app does.
  const pictures = usePictureMode();
  const [shot, setShot] = useState(0);
  const keysRef = useRef<HTMLTextAreaElement>(null);

  const wake = useCallback(() => {
    setWaking(true); setWakeError(null);
    api.ensureComputer()
      .then(() => useStore.getState().loadComputer())
      .catch((e: Error) => setWakeError(e.message || t('The computer did not start.')))
      .finally(() => setWaking(false));
  }, [t]);

  // Opening the large view is a request to see the computer, so wake it without another click.
  useEffect(() => {
    if (variant !== 'stage' || autoWoke.current || !computer) return;
    if (status === 'suspended' || status === 'stopped' || status === 'absent') { autoWoke.current = true; wake(); }
  }, [variant, computer, status, wake]);

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => {
    const on = () => setFullscreen(!!frameRef.current && document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  useEffect(() => {
    // Leaving the live path (tab hidden, panel not opened, computer not running) must not look like a
    // failure: a re-created effect used to reset the failure and the 15 s timer turned that into an
    // error, even though the picture had been streaming.
    setLastFailure(null);
    setWakingSince(null);
    if (!wantLive || !canvasRef.current) { setConn('idle'); return; }
    if (pictures) { setConn('connecting'); return; }
    hadFrame.current = false;
    setLastFailure(null);
    let disposed = false;
    let rfb: RFBType | null = null;
    setConn('connecting');
    (async () => {
      const { default: RFB } = await import('@novnc/novnc');
      if (disposed || !canvasRef.current) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/api/bots/${bot.id}/screen?mode=${mode}`;
      rfb = new RFB(canvasRef.current, url, { shared: true });
      rfb.viewOnly = mode === 'watch';
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      // Sharp text and little compression work on a fast link. A phone over a tailnet gets the same
      // picture with far fewer bytes: the first full frame is what stalls there, so it is made cheap
      // and the link decides the rest.
      const small = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
      rfb.qualityLevel = small ? 4 : 8;
      rfb.compressionLevel = small ? 6 : 1;
      rfb.background = 'transparent';
      rfb.focusOnClick = mode === 'control';
      rfb.addEventListener('connect', () => { if (!disposed) { hadFrame.current = true; setConn('connected'); if (mode === 'control') rfb?.focus(); } });
      rfb.addEventListener('disconnect', (e) => {
        if (disposed) return;
        const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
        if (!clean) setLastFailure(t('The screen closed the connection before the first frame.'));
        setConn(clean ? 'disconnected' : 'error');
      });
      rfb.addEventListener('securityfailure', () => { if (!disposed) { setLastFailure(t('The screen refused the session.')); setConn('error'); } });
      rfbRef.current = rfb;
    })().catch(() => { if (!disposed) { setLastFailure(t('The screen viewer could not start.')); setConn('error'); } });
    const el = canvasRef.current;
    return () => {
      disposed = true;
      try { rfb?.disconnect(); } catch { /* already closed */ }
      rfbRef.current = null;
      el.innerHTML = '';
    };
  }, [bot.id, wantLive, mode, attempt, pictures]);

  // Picture mode: the next picture is asked for only once the previous one has arrived (or failed), so
  // a slow link finishes each picture instead of restarting it; nothing is asked while the tab is hidden.
  const nextShot = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleShot = useCallback((ms: number) => {
    if (nextShot.current) clearTimeout(nextShot.current);
    nextShot.current = setTimeout(() => {
      nextShot.current = null;
      if (document.visibilityState === 'visible') setShot((n) => n + 1);
    }, ms);
  }, []);
  useEffect(() => () => { if (nextShot.current) clearTimeout(nextShot.current); }, []);
  // After a tap or a keystroke the next picture is wanted now, not in 0.7 s.
  const afterInput = useCallback(() => scheduleShot(120), [scheduleShot]);
  const inputFailed = useCallback((m: string) => setNote(m || t('The screen did not take that.')), [t]);
  useEffect(() => { if (pictures && visible && wantLive) scheduleShot(0); }, [pictures, visible, wantLive, attempt, scheduleShot]);

  useEffect(() => { onModeChange?.(mode); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handBack = useCallback(() => {
    setMode('watch');
    // The bot carries on either way; this only tells it sooner.
    configApi.handback(bot.id).catch(() => {});
  }, [bot.id]);

  // The panel view is too small to drive: control there only exists in full screen, and ends with it.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (variant === 'panel' && !fullscreen && modeRef.current === 'control') handBack();
  }, [variant, fullscreen, handBack]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(timer);
  }, [note]);
  useEffect(() => {
    if (!resetAsk) return;
    const timer = setTimeout(() => setResetAsk(false), 6000);
    return () => clearTimeout(timer);
  }, [resetAsk]);

  let phase: Phase;
  if (paused) phase = 'paused';
  else if (status === 'error' || wakeError) phase = 'error';
  else if (!running) phase = busy || waking ? 'waking' : 'asleep';
  else if (!opened && !hasScreen) phase = 'idle';
  else if (conn === 'error' || conn === 'disconnected') phase = 'error';
  else if (conn === 'connected') phase = 'live';
  else phase = hadFrame.current ? 'switching' : 'waking';

  // "Waking" is a wait, not a state: when nothing has come through after a while, say so. The wait is
  // timed from one attempt, not restarted by every re-render the store can trigger.
  useEffect(() => {
    if (phase !== 'waking') { setWakingSince(null); return; }
    if (wakingSince == null) { setWakingSince(Date.now()); return; }
    const left = WAKING_TIMEOUT_MS - (Date.now() - wakingSince);
    const id = setTimeout(() => {
      setLastFailure(t('No picture came through. Check that this device can reach the server, then retry.'));
      setConn('error');
    }, Math.max(0, left));
    return () => clearTimeout(id);
  }, [phase, attempt, mode, wakingSince]); // eslint-disable-line react-hooks/exhaustive-deps

  const takeControl = () => {
    if (variant === 'panel' && !fullscreen) onExpand?.('control');
    else setMode('control');
  };
  const retry = () => {
    setWakeError(null);
    if (running) setAttempt((n) => n + 1);
    else wake();
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else frameRef.current?.requestFullscreen().catch(() => setNote(t('Full screen isn’t available here.')));
  };
  const reset = async () => {
    setResetting(true);
    try { await configApi.resetScreen(bot.id); setAttempt((n) => n + 1); }
    catch { setNote(t('Couldn’t reset the screen.')); }
    finally { setResetting(false); setResetAsk(false); }
  };

  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  const expandable = variant === 'panel' && !fullscreen && phase === 'live';
  const mascot = large ? 64 : 40;
  const style = { ...botVars(bot.avatarColor), ['--screen-ratio' as string]: String(width / height) } as CSSProperties;

  return (
    <div
      ref={frameRef}
      className={`screen screen--${variant} is-${phase}${driving ? ' is-driving' : ''}${fullscreen ? ' is-fullscreen' : ''}`}
      style={style}
    >
      <div className="screen__body">
        <div className="screen__view" style={{ aspectRatio: `${width} / ${height}` }}>
          <div ref={canvasRef} className="screen__canvas" />
          {pictures && wantLive && (
            <img
              className="screen__picture"
              alt={t('{name}’s screen', { name: bot.name })}
              src={`/api/bots/${bot.id}/screenshot?n=${shot}`}
              onLoad={() => { hadFrame.current = true; setLastFailure(null); setConn('connected'); scheduleShot(PICTURE_EVERY_MS); }}
              onError={() => scheduleShot(PICTURE_EVERY_MS * 2)}
              draggable={false}
            />
          )}
          {pictures && wantLive && driving && conn === 'connected' && (
            <TouchDrive botId={bot.id} keysRef={keysRef} onSent={afterInput} onError={inputFailed} />
          )}
          {/* noVNC swallows clicks on its canvas, so the way into the large view is a button laid over it. */}
          {expandable && <button type="button" className="screen__expand" onClick={() => onExpand?.('watch')} aria-label={t('Open {name}’s computer in the large view', { name: bot.name })} title={t('Open the large view')} />}

          {phase === 'live' && !driving && (
            <span className="screen__badge" aria-hidden>
              <BotAvatarFor bot={bot} size={16} />
              <span>{t('Live')}</span>
              <i className="screen__live-dot" />
            </span>
          )}

          {phase === 'waking' && (
            <div className="screen__state is-waking" role="status">
              <span className="screen__sweep" aria-hidden />
              <span className="screen__mascot is-bobbing"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__label">{t('Waking {name}’s computer…', { name: bot.name })}</span>
            </div>
          )}
          {phase === 'switching' && (
            <div className="screen__state" role="status">
              <span className="screen__text">{t('One moment…')}</span>
            </div>
          )}
          {phase === 'asleep' && (
            <div className="screen__state">
              <span className="screen__mascot is-asleep"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__text">{status === 'suspending' ? t('Going to sleep…') : t('{name}’s computer is asleep', { name: bot.name })}</span>
              {status !== 'suspending' && <button type="button" className="screen__action" onClick={wake}>{t('Wake it up')}</button>}
            </div>
          )}
          {phase === 'idle' && (
            <div className="screen__state">
              <span className="screen__mascot"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__text">{t('{name} hasn’t opened a screen yet', { name: bot.name })}</span>
              {screensFull(computer, bot.id)
                ? <span className="screen__sub">{t('All {n} screens are in use. Reset one in Settings to free it.', { n: computer?.maxScreens ?? 0 })}</span>
                : <button type="button" className="screen__action" onClick={() => setOpened(true)}>{t('Open its screen')}</button>}
            </div>
          )}
          {phase === 'paused' && (
            <div className="screen__state">
              <span className="screen__text">{t('Open in the large view')}</span>
            </div>
          )}
          {phase === 'error' && (
            <div className="screen__state" role="alert">
              <span className="screen__text">
                {!running ? t('Couldn’t wake {name}’s computer', { name: bot.name }) : conn === 'disconnected' ? t('The screen disconnected') : t('Couldn’t reach {name}’s screen', { name: bot.name })}
              </span>
              {(wakeError || (status === 'error' && computer?.error) || lastFailure) && <span className="screen__sub">{wakeError ?? (status === 'error' ? computer?.error : null) ?? lastFailure}</span>}
              {running && screensFull(computer, bot.id) && <span className="screen__sub">{t('All {n} screens are in use. Reset one in Settings to free it.', { n: computer?.maxScreens ?? 0 })}</span>}
              <button type="button" className="screen__action" onClick={retry}>{t('Retry')}</button>
            </div>
          )}

          {phase === 'live' && !driving && (
            <div className={`screen__pill${resetAsk || note ? ' is-pinned' : ''}`} role="toolbar" aria-label={t('Screen controls')}>
              {note ? <span className="screen__pill-text" role="status">{note}</span> : resetAsk ? (
                <>
                  <span className="screen__pill-text">{t('Close all windows?')}</span>
                  <button type="button" className="screen__pill-btn is-danger" onClick={reset} disabled={resetting}>{resetting ? t('Resetting…') : t('Reset')}</button>
                  <button type="button" className="screen__pill-btn" onClick={() => setResetAsk(false)} disabled={resetting}>{t('Cancel')}</button>
                </>
              ) : (
                <>
                  <div className="screen__seg" role="group" aria-label={t('Who is using the screen')}>
                    <button type="button" className="screen__seg-btn is-active" aria-pressed="true">{large && <Icon name="eye" size={14} />}{t('Watch')}</button>
                    <button type="button" className="screen__seg-btn" aria-pressed="false" onClick={takeControl}>{large && <Icon name="pointer" size={14} />}{t('Take control')}</button>
                  </div>
                  <span className="screen__pill-rule" aria-hidden />
                  {canFullscreen && (
                    <button type="button" className="screen__pill-icon" onClick={toggleFullscreen} aria-label={fullscreen ? t('Leave full screen') : t('Full screen')} title={fullscreen ? t('Leave full screen') : t('Full screen')}>
                      <Icon name={fullscreen ? 'shrink' : 'expand'} size={15} />
                    </button>
                  )}
                  <button type="button" className="screen__pill-icon" onClick={() => setResetAsk(true)} aria-label={t('Reset screen')} title={t('Reset: close everything on this screen')}>
                    <Icon name="refresh" size={15} />
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {driving && (
          <div className="screen__chin">
            <span className="screen__chin-text" role="status">
              <i className="screen__ping" aria-hidden />
              <span>{note || hint || t('You’re driving')}</span>
            </span>
            <span className="screen__chin-actions">
              {pictures && (
                <button type="button" className="screen__chin-icon" onClick={() => focusKeys(keysRef.current)} aria-label={t('Keyboard')} title={t('Keyboard')}>
                  <Icon name="edit" size={15} />
                </button>
              )}
              {canFullscreen && (
                <button type="button" className="screen__chin-icon" onClick={toggleFullscreen} aria-label={fullscreen ? t('Leave full screen') : t('Full screen')} title={fullscreen ? t('Leave full screen') : t('Full screen')}>
                  <Icon name={fullscreen ? 'shrink' : 'expand'} size={15} />
                </button>
              )}
              <button type="button" className="screen__handback" onClick={handBack}>
                <BotAvatarFor bot={bot} size={18} />
                <span>{t('Hand back to {name}', { name: bot.name })}</span>
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** The large computer view: the bot's screen on a dimmed stage, opened from the chat menu or the details panel. */
export function ComputerViewer() {
  const t = useT();
  const bot = useSelectedBot();
  const computer = useStore((s) => s.computer);
  const initialMode = useStore((s) => s.viewerMode);
  const hint = useStore((s) => s.viewerHint);
  const set = useStore((s) => s.set);
  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const botId = bot?.id;

  const close = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (mode === 'control' && botId) configApi.handback(botId).catch(() => {});
    set({ viewerOpen: false, viewerMode: 'watch', viewerHint: null });
  }, [mode, botId, set]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // While driving, Escape belongs to the remote desktop. In full screen the browser uses it to leave.
      if (e.key === 'Escape' && mode === 'watch' && !document.fullscreenElement) { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [mode, close]);

  const onModeChange = useCallback((m: ScreenMode) => {
    setMode(m);
    // A hint belongs to one stretch of driving; it goes once the person hands back.
    set(m === 'watch' ? { viewerMode: m, viewerHint: null } : { viewerMode: m });
  }, [set]);

  if (!bot) return null;

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={t('{name}’s computer', { name: bot.name })} style={botVars(bot.avatarColor)}>
      <div className="viewer__scrim" onClick={mode === 'watch' ? close : undefined} />
      <div className="viewer__top">
        <div className="viewer__title">
          <BotAvatarFor bot={bot} size={24} />
          <span>{t('{name}’s computer', { name: bot.name })}</span>
          <span className="viewer__status">{computerStatusText(computer)}</span>
        </div>
        <button type="button" className="viewer__close" onClick={close} aria-label={t('Close computer')}><Icon name="close" color="#FFFFFF" /></button>
      </div>
      <div className="viewer__stage">
        <ComputerScreen key={bot.id} bot={bot} variant="stage" initialMode={initialMode} hint={hint} onModeChange={onModeChange} />
      </div>
    </div>
  );
}
