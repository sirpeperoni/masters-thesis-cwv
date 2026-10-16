import type { Page } from 'puppeteer-core';
import { ANALYTICS_BLOCK, pause, scrollDownUp, typeInto } from '../src/flow-kit.ts';
import { gentleNetwork, withShimsInPath } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// cobalt — загрузчик медиа (SvelteKit, adapter-static; pnpm-воркспейс: api, web, packages/*).
// Конфиг составлен 09.10.2026 для выборочной проверки (верхние 5 % по модели), сборкой НЕ проверен — `npm run trial`.
// Диапазон — с 10.09.2024 (cobalt 10: веб-клиент на Svelte в web/). Меряем только веб-клиент; API не запускаем:
// клиент обращается к API только по кнопке скачивания. С 2026 г. сборка требует WEB_DEFAULT_API (проба 10.10:
// «WEB_DEFAULT_API env variable is required») — указываем боевой адрес, он заблокирован при замерах.

/** Главная: ввод ссылки (проверка и подсказки на каждое нажатие) и стирание, прокрутка. Скачивание не запускаем. */
async function omnibox(page: Page) {
  await page.waitForSelector('#link-area', { visible: true, timeout: 60_000 });
  await pause(800);
  await typeInto(page, '#link-area', 'https://example.com/video/123', { delay: 50, clear: true });
  await pause(500);
  await scrollDownUp(page, 800);
}

export default {
  name: 'cobalt',
  url: 'https://github.com/imputnet/cobalt.git',
  branch: 'main',
  since: '2024-09-10',
  pathsFilter: ['web', 'packages', 'package.json', 'pnpm-lock.yaml', ':(exclude)web/i18n', ':(exclude,glob)**/*.md'],
  install: 'pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile',
  build: 'pnpm -C web run build',
  distDir: 'web/build',
  spaFallback: '404.html', // adapter-static: fallback '404.html'
  installInputs: ['pnpm-lock.yaml'],
  env: { HUSKY: '0', npm_config_engine_strict: 'false', WEB_DEFAULT_API: 'https://api.cobalt.tools/', ...withShimsInPath(), ...gentleNetwork() },
  blockedUrlPatterns: [...ANALYTICS_BLOCK, '*api.cobalt.tools*'],
  pages: [{ name: 'home', path: '/', flow: omnibox }],
} satisfies RepoConfig;
