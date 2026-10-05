/**
 * Сбор датасета «коммит → изменение метрик CWV».
 *
 *   npx tsx src/run.ts --repo excalidraw [--pairs 5] [--extra 10] [--aa-every 5] [--self-aa-every 15]
 *                      [--limit 10] [--every 1] [--sha <sha>] [--retry-failed] [--force]
 *   npx tsx src/run.ts --repo excalidraw --mutants [--mutant-commits 6] [--ops long_task --ops …]
 *     — искусственные регрессии (mutations.ts) → data/<repo>-mutants/; только когда основной сбор не идёт
 *
 * Каждый коммит сравнивается с базой — последней успешно собранной версией перед ним:
 *
 *  1. checkout → install (если изменился lock-файл) → build; сборка кешируется
 *     в work/builds/<repo>/<sha>, поэтому сборка коммита сразу служит базой для следующего;
 *  2. если сборка побайтно совпала с базой — статус identical_build, без замеров
 *     (каждое N-е такое сравнение всё же измеряется как контрольное A/A — оценка ложных срабатываний);
 *  3. иначе база (A) и коммит (B) измеряются вперемешку по схеме AB BA AB BA…,
 *     чтобы дрейф среды одинаково влиял на обе версии;
 *  4. после --pairs пар: если хоть одна метрика подозрительна (p < 0.1 или |Δ| ≥ порога),
 *     добавляется ещё --extra пар.
 *
 * Итоговая разметка (с поправкой Бенджамини–Хохберга по всему датасету) — в label.ts.
 * Уже обработанные коммиты пропускаются, поэтому сбор можно прерывать и продолжать.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sh } from './exec.ts';
import { bundleStats, distHash } from './bundle.ts';
import { checkout, cleanAll, ensureClone, listCommits, type CommitInfo } from './git.ts';
import { BROWSER_LANG, chromeVersion, LH_FLAGS } from './measure.ts';
import { Progress } from './progress.ts';
import { serveStatic } from './server.ts';
import { LighthouseWorker } from './worker-client.ts';
import { allMutants, applyMutation, type Mutant } from './mutations.ts';
import { compare, PRIMARY_TARGETS, TARGETS, type TargetName } from './stats.ts';
import type { BundleStats, CommitResult, CommitStatus, PageConfig, PageRun, RepoConfig } from './types.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const INSTALL_TIMEOUT = 20 * 60_000;
const BUILD_TIMEOUT = 15 * 60_000;
const RUN_TIMEOUT = 3 * 60_000;
/** Порог p-value для «подозрения» и расширения замеров (мягкий: пропустить хуже, чем перемерить). */
const SUSPECT_P = 0.1;
/** Доля практического порога метрики, начиная с которой изменение «подозрительно». */
const SUSPECT_DELTA = 0.5;
/** Описание правила расширения — пишется в результат, чтобы в датасете было видно, по какому правилу собран коммит. */
const EXTEND_RULE = `p<${SUSPECT_P} && |delta|>=${SUSPECT_DELTA}*max(abs,rel*base)`;
/** Сколько коммитов назад искать собираемую базу. */
// 20, а не 3: у vuejs-docs серия из 13 несобираемых коммитов подряд (битая ссылка в «3.5: …»,
// исправлена e5653324) — при глубине 3 коммит-исправление остался бы без базы.
// Сравнение через серию — честное: diff и замеры охватывают все промежуточные коммиты.
const MAX_BASE_LOOKBACK = 20;

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    pairs: { type: 'string', default: '5' },
    extra: { type: 'string', default: '10' },
    'aa-every': { type: 'string', default: '5' },
    'self-aa-every': { type: 'string', default: '15' },
    limit: { type: 'string' },
    every: { type: 'string', default: '1' },
    sha: { type: 'string', multiple: true },
    force: { type: 'boolean', default: false },
    'retry-failed': { type: 'boolean', default: false },
    // режим искусственных регрессий (см. mutations.ts)
    mutants: { type: 'boolean', default: false },
    'mutant-commits': { type: 'string', default: '6' },
    ops: { type: 'string', multiple: true },
  },
});
if (!args.repo) throw new Error('--repo is required');

