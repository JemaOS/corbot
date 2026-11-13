// Checks the interface translations: every sentence the code shows (t, tn, tx) must have a
// translation in every language, with the same {values}, and no translation may be left over.
//   node tools/i18n-check.mjs            check, exit 1 on a problem
//   node tools/i18n-check.mjs --keys     print the sentences found in the code, as JSON
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src');
const LANGS = ['fr', 'es', 'it', 'de', 'pt'];

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'i18n' ? [] : files(p);
    return /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

// A quoted literal: '...', "..." or `...` without ${}.
const STR = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|` + '`((?:[^`\\\\$]|\\\\.)*)`';
const one = new RegExp(String.raw`(?<![\w.$])(?:t|tx)\(\s*(?:${STR})`, 'g');
const two = new RegExp(String.raw`(?<![\w.$])tn\(\s*(?:${STR})\s*,\s*(?:${STR})`, 'g');
const unquote = (m, i) => (0, eval)(m[i] !== undefined ? `'${m[i]}'` : m[i + 1] !== undefined ? `"${m[i + 1]}"` : '`' + m[i + 2] + '`');

const keys = new Map();
for (const f of files(root)) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(root, f);
  for (const m of src.matchAll(one)) keys.set(unquote(m, 1), rel);
  for (const m of src.matchAll(two)) { keys.set(unquote(m, 1), rel); keys.set(unquote(m, 4), rel); }
}

if (process.argv.includes('--keys')) {
  console.log(JSON.stringify([...keys.keys()].sort((a, b) => a.localeCompare(b)), null, 1));
  process.exit(0);
}

// The dictionaries are plain TypeScript object literals; strip the two typed lines to load them.
async function load(lang) {
  const src = fs.readFileSync(path.join(root, 'i18n', `${lang}.ts`), 'utf8').replace(/const dict: Record<string, string> =/, 'const dict =');
  const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'i18n-')), `${lang}.mjs`);
  fs.writeFileSync(tmp, src);
  return (await import(pathToFileURL(tmp).href)).default;
}

const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
let bad = 0;
console.log(`${keys.size} sentences in the code`);
for (const lang of LANGS) {
  const dict = await load(lang);
  const missing = [...keys.keys()].filter((k) => !(k in dict));
  const extra = Object.keys(dict).filter((k) => !keys.has(k));
  const wrongVars = Object.keys(dict).filter((k) => keys.has(k) && vars(k) !== vars(dict[k]));
  const empty = Object.keys(dict).filter((k) => !String(dict[k]).trim());
  console.log(`${lang}: ${Object.keys(dict).length} translated, ${missing.length} missing, ${extra.length} unused, ${wrongVars.length} with different {values}, ${empty.length} empty`);
  for (const k of missing.slice(0, 15)) console.log(`   missing: ${JSON.stringify(k)}  (${keys.get(k)})`);
  for (const k of wrongVars.slice(0, 15)) console.log(`   values differ: ${JSON.stringify(k)} -> ${JSON.stringify(dict[k])}`);
  for (const k of extra.slice(0, 8)) console.log(`   unused: ${JSON.stringify(k)}`);
  bad += missing.length + wrongVars.length + empty.length + extra.length;
}
process.exit(bad ? 1 : 0);
