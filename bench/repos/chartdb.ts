import type { Page } from 'puppeteer-core';
import { ANALYTICS_BLOCK, clickText, pause, scrollDownUp, visible } from '../src/flow-kit.ts';
import { gentleNetwork } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// ChartDB — редактор схем баз данных (React + Vite + React Flow, без бэкенда, данные в IndexedDB).
// Конфиг составлен 09.10.2026 для выборочной проверки (верхние 5 % по модели), сборкой НЕ проверен — `npm run trial`.
// Диапазон — с 10.11.2024 (выбран под страницу шаблонов; сбор отобран моделью по нему — не менять).
// Страница /templates/<имя> НЕ подходит: с 13.03.2025 (52d2ea5, «add diff mode») она падает в самом приложении
// («useDiff must be used within an DiffProvider», проба 10.10). Поэтому меряется /examples.

/**
 * Страница примеров → клик по «Employees schema»: приложение создаёт диаграмму в IndexedDB и открывает
 * редактор с канвой (React Flow, ~10 таблиц со связями) — тяжёлое взаимодействие (INP).
 * Затем клик по таблицам (выделение и подсветка связей), колесо над канвой (масштаб), прокрутка.
 */
async function openExample(page: Page) {
  await page.waitForFunction(() => document.body.innerText.includes('Employees'), { timeout: 60_000 });
  await pause(800);
  await clickText(page, '.cursor-pointer', /Employees/);
  await visible(page, '.react-flow__node');
  await pause(1500);
  const nodes = await page.$$('.react-flow__node');
  for (const n of nodes.slice(0, 2)) {
    await n.click().catch(() => {});
    await pause(500);
  }
  const canvas = await visible(page, '.react-flow__pane');
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel({ deltaY: -300 });
    await pause(500);
    await page.mouse.wheel({ deltaY: 300 });
    await pause(500);
  }
  await scrollDownUp(page, 800, 100, 400);
}

export default {
  name: 'chartdb',
  url: 'https://github.com/chartdb/chartdb.git',
  branch: 'main',
  since: '2024-11-10',
  pathsFilter: ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js'],
  install: 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund',
  // npm run build = lint && tsc -b && vite build: ошибки линтера и типов на производительность не влияют — только vite
  build: 'npx vite build',
  distDir: 'dist',
  installInputs: ['package-lock.json'],
  env: { HUSKY: '0', npm_config_engine_strict: 'false', ...gentleNetwork() },
  blockedUrlPatterns: ANALYTICS_BLOCK,
  mutation: { html: 'index.html', entry: 'src/main.tsx' },
  pages: [{ name: 'examples', path: '/examples', flow: openExample }],
} satisfies RepoConfig;