const MUTANTS = args.mutants;
const cfg: RepoConfig = (await import(`../repos/${args.repo}.ts`)).default;
const repoDir = join(ROOT, 'work', 'repos', cfg.name);
const buildsDir = join(ROOT, 'work', 'builds', cfg.name);
/** Имя датасета: мутанты — отдельно, чтобы не смешивать с реальными коммитами. */
const datasetName = MUTANTS ? `${cfg.name}-mutants` : cfg.name;
const outDir = join(ROOT, 'data', datasetName);
const logDir = join(ROOT, 'work', 'logs', cfg.name);
const stateFile = join(ROOT, 'work', `${cfg.name}.install-hash`);
for (const d of [outDir, logDir, buildsDir]) mkdirSync(d, { recursive: true });

const PAIRS = Number(args.pairs);
const EXTRA = Number(args.extra);
const AA_EVERY = Number(args['aa-every']);
const SELF_AA_EVERY = Number(args['self-aa-every']);
const lhVersion = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'node_modules/lighthouse/package.json'), 'utf8')).version;
const env = {
  node: process.version,
  chrome: await chromeVersion(),
  lighthouse: lhVersion,
  settings: LH_FLAGS,
  blockedUrlPatterns: cfg.blockedUrlPatterns ?? [],
  // до 29.09.2026 язык не фиксировался (excalidraw измерен в ru-RU — языке системы)
  lang: BROWSER_LANG,
};

await ensureClone(cfg, repoDir);
const allCommits = await listCommits(cfg, repoDir);
const indexOf = new Map(allCommits.map((c, i) => [c.sha, i]));
let commits = allCommits;
if (args.sha?.length) commits = commits.filter((c) => args.sha!.some((s) => c.sha.startsWith(s)));
commits = commits.filter((_, i) => i % Number(args.every) === 0);
if (!args.force) commits = commits.filter((c) => !alreadyDone(c.sha));
if (args.limit) commits = commits.slice(0, Number(args.limit));

// Мутанты: K коммитов, равномерно по истории, из уже успешно измеренных (сборка заведомо работает)
const mutantJobs: { commit: CommitInfo; mutant: Mutant }[] = [];
if (MUTANTS) {
  const measured = allCommits.filter((c) => {
    const f = join(ROOT, 'data', cfg.name, `${c.sha}.json`);
    return existsSync(f) && JSON.parse(readFileSync(f, 'utf8')).status === 'ok';
  });
  const k = Math.min(Number(args['mutant-commits']), measured.length);
  const picked = [...new Set(Array.from({ length: k }, (_, i) => Math.round((i * (measured.length - 1)) / Math.max(1, k - 1))))];
  for (const idx of picked) {
    for (const mutant of allMutants(args.ops, cfg)) {
      if (args.force || !existsSync(join(outDir, `${measured[idx].sha}__${mutant.key}.json`))) {
        mutantJobs.push({ commit: measured[idx], mutant });
      }
    }
  }
  console.log(`${datasetName}: ${picked.length} commits × ${allMutants(args.ops, cfg).length} mutants → ${mutantJobs.length} to measure`);
} else {
  console.log(`${cfg.name}: ${commits.length} commits, ${PAIRS} pairs (+${EXTRA} if suspicious), A/A every ${AA_EVERY} identical builds + self A/A every ${SELF_AA_EVERY} measured; extend if ${EXTEND_RULE}`);
}

const progress = new Progress(join(ROOT, 'work', 'status', `${datasetName}.json`), {
  repo: datasetName,
  pairs: { initial: PAIRS, extended: PAIRS + EXTRA },
  totalInRange: MUTANTS ? mutantJobs.length : allCommits.length,
  queue: MUTANTS ? mutantJobs.length : commits.length,
});

let identicalSeen = 0;
let measuredSeen = 0;
const worker = new LighthouseWorker(cfg.name, RUN_TIMEOUT);

