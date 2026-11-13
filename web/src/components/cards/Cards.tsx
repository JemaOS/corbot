import { useEffect, useState } from 'react';
import { serverText } from '../../lib/phrases';
import type { CardBody, Row } from '@shared/types';
import { api, openPopup } from '../../lib/api';
import { tx, useT } from '../../i18n';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';

type Card<K extends CardBody['card']> = Extract<CardBody, { card: K }>;

function useBusy() {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message || t('Something went wrong')); } finally { setBusy(null); }
  };
  return { busy, error, run };
}

const prettyTool = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const KNOWN: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', hubspot: 'HubSpot', linkedin: 'LinkedIn', youtube: 'YouTube', clickup: 'ClickUp', googledocs: 'Google Docs', googledrive: 'Google Drive', googlesheets: 'Google Sheets', googlecalendar: 'Google Calendar', googletasks: 'Google Tasks', googlemeet: 'Google Meet' };
/** "googlecalendar" → "Google Calendar", "slack" → "Slack". */
export const humanizeToolkit = (slug: string) => KNOWN[slug.toLowerCase()] ?? slug.replace(/^(google|microsoft)(?=\w)/i, '$1 ').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ---------------- approval ----------------

const APPROVAL_OUTCOME: Record<string, string> = { allowed: tx('Allowed once'), always: tx('Always allowed'), denied: tx('Not allowed'), expired: tx('Expired') };

export function ApprovalCard({ body }: { body: Card<'approval'> }) {
  const t = useT();
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const decide = (d: 'allow' | 'always' | 'deny') => run(d, () => api.approve(body.approvalId, d));
  const name = body.toolkit ? humanizeToolkit(body.toolkit) : prettyTool(body.tool);
  return (
    <div className={`card approval-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name={name} logo={body.toolkit ? `https://logos.composio.dev/api/${body.toolkit.toLowerCase()}` : undefined} size={44} />
        <div className="card__titles">
          <div className="card__title">{serverText(body.title)}</div>
          <div className="card__sub">{name}</div>
        </div>
      </div>
      {body.detail && <div className="card__body">{body.detail}</div>}
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('deny')}>{t("Don't allow")}</button>
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('always')}>{t('Always allow')}</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => decide('allow')}>{t('Allow')}</button>
          </div>
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'denied' || body.status === 'expired' ? 'close' : 'check'} size={12} opacity={0.7} />
          {APPROVAL_OUTCOME[body.status] ? t(APPROVAL_OUTCOME[body.status]) : body.status}
        </div>
      )}
    </div>
  );
}

// ---------------- question ----------------

