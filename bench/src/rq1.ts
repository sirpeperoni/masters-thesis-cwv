/**
 * RQ1: шум измерений и ложные срабатывания — сводка по репозиториям.
 *
 *   npx tsx src/rq1.ts [--repo excalidraw --repo mermaid-live-editor]
 *
 * Три источника:
 *  1. Все измеренные пары датасета: прогоны базы между собой и прогоны коммита между собой —
 *     один и тот же код. Разброс внутри стороны = шум измерения; таких оценок — сотни.
 *  2. A/A-сравнения датасета (одинаковая сборка базы и коммита; «сборка сама с собой»):
 *     доля p < 0.05 без поправки и доля ложных меток после всей процедуры.
 *  3. A/A пробного инструмента (trial.ts --aa N, work/logs/<repo>/aa-*.json) — длинные серии.
 *
 * MDE (α = 0.05, мощность 0.8, две выборки по n): 2.8 · σ · √(2/n).
 * Результат печатается и сохраняется в ml/results/rq1-noise.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compare, mean, median, sd, TARGETS, threshold, valuesOf, type TargetName } from './stats.ts';
import type { CommitResult, PageRun } from './types.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const { values: args } = parseArgs({ options: { repo: { type: 'string', multiple: true } } });
// репозитории с данными и/или с A/A пробного инструмента (у нового репозитория данных ещё может не быть)
const repos = args.repo ?? [
  ...new Set([
    ...readdirSync(join(ROOT, 'data'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.endsWith('-mutants') && !d.name.includes('-v1-'))
      .map((d) => d.name),
    ...readdirSync(join(ROOT, 'work', 'logs'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && readdirSync(join(ROOT, 'work', 'logs', d.name)).some((f) => /^aa-.*.json$/.test(f)))
      .map((d) => d.name),
  ]),
];

const targets = Object.keys(TARGETS) as TargetName[];
const mde = (sigma: number, n: number) => 2.8 * sigma * Math.sqrt(2 / n);
const q = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : NaN;
};

const report: Record<string, unknown> = {};

for (const repo of repos) {
  const dir = join(ROOT, 'data', repo);
  const results: CommitResult[] = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((r) => r.schema === 2);
  const measured = results.filter((r) => Object.keys(r.runs ?? {}).length > 0 && r.status !== 'measure_failed');
  const page = (r: CommitResult) => Object.keys(r.runs)[0];

  console.log(`\n══ ${repo}: пар с замерами ${measured.length} (из них A/A ${measured.filter((r) => r.aa).length})`);

  // 1. шум внутри стороны по всем парам
  console.log('\n  1) Шум внутри стороны (один код) по всем парам: медиана и 90-й перцентиль по сторонам');
  console.log('  метрика     медиана знач.   CV мед   CV p90   σ мед    MDE n=5   MDE n=15   порог при мед.');
  const noise: Record<string, unknown> = {};
  for (const t of targets) {
    const sides: number[][] = measured.flatMap((r) => [valuesOf(r.baseRuns[page(r)], t), valuesOf(r.runs[page(r)], t)]).filter((v) => v.length >= 3);
    if (!sides.length) continue;
    const med = median(sides.map(median));
    const cvs = sides.map((v) => (mean(v) ? sd(v) / Math.abs(mean(v)) : 0));
    const sigmas = sides.map(sd);
    const sigma = median(sigmas);
    const thr = threshold(t, med);
    const f = (x: number) => (t === 'cls' ? x.toFixed(4) : x.toFixed(0));
    const pct = (x: number) => (med ? `${((x / med) * 100).toFixed(0)}%` : '');
    console.log(
      `  ${TARGETS[t].label.padEnd(10)} ${f(med).padStart(12)}  ${(median(cvs) * 100).toFixed(1).padStart(6)}%  ${(q(cvs, 0.9) * 100).toFixed(1).padStart(6)}%` +
        `  ${f(sigma).padStart(6)}  ${`${f(mde(sigma, 5))} ${pct(mde(sigma, 5))}`.padStart(10)}  ${`${f(mde(sigma, 15))} ${pct(mde(sigma, 15))}`.padStart(10)}   ${f(thr)}`,
    );
    noise[t] = { median: med, cvMedian: median(cvs), cvP90: q(cvs, 0.9), sigmaMedian: sigma, mde5: mde(sigma, 5), mde15: mde(sigma, 15), threshold: thr, sides: sides.length };
  }

  // 2. A/A датасета
  const aa = measured.filter((r) => r.aa);
  const aaStats: Record<string, unknown> = { n: aa.length };
  if (aa.length) {
    const ps = aa.flatMap((r) => targets.map((t) => compare(r.baseRuns[page(r)], r.runs[page(r)], t)?.p)).filter((p): p is number => p !== undefined);
    const bigAndSig = aa.filter((r) =>
      targets.some((t) => {
        const c = compare(r.baseRuns[page(r)], r.runs[page(r)], t);
        return !!c && c.p < 0.05 && Math.abs(c.delta) >= c.threshold;
      }),
    ).length;
    console.log(
      `\n  2) A/A в датасете: ${aa.length} сравнений (сборка = база: ${aa.filter((r) => !r.selfAA).length}, «сама с собой»: ${aa.filter((r) => r.selfAA).length})` +
        `\n     p < 0.05 без поправки: ${ps.filter((p) => p < 0.05).length} из ${ps.length} проверок (${((ps.filter((p) => p < 0.05).length / ps.length) * 100).toFixed(1)}%, ожидается ≈5%)` +
        `\n     p < 0.05 и |Δ| ≥ порога (до поправки BH): ${bigAndSig} из ${aa.length} сравнений`,
    );
    Object.assign(aaStats, { tests: ps.length, pBelow05: ps.filter((p) => p < 0.05).length, sigAndAboveThreshold: bigAndSig });
  }

  // 3. длинные A/A из пробного инструмента
  const logDir = join(ROOT, 'work', 'logs', repo);
  const trialAA = existsSync(logDir) ? readdirSync(logDir).filter((f) => /^aa-.*\.json$/.test(f)) : [];
  const trial: Record<string, unknown> = {};
  for (const f of trialAA) {
    const runs: Record<'A' | 'B', PageRun[]> = JSON.parse(readFileSync(join(logDir, f), 'utf8'));
    console.log(`\n  3) A/A пробы ${f}: ${runs.A.length} пар`);
    for (const t of targets) {
      const a = valuesOf(runs.A, t), b = valuesOf(runs.B, t);
      if (a.length < 3) continue;
      const sigma = Math.sqrt((sd(a) ** 2 + sd(b) ** 2) / 2);
      const med = median([...a, ...b]);
      const c = compare(runs.A, runs.B, t)!;
      const fmt = (x: number) => (t === 'cls' ? x.toFixed(4) : x.toFixed(0));
      console.log(`     ${TARGETS[t].label.padEnd(10)} мед ${fmt(med).padStart(7)}  MDE n=15 ${fmt(mde(sigma, 15)).padStart(6)} (${((mde(sigma, 15) / med) * 100 || 0).toFixed(0)}%)  Δ ${fmt(c.delta)}  p=${c.p.toFixed(2)}`);
      trial[`${f}:${t}`] = { median: med, sigma, mde15: mde(sigma, 15), delta: c.delta, p: c.p };
    }
  }

  report[repo] = { measured: measured.length, noise, aa: aaStats, trialAA: trial };
}

const out = join(ROOT, 'ml', 'results', 'rq1-noise.json');
mkdirSync(join(ROOT, 'ml', 'results'), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(`\n→ ${out}`);
