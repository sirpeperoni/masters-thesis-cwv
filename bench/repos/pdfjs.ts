import type { Page } from 'puppeteer-core';
import { ANALYTICS_BLOCK, pause, visible } from '../src/flow-kit.ts';
import { gentleNetwork } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// PDF.js — просмотрщик PDF Mozilla (встроен в Firefox); меряется web/viewer.html сборки generic
// с демонстрационным документом (compressed.tracemonkey-pldi-09.pdf, 14 страниц, кладётся сборкой).
// Конфиг составлен 09.10.2026 для выборочной проверки (верхние 5 % по модели), сборкой НЕ проверен — `npm run trial`.
// Диапазон — с 01.06.2025. Переводы (l10n/) и тесты исключены. engines в конце диапазона — Node ≥ 22.22, у нас 22.20.

/** Листание: кнопка «следующая страница» и прокрутка документа (отрисовка страниц и текстового слоя). */
async function readDocument(page: Page) {
  await visible(page, '#viewerContainer .page canvas');
  await pause(1000);
  for (let i = 0; i < 2; i++) {
    await (await visible(page, '#next')).click();
    await pause(600);
  }
  const box = await (await visible(page, '#viewerContainer')).boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel({ deltaY: 800 });
      await pause(400);
    }
  }
  await pause(800);
}

export default {
  name: 'pdfjs',
  url: 'https://github.com/mozilla/pdf.js.git',
  branch: 'master',
  since: '2025-06-01',
  pathsFilter: ['src', 'web', 'external', 'gulpfile.mjs', 'package.json', 'package-lock.json', ':(exclude,glob)**/*.md'],
  install: 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund',
  // стенд считает сборку удачной, если в distDir есть index.html; у generic его нет (просмотрщик — web/viewer.html):
  // сбор 11.10 — все 50 собранных коммитов записаны build_failed. Кладём копию viewer.html только для этой проверки.
  build: 'npx gulp generic && copy /Y build\\generic\\web\\viewer.html build\\generic\\index.html >nul',
  distDir: 'build/generic',
  installInputs: ['package-lock.json'],
  env: { npm_config_engine_strict: 'false', ...gentleNetwork() },
  blockedUrlPatterns: ANALYTICS_BLOCK,
  pages: [{ name: 'viewer', path: '/web/viewer.html', flow: readDocument }],
} satisfies RepoConfig;