export function QuestionCard({ row, body }: { row: Row; body: Card<'question'> }) {
  const t = useT();
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return (
    <div className={`card question-card${pending ? '' : ' is-resolved'}`}>
      <div className="question-card__head">
        <div className="question-card__q">{body.question}</div>
        <div className="question-card__hint">{pending ? t('Pick an option or reply in your own words') : body.status === 'dismissed' ? t('Skipped') : t('Answered')}</div>
      </div>
      <div className="question-card__options">
        {body.options.map((opt, i) => {
          const chosen = body.answer === opt;
          return (
            <button
              key={i}
              type="button"
              className={`question-option${chosen ? ' is-chosen' : ''}`}
              disabled={!pending || !!busy}
              onClick={() => run(String(i), () => api.answer(row.botId, row.seq, opt))}
            >
              <span className="question-option__key">{letters[i] ?? i + 1}</span>
              <span className="question-option__label">{opt}</span>
              {chosen && <Icon name="check" size={12} opacity={0.6} style={{ marginLeft: 'auto', marginTop: 6 }} />}
            </button>
          );
        })}
      </div>
      {pending && (
        <div className="question-card__foot">
          <button type="button" className="link-btn" disabled={!!busy} onClick={() => run('dismiss', () => api.dismiss(row.botId, row.seq))}>{t('Skip')}</button>
        </div>
      )}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}

// ---------------- connect ----------------

export function ConnectCard({ row, body }: { row: Row; body: Card<'connect'> }) {
  const t = useT();
  const { busy, error, run } = useBusy();
  const [waiting, setWaiting] = useState(false);
  const connectionsVersion = useStore((s) => s.connectionsVersion);
  const pending = body.status === 'pending';

  // Leave the "waiting" state once the server reports a connection change or the card resolves.
  useEffect(() => { setWaiting(false); }, [connectionsVersion, body.status]);

  const connect = () => run('connect', async () => {
    const popup = openPopup('about:blank');
    try {
      const { redirectUrl } = await api.connect(body.toolkit, row.botId, row.seq);
      if (popup) popup.location.href = redirectUrl; else window.open(redirectUrl, '_blank');
      setWaiting(true);
    } catch (e) { popup?.close(); throw e; }
  });

  return (
    <div className={`card connect-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name={body.toolkitName} logo={body.logo} size={44} />
        <div className="card__titles">
          <div className="card__title">{t('Connect {app}', { app: body.toolkitName })}</div>
          <div className="card__sub">{body.reason}</div>
        </div>
      </div>
      {pending ? (
        <>
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('skip', () => api.dismiss(row.botId, row.seq))}>{t('Skip')}</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={connect}>{waiting ? t('Waiting for sign-in…') : t('Connect')}</button>
          </div>
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'connected' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'connected' ? t('{app} connected', { app: body.toolkitName }) : t('Skipped')}
        </div>
      )}
    </div>
  );
}

// ---------------- draft (screen 02) ----------------

const CHANNEL_LABEL: Record<string, string> = { email: tx('Email'), slack: 'Slack', message: tx('Chat') };

export function DraftCard({ body }: { body: Card<'draft'> }) {
  const t = useT();
  const { busy, error, run } = useBusy();
  const user = useStore((s) => s.user);
  const pending = body.status === 'pending';
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(body.text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ } };
  const handle = user?.email ? `@${user.email.split('@')[0]}` : '';
  return (
    <div className={`card draft-card${pending ? '' : ' is-resolved'}`}>
      <div className="draft-card__head">
        <span className="draft-card__tile"><Icon name="chat_filled" size={18} color="#FFFFFF" /></span>
        <div className="draft-card__titles">
          <div className="draft-card__channel">{body.channel === 'slack' ? CHANNEL_LABEL.slack : t(CHANNEL_LABEL[body.channel] ?? tx('Message'))}</div>
          <div className="draft-card__from">{handle}</div>
        </div>
        <button type="button" className="draft-card__copy" onClick={copy} aria-label={t('Copy draft')} title={copied ? t('Copied') : t('Copy')}>
          <Icon name={copied ? 'check' : 'copy'} size={12} opacity={0.66} />
        </button>
      </div>
      <div className="draft-card__content">
        <div className="draft-card__to">
          <span className="draft-card__to-label">{t('To')}</span>
          <span className="draft-card__to-avatar">{(body.to.trim()[0] ?? '?').toUpperCase()}</span>
          <span className="draft-card__to-name">{body.to}</span>
        </div>
        {body.subject && <div className="draft-card__subject">{body.subject}</div>}
        <div className="draft-card__text">{body.text}</div>
      </div>
      {pending ? (
        <div className="draft-card__actions">
          <button type="button" className="btn btn--secondary btn--grow" disabled={!!busy} onClick={() => run('discard', () => api.approve(body.approvalId, 'deny'))}>{t('Discard')}</button>
          <button type="button" className="btn btn--primary btn--grow" disabled={!!busy} onClick={() => run('send', () => api.approve(body.approvalId, 'allow'))}>{t('Send')}</button>
        </div>
      ) : (
        <div className={`card__outcome is-${body.status}`} style={{ padding: '0 16px 16px' }}>
          <Icon name={body.status === 'sent' ? 'check' : 'close'} size={12} opacity={0.7} />
          {body.status === 'sent' ? t('Sent') : t('Discarded')}
        </div>
      )}
      {error && <div className="card__error" style={{ padding: '0 16px 12px' }}>{error}</div>}
    </div>
  );
}

export function CardRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type !== 'card') return null;
  switch (b.card) {
    case 'approval': return <ApprovalCard body={b} />;
    case 'question': return <QuestionCard row={row} body={b} />;
    case 'connect': return <ConnectCard row={row} body={b} />;
    case 'draft': return <DraftCard body={b} />;
    default: return null;
  }
}
