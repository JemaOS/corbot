/**
 * The look of a bot: one eye in a simple body. Original artwork, drawn here as geometry.
 *
 * Everything is in a 48 x 48 box. The body is one of the outlines below, filled with the bot's
 * colour. The eye sits in the middle: a white almond with an iris and a pupil that move, and two
 * lids that close over it. The web app animates it (web/src/avatar/BotAvatar.tsx); the bot's own
 * desktop uses the still picture from eyeSvg().
 */

export const BOX = 48;

/** Body outlines, as SVG path data. Each leaves room for the eye around the centre (24, 24). */
export const BODIES = {
  disc: 'M24 4a20 20 0 1 0 0 40a20 20 0 1 0 0-40Z',
  tile: 'M14 5h20a9 9 0 0 1 9 9v20a9 9 0 0 1-9 9H14a9 9 0 0 1-9-9V14a9 9 0 0 1 9-9Z',
  hexagon: 'M21.5 4.4a5 5 0 0 1 5 0l13.3 7.7a5 5 0 0 1 2.5 4.3v15.2a5 5 0 0 1-2.5 4.3l-13.3 7.7a5 5 0 0 1-5 0L8.2 35.9a5 5 0 0 1-2.5-4.3V16.4a5 5 0 0 1 2.5-4.3Z',
  diamond: 'M20.5 5.5a5 5 0 0 1 7 0l15 15a5 5 0 0 1 0 7l-15 15a5 5 0 0 1-7 0l-15-15a5 5 0 0 1 0-7Z',
  shield: 'M9 6h30a4 4 0 0 1 4 4v12c0 11-8 18.500-17.300 21.700a5 5 0 0 1-3.400 0C13 40.500 5 33 5 22V10a4 4 0 0 1 4-4Z',
  arch: 'M24 4a18 18 0 0 1 18 18v17a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5V22A18 18 0 0 1 24 4Z',
  drop: 'M21.200 5.300a4 4 0 0 1 5.600 0C33 11.500 41 19.500 41 28a17 17 0 0 1-34 0c0-8.500 8-16.500 14.200-22.700Z',
  egg: 'M24 4c9.500 0 17 12 17 22.500a17 17 0 0 1-34 0C7 16 14.500 4 24 4Z',
  pebble: 'M17 6h12c8 0 14 5.500 14 13.500 0 4-1.500 6.500-1.500 10.500C41.500 38 35 43 26 43h-6C11 43 5 37.500 5 29.500 5 25 6.500 22 6.500 18 6.500 11 10.500 6 17 6Z',
  ticket: 'M10 8h28a5 5 0 0 1 5 5v5.500a5.500 5.500 0 0 0 0 11V35a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5v-5.500a5.500 5.500 0 0 0 0-11V13a5 5 0 0 1 5-5Z',
  cog: 'M24 3.500l4.300 4.200 5.900-1.200 1.600 5.800 5.800 1.600-1.200 5.900 4.100 4.200-4.100 4.200 1.200 5.900-5.800 1.600-1.600 5.800-5.900-1.200L24 44.500l-4.300-4.200-5.900 1.200-1.600-5.800-5.800-1.600 1.200-5.900L3.500 24l4.100-4.200-1.200-5.900 5.800-1.600 1.600-5.800 5.900 1.200Z',
  moon: 'M24 4a20 20 0 1 0 19.400 24.900 4 4 0 0 0-5.300-4.600A13 13 0 0 1 23.700 9.900a4 4 0 0 0-3.600-5.500A20 20 0 0 0 24 4Z',
  tower: 'M9 8a3 3 0 0 1 3-3h4v4h5V5h6v4h5V5h4a3 3 0 0 1 3 3v31a5 5 0 0 1-5 5H14a5 5 0 0 1-5-5Z',
} as const;

export type BodyId = keyof typeof BODIES;

/** Bodies offered in the picker, in order. */
export const BODY_ORDER: BodyId[] = ['disc', 'tile', 'hexagon', 'diamond', 'shield', 'arch', 'drop', 'egg', 'pebble', 'ticket', 'cog', 'moon', 'tower'];

/** Where the eye sits and how big it is, for bodies whose middle is not their widest part. */
const EYE_PLACE: Partial<Record<BodyId, { cy?: number; scale?: number }>> = {
  drop: { cy: 27.5, scale: 0.92 },
  egg: { cy: 26, scale: 0.94 },
  shield: { cy: 21.5 },
  arch: { cy: 25 },
  diamond: { scale: 0.8 },
  moon: { cy: 27, scale: 0.74 },
  tower: { cy: 26 },
  cog: { scale: 0.86 },
};

