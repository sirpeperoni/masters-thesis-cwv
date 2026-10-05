import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { withShimsInPath } from '../src/shims.ts';
import type { RepoConfig } from '../src/types.ts';

// Конфиг составлен 04.10.2026 по истории репозитория, сборкой ещё НЕ проверен — сначала `npm run trial`.
// Во всём диапазоне (с 09.2025): pnpm-воркспейс + turbo, фронтенд собирается в frontend/dist.
// Node: в начале диапазона engines 20.19, в конце ≥ 24 — у нас 22, поэтому engine-strict выключен.

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FIREBASE_CONFIG = join(import.meta.dirname, 'files', 'monkeytype-firebase-config.ts');

/** Нажать кнопку с подходящим текстом, если она появится за timeout мс (окно cookies — не в каждой версии сразу). */
async function clickButtonByText(page: Page, re: RegExp, timeout: number) {
  const found = await page
    .waitForFunction(
      (src: string) => {
        const r = new RegExp(src, 'i');
        const b = [...document.querySelectorAll('button')].find((el) => r.test(el.textContent ?? '') && el.offsetParent !== null);
        if (b) (b as HTMLButtonElement).click();
        return !!b;
      },
      { timeout },
      re.source,
    )
    .then(() => true)
    .catch(() => false);
  if (found) await pause(500);
}

/**
 * Тест печати: monkeytype обрабатывает каждое нажатие клавиши (подсветка букв, каретка, подсчёт
 * скорости) — это основная нагрузка на отзывчивость (INP). Печатаем первые слова теста со скоростью
 * ~200 знаков в минуту, без ошибок. Слова случайные, поэтому текст берём со страницы.
 */
async function typeTest(page: Page) {
  // согласие на cookies записано заранее (localStorage в конфиге страницы); это подстраховка на случай,
  // если окно всё же появится. «reject non-essential» — одна надпись в старом (jQuery) и новом (Solid) окне
  await clickButtonByText(page, /reject non-essential/, 1_000);

  await page.waitForSelector('#words .word', { visible: true, timeout: 60_000 });
  await pause(500);

  const words = await page.evaluate(() =>
    [...document.querySelectorAll('#words .word')].slice(0, 12).map((w) => (w.textContent ?? '').trim()),
  );
  if (words.length < 5) throw new Error(`monkeytype: на странице ${words.length} слов теста`);

  // фокус в скрытое поле ввода теста (его ищет обработчик клавиатуры)
  await page.focus('#wordsInput').catch(() => page.click('#wordsWrapper'));
  for (const w of words) {
    await page.keyboard.type(w + ' ', { delay: 60 });
  }
  await pause(1000);
}

