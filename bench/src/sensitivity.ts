/**
 * Кривая чувствительности стенда по искусственным регрессиям (RQ1).
 *
 *   npx tsx src/sensitivity.ts --repo excalidraw      (читает data/<repo>-mutants/ и <repo>-mutants.labels.csv)
 *
 * Для каждого оператора и уровня силы: сколько мутантов собралось, в скольких итоговая
 * разметка (BH + порог) нашла регрессию **по целевой метрике** оператора, медиана Δ целевой
 * метрики и побочные метки по другим метрикам. Сначала — npm run label -- --repo <repo>-mutants.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { median, TARGETS, type TargetName } from './stats.ts';
import type { CommitResult } from './types.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const { values: args } = parseArgs({ options: { repo: { type: 'string', default: 'excalidraw' } } });
const name = `${args.repo}-mutants`;
const dir = join(ROOT, 'data', name);
const labelsFile = join(ROOT, 'data', `${name}.labels.csv`);
if (!existsSync(labelsFile)) throw new Error(`нет ${labelsFile} — сначала npm run label -- --repo ${name}`);

/** На какую метрику рассчитан оператор (bundle_bloat — на загрузку). */
const TARGET_OF: Record<string, TargetName> = {
  blocking_script: 'lcp',
  long_task: 'tbt',
  slow_input: 'inp',
  layout_shift: 'cls',
  bundle_bloat: 'lcp',
};

const lines = readFileSync(labelsFile, 'utf8').trim().split('\n');
const header = lines[0].split(',');
const labels = lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [header[i], v])));

const results: CommitResult[] = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
const labelOf = (r: CommitResult) => labels.find((l) => l.sha === r.sha && l.mutation === `${r.mutation!.op}-${r.mutation!.level}`);

type Row = { built: number; failed: number; detected: number; deltas: number[]; side: Record<string, number>; budget: number };
const table = new Map<string, Row>();
for (const r of results) {
  const m = r.mutation!;
  const key = `${m.op}|${m.level}`;
  const row = table.get(key) ?? { built: 0, failed: 0, detected: 0, deltas: [], side: {}, budget: 0 };
  table.set(key, row);
  if (r.status !== 'ok') {
    row.failed++;
    if (/maximumFileSizeToCacheInBytes/.test(r.error ?? '')) row.budget++;
    continue;
  }
  row.built++;
  const lab = labelOf(r);
  if (!lab) continue;
  const t = TARGET_OF[m.op];
  if (lab[`${t}_label`] === 'regression') row.detected++;
  const d = Number(lab[`${t}_delta`]);
  if (!Number.isNaN(d)) row.deltas.push(d);
  for (const other of Object.keys(TARGETS) as TargetName[]) {
    if (other !== t && lab[`${other}_label`] && lab[`${other}_label`] !== 'none') {
      row.side[`${other}:${lab[`${other}_label`] === 'regression' ? '▲' : '▼'}`] = (row.side[`${other}:${lab[`${other}_label`] === 'regression' ? '▲' : '▼'}`] ?? 0) + 1;
    }
  }
}

console.log(`${name}: ${results.length} мутантов\n`);
console.log('оператор          уровень   цель   собрано  найдено   доля   медиана Δ цели   побочные метки');
const out: unknown[] = [];
for (const [key, row] of [...table].sort(([a], [b]) => {
  const [oa, la] = a.split('|'), [ob, lb] = b.split('|');
  return oa.localeCompare(ob) || Number(la) - Number(lb);
})) {
  const [op, level] = key.split('|');
  const t = TARGET_OF[op];
  const unit = results.find((r) => r.mutation!.op === op)!.mutation!.unit;
  const share = row.built ? row.detected / row.built : NaN;
  const med = row.deltas.length ? median(row.deltas) : NaN;
  const fmt = (x: number) => (Number.isNaN(x) ? '—' : t === 'cls' ? x.toFixed(3) : x.toFixed(0));
  const side = Object.entries(row.side).map(([k, v]) => `${k}×${v}`).join(' ');
  console.log(
    `${op.padEnd(17)} ${`${level} ${unit}`.padStart(7)}   ${t.padEnd(5)}  ${String(row.built).padStart(5)}  ${String(row.detected).padStart(7)}  ` +
      `${Number.isNaN(share) ? '   —' : `${(share * 100).toFixed(0).padStart(4)}%`}   ${fmt(med).padStart(12)}     ${side}` +
      (row.failed ? `   [не собрано: ${row.failed}${row.budget ? `, из них бюджет размера PWA: ${row.budget}` : ''}]` : ''),
  );
  out.push({ op, level: Number(level), unit, target: t, built: row.built, failed: row.failed, budgetRejected: row.budget, detected: row.detected, share, medianDelta: med, side: row.side });
}
const file = join(ROOT, 'ml', 'results', `sensitivity-${args.repo}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`\n→ ${file}`);
