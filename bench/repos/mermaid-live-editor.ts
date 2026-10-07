import type { Page } from 'puppeteer-core';
import { withShimsInPath } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// Проверено пробой (trial.ts, 29.09.2026): сборка на yarn (09.2024), pnpm (09.2025) и последнем коммите,
// сценарий редактирования даёт INP 140–270 мс. Шум большой (TBT ±400 мс) — см. A/A перед сбором.

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));


/**
 * Правка диаграммы в редакторе Monaco: каждое нажатие перерисовывает диаграмму —
 * это основная нагрузка на отзывчивость (INP) в этом приложении.
 */
async function editDiagram(page: Page) {
  await page.waitForSelector('.monaco-editor .view-lines', { timeout: 60_000 });
  await pause(800);

  // Всплывающие окна (выбор редактора с 03.2026, промо) — закрываем, если есть
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape');
    await pause(200);
  }

  await page.click('.monaco-editor .view-lines');
  await page.keyboard.down('Control');
  await page.keyboard.press('End');
  await page.keyboard.up('Control');
  await pause(200);

  // Дописываем узлы в конец диаграммы по умолчанию (flowchart)
  for (const line of ['A --> Z1[Web Vitals]', 'Z1 --> Z2{Regression?}', 'Z2 -->|yes| Z3[Alert]']) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(line, { delay: 40 });
    await pause(400);
  }
  // дождаться последней перерисовки (ввод обрабатывается с задержкой)
  await pause(1500);
}

export default {
  name: 'mermaid-live-editor',
  url: 'https://github.com/mermaid-js/mermaid-live-editor.git',
  branch: 'develop',
  // 06.10.2026: диапазон продлён назад с 2024-09-01, чтобы добрать регрессий (у mermaid их больше всего, 7%).
  // Раньше 04.2022 не берём: SvelteKit 1.0.0-next.<300, нет `svelte-kit sync`, наша команда сборки не подходит.
  since: '2022-04-01',
  pathsFilter: [
    'src',
    'static',
    'package.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'svelte.config.js',
    'vite.config.js',
    'vite.config.ts',
    'vite.embed.config.js',
    'tailwind.config.js',
    'tailwind.config.cjs',
    'postcss.config.cjs',
    '.env',
  ],
  // До 16.03.2025 (#1644) проект собирался через yarn, после — через pnpm.
  // Команды выполняются в cmd.exe, отсюда синтаксис if exist … else.
  // yarn: --ignore-scripts — нативный deasync (нужен dev-инструменту, не приложению) не собирается
  // на Node 22 под Windows (spawn EINVAL); sync SvelteKit всё равно делает сам при vite build.
  install:
    'if exist pnpm-lock.yaml (pnpm install --frozen-lockfile) else (yarn install --frozen-lockfile --ignore-scripts --network-timeout 600000)',
  // svelte-kit sync создаёт .svelte-kit/ (обычно в postinstall). Стенд при переключении коммита
  // удаляет игнорируемые git файлы, а install пропускает, если lock-файл не менялся, — поэтому
  // sync повторяем перед каждой сборкой (иначе build:embed падает: нет .svelte-kit/tsconfig.json).
  build: 'if exist pnpm-lock.yaml (pnpm exec svelte-kit sync && pnpm run build) else (yarn svelte-kit sync && yarn build)',
  distDir: 'docs', // adapter-static: pages: 'docs'
  spaFallback: '404.html', // adapter-static: fallback: '404.html' (с 2025 г.; раньше — index.html)
  installInputs: ['pnpm-lock.yaml', 'yarn.lock'],
  // старые коммиты требуют Node 20, новые — 24; у нас Node 22.
  // PATH: скрипт сборки новых коммитов сам вызывает `pnpm …`, а он у нас есть только как
  // `corepack pnpm` — обёртки bench/shims/{pnpm,yarn}.cmd.
  env: { YARN_IGNORE_ENGINES: 'true', npm_config_engine_strict: 'false', HUSKY: '0', ...withShimsInPath() },
  // Единственный внешний запрос (с 2025 г.) — JSON-схема для подсказок в редакторе конфигурации;
  // на отрисовку не влияет (проверено: метрики с блокировкой и без — в пределах шума).
  blockedUrlPatterns: ['*mermaid.js.org/schemas/*'],
  // hooks.client.ts в истории нет — создаётся мутантом, SvelteKit подхватывает его сам
  mutation: { html: 'src/app.html', entry: 'src/hooks.client.ts' },
  pages: [{ name: 'edit', path: '/edit', flow: editDiagram }],
} satisfies RepoConfig;
