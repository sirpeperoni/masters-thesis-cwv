/**
 * Разметка датасета: регрессия / улучшение / без изменений для каждой целевой метрики.
 *
 *   npx tsx src/label.ts --repo excalidraw [--fdr 0.05]
 *
 * Правило (оба условия сразу):
 *   1. статистическая значимость: q-value Бенджамини–Хохберга < fdr; поправка считается
 *      отдельно по каждой метрике по всем измеренным сравнениям репозитория;
 *   2. практическая значимость: |Δ медиан| ≥ порога метрики (stats.ts → TARGETS).
 * Коммиты с побайтно одинаковой сборкой — «без изменений» по построению.
 * Контрольные A/A-сравнения (одинаковый код, но измерен) дают оценку доли ложных срабатываний.
 *
 * Результат: data/<repo>.labels.csv (+ сводка в консоль).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { benjaminiHochberg, compare, PRIMARY_TARGETS, TARGETS, type Comparison, type TargetName } from './stats.ts';
import type { CommitResult } from './types.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const { values: args } = parseArgs({
  options: { repo: { type: 'string', default: 'excalidraw' }, fdr: { type: 'string', default: '0.05' } },
});
const FDR = Number(args.fdr);
const targets = Object.keys(TARGETS) as TargetName[];

type Label = 'regression' | 'improvement' | 'none';

const dir = join(ROOT, 'data', args.repo!);
const commits: CommitResult[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .filter((r) => r.schema === 2 && (r.status === 'ok' || r.status === 'identical_build'))
  .sort((a, b) => a.date.localeCompare(b.date));

const measured = (c: CommitResult) => Object.keys(c.runs).length > 0;

interface Row {
  c: CommitResult;
  cmp: Partial<Record<TargetName, Comparison>>;
  q: Partial<Record<TargetName, number>>;
  label: Partial<Record<TargetName, Label>>;
}
const rows: Row[] = commits.map((c) => {
  const page = Object.keys(c.runs)[0];
  const cmp: Row['cmp'] = {};
  if (page) {
    for (const t of targets) {
      const r = compare(c.baseRuns[page], c.runs[page], t);
      if (r) cmp[t] = r;
    }
  }
  return { c, cmp, q: {}, label: {} };
});

// Поправка по каждой метрике по всем измеренным сравнениям (включая A/A — они тоже проверки)
for (const t of targets) {
  const withP = rows.filter((r) => r.cmp[t]);
  const q = benjaminiHochberg(withP.map((r) => r.cmp[t]!.p));
  withP.forEach((r, i) => (r.q[t] = q[i]));
}

for (const r of rows) {
  for (const t of targets) {
    if (r.c.status === 'identical_build' && !r.c.aa) {
      r.label[t] = 'none';
      continue;
    }
    const cmp = r.cmp[t], q = r.q[t];
    if (!cmp || q === undefined) continue; // метрика не измерена — метки нет
    if (q < FDR && cmp.delta >= cmp.threshold) r.label[t] = 'regression';
    else if (q < FDR && cmp.delta <= -cmp.threshold) r.label[t] = 'improvement';
    else r.label[t] = 'none';
  }
}

const overall = (r: Row): Label | '' => {
  // итоговая метка коммита — только по основным метрикам (наблюдаемый LCP — дополнительная)
  const ls = PRIMARY_TARGETS.map((t) => r.label[t]).filter((l): l is Label => !!l);
  if (!ls.length) return '';
  if (ls.includes('regression')) return 'regression';
  if (ls.includes('improvement')) return 'improvement';
  return 'none';
};

// ─── CSV ──────────────────────────────────────────────────────────────────────
const num = (x: number | undefined, d = 3) => (x === undefined ? '' : Number(x.toFixed(d)).toString());
const header = [
  'sha', 'date', 'base_sha', 'status', 'aa', 'self_aa', 'extended', 'mutation', 'js_gzip', 'label',
  ...targets.flatMap((t) => [`${t}_base`, `${t}_head`, `${t}_delta`, `${t}_rel`, `${t}_p`, `${t}_q`, `${t}_label`]),
];
const csv = [header.join(',')];
for (const r of rows) {
  csv.push(
    [
      r.c.sha, r.c.date, r.c.base?.sha ?? '', r.c.status, r.c.aa ? 1 : 0, r.c.selfAA ? 1 : 0, r.c.extended ? 1 : 0,
      r.c.mutation ? `${r.c.mutation.op}-${r.c.mutation.level}` : '',
      r.c.bundle?.byExt['.js']?.gzip ?? '', overall(r),
      ...targets.flatMap((t) => {
        const c = r.cmp[t];
        return [num(c?.base), num(c?.head), num(c?.delta), num(c?.rel, 4), num(c?.p, 5), num(r.q[t], 5), r.label[t] ?? ''];
      }),
    ].join(','),
  );
}
const outFile = join(ROOT, 'data', `${args.repo}.labels.csv`);
writeFileSync(outFile, csv.join('\n') + '\n');

// ─── сводка ───────────────────────────────────────────────────────────────────
const real = rows.filter((r) => !r.c.aa);
const aa = rows.filter((r) => r.c.aa);
console.log(`${args.repo}: ${rows.length} коммитов (измерено ${real.filter((r) => measured(r.c)).length}, ` +
  `одинаковых сборок ${real.filter((r) => r.c.status === 'identical_build').length}, A/A ${aa.length}), FDR=${FDR}\n`);
console.log('метрика     регрессий  улучшений  без изм.   порог');
for (const t of targets) {
  const cnt = (l: Label) => real.filter((r) => r.label[t] === l).length;
  const { abs, rel } = TARGETS[t];
  console.log(
    `${TARGETS[t].label.padEnd(10)} ${String(cnt('regression')).padStart(9)} ${String(cnt('improvement')).padStart(10)} ` +
      `${String(cnt('none')).padStart(9)}   ≥ ${rel ? `max(${abs}, ${rel * 100}%)` : abs}` +
      (TARGETS[t].primary ? '' : '   (дополнительная, не входит в итоговую метку)'),
  );
}
const anyReg = real.filter((r) => overall(r) === 'regression').length;
console.log(`\nКоммитов с регрессией хотя бы по одной основной метрике: ${anyReg} из ${real.length}`);

if (aa.length) {
  // ложное срабатывание — только настоящая метка; сравнение без замеров (метка '') ложным не считается
  const unmeasured = aa.filter((r) => overall(r) === '').length;
  const fp = aa.filter((r) => overall(r) === 'regression' || overall(r) === 'improvement').length;
  const rawP = aa.flatMap((r) => PRIMARY_TARGETS.map((t) => r.cmp[t]?.p)).filter((p): p is number => p !== undefined);
  const extra = targets.filter((t) => !TARGETS[t].primary);
  const fpExtra = extra.map((t) => `${TARGETS[t].label}: ${aa.filter((r) => r.label[t] && r.label[t] !== 'none').length}`).join(', ');
  console.log(
    `\nКонтроль A/A (одинаковый код): ${aa.length} сравнений (из них «сборка сама с собой»: ${aa.filter((r) => r.c.selfAA).length})\n` +
      (unmeasured ? `  без замеров (сбой прогонов, не входят в долю): ${unmeasured}\n` : '') +
      `  ложных срабатываний по итоговой разметке: ${fp} (${((fp / Math.max(aa.length - unmeasured, 1)) * 100).toFixed(1)}%)` +
      (extra.length ? `; по дополнительным метрикам — ${fpExtra}` : '') +
      `\n  доля p < 0.05 без поправки: ${((rawP.filter((p) => p < 0.05).length / rawP.length) * 100).toFixed(1)}% ` +
      `(основные метрики; ожидается ≈5% при отсутствии дрейфа)`,
  );
}
console.log(`\n→ ${outFile}`);
