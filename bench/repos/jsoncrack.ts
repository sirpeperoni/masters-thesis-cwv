import type { Page } from 'puppeteer-core';
import { ANALYTICS_BLOCK, pause, visible } from '../src/flow-kit.ts';
import { gentleNetwork, withShimsInPath } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// JSON Crack — визуализатор JSON в виде графа (Next.js, output: 'export' → out/; редактор Monaco).
// Конфиг составлен 09.10.2026 для выборочной проверки (верхние 5 % по модели), сборкой НЕ проверен — `npm run trial`.
// Диапазон — 01.2024 … 18.02.2026: 19.02.2026 проект переехал в монорепозиторий turborepo (apps/www) — другая сборка.
// next build запускает ESLint с prettier/linebreak-style: при глобальном core.autocrlf=true файлы приходят с CRLF
// и сборка падает (проба 10.10) — в клоне work/repos/jsoncrack выставлено core.autocrlf=false (git config, 10.10).

/**
 * Редактор: правка JSON в Monaco — после каждого изменения граф перестраивается (разбор, раскладка, отрисовка).
 * В начало последней строки (перед закрывающей скобкой) дописываем поле — документ остаётся корректным JSON.
 */
async function editJson(page: Page) {
  const editor = await visible(page, '.monaco-editor');
  await page.waitForSelector('svg', { visible: true, timeout: 60_000 });
  await pause(1500);
  await editor.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('End');
  await page.keyboard.up('Control');
  await page.keyboard.press('Home');
  await page.keyboard.type(',"bench": [1, 2, 3]', { delay: 80 });
  await pause(2000);
}

export default {
  name: 'jsoncrack',
  url: 'https://github.com/AykutSarac/jsoncrack.com.git',
  branch: 'main',
  since: '2024-01-01',
  until: '2026-02-18',
  pathsFilter: ['src', 'public', 'package.json', 'pnpm-lock.yaml', 'next.config.js', ':(exclude,glob)**/*.md'],
  install: 'pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile',
  // next build (Next 13–15) запускает ESLint с prettier: сбор 11.10 — 18 из 21 build_failed на «prettier/prettier»
  // (и таймауты 15 мин на линтинге). Линтер на производительность не влияет — --no-lint. В Next 16 флага нет
  // (и линтинга при сборке тоже) — тогда обычная сборка. postbuild (sitemap) при этом не выполняется — не нужен.
  build: 'pnpm exec next build --no-lint || pnpm exec next build',
  distDir: 'out',
  installInputs: ['pnpm-lock.yaml'],
  env: { HUSKY: '0', npm_config_engine_strict: 'false', NEXT_TELEMETRY_DISABLED: '1', ...withShimsInPath(), ...gentleNetwork() },
  blockedUrlPatterns: [...ANALYTICS_BLOCK, '*supabase.co*', '*lemonsqueezy*'],
  pages: [{ name: 'editor', path: '/editor', flow: editJson }],
} satisfies RepoConfig;
