import type { Page } from 'puppeteer-core';
import { ANALYTICS_BLOCK, clickText, pause, scrollDownUp, visible } from '../src/flow-kit.ts';
import { gentleNetwork } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// React Bits — каталог анимированных React-компонентов (Vite + Chakra UI): сайт с живыми демо.
// Конфиг составлен 09.10.2026 для выборочной проверки (верхние 5 % по модели), сборкой НЕ проверен — `npm run trial`.
// Диапазон — с 07.08.2024 (создание); адрес /:category/:subcategory одинаков всю историю.

/**
 * Страница компонента: кнопка перезапуска анимации в .demo-container (есть во всех версиях — проба 10.10:
 * в 08.2024 вкладок ещё не было), затем, если есть, вкладки Preview ↔ Code (подсветка кода), прокрутка.
 */
async function componentPage(page: Page) {
  await page.waitForSelector('.demo-container button', { visible: true, timeout: 60_000 });
  await pause(1000);
  for (let i = 0; i < 2; i++) {
    await (await visible(page, '.demo-container button')).click();
    await pause(900);
  }
  if (await clickText(page, '[role="tab"]', /^code$/i, false)) {
    await pause(800);
    await clickText(page, '[role="tab"]', /^preview$/i, false);
    await pause(800);
  }
  await scrollDownUp(page, 1200);
}

export default {
  name: 'react-bits',
  url: 'https://github.com/DavidHDev/react-bits.git',
  branch: 'main',
  since: '2024-08-07',
  pathsFilter: ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.js', ':(exclude,glob)**/*.md'],
  install: 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund',
  // npm run build = проверка документации, сборка реестра shadcn, llms.txt, sitemap, RSS + vite build — нужен только vite
  build: 'npx vite build',
  distDir: 'dist',
  installInputs: ['package-lock.json'],
  env: { HUSKY: '0', npm_config_engine_strict: 'false', ...gentleNetwork() },
  blockedUrlPatterns: ANALYTICS_BLOCK,
  mutation: { html: 'index.html', entry: 'src/main.jsx' },
  pages: [{ name: 'split-text', path: '/text-animations/split-text', flow: componentPage }],
} satisfies RepoConfig;
