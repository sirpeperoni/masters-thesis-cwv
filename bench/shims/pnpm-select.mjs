// Выбор версии pnpm для обёртки pnpm.cmd.
// Если у проекта есть packageManager в package.json — версию выбирает corepack (как раньше).
// Если нет — corepack берёт «последнюю известную» версию, а это pnpm 12, который corepack 0.34 запустить
// не может (в кеше нет bin/pnpm.cjs; пробы 09.10: shadcn-admin, старые jsoncrack и lexical). Тогда версия —
// по формату pnpm-lock.yaml, как у авторов в то время: lockfile 6.0 → pnpm 8, 9.0 → pnpm 9.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BY_LOCKFILE = { '5.4': '7.33.7', '6.0': '8.15.9', '9.0': '9.15.9' };

function pick() {
  let dir = process.cwd();
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).packageManager) return 'pnpm';
      } catch {}
    }
    const lock = join(dir, 'pnpm-lock.yaml');
    if (existsSync(lock)) {
      const v = /lockfileVersion:\s*'?([\d.]+)'?/.exec(readFileSync(lock, 'utf8').slice(0, 200))?.[1];
      return `pnpm@${BY_LOCKFILE[v] ?? BY_LOCKFILE['9.0']}`;
    }
    const up = dirname(dir);
    if (up === dir) return `pnpm@${BY_LOCKFILE['9.0']}`;
    dir = up;
  }
}

const r = spawnSync('corepack', [pick(), ...process.argv.slice(2)], { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
