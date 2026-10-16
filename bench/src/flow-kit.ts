import type { ElementHandle, Page } from 'puppeteer-core';

// Общие шаги сценариев взаимодействия (INP) для конфигов bench/repos/*.ts.
// Все действия — настоящими событиями мыши и клавиатуры (puppeteer), а не element.click():
// синтетический клик не даёт событий ввода, и Lighthouse не видит взаимодействия.

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Типовая аналитика и мониторинг ошибок — блокируются у всех новых проектов (blockedUrlPatterns):
 * время этих запросов зависит от интернета, а не от коммита. Свои CDN проекта сюда не входят.
 */
export const ANALYTICS_BLOCK = [
  '*google-analytics*',
  '*googletagmanager*',
  '*/_vercel/*',
  '*vercel-insights*',
  '*vitals.vercel*',
  '*plausible.io*',
  '*umami*',
  '*posthog*',
  '*clarity.ms*',
  '*cloudflareinsights*',
  '*sentry.io*',
  '*ingest.sentry*',
  '*googlesyndication*',
  '*doubleclick*',
  '*carbonads*',
  '*simpleanalytics*', // Simple Analytics (bentopdf)
  '*usefathom.com*', // аналитика Fathom (chartdb)
  '*ghbtns.com*', // iframe с кнопкой «Star» GitHub (chartdb)
  '*api.github.com*', // счётчик звёзд репозитория (bentopdf, omni-tools, react-bits) — время ответа от сети
];

/** Первый видимый элемент по селектору (с ожиданием). */
export async function visible(page: Page, selector: string, timeout = 60_000): Promise<ElementHandle<Element>> {
  const el = await page.waitForSelector(selector, { visible: true, timeout });
  if (!el) throw new Error(`нет элемента ${selector}`);
  return el;
}

/** Видимый элемент из `selector`, текст которого подходит под `re`; null, если такого нет. */
export async function byText(page: Page, selector: string, re: RegExp): Promise<ElementHandle<Element> | null> {
  for (const el of await page.$$(selector)) {
    const ok = await el.evaluate(
      (e, src, flags) => new RegExp(src, flags).test((e.textContent ?? '').trim()) && (e as HTMLElement).offsetParent !== null,
      re.source,
      re.flags,
    );
    if (ok) return el;
  }
  return null;
}

/** Клик по элементу с текстом; `required` — бросить ошибку, если его нет (иначе шаг пропускается). */
export async function clickText(page: Page, selector: string, re: RegExp, required = true): Promise<boolean> {
  const el = await byText(page, selector, re);
  if (!el) {
    if (required) throw new Error(`нет ${selector} с текстом ${re}`);
    return false;
  }
  await el.click();
  return true;
}

/** Набрать текст в поле (клик для фокуса, затем клавиатура) и, если `clear`, стереть его обратно. */
export async function typeInto(page: Page, selector: string, text: string, opts: { delay?: number; clear?: boolean } = {}) {
  const el = await visible(page, selector);
  await el.click();
  await page.keyboard.type(text, { delay: opts.delay ?? 80 });
  if (opts.clear) {
    await pause(400);
    for (let i = 0; i < text.length; i++) await page.keyboard.press('Backspace', { delay: 30 });
  }
}

/** Навести мышь на первые `n` видимых элементов по селектору. */
export async function hoverEach(page: Page, selector: string, n: number, gap = 250) {
  for (const el of (await page.$$(selector)).slice(0, n)) {
    await el.hover().catch(() => {});
    await pause(gap);
  }
}

/** Прокрутка колесом вниз и обратно в точке (x, y). */
export async function scrollDownUp(page: Page, deltaY = 1500, x = 700, y = 500) {
  await page.mouse.move(x, y);
  await page.mouse.wheel({ deltaY });
  await pause(600);
  await page.mouse.wheel({ deltaY: -deltaY });
  await pause(600);
}
