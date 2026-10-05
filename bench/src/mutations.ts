/**
 * Искусственные регрессии (мутанты): известный антипаттерн заданной силы, внедрённый
 * в реальный коммит перед сборкой.
 *
 * Зачем:
 *  1. чувствительность стенда — при какой силе антипаттерна регрессия уверенно обнаруживается
 *     (эмпирический MDE, RQ1);
 *  2. размеченные положительные примеры по метрикам, по которым реальных регрессий мало
 *     (INP, CLS).
 *
 * Код пишется так, чтобы быть валидным и в JS, и в TS (без аннотаций типов), и не вырезаться
 * при tree-shaking (побочные эффекты на верхнем уровне модуля).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RepoConfig } from './types.ts';

export type MutationTarget = 'entry' | 'html';

export interface MutationOp {
  id: string;
  /** Какую метрику должен ухудшить. */
  metric: 'lcp' | 'tbt' | 'inp' | 'cls' | 'bytes';
  target: MutationTarget;
  levels: number[];
  unit: string;
  code: (level: number) => string;
}

const busy = (ms: number) => `const __t = performance.now(); while (performance.now() - __t < ${ms}) {}`;

/**
 * Код для модуля-точки входа выполняется только в браузере: у SSG (VitePress, SvelteKit prerender)
 * этот модуль исполняется ещё и при сборке в Node, где нет window/document — сборка упала бы.
 */
const inBrowser = (id: string, body: string) => `\n/* mutant:${id} */\nif (typeof window !== 'undefined') {\n${body}}\n`;

export const OPS: MutationOp[] = [
  {
    // синхронный скрипт в <head> блокирует разбор HTML → позже первая отрисовка и LCP
    id: 'blocking_script',
    metric: 'lcp',
    target: 'html',
    levels: [25, 50, 100, 200],
    unit: 'ms',
    code: (ms) => `<script>/* mutant:blocking_script */ (function () { ${busy(ms)} })();</script>`,
  },
  {
    // долгая задача при инициализации приложения → TBT (и LCP, если до первой отрисовки)
    id: 'long_task',
    metric: 'tbt',
    target: 'entry',
    levels: [50, 100, 200, 400],
    unit: 'ms',
    code: (ms) => inBrowser('long_task', `  setTimeout(function () { ${busy(ms)} }, 0);\n`),
  },
  {
    // тяжёлый обработчик ввода (capture, на всё окно) → INP
    id: 'slow_input',
    metric: 'inp',
    target: 'entry',
    levels: [10, 25, 50, 100],
    unit: 'ms',
    code: (ms) =>
      inBrowser(
        'slow_input',
        `  ['pointerdown', 'keydown'].forEach(function (e) {\n` +
          `    window.addEventListener(e, function () { ${busy(ms)} }, true);\n  });\n`,
      ),
  },
  {
    // блок, вставленный в начало страницы после загрузки, сдвигает содержимое → CLS
    id: 'layout_shift',
    metric: 'cls',
    target: 'entry',
    levels: [10, 40, 120, 300],
    unit: 'px',
    code: (px) =>
      inBrowser(
        'layout_shift',
        `  setTimeout(function () {\n` +
          `    var d = document.createElement('div'); d.style.height = '${px}px'; document.body.prepend(d);\n  }, 300);\n`,
      ),
  },
  {
    // «раздутый» бандл: плохо сжимаемая строка в точке входа → больше байт и разбора JS
    id: 'bundle_bloat',
    metric: 'bytes',
    target: 'entry',
    levels: [50, 200, 800],
    unit: 'KB',
    code: (kb) => `\n/* mutant:bundle_bloat */\nReflect.set(globalThis, '__mutant_bloat', '${noise(kb * 1024)}');\n`,
  },
];

/** Детерминированная плохо сжимаемая строка (LCG), чтобы размер после gzip был близок к исходному. */
function noise(bytes: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let x = 12345;
  let s = '';
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += alphabet[x % alphabet.length];
  }
  return s;
}

export interface Mutant {
  key: string; // для кеша сборок и имени файла результата
  op: MutationOp;
  level: number;
}

/** Все мутанты (или только операторы из filter); HTML-мутанты — только если у репозитория есть HTML-шаблон. */
export function allMutants(filter?: string[], cfg?: RepoConfig): Mutant[] {
  return OPS.filter((op) => !filter?.length || filter.includes(op.id))
    .filter((op) => op.target !== 'html' || !cfg || !!cfg.mutation?.html)
    .flatMap((op) => op.levels.map((level) => ({ key: `${op.id}-${level}`, op, level })));
}

/**
 * Внедрить мутацию в рабочую копию (после checkout, перед сборкой).
 * Идемпотентно: исходник берётся из HEAD, а не из рабочей копии. Возвращает путь и вставку.
 */
export async function applyMutation(cfg: RepoConfig, repoDir: string, m: Mutant): Promise<{ file: string; snippet: string }> {
  if (!cfg.mutation) throw new Error(`${cfg.name}: в конфиге нет mutation — некуда внедрять`);
  const file = m.op.target === 'html' ? cfg.mutation.html : cfg.mutation.entry;
  if (!file) throw new Error(`${cfg.name}: в конфиге нет файла для мутаций типа ${m.op.target}`);
  const original = gitShow(repoDir, `HEAD:${file}`); // entry может не существовать — тогда создаём
  const snippet = m.op.code(m.level);
  let content: string;
  if (m.op.target === 'html') {
    if (!/<head[^>]*>/i.test(original)) throw new Error(`${file}: нет <head>`);
    content = original.replace(/<head[^>]*>/i, (h) => `${h}\n    ${snippet}`);
  } else {
    content = original + snippet;
  }
  mkdirSync(dirname(join(repoDir, file)), { recursive: true });
  writeFileSync(join(repoDir, file), content);
  return { file, snippet: snippet.length > 500 ? snippet.slice(0, 200) + `…(${snippet.length} символов)` : snippet };
}

/** Содержимое файла из git целиком (exec.sh хранит только хвост вывода); "" — если файла нет. */
function gitShow(repoDir: string, spec: string): string {
  try {
    return execFileSync('git', ['show', spec], { cwd: repoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}
