import type { Page } from 'puppeteer-core';
import { ANALYTICS_BLOCK, pause, visible } from '../src/flow-kit.ts';
import { gentleNetwork, withShimsInPath } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// Lexical — текстовый редактор Meta; меряется его playground (Vite, собирается из исходников пакетов монорепозитория).
// Конфиг составлен 09.10.2026 для выборочной проверки (верхние 5 % по модели), сборкой НЕ проверен — `npm run trial`.
// Диапазон — с 22.12.2025 (переход npm → pnpm). Сайт документации и тесты исключены.

/** Ввод текста в редактор: каждое нажатие — обновление состояния редактора, тулбара и плагинов. */
async function typeText(page: Page) {
  const editor = await visible(page, '.ContentEditable__root');
  await pause(800);
  await editor.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('End');
  await page.keyboard.up('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Performance check of the editor input.', { delay: 60 });
  await pause(800);
}

export default {
  name: 'lexical',
  url: 'https://github.com/facebook/lexical.git',
  branch: 'main',
  since: '2025-12-22',
  pathsFilter: [
    'packages',
    'scripts',
    'package.json',
    'pnpm-lock.yaml',
    ':(exclude)packages/lexical-website',
    ':(exclude)packages/lexical-devtools',
    ':(exclude,glob)**/__tests__/**',
    ':(exclude,glob)**/*.md',
  ],
  install: 'pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile',
  // playground берёт собранные пакеты (dist/Lexical.js) — сначала сборка монорепозитория (проба 10.10: «Missing
  // dist/Lexical.mjs»). Так же собирают их деплой (build-vercel): scripts/build + playground в режиме build-dev.
  build: 'pnpm run build && pnpm -C packages/lexical-playground run build-dev',
  distDir: 'packages/lexical-playground/build',
  installInputs: ['pnpm-lock.yaml'],
  // установка шла 10–13 минут: playwright (e2e-тесты) скачивает браузеры — для замеров не нужны
  env: { HUSKY: '0', npm_config_engine_strict: 'false', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', ...withShimsInPath(), ...gentleNetwork() },
  blockedUrlPatterns: ANALYTICS_BLOCK,
  pages: [{ name: 'playground', path: '/', flow: typeText }],
} satisfies RepoConfig;
