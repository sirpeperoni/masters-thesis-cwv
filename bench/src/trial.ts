/**
 * Пробный запуск нового репозитория перед сбором: собирается ли история и работает ли сценарий.
 *
 *   npx tsx src/trial.ts --repo mermaid-live-editor [--sha <sha> ...] [--measure] [--clean] [--aa 10]
 *
 * Без --sha берёт три точки: самый старый, средний и самый новый коммит диапазона конфига.
 * Для каждой: checkout → install (если изменился lock-файл) → build теми же командами и с тем же
 * окружением, что run.ts; печатает время, наличие страниц в сборке и хеш.
 * С --measure — ещё прогрев (внешние домены страницы) и один прогон Lighthouse (метрики, сценарий).
 * В датасет ничего не пишет. Логи — work/logs/<repo>/trial-<sha>.*.log.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { distHash } from './bundle.ts';
import { sh } from './exec.ts';
import { checkout, cleanAll, ensureClone, listCommits } from './git.ts';
import { serveStatic } from './server.ts';
import type { PageRun, RepoConfig } from './types.ts';
import { compare, mean, median, quartiles, sd, TARGETS, valuesOf, type TargetName } from './stats.ts';
import { LighthouseWorker } from './worker-client.ts';
import { Progress } from './progress.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    sha: { type: 'string', multiple: true },
    measure: { type: 'boolean', default: false },
    // перед каждой точкой — удалить всё игнорируемое git, включая node_modules (смена менеджера пакетов)
    clean: { type: 'boolean', default: false },
    // A/A-проверка шума: N пар «сборка против самой себя» на каждой точке
    aa: { type: 'string' },
  },
});
if (!args.repo) throw new Error('--repo is required');

const cfg: RepoConfig = (await import(`../repos/${args.repo}.ts`)).default;
const repoDir = join(ROOT, 'work', 'repos', cfg.name);
const logDir = join(ROOT, 'work', 'logs', cfg.name);
const stateFile = join(ROOT, 'work', `${cfg.name}.install-hash`);
mkdirSync(logDir, { recursive: true });

await ensureClone(cfg, repoDir);
const commits = await listCommits(cfg, repoDir);
console.log(`${cfg.name}: ${commits.length} коммитов в диапазоне (${commits[0]?.date.slice(0, 10)} … ${commits.at(-1)?.date.slice(0, 10)})`);

const points = args.sha?.length
  ? args.sha.map((s) => commits.find((c) => c.sha.startsWith(s)) ?? { sha: s, date: '?', subject: '(вне диапазона)', parent: null })
  : [...new Set([0, Math.floor(commits.length / 2), commits.length - 1])].map((i) => commits[i]);

const AA_PAIRS = Number(args.aa ?? 0);
const worker = args.measure || AA_PAIRS ? new LighthouseWorker(cfg.name, 3 * 60_000) : null;
// статус для панели (npm run dashboard): проба видна на вкладке репозитория
const progress = new Progress(join(ROOT, 'work', 'status', `${cfg.name}.json`), {
  repo: cfg.name,
  pairs: { initial: AA_PAIRS || 1, extended: AA_PAIRS || 1 },
  totalInRange: commits.length,
  queue: points.length,
});

for (const c of points) {
  console.log(`\n== ${c.sha.slice(0, 8)} ${c.date.slice(0, 10)} ${c.subject.slice(0, 70)}`);
  progress.startCommit(c.sha, `[проба] ${c.subject}`);
  try {
    await checkout(repoDir, c.sha);
    if (args.clean) {
      await cleanAll(repoDir);
      writeFileSync(stateFile, '');
    }

    const lock = cfg.installInputs.find((f) => existsSync(join(repoDir, f))) ?? '—';
    const hash = createHash('sha1');
    for (const f of cfg.installInputs) {
      const p = join(repoDir, f);
      hash.update(f).update(existsSync(p) ? readFileSync(p) : '');
    }
    const h = hash.digest('hex');
    if (h !== (existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '')) {
      progress.stage('install');
      const r = await sh(cfg.install, { cwd: repoDir, env: cfg.env, timeoutMs: 20 * 60_000 });
      writeFileSync(join(logDir, `trial-${c.sha}.install.log`), r.output);
      console.log(`   install (${lock}): ${r.code === 0 ? 'ok' : `ОШИБКА ${r.code}`} за ${(r.ms / 1000).toFixed(0)} с`);
      if (r.code !== 0) {
        writeFileSync(stateFile, '');
        console.log('   ' + lastLines(r.output));
        continue;
      }
      writeFileSync(stateFile, h);
    } else {
      console.log(`   install (${lock}): не нужен, lock-файл не менялся`);
    }

    progress.stage('build');
    const b = await sh(cfg.build, { cwd: repoDir, env: cfg.env, timeoutMs: 15 * 60_000 });
    writeFileSync(join(logDir, `trial-${c.sha}.build.log`), b.output);
    const dist = join(repoDir, cfg.distDir);
    const hasIndex = existsSync(join(dist, 'index.html'));
    console.log(`   build: ${b.code === 0 ? 'ok' : `ОШИБКА ${b.code}`} за ${(b.ms / 1000).toFixed(0)} с; ${cfg.distDir}/index.html ${hasIndex ? 'есть' : 'НЕТ'}`);
    if (b.code !== 0) console.log('   ' + lastLines(b.output));
    if (!hasIndex) continue;

    const html = readdirSync(dist).filter((f) => f.endsWith('.html'));
    const pages = cfg.pages.map((p) => {
      const base = p.path.replace(/^\/|\/$/g, '');
      const found = !base || [`${base}.html`, `${base}/index.html`].some((f) => existsSync(join(dist, f)));
      return `${p.path} ${found ? '✓' : '(нет файла — отдаст fallback)'}`;
    });
    console.log(`   html в корне: ${html.join(', ')}; страницы: ${pages.join('; ')}; хеш ${distHash(dist).slice(0, 12)}`);

    if (worker && args.measure) {
      const server = await serveStatic(dist, { fallback: cfg.spaFallback });
      try {
        await worker.restart();
        for (const page of cfg.pages) {
          progress.stage('warmup', { page: page.name });
          const hosts = await worker.warmup(page.name, server.url);
          console.log(`   [${page.name}] внешние: ${hosts.external.join(', ') || 'нет'}${hosts.blocked.length ? `; заблокированы: ${hosts.blocked.join(', ')}` : ''}`);
          try {
            progress.stage('measure', { page: page.name, run: 1, total: 1, side: 'B' });
            const r = await worker.measure(page.name, server.url);
            const n = r.navigation, i = r.interaction;
            console.log(
              `   [${page.name}] lcp ${n.lcp?.toFixed(0)}  cls ${n.cls?.toFixed(3)}  tbt ${n.tbt?.toFixed(0)}` +
                (i ? `  | сценарий: inp ${i.inp?.toFixed(0) ?? '— (взаимодействий не было!)'}  tbt ${i.tbt?.toFixed(0)}` : ''),
            );
          } catch (e) {
            console.log(`   [${page.name}] ПРОГОН УПАЛ: ${String(e).split('\n').slice(0, 3).join(' ').slice(0, 300)}`);
          }
        }
      } finally {
        await server.close();
      }
    }

    if (worker && AA_PAIRS) await aaCheck(c.sha, dist);
  } finally {
    progress.endCommit();
  }
}

/**
 * A/A: одна и та же сборка на двух серверах, N пар в порядке AB BA… — как в сборе.
 * Даёт реальный шум метрик на этом приложении: разброс, MDE при 5 и 15 парах и проверку,
 * что тест не «находит» разницу там, где её нет.
 */
