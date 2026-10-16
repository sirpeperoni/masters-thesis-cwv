import type { ElementHandle, Page } from 'puppeteer-core';
import type { RepoConfig } from '../src/types.ts';

// drawDB — редактор схем баз данных в браузере (React + Vite, без бэкенда; данные — в IndexedDB).
// Конфиг составлен 09.10.2026, сборкой ещё НЕ проверен — сначала `npm run trial`.
// Сбор — выборочный: модель отбирает рискованные коммиты + случайный контроль (ml/select_commits.py, --shas-file).

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Вкладка Semi UI с нужным текстом — настоящим кликом мыши (синтетический click() не даёт событий ввода и INP). */
async function clickTab(page: Page, text: string) {
  const tabs = await page.$$('.semi-tabs-tab');
  for (const t of tabs) {
    const label = await t.evaluate((el) => el.textContent ?? '');
    if (label.includes(text)) {
      await (t as ElementHandle<Element>).click();
      return;
    }
  }
  throw new Error(`drawdb: нет вкладки «${text}»`);
}

/**
 * Страница шаблонов: превью шести схем рисует тот же код, что редактор (таблицы, связи).
 * Сценарий: переключение вкладок «Your templates» ↔ «Default templates» (перерисовка превью),
 * наведение на карточки, прокрутка. Шаблон открывается в новой вкладке (window.open) — сценарий
 * за ней не следует, поэтому взаимодействие остаётся на этой странице.
 */
async function browseTemplates(page: Page) {
  await page.waitForSelector('.semi-tabs-tab', { timeout: 60_000 });
  await pause(800);

  await clickTab(page, 'Your templates');
  await pause(600);
  await clickTab(page, 'Default templates');
  await pause(800);

  // наведение на карточки шаблонов (анимация подъёма) и прокрутка
  const cards = await page.$$('.grid > div');
  for (const c of cards.slice(0, 3)) {
    await c.hover().catch(() => {});
    await pause(250);
  }
  await page.mouse.move(700, 500);
  await page.mouse.wheel({ deltaY: 1200 });
  await pause(500);
  await page.mouse.wheel({ deltaY: -1200 });
  await pause(800);
}

export default {
  name: 'drawdb',
  url: 'https://github.com/drawdb-io/drawdb.git',
  branch: 'main',
  since: '2024-01-01',
  pathsFilter: ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.js', 'tailwind.config.js', 'postcss.config.js'],
  // В начале 2024 package.json и package-lock.json у проекта рассинхронизированы (зависимости yjs, monaco-editor
  // и др. есть в package.json, но не в lock-файле) — npm ci отказывается. Тогда npm install: он берёт версии
  // по диапазонам package.json на сегодня (не исторические) — только для таких коммитов; lock-файл он
  // перепишет, но следующий checkout --force (git.ts) вернёт его к версии коммита.
  install: 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund',
  build: 'npm run build',
  distDir: 'dist',
  installInputs: ['package-lock.json'],
  env: { HUSKY: '0', npm_config_engine_strict: 'false' },
  // Vercel Analytics (@vercel/analytics) грузит /_vercel/insights/script.js с того же сервера и шлёт события —
  // блокируем. Иконки Bootstrap и Font Awesome с CDN (jsdelivr, cdnjs) в <head> — часть оформления
  // приложения, как CDN у excalidraw: не блокируем (без них меняется отрисовка), шум — по A/A.
  blockedUrlPatterns: ['*/_vercel/*', '*vercel-insights*', '*vitals.vercel*'],
  mutation: { html: 'index.html', entry: 'src/main.jsx' },
  pages: [{ name: 'templates', path: '/templates', flow: browseTemplates }],
} satisfies RepoConfig;