export default {
  name: 'monkeytype',
  url: 'https://github.com/monkeytypegame/monkeytype.git',
  branch: 'master',
  // ~1170 коммитов фронтенда за год — собирать с прореживанием: --every 5
  since: '2025-09-01',
  pathsFilter: [
    'frontend',
    'packages',
    'package.json',
    'pnpm-lock.yaml',
    'turbo.json',
    ':(exclude,glob)**/__tests__/**',
    ':(exclude)frontend/storybook',
    ':(exclude,glob)**/*.md',
  ],
  // pnpm 9 → 11 (packageManager в package.json, corepack через bench/shims); preinstall «only-allow pnpm» проходит
  install: 'pnpm install --frozen-lockfile',
  // firebase-config*.ts не хранятся в git (ключи проекта). Подставляем фиктивный, но заполненный конфиг
  // (files/monkeytype-firebase-config.ts — там же, почему не пустой пример: старые версии с ним не грузятся).
  // В продакшен-сборке vite подменяет firebase-config на firebase-config-live — создаём оба.
  // build-fe = turbo run build --filter @monkeytype/frontend (с пакетами packages/*, от которых он зависит).
  build:
    `copy /Y "${FIREBASE_CONFIG}" frontend\\src\\ts\\constants\\firebase-config.ts >nul` +
    ` && copy /Y "${FIREBASE_CONFIG}" frontend\\src\\ts\\constants\\firebase-config-live.ts >nul` +
    ' && pnpm run build-fe',
  distDir: 'frontend/dist', // vite: root 'src', outDir '../dist'
  installInputs: ['pnpm-lock.yaml'],
  env: {
    // продакшен-сборка требует ключ reCAPTCHA; это публичный тестовый ключ Google (он же у них в dev-конфиге).
    // reCAPTCHA нужна только при регистрации — на тест печати не влияет. В turbo.json переменная объявлена.
    RECAPTCHA_SITE_KEY: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
    // Бэкенд — заглушка стенда (server.ts, STUB_PREFIX): относительный адрес, запросы идут на тот же
    // сервер и получают 404. Если блокировать api.monkeytype.com, клиент видит сетевую ошибку (статус 500),
    // запрашивает monkeytype.instatus.com и показывает баннер «server down»: в A/A 04.10 LCP-элементом был
    // этот баннер, а время его появления зависело от интернета (выброс LCP 11,7 с). На 404 баннера нет.
    BACKEND_URL: '/__stub',
    npm_config_engine_strict: 'false',
    HUSKY: '0',
    TURBO_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    ...withShimsInPath(),
  },
  // Сборка НЕ детерминирована: в JS зашита версия «дата_время_хеш» (getClientVersion в vite.config) —
  // одинаковых сборок (identical_build) и контрольных A/A на них не будет, только self-A/A.
  //
  // Внешние запросы — уточнить по externalHosts пробы:
  //  - api.monkeytype.com — боевой бэкенд; заменён заглушкой (BACKEND_URL), блокировка оставлена на случай,
  //    если адрес где-то зашит; monkeytype.instatus.com — страница статуса, к ней клиент идёт при сбое API;
  //  - реклама (с 2023 г. — Playwire/Nitropay, Google Ad Manager), аналитика Google, Sentry;
  //  - Firebase с фиктивным конфигом и без сохранённого входа к серверам не обращается — домены
  //    заблокированы на всякий случай; reCAPTCHA (google.com/gstatic) — только при регистрации.
  // Шрифты и языковые файлы — свои, с того же домена, не блокируются.
  blockedUrlPatterns: [
    '*api.monkeytype.com*',
    '*instatus.com*',
    '*nitropay*',
    '*playwire*',
    '*pubgalaxy*',
    '*googlesyndication*',
    '*doubleclick*',
    '*googletagmanager*',
    '*google-analytics*',
    '*sentry.io*',
    '*identitytoolkit.googleapis.com*',
    '*securetoken.googleapis.com*',
    '*firebaseinstallations.googleapis.com*',
    '*bench-fake.firebaseapp.com*',
    // проба старой точки (177eb590, 09.2025): реклама подключалась иначе, чем сейчас, — Playwire (intergient),
    // Amazon, Confiant (fixedfold — её же проверка); GitHub (api, raw); reCAPTCHA грузилась сразу
    '*intergient*',
    '*amazon-adsystem*',
    '*confiant*',
    '*fixedfold*',
    '*api.github.com*',
    '*raw.githubusercontent.com*',
    '*www.google.com*',
    '*www.gstatic.com*',
  ],
  // <head> подключается фрагментом html/head.html (vite-plugin-html-inject), точка входа — ts/index.ts
  mutation: { html: 'frontend/src/html/head.html', entry: 'frontend/src/ts/index.ts' },
  pages: [
    {
      name: 'test',
      path: '/',
      flow: typeTest,
      // Вернувшийся пользователь, уже ответивший на окно cookies («reject non-essential»): без этого
      // LCP-элементом было окно согласия (A/A 04.10), а не слова теста. Ключ и формат одинаковы
      // во всём диапазоне (frontend/src/ts/cookies.ts).
      localStorage: { acceptedCookies: JSON.stringify({ security: true, analytics: false, sentry: false }) },
    },
  ],
} satisfies RepoConfig;