for (const [i, { commit, mutant }] of mutantJobs.entries()) {
  const t0 = Date.now();
  progress.startCommit(commit.sha, `${commit.subject} + ${mutant.key}`);
  const result = await processMutant(commit, mutant).catch((e) => ({
    ...crashed(commit, e),
    mutation: { op: mutant.op.id, metric: mutant.op.metric, level: mutant.level, unit: mutant.op.unit, file: '', snippet: '' },
  }));
  writeFileSync(join(outDir, `${commit.sha}__${mutant.key}.json`), JSON.stringify(result, null, 1));
  progress.endCommit();
  pruneBuilds(result.base?.sha); // сборки мутантов не нужны, база пригодится следующему мутанту
  console.log(
    `[${i + 1}/${mutantJobs.length}] ${commit.sha.slice(0, 8)} + ${mutant.key.padEnd(20)} ${result.status}${result.extended ? ' +ext' : ''}` +
      ` ${summaryLine(result)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
}

for (const [i, commit] of (MUTANTS ? [] : commits).entries()) {
  const t0 = Date.now();
  progress.startCommit(commit.sha, commit.subject);
  const result = await processCommit(commit).catch((e) => crashed(commit, e));
  writeFileSync(join(outDir, `${commit.sha}.json`), JSON.stringify(result, null, 1));
  if (result.status === 'ok' && SELF_AA_EVERY && ++measuredSeen % SELF_AA_EVERY === 0) {
    const aa = await measureSelfAA(result);
    writeFileSync(join(outDir, `${commit.sha}.aa.json`), JSON.stringify(aa, null, 1));
    console.log(`      ${commit.sha.slice(0, 8)} self A/A${aa.extended ? ' +ext' : ''} ${summaryLine(aa)}`);
  }
  progress.endCommit();
  pruneBuilds(result.status === 'ok' || result.status === 'identical_build' ? commit.sha : result.base?.sha);
  console.log(
    `[${i + 1}/${commits.length}] ${commit.sha.slice(0, 8)} ${result.status}${result.aa ? ' (A/A)' : ''}${result.extended ? ' +ext' : ''}` +
      ` ${summaryLine(result)} (${((Date.now() - t0) / 1000).toFixed(0)}s) ${commit.subject.slice(0, 50)}`,
  );
}
progress.finish();
await worker.stop();

// ─── обработка коммита ────────────────────────────────────────────────────────

async function processCommit(c: CommitInfo): Promise<CommitResult> {
  const result: CommitResult = {
    schema: 2,
    repo: cfg.name,
    ...c,
    status: 'ok',
    base: null,
    distHash: null,
    timings: { installMs: null, buildMs: null, measureMs: null },
    bundle: null,
    runs: {},
    baseRuns: {},
    extended: false,
    aa: false,
    method: { pairs: PAIRS, extra: EXTRA, extendRule: EXTEND_RULE },
    env,
  };

  const head = await ensureBuild(c.sha);
  result.timings.installMs = head.installMs;
  result.timings.buildMs = head.buildMs;
  if (!head.ok) return { ...result, status: head.status, error: head.error };
  result.distHash = head.hash;
  result.bundle = head.bundle;

  const base = await findBase(c);
  if (!base) return { ...result, status: 'no_base', error: 'no buildable base commit found' };
  result.base = { sha: base.sha, distHash: base.hash };

  if (base.hash === head.hash) {
    result.status = 'identical_build';
    identicalSeen++;
    if (!AA_EVERY || identicalSeen % AA_EVERY !== 1 % AA_EVERY) return result;
    result.aa = true; // контрольное измерение одинакового кода
  }

  await measureBuilds(result, base.dist, head.dist);
  return result;
}

/**
 * Мутант: база — та же, что у коммита в основном датасете; «коммит» — реальный коммит
 * плюс внедрённый антипаттерн. Так у мутанта настоящий diff коммита + вставка.
 */
async function processMutant(c: CommitInfo, m: Mutant): Promise<CommitResult> {
  const result: CommitResult = {
    schema: 2,
    repo: datasetName,
    ...c,
    status: 'ok',
    base: null,
    distHash: null,
    timings: { installMs: null, buildMs: null, measureMs: null },
    bundle: null,
    runs: {},
    baseRuns: {},
    extended: false,
    aa: false,
    method: { pairs: PAIRS, extra: EXTRA, extendRule: EXTEND_RULE },
    env,
  };
  const head = await ensureBuild(c.sha, 'head', m);
  result.timings.installMs = head.installMs;
  result.timings.buildMs = head.buildMs;
  result.mutation = {
    op: m.op.id, metric: m.op.metric, level: m.level, unit: m.op.unit,
    file: head.mutation?.file ?? '', snippet: head.mutation?.snippet ?? '',
  };
  if (!head.ok) return { ...result, status: head.status, error: head.error };
  result.distHash = head.hash;
  result.bundle = head.bundle;

  const base = await findBase(c);
  if (!base) return { ...result, status: 'no_base', error: 'no buildable base commit found' };
  result.base = { sha: base.sha, distHash: base.hash };
  // мутация не попала в сборку (например, вырезана как мёртвый код) — это тоже результат
  if (base.hash === head.hash) return { ...result, status: 'identical_build' };

  await measureBuilds(result, base.dist, head.dist);
  return result;
}

/** Замер пары сборок (A — база, B — коммит) во всех страницах; заполняет runs/baseRuns результата. */
async function measureBuilds(result: CommitResult, distA: string, distB: string) {
  progress.stage('warmup', { baseSha: result.base?.sha, role: 'head' });
  const tm = Date.now();
  // свежий воркер на каждое сравнение: память Lighthouse не копится, а перезапуск
  // никогда не попадает внутрь серии A/B
  await worker.restart();
  const [serverA, serverB] = await Promise.all([serveStatic(distA, { fallback: cfg.spaFallback }), serveStatic(distB, { fallback: cfg.spaFallback })]);
  try {
    for (const page of cfg.pages) {
      const { baseRuns, headRuns, extended, hosts } = await measurePair(page, serverA.url, serverB.url);
      result.baseRuns[page.name] = baseRuns;
      result.runs[page.name] = headRuns;
      result.extended ||= extended;
      result.externalHosts = hosts;
    }
  } finally {
    await Promise.all([serverA.close(), serverB.close()]);
  }
  result.timings.measureMs = Date.now() - tm;
  const allFailed = [...Object.values(result.runs), ...Object.values(result.baseRuns)].every((rs) =>
    rs.every((r) => r.error),
  );
  if (allFailed) result.status = 'measure_failed';
}

/**
 * Контрольное A/A: сборка коммита против самой себя (два сервера, одни и те же файлы),
 * по той же процедуре, включая расширение серии. Одинаковые сборки соседних коммитов
 * оказались редкими (~2%), поэтому A/A-пары добираем так — для оценки доли ложных срабатываний.
 */
async function measureSelfAA(head: CommitResult): Promise<CommitResult> {
  const dist = join(buildsDir, head.sha);
  const aa: CommitResult = {
    ...head,
    status: 'identical_build',
    base: { sha: head.sha, distHash: head.distHash ?? '' },
    timings: { installMs: null, buildMs: null, measureMs: null },
    runs: {},
    baseRuns: {},
    extended: false,
    aa: true,
    selfAA: true,
  };
  await measureBuilds(aa, dist, dist);
  return aa;
}

/** Чередование AB BA AB BA… с расширением при подозрении на изменение. */
async function measurePair(page: PageConfig, urlA: string, urlB: string) {
  const baseRuns: PageRun[] = [];
  const headRuns: PageRun[] = [];
  let seq = 0;

  // лёгкий прогрев обеих версий (загрузка в Chrome без Lighthouse): дисковый кеш ОС, сервер,
  // заодно прогревается и свежий воркер — одинаково для A и B
  progress.stage('warmup', { page: page.name });
  const none = { external: [] as string[], blocked: [] as string[] };
  const hostsA = await worker.warmup(page.name, urlA).catch(() => none);
  const hostsB = await worker.warmup(page.name, urlB).catch(() => none);
  const hosts = {
    external: [...new Set([...hostsA.external, ...hostsB.external])].sort(),
    blocked: [...new Set([...hostsA.blocked, ...hostsB.blocked])].sort(),
  };

  const runPairs = async (from: number, to: number, total: number) => {
    for (let i = from; i < to; i++) {
      const order: ('A' | 'B')[] = i % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
      for (const side of order) {
        progress.stage('measure', { page: page.name, run: i + 1, total, side });
        let run: PageRun;
        try {
          run = await worker.measure(page.name, side === 'A' ? urlA : urlB);
        } catch (e) {
          run = { navigation: {}, interaction: null, error: String(e).slice(0, 2000) };
        }
        run.seq = seq++;
        (side === 'A' ? baseRuns : headRuns).push(run);
      }
    }
  };

  await runPairs(0, PAIRS, PAIRS);
  const extended = EXTRA > 0 && isSuspicious(baseRuns, headRuns);
  if (extended) await runPairs(PAIRS, PAIRS + EXTRA, PAIRS + EXTRA);
  return { baseRuns, headRuns, extended, hosts };
}

/**
 * Подозрение на изменение: p < SUSPECT_P **и** |Δ| ≥ SUSPECT_DELTA·порога хотя бы по одной метрике.
 * Раньше было «или»: одно p < 0.1 из пяти метрик случайно выпадает в ~30–40% сравнений,
 * и на первых 160 коммитах расширялся 31% — почти столько же, сколько дал бы чистый шум
 * (включая A/A-пару с одинаковым кодом).
 */
function isSuspicious(baseRuns: PageRun[], headRuns: PageRun[]): boolean {
  // только основные метрики: дополнительные (наблюдаемый LCP) процедуру сбора не меняют
  return PRIMARY_TARGETS.some((t) => {
    const cmp = compare(baseRuns, headRuns, t);
    return !!cmp && cmp.p < SUSPECT_P && Math.abs(cmp.delta) >= SUSPECT_DELTA * cmp.threshold;
  });
}

// ─── сборки и их кеш ──────────────────────────────────────────────────────────

interface Build {
  sha: string;
  ok: boolean;
  status: CommitStatus;
  error?: string;
  dist: string;
  hash: string;
  bundle: BundleStats | null;
  installMs: number | null;
  buildMs: number | null;
  mutation?: { file: string; snippet: string };
}

/**
 * Сборка коммита из кеша или заново. Кеш хранит только статические файлы (без source maps).
 * С `mutant` — сборка коммита с внедрённым антипаттерном (свой ключ кеша: <sha>__<мутант>).
 */
async function ensureBuild(sha: string, role: 'head' | 'base' = 'head', mutant?: Mutant): Promise<Build> {
  const key = mutant ? `${sha}__${mutant.key}` : sha;
  const dist = join(buildsDir, key);
  const metaFile = join(buildsDir, `${key}.meta.json`);
  if (existsSync(metaFile) && existsSync(join(dist, 'index.html'))) {
    return { ...JSON.parse(readFileSync(metaFile, 'utf8')), dist, installMs: null, buildMs: null };
  }
  const fail = (status: CommitStatus, error: string, installMs: number | null, buildMs: number | null): Build => ({
    sha, ok: false, status, error: error.slice(-2000), dist, hash: '', bundle: null, installMs, buildMs,
  });
  const log = (name: string, text: string) => writeFileSync(join(logDir, `${key}.${name}.log`), text);

  progress.stage('checkout', { role });
  await checkout(repoDir, sha);

  let installMs: number | null = null;
  let buildMs: number | null = null;
  const add = (acc: number | null, ms: number) => (acc ?? 0) + ms;

  // Вторая попытка — с нуля: node_modules переиспользуются между коммитами, и после смены
  // lock-файла дерево иногда оказывается неполным («Cannot find module …») — это сбой стенда,
  // а не коммита. Удаляем всё игнорируемое git (включая node_modules) и ставим заново.
  for (const clean of [false, true]) {
    const suffix = clean ? '.clean' : '';
    if (clean) {
      progress.stage('install', { role });
      await cleanAll(repoDir);
      writeFileSync(stateFile, '');
    }

    const hash = installHash();
    const prevHash = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '';
    if (hash !== prevHash) {
      progress.stage('install', { role });
      const r = await sh(cfg.install, { cwd: repoDir, env: cfg.env, timeoutMs: INSTALL_TIMEOUT });
      installMs = add(installMs, r.ms);
      if (r.code !== 0) {
        log('install' + suffix, r.output);
        writeFileSync(stateFile, '');
        if (!clean) continue;
        return fail('install_failed', r.output, installMs, buildMs);
      }
      writeFileSync(stateFile, hash);
    }

    // мутацию внедряем в каждой попытке заново: git clean во второй попытке не откатывает
    // изменения отслеживаемых файлов, а applyMutation идемпотентна (исходник берётся из HEAD)
    const mutation = mutant ? await applyMutation(cfg, repoDir, mutant) : undefined;
    progress.stage('build', { role });
    const b = await sh(cfg.build, { cwd: repoDir, env: cfg.env, timeoutMs: BUILD_TIMEOUT });
    buildMs = add(buildMs, b.ms);
    const src = join(repoDir, cfg.distDir);
    if (b.code !== 0 || !existsSync(join(src, 'index.html'))) {
      log('build' + suffix, b.output);
      // переустановка с нуля лечит только поломанные node_modules; ошибку в самом коммите
      // (битая ссылка VitePress, ошибка TypeScript) она не исправит — не тратим на неё минуту
      if (!clean && looksLikeBrokenDeps(b.output)) continue;
      return fail('build_failed', b.output, installMs, buildMs);
    }

    progress.stage('bundle', { role });
    rmSync(dist, { recursive: true, force: true });
    cpSync(src, dist, { recursive: true, filter: (p) => !p.endsWith('.map') });
    const meta = { sha, ok: true, status: 'ok' as const, hash: distHash(dist), bundle: bundleStats(dist), cleanRetry: clean, mutation };
    writeFileSync(metaFile, JSON.stringify(meta));
    return { ...meta, dist, installMs, buildMs };
  }
  throw new Error('unreachable');
}

/**
 * Непредвиденная ошибка на одном коммите (например, git не смог почистить рабочую копию)
 * не должна останавливать многочасовой сбор: записываем её как сбой этого коммита.
 * Такие коммиты пересобираются через --retry-failed.
 */
function crashed(c: CommitInfo, e: unknown): CommitResult {
  const error = String((e as Error)?.stack ?? e).slice(0, 4000);
  writeFileSync(join(logDir, `${c.sha}.crash.log`), error);
  console.error(`   ${c.sha.slice(0, 8)}: непредвиденная ошибка — записана как build_failed, сбор продолжается`);
  return {
    schema: 2, repo: datasetName, ...c, status: 'build_failed', error, base: null, distHash: null,
    timings: { installMs: null, buildMs: null, measureMs: null }, bundle: null, runs: {}, baseRuns: {},
    extended: false, aa: false, method: { pairs: PAIRS, extra: EXTRA, extendRule: EXTEND_RULE }, env,
  };
}

/**
 * Похоже ли падение сборки на поломку node_modules (тогда поможет установка с нуля),
 * а не на ошибку в коде коммита. Признаки взяты из реальных сбоев: excalidraw
 * («Cannot find module '@babel/helper-split-export-declaration'»), смена менеджера пакетов.
 */
function looksLikeBrokenDeps(output: string): boolean {
  return /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_PNPM|ENOENT[^\n]*node_modules|is not recognized as an internal or external command|не является внутренней или внешней/i.test(
    output,
  );
}

/** База — ближайший более ранний коммит диапазона, который удаётся собрать. */
async function findBase(c: CommitInfo): Promise<Build | null> {
  const idx = indexOf.get(c.sha) ?? -1;
  const candidates = allCommits.slice(Math.max(0, idx - MAX_BASE_LOOKBACK), Math.max(0, idx)).map((x) => x.sha).reverse();
  // у первого коммита диапазона предшественников в списке нет — берём его git-родителя
  if (idx === 0 && c.parent) candidates.push(c.parent);
  for (const sha of candidates) {
    const b = await ensureBuild(sha, 'base');
    if (b.ok) return b;
  }
  return null;
}

/** Держим в кеше только сборку, которая станет базой для следующего коммита. */
function pruneBuilds(keep: string | undefined) {
  for (const name of readdirSync(buildsDir)) {
    if (keep && name.startsWith(keep)) continue;
    rmSync(join(buildsDir, name), { recursive: true, force: true });
  }
}

function installHash(): string {
  const h = createHash('sha1');
  for (const f of cfg.installInputs) {
    const p = join(repoDir, f);
    h.update(f).update(existsSync(p) ? readFileSync(p) : '');
  }
  return h.digest('hex');
}

// ─── прочее ───────────────────────────────────────────────────────────────────

function alreadyDone(sha: string): boolean {
  const file = join(outDir, `${sha}.json`);
  if (!existsSync(file)) return false;
  const r = JSON.parse(readFileSync(file, 'utf8'));
  // файлы старой схемы (без базы) пересобираем
  if (r.schema !== 2) return false;
  return !args['retry-failed'] || r.status === 'ok' || r.status === 'identical_build';
}

function summaryLine(r: CommitResult): string {
  const page = cfg.pages[0].name;
  if (!r.runs[page]) return '';
  // Core Web Vitals (LCP, INP, CLS) + TBT как лабораторный прокси INP: «медиана коммита (Δ к базе, p)»
  return (['lcp', 'inp', 'cls', 'tbt'] as TargetName[])
    .map((t) => {
      const cmp = compare(r.baseRuns[page], r.runs[page], t);
      if (!cmp) return `${t}=—`;
      const d = t === 'cls' ? 3 : 0;
      // округлённый ноль — «0», без «-0»
      const delta = Number(cmp.delta.toFixed(d)) === 0 ? '0' : `${cmp.delta > 0 ? '+' : ''}${cmp.delta.toFixed(d)}`;
      return `${t}=${cmp.head.toFixed(d)} (${delta}, p=${cmp.p.toFixed(2)})`;
    })
    .join(' ') +
    // внешние домены, которые страница грузит без блокировки, — кандидаты в blockedUrlPatterns
    (r.externalHosts?.external.length ? ` внешние: ${r.externalHosts.external.join(', ')}` : '');
}
