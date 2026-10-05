import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { shOk } from './exec.ts';
import type { RepoConfig } from './types.ts';

export interface CommitInfo {
  sha: string;
  parent: string | null;
  date: string;
  subject: string;
}

export async function ensureClone(cfg: RepoConfig, dir: string) {
  if (existsSync(dir)) return;
  await shOk(`git clone --filter=blob:none --no-checkout ${cfg.url} "${dir}"`, process.cwd());
}

/** First-parent коммиты ветки (от старых к новым). */
export async function listCommits(cfg: RepoConfig, dir: string): Promise<CommitInfo[]> {
  await shOk(`git fetch --quiet origin ${cfg.branch}`, dir);
  // дату без времени git дополняет ТЕКУЩИМ временем суток — граница диапазона «плавала» в зависимости
  // от часа запуска (monkeytype: 1179 коммитов утром, 1174 днём); явно берём начало и конец суток
  const day = (d: string, time: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} ${time}` : d);
  const range = [
    cfg.since ? `--since="${day(cfg.since, '00:00:00')}"` : '',
    cfg.until ? `--until="${day(cfg.until, '23:59:59')}"` : '',
  ].join(' ');
  const paths = cfg.pathsFilter?.length ? `-- ${cfg.pathsFilter.map((p) => `"${p}"`).join(' ')}` : '';
  // \x1f — разделитель полей, который не встречается в сообщениях коммитов
  const out = await shOk(
    `git log --first-parent --reverse ${range} --format=%H%x1f%P%x1f%cI%x1f%s origin/${cfg.branch} ${paths}`,
    dir,
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, date, subject] = line.split('\x1f');
      return { sha, parent: parents.split(' ')[0] || null, date, subject };
    });
}

/**
 * core.longPaths: pnpm кладёт пакеты по путям длиннее 260 символов
 * (node_modules/.pnpm/<пакет>@<версия>_<зависимости>_<хеш>/…), и без этого git на Windows
 * не может их удалить — так однажды упал весь сбор vuejs-docs.
 */
const GIT = 'git -c core.longPaths=true';

export async function checkout(dir: string, sha: string) {
  await shOk(`${GIT} checkout --quiet --force ${sha}`, dir);
  // node_modules оставляем: переустановка решается по хешу lock-файлов
  await shOk(`${GIT} clean -fdxq -e node_modules`, dir);
}

/**
 * Удалить всё игнорируемое git, включая node_modules (переустановка с нуля).
 * Если git не справится (длинные пути, занятые файлы), node_modules удаляются средствами Node
 * (fs поддерживает длинные пути Windows) и git clean повторяется.
 */
export async function cleanAll(dir: string) {
  // git clean удаляет node_modules от pnpm (~900 пакетов) 20–30 минут: проверяет каждый файл по .gitignore.
  // rmdir в Windows удаляет быстрее и не заходит внутрь junction-ссылок pnpm; \\?\ — для длинных путей.
  const nm = join(dir, 'node_modules');
  if (process.platform === 'win32' && existsSync(nm)) {
    await shOk(`cmd /d /c rmdir /s /q "\\\\?\\${nm}"`, dir).catch(() => {}); // не вышло — доудалит git clean
  }
  try {
    await shOk(`${GIT} clean -fdxq`, dir);
    return;
  } catch {
    // ниже — запасной путь
  }
  const walk = (d: string, depth: number) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.name === 'node_modules') rmSync(p, { recursive: true, force: true, maxRetries: 3 });
      else if (depth < 3) walk(p, depth + 1); // workspaces монорепозиториев: packages/*/node_modules
    }
  };
  walk(dir, 0);
  await shOk(`${GIT} clean -fdxq`, dir);
}
