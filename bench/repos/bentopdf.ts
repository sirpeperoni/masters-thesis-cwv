import type { Page } from 'puppeteer-core';
import { ANALYTICS_BLOCK, hoverEach, pause, scrollDownUp, typeInto } from '../src/flow-kit.ts';
import { gentleNetwork } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// BentoPDF — набор PDF-инструментов в браузере (Vite + TypeScript без фреймворка, обработка локально).
// Конфиг составлен 09.10.2026 для выборочной проверки (верхние 5 % по модели), сборкой НЕ проверен — `npm run trial`.
// Диапазон — вся история (с 12.10.2025).

/** Главная: сетка из ~80 инструментов и поиск по ним (фильтрация сетки на каждое нажатие). */
async function searchTools(page: Page) {
  await page.waitForSelector('#tool-grid', { timeout: 60_000 });
  await pause(800);
  await typeInto(page, '#search-bar', 'merge', { clear: true });
  await pause(500);
  await hoverEach(page, '#tool-grid > *', 4);
  await scrollDownUp(page, 1500);
}

export default {
  name: 'bentopdf',
  url: 'https://github.com/alam00000/bentopdf.git',
  branch: 'main',
  since: '2025-10-12',
  pathsFilter: ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', ':(exclude,glob)**/*.md'],
  install: 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund',
  // npm run build = генерация блога, SEO-страниц, sitemap… + tsc + vite build (и синтаксис NODE_OPTIONS=… не для cmd):
  // для замеров главной нужна только сборка vite
  build: 'npx vite build',
  distDir: 'dist',
  installInputs: ['package-lock.json'],
  env: { HUSKY: '0', npm_config_engine_strict: 'false', ...gentleNetwork() },
  // проба 10.10, первая точка: рекламный пиксель партнёра (pdffiller) и Simple Analytics (в общем списке)
  blockedUrlPatterns: [...ANALYTICS_BLOCK, '*pdffiller.com*'],
  mutation: { html: 'index.html', entry: 'src/js/main.ts' },
  pages: [{ name: 'home', path: '/', flow: searchTools }],
} satisfies RepoConfig;
