import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  output: string;
  ms: number;
}

/** Запуск shell-команды с таймаутом; на Windows убиваем всё дерево процессов. */
export function sh(
  cmd: string,
  opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd: opts.cwd,
      shell: true,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
    let output = '';
    const onData = (d: Buffer) => {
      output += d.toString();
      // держим в памяти только хвост лога
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          output += `\n[timeout after ${opts.timeoutMs} ms]`;
          killTree(child.pid);
        }, opts.timeoutMs)
      : null;

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, output, ms: Date.now() - started });
    });
  });
}

export function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
  else process.kill(-pid, 'SIGKILL');
}

export async function shOk(cmd: string, cwd: string): Promise<string> {
  const r = await sh(cmd, { cwd });
  if (r.code !== 0) throw new Error(`${cmd} failed (${r.code}):\n${r.output}`);
  return r.output.trim();
}
