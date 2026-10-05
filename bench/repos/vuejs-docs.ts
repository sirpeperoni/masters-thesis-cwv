import type { Page } from 'puppeteer-core';
import { withShimsInPath } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// Проверено пробой 01.10.2026: сборка 3 точек (переход pnpm 9 → 10 — см. bench/shims/README.md),
// A/A 10 пар после блокировки: MDE при 15 парах LCP 12 мс, INP 10, TBT 22/28, CLS 0 — всё ≤ порогов.
// Рекламный баннер (bitterbrains) давал CLS 0,118 и TBT +100 мс — заблокирован вместе с аналитикой.

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Чтение руководства: переключение стиля API (Options ↔ Composition) перестраивает
 * 9 блоков содержимого страницы — основная нагрузка на отзывчивость (INP);
 * затем прокрутка и переход по боковому меню на соседнюю страницу (SPA-навигация VitePress).
 */
async function readGuide(page: Page) {
  // переключатель — в начале боковой панели, на широком экране раскрыт по умолчанию
  await page.waitForSelector('.api-switch', { timeout: 60_000 });
  await pause(500);

  await page.click('.api-switch'); // → Composition API
  await pause(600);
  await page.click('.api-switch'); // ← обратно, Options API
  await pause(600);

  await page.mouse.move(700, 500);
  await page.mouse.wheel({ deltaY: 1500 });
  await pause(400);
  await page.mouse.wheel({ deltaY: -1500 });
  await pause(400);

  await page.click('a[href*="/guide/essentials/computed"]');
  await page.waitForFunction(() => location.pathname.includes('/guide/essentials/computed'), { timeout: 30_000 });
  await pause(1000);
}

export default {
  name: 'vuejs-docs',
  url: 'https://github.com/vuejs/docs.git',
  branch: 'main',
  since: '2024-09-01',
  // сайт документации: меняется в основном содержимое (src) и тема (.vitepress)
  pathsFilter: ['src', '.vitepress', 'package.json', 'pnpm-lock.yaml'],
  // pnpm на всём диапазоне (9 → 10); preinstall «npx only-allow pnpm» проходит, т. к. зовём pnpm
  install: 'pnpm install --frozen-lockfile',
  build: 'pnpm run build',
  distDir: '.vitepress/dist', // VitePress: srcDir 'src', outDir по умолчанию — <root>/.vitepress/dist
  installInputs: ['pnpm-lock.yaml'],
  env: { npm_config_engine_strict: 'false', ...withShimsInPath() },
  // Внешние сервисы из <head> конфига сайта и темы (проба 01.10.2026):
  //  - media.bitterbrains.com — рекламный баннер сверху (async), сдвигал вёрстку: CLS 0,118 и шум CLS;
  //  - cdn.usefathom.com — аналитика; automation.vuejs.org — данные спонсоров (меняются со временем);
  //  - Carbon Ads — реклама; Algolia — поиск.
  // fonts.googleapis.com не блокируем: в коде сайта шрифтов Google нет — их подтягивал баннер.
  blockedUrlPatterns: ['*carbonads*', '*buysellads*', '*algolia*', '*bitterbrains*', '*usefathom*', '*automation.vuejs.org*'],
  // HTML-шаблона с <head> у VitePress нет (head задаётся в конфиге) — только модульные мутанты.
  // Тема выполняется и при SSG-сборке в Node — вставки мутантов защищены проверкой window.
  mutation: { entry: '.vitepress/theme/index.ts' },
  pages: [{ name: 'reactivity', path: '/guide/essentials/reactivity-fundamentals', flow: readGuide }],
} satisfies RepoConfig;