/** Names stored for bots made before these bodies existed, mapped onto the closest new one. */
const LEGACY: Record<string, BodyId> = {
  blob: 'disc', pebble: 'pebble', bean: 'pebble', egg: 'egg', squircle: 'tile', tablet: 'ticket', capsule: 'ticket', cylinder: 'tower',
  hex: 'hexagon', gem: 'diamond', crystal: 'diamond', wedge: 'shield', shield: 'shield', dome: 'arch', arch: 'arch', cloud: 'pebble',
  teardrop: 'drop', leaf: 'drop', square: 'tile', sparkle: 'cog', clover: 'cog', flower: 'cog', heart: 'shield', house: 'tower', star: 'diamond',
};

export function bodyId(shape: string): BodyId {
  return shape in BODIES ? (shape as BodyId) : LEGACY[shape] ?? 'disc';
}

/** What the eye is doing. */
export type EyeMood = 'idle' | 'working' | 'waiting' | 'asleep';

export interface EyeGeometry {
  body: string;
  /** Centre of the eye. */
  cx: number; cy: number;
  /** Half-width and half-height of the open eye. */
  rx: number; ry: number;
  /** Outline of the open eye (an almond), as path data. */
  almond: string;
  iris: number;
  pupil: number;
}

/** An almond: two arcs meeting at the corners of the eye. */
export function almondPath(cx: number, cy: number, rx: number, ry: number): string {
  const f = (n: number) => +n.toFixed(2);
  return `M${f(cx - rx)} ${f(cy)}Q${f(cx)} ${f(cy - ry * 2)} ${f(cx + rx)} ${f(cy)}Q${f(cx)} ${f(cy + ry * 2)} ${f(cx - rx)} ${f(cy)}Z`;
}

export function eyeGeometry(shape: string): EyeGeometry {
  const id = bodyId(shape);
  const place = EYE_PLACE[id] ?? {};
  const s = place.scale ?? 1;
  const cx = BOX / 2;
  const cy = place.cy ?? BOX / 2;
  const rx = 11.5 * s;
  const ry = 6.4 * s;
  return { body: BODIES[id], cx, cy, rx, ry, almond: almondPath(cx, cy, rx, ry), iris: 5.6 * s, pupil: 2.7 * s };
}

/** How far the eye opens (1 = fully) and where it looks, per mood. The web app animates between these. */
export const MOOD: Record<EyeMood, { open: number; lookX: number; lookY: number; pupil: number }> = {
  idle: { open: 1, lookX: 0, lookY: 0, pupil: 1 },
  working: { open: 0.82, lookX: 0.62, lookY: 0.12, pupil: 0.9 },
  waiting: { open: 1.28, lookX: 0, lookY: -0.06, pupil: 1.3 },
  asleep: { open: 0.04, lookX: 0, lookY: 0.2, pupil: 1 },
};

/** True for a fill light enough that a white eye would not show on it. */
export function isLight(fill: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(fill.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.72;
}

/** The closed eye: one lash line, curved down. */
export function closedPath(cx: number, cy: number, rx: number, ry: number): string {
  const f = (n: number) => +n.toFixed(2);
  return `M${f(cx - rx * 0.86)} ${f(cy)}Q${f(cx)} ${f(cy + ry * 1.1)} ${f(cx + rx * 0.86)} ${f(cy)}`;
}

let stills = 0;

/** A still picture of a bot, for places that cannot run the web app's animation (the bot's own desktop). */
export function eyeSvg(shape: string, fill: string, mood: EyeMood = 'idle'): string {
  const g = eyeGeometry(shape);
  const m = MOOD[mood];
  // On a light body the eye is drawn dark with a light iris, so it still reads.
  const light = isLight(fill);
  const white = light ? '#141414' : '#fff';
  const ink = light ? '#fff' : '#141414';
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}"><path d="${g.body}" fill="${fill}"/>`;
  if (mood === 'asleep') {
    return `${head}<path d="${closedPath(g.cx, g.cy, g.rx, g.ry)}" fill="none" stroke="${white}" stroke-width="2.2" stroke-linecap="round"/></svg>`;
  }
  const grow = mood === 'waiting' ? 1.14 : 1;
  const eye = almondPath(g.cx, g.cy, g.rx * grow, g.ry * grow * Math.min(1, m.open));
  const iris = g.iris * grow;
  const ix = g.cx + m.lookX * (g.rx - g.iris) * 0.9;
  const iy = g.cy + m.lookY * g.ry;
  const clip = `eye${++stills}`;
  return `${head}<defs><clipPath id="${clip}"><path d="${eye}"/></clipPath></defs>`
    + `<path d="${eye}" fill="${white}"/>`
    + `<g clip-path="url(#${clip})"><circle cx="${ix.toFixed(2)}" cy="${iy.toFixed(2)}" r="${iris.toFixed(2)}" fill="${ink}"/>`
    + `<circle cx="${(ix - iris * 0.32).toFixed(2)}" cy="${(iy - iris * 0.34).toFixed(2)}" r="${(iris * 0.26).toFixed(2)}" fill="${white}"/></g>`
    + `</svg>`;
}
