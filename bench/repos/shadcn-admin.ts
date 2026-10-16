import type { Page } from 'puppeteer-core';
import { ANALYTICS_BLOCK, clickText, pause, scrollDownUp } from '../src/flow-kit.ts';
import { gentleNetwork, withShimsInPath } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// shadcn-admin — шаблон админ-панели (React + Vite + shadcn/ui, данные — заглушки в коде, входа нет).
// Конфиг составлен 09.10.2026 для выборочной проверки (верхние 5 % по модели), сборкой НЕ проверен — `npm run trial`.
// Диапазон — с 27.01.2024 (создание проекта); в 12.2024 переход на TanStack Router, главная «/» — панель всё время.

/** Панель: вкладки Overview ↔ Analytics (перерисовка графиков), прокрутка. */
async function dashboard(page: Page) {
  await page.waitForSelector('[role="tab"]', { visible: true, timeout: 60_000 });
  await pause(800);
  if (await clickText(page, '[role="tab"]', /analytics/i, false)) await pause(700);
  await clickText(page, '[role="tab"]', /overview/i, false);
  await pause(700);
  await scrollDownUp(page, 1200);
}

export default {
  name: 'shadcn-admin',
  url: 'https://github.com/satnaing/shadcn-admin.git',
  branch: 'main',
  since: '2024-01-27',
  pathsFilter: ['src', 'public', 'index.html', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tailwind.config.js', ':(exclude,glob)**/*.md'],
  install: 'pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile',
  build: 'npx vite build', // pnpm build = tsc -b && vite build
  distDir: 'dist',
  installInputs: ['pnpm-lock.yaml'],
  env: { HUSKY: '0', npm_config_engine_strict: 'false', ...withShimsInPath(), ...gentleNetwork() },
  blockedUrlPatterns: ANALYTICS_BLOCK,
  mutation: { html: 'index.html', entry: 'src/main.tsx' },
  pages: [{ name: 'dashboard', path: '/', flow: dashboard }],
} satisfies RepoConfig;
