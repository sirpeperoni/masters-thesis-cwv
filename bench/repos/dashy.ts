import type { Page } from 'puppeteer-core';
import { ANALYTICS_BLOCK, hoverEach, pause, scrollDownUp, typeInto } from '../src/flow-kit.ts';
import { gentleNetwork, withShimsInPath } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// Dashy — стартовая страница-панель для домашнего сервера (Vue 3 + Vite; конфигурация — conf.yml в сборке).
// Конфиг составлен 09.10.2026 для выборочной проверки (верхние 5 % по модели), сборкой НЕ проверен — `npm run trial`.
// Диапазон — с 27.04.2026 (переход Vue 2 / Vue CLI → Vue 3 / Vite). Около половины коммитов — обновления
// зависимостей ботом. Иконки сервисов в conf.yml по умолчанию — внешние (favicon-сервисы, simple-icons, Font
// Awesome): при необходимости добавить их хосты в блокировку по externalHosts пробы.

/** Главная: фильтр плиток (поиск на каждое нажатие), наведение на плитки, прокрутка. */
async function filterTiles(page: Page) {
  await page.waitForSelector('#filter-tiles', { visible: true, timeout: 60_000 });
  await pause(800);
  await typeInto(page, '#filter-tiles', 'docs', { clear: true });
  await pause(500);
  await hoverEach(page, '.item', 4);
  await scrollDownUp(page, 1000);
}

export default {
  name: 'dashy',
  url: 'https://github.com/Lissy93/dashy.git',
  branch: 'master',
  since: '2026-04-27',
  pathsFilter: ['src', 'public', 'user-data', 'index.html', 'package.json', 'yarn.lock', 'vite.config.mjs', ':(exclude,glob)**/*.md'],
  install: 'yarn install --frozen-lockfile --ignore-engines --network-timeout 600000',
  build: 'yarn build',
  distDir: 'dist',
  installInputs: ['yarn.lock'],
  env: { HUSKY: '0', YARN_IGNORE_ENGINES: 'true', npm_config_engine_strict: 'false', ...withShimsInPath(), ...gentleNetwork() },
  // проба 10.10: conf.yml по умолчанию тянет виджеты с чужих серверов — RSS через api.rss2json.com, картинку
  // спонсоров (readme-contribs.as93.net) и аватары GitHub; их время — от сети. Font Awesome (kit) — иконки
  // оформления, как CDN у excalidraw, — не блокируем.
  blockedUrlPatterns: [...ANALYTICS_BLOCK, '*rss2json.com*', '*readme-contribs.as93.net*', '*avatars.githubusercontent.com*'],
  pages: [{ name: 'home', path: '/', flow: filterTiles }],
} satisfies RepoConfig;
