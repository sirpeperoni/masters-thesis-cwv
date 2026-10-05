/**
 * Долгоживущий процесс для прогонов Lighthouse.
 *
 * Lighthouse в долгоживущем процессе копит память (~0.5 ГБ на коммит) и падает с OOM,
 * поэтому run.ts перезапускает этот процесс каждые несколько прогонов. Но и не запускает
 * новый на каждый прогон: старт Node + tsx + импорт Lighthouse стоит ~3–4 с.
 * Chrome при этом свежий на каждом прогоне (новый временный профиль).
 *
 *   node --import tsx src/measure-worker.ts <repo>
 *
 * Протокол: по строке JSON на команду в stdin — {id, kind: 'measure' | 'warmup', page, url};
 * ответ — строка `@@result {id, run?, error?}` в stdout (префикс отделяет её от логов).
 */
import { createInterface } from 'node:readline';
import { measurePage, warmup } from './measure.ts';
import type { RepoConfig } from './types.ts';
import { RESULT_PREFIX, type WorkerCommand } from './worker-client.ts';

const [repo] = process.argv.slice(2);
const cfg: RepoConfig = (await import(`../repos/${repo}.ts`)).default;

const reply = (msg: object) => process.stdout.write(RESULT_PREFIX + JSON.stringify(msg) + '\n');

// Команды приходят строго по одной (run.ts ждёт ответа), поэтому обрабатываем последовательно.
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const cmd: WorkerCommand = JSON.parse(line);
  const page = cfg.pages.find((p) => p.name === cmd.page);
  try {
    if (!page) throw new Error(`page ${cmd.page} not found in ${repo}`);
    const blocked = cfg.blockedUrlPatterns ?? [];
    if (cmd.kind === 'warmup') {
      reply({ id: cmd.id, hosts: await warmup(cmd.url, page, blocked) });
    } else {
      reply({ id: cmd.id, run: await measurePage(cmd.url, page, blocked) });
    }
  } catch (e) {
    reply({ id: cmd.id, error: String((e as Error)?.stack ?? e).slice(0, 2000) });
  }
}
process.exit(0);
