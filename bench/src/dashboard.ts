/**
 * Локальная панель наблюдения за сбором датасета.
 *
 *   npx tsx src/dashboard.ts [--port 4173]
 *
 * Читает work/status/<repo>.json (что происходит сейчас) и data/<repo>/*.json (что уже измерено).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RunStatus } from "./progress.ts";
import { compare, TARGETS, type TargetName } from "./stats.ts";
import type { CommitResult, RepoConfig } from "./types.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DATA = join(ROOT, "data");
const STATUS = join(ROOT, "work", "status");
const REPOS = join(import.meta.dirname, "..", "repos");
const STALE_MS = 30 * 60_000;

const { values: args } = parseArgs({
  options: { port: { type: "string", default: "4173" } },
});

/** Метрики для графиков: [источник, ключ]. */
const METRICS = {
  lcp: ["navigation", "lcp"],
  cls: ["navigation", "cls"],
  tbt: ["navigation", "tbt"],
  inp: ["interaction", "inp"],
  tbtInteraction: ["interaction", "tbt"],
} as const;

interface Summary {
  sha: string;
  date: string;
  subject: string;
  status: CommitResult["status"];
  measuredAt: number;
  runs: number;
  failedRuns: number;
  bundleGzip: number | null;
  jsGzip: number | null;
  seconds: {
    install: number | null;
    build: number | null;
    measure: number | null;
  };
  /** metric → [p25, median, p75] */
  stats: Record<string, [number, number, number] | null>;
  baseSha: string | null;
  aa: boolean;
  selfAA: boolean;
  extended: boolean;
  /** Сравнение с базой (без поправки на множественные сравнения — итог в label.ts). */
  deltas: Partial<Record<TargetName, { delta: number; p: number; threshold: number }>>;
}

// Кеш разобранных результатов по mtime: файлов сотни, опрос каждые несколько секунд.
const cache = new Map<string, { mtime: number; summary: Summary }>();

function summarize(file: string): Summary | null {
  const mtime = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit?.mtime === mtime) return hit.summary;
  let r: CommitResult;
  try {
    r = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return hit?.summary ?? null; // файл пишется прямо сейчас
  }
  const page = Object.keys(r.runs ?? {})[0];
  const runs = (page && r.runs[page]) || [];
  const baseRuns = (page && r.baseRuns?.[page]) || [];
  const stats: Summary["stats"] = {};
  for (const [name, [src, key]] of Object.entries(METRICS)) {
    stats[name] = quartiles(runs.map((run) => run[src]?.[key]));
  }
  const deltas: Summary["deltas"] = {};
  for (const t of Object.keys(TARGETS) as TargetName[]) {
    const c = compare(baseRuns, runs, t);
    if (c) deltas[t] = { delta: c.delta, p: c.p, threshold: c.threshold };
  }
  const summary: Summary = {
    sha: r.sha,
    date: r.date,
    // у мутанта в теме — какой антипаттерн и какой силы внедрён
    subject: r.mutation ? `${r.subject}  ⟶ ${r.mutation.op} ${r.mutation.level}${r.mutation.unit}` : r.subject,
    status: r.status,
    measuredAt: mtime,
    runs: runs.length + baseRuns.length,
    failedRuns: [...runs, ...baseRuns].filter((x) => x.error).length,
    bundleGzip: r.bundle?.totalGzip ?? null,
    jsGzip: r.bundle?.byExt[".js"]?.gzip ?? null,
    seconds: {
      install: sec(r.timings?.installMs),
      build: sec(r.timings?.buildMs),
      measure: sec(r.timings?.measureMs),
    },
    stats,
    baseSha: r.base?.sha ?? null,
    aa: !!r.aa,
    selfAA: !!r.selfAA,
    extended: !!r.extended,
    deltas,
  };
  cache.set(file, { mtime, summary });
  return summary;
}

function quartiles(
  xs: (number | null | undefined)[],
): [number, number, number] | null {
  const v = xs
    .filter((x): x is number => typeof x === "number")
    .sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p: number) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    return v[lo] + (v[Math.ceil(i)] - v[lo]) * (i - lo);
  };
  return [q(0.25), q(0.5), q(0.75)];
}

const sec = (ms: number | null | undefined) =>
  typeof ms === "number" ? ms / 1000 : null;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function repoUrl(name: string): Promise<string | null> {
  const file = join(REPOS, `${name}.ts`);
  if (!existsSync(file)) return null;
  const cfg: RepoConfig = (await import(`../repos/${name}.ts`)).default;
  return cfg.url.replace(/\.git$/, "");
}

async function state() {
  const names = new Set<string>();
  // репозитории — это папки в data/ (рядом лежат CSV с разметкой) и файлы статуса
  if (existsSync(DATA)) {
    for (const f of readdirSync(DATA, { withFileTypes: true })) {
      if (f.isDirectory()) names.add(f.name);
    }
  }
  if (existsSync(STATUS)) {
    for (const f of readdirSync(STATUS)) names.add(basename(f, ".json"));
  }
  const repos = [];
  for (const name of [...names].sort()) {
    const statusFile = join(STATUS, `${name}.json`);
    let status: (RunStatus & { finished?: boolean }) | null = null;
    if (existsSync(statusFile)) {
      try {
        status = JSON.parse(readFileSync(statusFile, "utf8"));
      } catch {}
    }
    const alive =
      !!status &&
      !status.finished &&
      isAlive(status.pid) &&
      Date.now() - status.updatedAt < STALE_MS;
    const dir = join(DATA, name);
    const commits = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => summarize(join(dir, f)))
          .filter((s): s is Summary => !!s)
          .sort((a, b) => a.date.localeCompare(b.date))
      : [];
    repos.push({ name, url: await repoUrl(name), status, alive, commits });
  }
  return { now: Date.now(), repos };
}

const html = () => readFileSync(join(import.meta.dirname, "dashboard.html"));

createServer(async (req, res) => {
  try {
    if (req.url === "/api/state") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(await state()));
    } else if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html());
    } else {
      res.writeHead(404).end();
    }
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
  }
})
  .on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EADDRINUSE") throw e;
    console.error(
      `Порт ${args.port} занят — панель, скорее всего, уже запущена: http://localhost:${args.port}`,
    );
    console.error("Другой порт: npm run dashboard -- --port 4174");
    process.exit(1);
  })
  .listen(Number(args.port), "127.0.0.1", () => {
    console.log(`Dashboard: http://localhost:${args.port}`);
  });
