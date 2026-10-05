/**
 * Анализ шума измерений (RQ1).
 *
 *   npx tsx src/noise.ts --repo excalidraw
 *
 * Для каждой метрики: разброс внутри коммита (одинаковый код, разные прогоны),
 * минимально различимый эффект (MDE) при текущем числе прогонов,
 * и сравнение соседних коммитов тестом Манна–Уитни.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { CommitResult } from './types.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const { values: args } = parseArgs({ options: { repo: { type: 'string', default: 'excalidraw' } } });

const METRICS: [string, 'navigation' | 'interaction', string][] = [
  ['LCP (sim)', 'navigation', 'lcp'],
  ['LCP (obs)', 'navigation', 'observedLargestContentfulPaint'],
  ['FCP (sim)', 'navigation', 'fcp'],
  ['TBT load', 'navigation', 'tbt'],
  ['CLS load', 'navigation', 'cls'],
  ['INP', 'interaction', 'inp'],
  ['TBT flow', 'interaction', 'tbt'],
];

const dir = join(ROOT, 'data', args.repo!);
const commits: CommitResult[] = readdirSync(dir)
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .filter((r) => r.status === 'ok')
  .sort((a, b) => a.date.localeCompare(b.date));

const values = (c: CommitResult, src: string, key: string) =>
  (Object.values(c.runs)[0] ?? [])
    .map((r) => (r as any)[src]?.[key])
    .filter((x): x is number => typeof x === 'number');

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + (x - mean(v)) ** 2, 0) / (v.length - 1));

/** Двусторонний тест Манна–Уитни, нормальное приближение с поправкой на связи. */
function mannWhitney(a: number[], b: number[]): number {
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array(all.length);
  let tieTerm = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const t = j - i + 1;
    tieTerm += t ** 3 - t;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const n1 = a.length, n2 = b.length, n = n1 + n2;
  const r1 = all.reduce((s, x, i) => s + (x.g === 0 ? ranks[i] : 0), 0);
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return 1;
  const z = (Math.abs(u - mu) - 0.5) / sigma;
  return Math.min(1, 2 * (1 - phi(Math.max(0, z))));
}
function phi(z: number) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * (z / Math.SQRT2));
  const y = 1 - (((((1.061405429 * t - 1.453152735) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + y);
}

const n = values(commits[0], 'navigation', 'lcp').length;
console.log(`${args.repo}: ${commits.length} коммитов, ${n} прогонов на коммит\n`);

console.log('1) Шум внутри коммита (один и тот же код)');
console.log('метрика      медиана   CV внутри   IQR/мед   разброс медиан   MDE (n=' + n + ')   MDE (n=15)');
for (const [name, src, key] of METRICS) {
  const per = commits.map((c) => values(c, src, key)).filter((v) => v.length > 1);
  if (!per.length) continue;
  const med = median(per.flat());
  const cv = median(per.map((v) => (mean(v) ? sd(v) / mean(v) : 0)));
  const iqr = median(per.map((v) => {
    const s = [...v].sort((a, b) => a - b);
    return (s[Math.floor(s.length * 0.75)] - s[Math.floor(s.length * 0.25)]) / (median(v) || 1);
  }));
  // объединённое внутригрупповое SD → MDE для двух выборок (α=0.05, мощность 0.8): 2.8·σ·√(2/n)
  const pooled = Math.sqrt(mean(per.map((v) => sd(v) ** 2)));
  const mde = (k: number) => 2.8 * pooled * Math.sqrt(2 / k);
  const meds = per.map(median);
  const between = (Math.max(...meds) - Math.min(...meds)) / (med || 1);
  const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + '%';
  const abs = (x: number) => (key === 'cls' ? x.toFixed(4) : x.toFixed(0) + ' мс').padStart(8);
  console.log(
    `${name.padEnd(11)} ${abs(med)}   ${pct(cv)}      ${pct(iqr)}     ${pct(between)}          ${abs(mde(n))} (${pct(mde(n) / med)})   ${abs(mde(15))}`,
  );
}

console.log('\n2) Соседние коммиты: Δ медианы и p-value Манна–Уитни (* — p<0.05)');
const cols: [string, 'navigation' | 'interaction', string][] = [METRICS[0], METRICS[1], METRICS[3], METRICS[5], METRICS[6]];
console.log('коммит    ' + cols.map(([n]) => n.padEnd(20)).join('') + 'Δ JS gzip  сообщение');
for (let i = 1; i < commits.length; i++) {
  const a = commits[i - 1], b = commits[i];
  const cells = cols.map(([, src, key]) => {
    const va = values(a, src, key), vb = values(b, src, key);
    const d = median(vb) - median(va);
    const p = mannWhitney(va, vb);
    return `${(d >= 0 ? '+' : '') + d.toFixed(0)} (p=${p.toFixed(2)})${p < 0.05 ? '*' : ' '}`.padEnd(20);
  });
  const js = (b.bundle?.byExt['.js']?.gzip ?? 0) - (a.bundle?.byExt['.js']?.gzip ?? 0);
  console.log(`${b.sha.slice(0, 8)}  ${cells.join('')}${((js >= 0 ? '+' : '') + (js / 1024).toFixed(1) + ' KB').padEnd(11)}${b.subject.slice(0, 50)}`);
}
