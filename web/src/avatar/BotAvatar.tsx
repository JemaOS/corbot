import { useId } from 'react';
import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import { BODY_ORDER, BOX, closedPath, eyeGeometry, type EyeMood } from '@shared/eye';
import { tx } from '../i18n';
import { palette } from '../lib/colors';
import { Icon } from '../components/Icon';
import { useStore } from '../store';

/**
 * A bot's picture: one living eye in a simple body (geometry in server/src/eye.ts).
 * The eye shows what the bot is doing: it looks towards its screen while working, opens wide
 * while it waits for an answer, and closes when the bot is asleep. Motion is in base.css.
 */

/** Bodies offered in the Create New Bot picker. */
export const PICKER_SHAPES: AvatarShape[] = BODY_ORDER;

/** Body names for the picker (aria-label); show with t(SHAPE_LABELS[s] ?? s). */
export const SHAPE_LABELS: Partial<Record<AvatarShape, string>> = {
  disc: tx('Disc'), tile: tx('Tile'), hexagon: tx('Hexagon'), diamond: tx('Diamond'), shield: tx('Shield'), arch: tx('Arch'), drop: tx('Drop'),
  egg: tx('Egg'), pebble: tx('Pebble'), ticket: tx('Ticket'), cog: tx('Cog'), moon: tx('Moon'), tower: tx('Tower'),
};

interface Props {
  shape: AvatarShape | string;
  color: AvatarColor | string;
  /** Slot size in px. */
  size: number;
  star?: boolean;
  /** Selected-shape ring following the body's outline. */
  ring?: boolean;
  /** What the eye is doing. Default: idle. */
  mood?: EyeMood;
  className?: string;
  title?: string;
}

/** The drawing is a little larger than its slot, so a body reads at the size of the slot. */
const OVERDRAW = 1.12;

/** A stable number in [0, 1) from a string, so each bot blinks on its own beat. */
function beat(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

export function BotAvatar({ shape, color, size, star, ring, mood = 'idle', className, title }: Props) {
  const clip = useId();
  const g = eyeGeometry(shape);
  const draw = size * OVERDRAW;
  const off = (draw - size) / 2;
  // Black follows the theme: an ink body with the page colour for the eye, in either theme.
  const themed = color === 'black';
  const fill = themed ? 'var(--color-ink)' : palette(color).fill;
  const white = themed ? 'var(--color-bg-pane)' : '#FFFFFF';
  const ink = themed ? 'var(--color-ink)' : '#141414';
  const reach = (g.rx - g.iris) * 0.9;
  const vars = {
    width: size, height: size,
    '--eye-cx': `${g.cx}px`, '--eye-cy': `${g.cy}px`, '--eye-ry': `${g.ry}px`, '--eye-reach': `${reach}px`,
    '--eye-beat': `${(-beat(`${shape}${color}${title ?? ''}`) * 6).toFixed(2)}s`,
  } as React.CSSProperties;
  return (
    <span className={`bot-avatar is-${mood} ${className ?? ''}`} style={vars} title={title} role="img" aria-label={title}>
      <svg width={draw} height={draw} viewBox={`0 0 ${BOX} ${BOX}`} style={{ position: 'absolute', left: -off, top: -off, overflow: 'visible' }} aria-hidden>
        <defs><clipPath id={clip}><path d={g.almond} /></clipPath></defs>
        {ring && <path d={g.body} fill="none" stroke="var(--color-border-focus)" strokeWidth={5.6} strokeLinejoin="round" />}
        {ring && <path d={g.body} fill="none" stroke="var(--color-bg-pane)" strokeWidth={3} strokeLinejoin="round" />}
        <path d={g.body} fill={fill} />
        <g className="eye">
          <path className="eye__white" d={g.almond} fill={white} />
          <g className="eye__ball" clipPath={`url(#${clip})`}>
            <g className="eye__iris">
              <circle cx={g.cx} cy={g.cy} r={g.iris} fill={ink} />
              <circle className="eye__glint" cx={g.cx - g.iris * 0.32} cy={g.cy - g.iris * 0.34} r={g.iris * 0.26} fill={white} />
            </g>
            {/* Lids: the body's colour, sliding over the eye from above and below. */}
            <rect className="eye__lid eye__lid--top" x={g.cx - g.rx - 1} y={g.cy - g.ry * 3} width={g.rx * 2 + 2} height={g.ry * 2} fill={fill} />
            <rect className="eye__lid eye__lid--bottom" x={g.cx - g.rx - 1} y={g.cy + g.ry} width={g.rx * 2 + 2} height={g.ry * 2} fill={fill} />
          </g>
          <path className="eye__closed" d={closedPath(g.cx, g.cy, g.rx, g.ry)} fill="none" stroke={white} strokeWidth={2.2} strokeLinecap="round" />
        </g>
      </svg>
      {star && (
        <span className="bot-avatar__star" style={{ width: size * 0.2667, height: size * 0.2667 }}>
          <Icon name="star" size={size * 0.1333} color="#FFFFFF" />
        </span>
      )}
    </span>
  );
}

/** A bot with no activity for this long is shown asleep. */
const ASLEEP_AFTER_MS = 10 * 60_000;

type BotLook = Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'> & Partial<Pick<Bot, 'id' | 'lastActivityAt'>> & { isPrimary?: boolean };

/** What a bot is doing right now, as the eye shows it. */
export function useBotMood(bot: BotLook): EyeMood {
  const live = useStore((s) => (bot.id ? s.live[bot.id] : undefined));
  const down = useStore((s) => s.computer?.status === 'suspended' || s.computer?.status === 'stopped');
  if (live?.awaiting) return 'waiting';
  if (live?.isRunning) return 'working';
  if (down) return 'asleep';
  if (bot.lastActivityAt && Date.now() - bot.lastActivityAt > ASLEEP_AFTER_MS) return 'asleep';
  return 'idle';
}

export function BotAvatarFor({ bot, size, star, className, mood }: { bot: BotLook; size: number; star?: boolean; className?: string; mood?: EyeMood }) {
  const current = useBotMood(bot);
  return <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} star={star} className={className} title={bot.name} mood={mood ?? current} />;
}
