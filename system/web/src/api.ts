// Данные панели: те же пути под живым сервером (FastAPI) и в статической копии (файлы *.json).
import { useEffect, useState } from 'react';

export type Level = 'high' | 'elevated' | 'low';
export type MetricKey = 'lcp' | 'inp' | 'cls' | 'tbt' | 'tbtFlow' | 'lcpObs';

export interface Metric {
  base: number | null;
  head: number | null;
  delta: number | null;
  rel: number | null;
  q: number | null;
  label: 'regression' | 'improvement' | 'none' | string;
}

export interface Reason {
  feature: string;
  label: string;
  value: number;
  percentile: number;
  weight: number;
}

export interface Change {
  project: string;
  sha: string;
  kind: 'commit' | 'pr';
  pr: number | null;
  base: string;
  date: string;
  subject: string;
  selection: string;
  risk: number | null;
  /** доля коммитов проекта с более высоким риском: 0 — самый рискованный */
  place: number | null;
  level: Level | null;
  measured: number;
  status: string | null;
  label: string | null;
  metrics: Partial<Record<MetricKey, Metric>> | null;
  k_la: number | null;
  k_ld: number | null;
  reasons: Reason[] | null;
}

export interface ExternalState {
  slug: string;
  name: string;
  url: string;
  branch: string | null;
  /** queued → clone → features → scoring → ready | error */
  status: 'queued' | 'clone' | 'features' | 'scoring' | 'ready' | 'error';
  done: number;
  total: number;
  message: string;
  history: number;
  added: string;
  finished: string | null;
}

export interface Project {
  name: string;
  url: string | null;
  group_name: 'study' | 'new' | 'external';
  external?: ExternalState | null;
  commits: number;
  scored: number;
  measured: number;
  regressions: number;
  prs: number;
  first_date: string;
  last_date: string;
}

export interface BudgetPoint {
  model: number;
  model_ci: [number, number];
  size: number;
  size_ci: [number, number];
  diff_ci: [number, number];
  random: number;
}

export interface Meta {
  live: boolean;
  ingested: string | null;
  queues: { github: string; bench: string }[];
  model: { kind: string; trained_on: string[]; pairs: number; regressions: number; created: string };
  levels: { top: number; level: Level; name: string; rate: number }[];
  budget_curve?: { total: number; budgets: Record<string, BudgetPoint> };
}

export interface Summary {
  projects: number;
  n: number;
  scored: number;
  measured: number;
  regressions: number;
  prs: number;
  by_level: { level: Level; n: number; regressions: number }[];
}

export interface QueueItem {
  github: string;
  bench?: string;
  number?: number;
  title?: string;
  url?: string;
  pr_state?: string;
  state?: 'queued' | 'measured' | 'other';
  result?: 'regression' | 'ok' | null;
  updated?: string;
  error?: string;
}

export interface Assessment {
  merge_base?: string;
  risk: number;
  place: number;
  level: Level;
  level_name: string;
  expected_rate: number;
  history: number;
  lines_added: number;
  lines_deleted: number;
  files: number;
  reasons: Reason[];
}

export interface PullRequest {
  number: number;
  title: string;
  headRefOid: string;
  baseRefName: string;
  author: string | null;
  updatedAt: string;
  url: string;
  additions: number;
  deletions: number;
  isDraft: boolean;
  assessed: { level: Level; place: number } | null;
}

export interface Refs {
  default: string;
  branches: string[];
  commits: { sha: string; date: string; subject: string }[];
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`api/${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const r = await fetch(`api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  meta: () => get<Meta>('meta.json'),
  summary: () => get<Summary>('summary.json'),
  projects: () => get<Project[]>('projects.json'),
  project: (name: string) => get<{ project: Project; changes: Change[] }>(`projects/${encodeURIComponent(name)}.json`),
  queue: () => get<QueueItem[]>('queue.json'),
  assess: (body: { project: string; base: string; head: string }) => post<Assessment>('assess', body),
  addExternal: (url: string, history: number) => post<{ slug: string }>('external', { url, history }),
  refreshExternal: (slug: string) => post<{ slug: string }>(`external/${slug}/refresh`),
  deleteExternal: (slug: string) => post<{ ok: boolean }>(`external/${slug}`, undefined, 'DELETE'),
  prs: (project: string) => get<PullRequest[]>(`projects/${encodeURIComponent(project)}/prs.json`),
  assessPr: (project: string, n: number) => post<Assessment & { pr: number; title: string; url: string }>(`projects/${project}/prs/${n}/assess`),
  refs: (project: string) => get<Refs>(`projects/${encodeURIComponent(project)}/refs.json`),
  explain: (project: string, sha: string) =>
    post<{ reasons: Reason[]; history_place: number; history_level: Level; history: number }>(`explain/${project}/${sha}`),
};

/**
 * Загрузка с состоянием: данные, ошибка, идёт ли загрузка; reload() — перечитать (тихо, без мигания данных);
 * pollMs — перечитывать по таймеру, пока poll(data) возвращает true (прогресс фоновых заданий).
 */
export function useData<T>(load: () => Promise<T>, deps: unknown[] = [], opts: { pollMs?: number; poll?: (d: T) => boolean } = {}) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    load()
      .then((data) => alive && setState({ data, loading: false }))
      .catch((e: Error) => alive && setState((s) => ({ ...s, error: e.message, loading: false })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  useEffect(() => {
    if (!opts.pollMs || !state.data || !opts.poll?.(state.data)) return;
    const t = setTimeout(() => setTick((x) => x + 1), opts.pollMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data]);
  return { ...state, reload: () => setTick((x) => x + 1) };
}
