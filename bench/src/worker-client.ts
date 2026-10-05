import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { killTree } from './exec.ts';
import type { PageRun } from './types.ts';

/** Префикс строки-ответа воркера — отделяет результат от логов Lighthouse. */
export const RESULT_PREFIX = '@@result ';

export interface WorkerCommand {
  id: number;
  kind: 'measure' | 'warmup';
  page: string;
  url: string;
}

export interface WarmupHosts {
  external: string[];
  blocked: string[];
}

export interface WorkerReply {
  id: number;
  run?: PageRun;
  hosts?: WarmupHosts;
  error?: string;
}

interface Pending {
  resolve: (msg: WorkerReply) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Клиент долгоживущего measure-worker.ts.
 * run.ts перезапускает воркер в начале каждого измеряемого коммита (restart()):
 * память Lighthouse не успевает накопиться, а перезапуск никогда не попадает внутрь серии A/B.
 */
export class LighthouseWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private buf = '';
  private logTail = '';

  constructor(
    private repo: string,
    private timeoutMs: number,
  ) {}

  async restart() {
    await this.stop();
    const script = join(import.meta.dirname, 'measure-worker.ts');
    const proc = spawn(process.execPath, ['--max-old-space-size=8192', '--import', 'tsx', script, this.repo], {
      cwd: join(import.meta.dirname, '..'),
      windowsHide: true,
    });
    this.proc = proc;
    this.buf = '';
    this.logTail = '';
    proc.stdout.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trimEnd();
        this.buf = this.buf.slice(i + 1);
        if (line.startsWith(RESULT_PREFIX)) this.onResult(JSON.parse(line.slice(RESULT_PREFIX.length)));
        else this.log(line + '\n');
      }
    });
    proc.stderr.on('data', (d: Buffer) => this.log(d.toString()));
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      this.failAll(new Error(`worker exited (${code}): ${this.logTail}`));
    });
  }

  async measure(page: string, url: string): Promise<PageRun> {
    return (await this.request('measure', page, url)).run!;
  }

  /** Прогрев; возвращает внешние домены, к которым обращалась страница. */
  async warmup(page: string, url: string): Promise<WarmupHosts> {
    return (await this.request('warmup', page, url)).hosts ?? { external: [], blocked: [] };
  }

  async stop() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    proc.stdin.end();
    const exited = new Promise<void>((r) => proc.once('exit', () => r()));
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000));
    if ((await Promise.race([exited, timeout])) === 'timeout') killTree(proc.pid);
  }

  private async request(kind: WorkerCommand['kind'], page: string, url: string): Promise<WorkerReply> {
    if (!this.proc) await this.restart();
    const id = this.nextId++;
    const cmd: WorkerCommand = { id, kind, page, url };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${kind} timeout after ${this.timeoutMs} ms: ${this.logTail}`));
        // зависший прогон — убиваем воркер целиком, следующий запрос поднимет новый
        const proc = this.proc;
        this.proc = null;
        killTree(proc?.pid);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify(cmd) + '\n');
    });
  }

  private onResult(msg: WorkerReply) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg);
  }

  private failAll(e: Error) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
      this.pending.delete(id);
    }
  }

  private log(text: string) {
    this.logTail = (this.logTail + text).slice(-1500);
  }
}
