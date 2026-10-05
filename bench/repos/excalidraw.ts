import type { Page } from 'puppeteer-core';
import type { RepoConfig } from '../src/types.ts';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 8 });
  await page.mouse.up();
  await pause(150);
}

/** Типичная сессия рисования: фигуры, текст, выделение, перемещение, отмена. */
async function drawingSession(page: Page) {
  await page.waitForSelector('canvas', { timeout: 30_000 });
  await pause(500);

  await page.keyboard.press('r');
  await drag(page, [400, 300], [600, 450]);
  await page.keyboard.press('o');
  await drag(page, [700, 300], [850, 450]);
  await page.keyboard.press('a');
  await drag(page, [600, 380], [700, 380]);

  await page.keyboard.press('t');
  await page.mouse.click(450, 550);
  await pause(150);
  await page.keyboard.type('Core Web Vitals', { delay: 30 });
  await page.keyboard.press('Escape');
  await pause(150);

  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await pause(150);
  await drag(page, [500, 375], [560, 420]);

  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await pause(500);
}

export default {
  name: 'excalidraw',
  url: 'https://github.com/excalidraw/excalidraw.git',
  branch: 'master',
  since: '2024-09-01',
  // документацию, тесты и CI не трогаем — они не влияют на собранное приложение
  pathsFilter: ['excalidraw-app', 'packages', 'package.json', 'yarn.lock', 'public', 'index.html'],
  install: 'corepack yarn install --frozen-lockfile --ignore-engines --network-timeout 600000',
  build: 'corepack yarn build:app:docker',
  distDir: 'excalidraw-app/build',
  installInputs: ['yarn.lock'],
  // старые коммиты требуют Node 18–20; yarn проверяет engines и при install, и при run
  env: { VITE_APP_DISABLE_SENTRY: 'true', YARN_IGNORE_ENGINES: 'true' },
  // точки внедрения искусственных регрессий (--mutants); есть на всём диапазоне с 09.2024
  mutation: { html: 'excalidraw-app/index.html', entry: 'excalidraw-app/index.tsx' },
  pages: [{ name: 'home', path: '/', flow: drawingSession }],
} satisfies RepoConfig;