async function aaCheck(sha: string, dist: string) {
  const [sa, sb] = await Promise.all([
    serveStatic(dist, { fallback: cfg.spaFallback }),
    serveStatic(dist, { fallback: cfg.spaFallback }),
  ]);
  try {
    await worker!.restart();
    for (const page of cfg.pages) {
      progress.stage('warmup', { page: page.name });
      await worker!.warmup(page.name, sa.url).catch(() => {});
      await worker!.warmup(page.name, sb.url).catch(() => {});
      const runs: Record<'A' | 'B', PageRun[]> = { A: [], B: [] };
      for (let i = 0; i < AA_PAIRS; i++) {
        for (const side of i % 2 === 0 ? (['A', 'B'] as const) : (['B', 'A'] as const)) {
          progress.stage('measure', { page: page.name, run: i + 1, total: AA_PAIRS, side });
          try {
            runs[side].push(await worker!.measure(page.name, side === 'A' ? sa.url : sb.url));
          } catch (e) {
            runs[side].push({ navigation: {}, interaction: null, error: String(e).slice(0, 500) });
          }
        }
      }
      writeFileSync(join(logDir, `aa-${sha}-${page.name}.json`), JSON.stringify(runs, null, 1));
      const failed = [...runs.A, ...runs.B].filter((r) => r.error).length;
      console.log(`\n   A/A [${page.name}]: ${AA_PAIRS} пар${failed ? `, упавших прогонов: ${failed}` : ''}`);
      console.log('   метрика     медиана     CV    IQR/мед   Δ (B−A)     p    порог   MDE n=5   MDE n=15');
      for (const t of Object.keys(TARGETS) as TargetName[]) {
        const a = valuesOf(runs.A, t), b = valuesOf(runs.B, t);
        const cmp = compare(runs.A, runs.B, t);
        if (!cmp) continue;
        const all = [...a, ...b];
        const med = median(all);
        const q = quartiles(all)!;
        const pooled = Math.sqrt((sd(a) ** 2 + sd(b) ** 2) / 2);
        const mde = (n: number) => 2.8 * pooled * Math.sqrt(2 / n);
        const f = (x: number) => (t === 'cls' ? x.toFixed(4) : x.toFixed(0));
        const pct = (x: number) => (med ? `${((x / med) * 100).toFixed(0)}%` : '—');
        console.log(
          `   ${TARGETS[t].label.padEnd(10)} ${f(med).padStart(8)}  ${((sd(all) / (mean(all) || 1)) * 100).toFixed(0).padStart(4)}%` +
            `  ${pct(q[2] - q[0]).padStart(6)}  ${f(cmp.delta).padStart(9)}  ${cmp.p.toFixed(2).padStart(5)}  ${f(cmp.threshold).padStart(6)}` +
            `  ${`${f(mde(5))} (${pct(mde(5))})`.padStart(12)}  ${`${f(mde(15))} (${pct(mde(15))})`.padStart(12)}`,
        );
      }
    }
  } finally {
    await Promise.all([sa.close(), sb.close()]);
  }
}
await worker?.stop();
progress.finish();

function lastLines(text: string): string {
  return text.trim().split('\n').filter((l) => /error|ERR|Error|failed/.test(l)).slice(-3).join('\n   ') || text.trim().split('\n').slice(-3).join('\n   ');
}
