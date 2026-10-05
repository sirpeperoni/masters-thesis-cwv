import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Stage =
  | 'checkout'
  | 'install'
  | 'build'
  | 'bundle'
  | 'warmup'
  | 'measure'
  | 'idle'
  | 'done';

export interface RunStatus {
  repo: string;
  pid: number;
  startedAt: number;
  updatedAt: number;
  /** Пар прогонов (база+коммит) в первичной проверке и после расширения. */
  pairs: { initial: number; extended: number };
  /** Сколько коммитов в диапазоне конфига вообще (для общего прогресса по репозиторию). */
  totalInRange: number;
  /** Очередь этого запуска. */
  queue: number;
  done: number;
  current: {
    sha: string;
    subject: string;
    stage: Stage;
    stageStartedAt: number;
    commitStartedAt: number;
    page?: string;
    run?: number;
    /** Сколько пар планируется сейчас (initial или initial+extended). */
    total?: number;
    /** A — база, B — коммит. */
    side?: 'A' | 'B';
    baseSha?: string;
    /** Чью сборку сейчас делаем: коммита или базы для сравнения. */
    role?: 'head' | 'base';
  } | null;
  /** Длительность обработанных в этом запуске коммитов, сек. */
  durations: number[];
}

/** Статус текущего запуска в work/status/<repo>.json — его читает дашборд. */
export class Progress {
  status: RunStatus;

  constructor(
    private file: string,
    init: Pick<RunStatus, 'repo' | 'pairs' | 'totalInRange' | 'queue'>,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    const now = Date.now();
    this.status = { ...init, pid: process.pid, startedAt: now, updatedAt: now, done: 0, current: null, durations: [] };
    this.flush();
  }

  startCommit(sha: string, subject: string) {
    const now = Date.now();
    this.status.current = { sha, subject, stage: 'checkout', stageStartedAt: now, commitStartedAt: now };
    this.flush();
  }

  stage(stage: Stage, extra: Partial<Pick<NonNullable<RunStatus['current']>, 'page' | 'run' | 'total' | 'side' | 'baseSha' | 'role'>> = {}) {
    if (this.status.current) {
      Object.assign(this.status.current, { stage, stageStartedAt: Date.now(), ...extra });
    }
    this.flush();
  }

  endCommit() {
    const cur = this.status.current;
    if (cur) this.status.durations.push((Date.now() - cur.commitStartedAt) / 1000);
    this.status.done++;
    this.status.current = null;
    this.flush();
  }

  finish() {
    this.status.current = null;
    this.flush('done');
  }

  private flush(final?: 'done') {
    this.status.updatedAt = Date.now();
    writeFileSync(this.file, JSON.stringify({ ...this.status, finished: final === 'done' }));
  }
}
