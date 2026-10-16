import type { Page } from 'puppeteer-core';
import { ANALYTICS_BLOCK, pause, scrollDownUp, typeInto } from '../src/flow-kit.ts';
import { gentleNetwork } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// OmniTools — набор утилит в браузере (React + MUI + Vite).
// Конфиг составлен 09.10.2026 для выборочной проверки (верхние 5 % по модели), сборкой НЕ проверен — `npm run trial`.
// Диапазон — с 20.06.2024 (переход на Vite + TS). В репозитории два lock-файла; Dockerfile и свежие
// коммиты используют npm (pnpm-lock.yaml не обновляется с 07.2025).

/** Главная: поиск инструмента (выпадающий список MUI Autocomplete на каждое нажатие), прокрутка категорий. */
async function searchTools(page: Page) {
  await page.waitForSelector('input', { visible: true, timeout: 60_000 });
  await pause(800);
  await typeInto(page, 'input', 'json', { clear: true });
  await page.keyboard.press('Escape');
  await pause(400);
  await scrollDownUp(page, 1500);
}

export default {
  name: 'omni-tools',
  url: 'https://github.com/iib0011/omni-tools.git',
  branch: 'main',
  since: '2024-06-20',
  pathsFilter: ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', ':(exclude,glob)**/*.test.*', ':(exclude,glob)**/*.md'],
  install: 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund',
  build: 'npx vite build', // npm run build = tsc && vite build
  distDir: 'dist',
  installInputs: ['package-lock.json'],
  env: { HUSKY: '0', npm_config_engine_strict: 'false', ...gentleNetwork() },
  blockedUrlPatterns: ANALYTICS_BLOCK,
  mutation: { html: 'index.html', entry: 'src/index.tsx' },
  pages: [{ name: 'home', path: '/', flow: searchTools }],
} satisfies RepoConfig;
