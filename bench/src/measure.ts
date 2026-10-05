import { startFlow, type Flags, type Result } from 'lighthouse';
import puppeteer, { type Browser } from 'puppeteer-core';
import type { LcpElement, Metrics, PageConfig, PageRun } from './types.ts';

export const CHROME_PATH =
  process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/**
 * Единые настройки измерений для всех проектов.
 * Десктопный экран (UI приложений рассчитан на него), но CPU замедлен в 4 раза,
 * иначе на быстрой машине TBT/INP почти всегда ~0 и сигнала нет.
 */
export const LH_FLAGS: Flags = {
  formFactor: 'desktop',
  screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
  throttlingMethod: 'simulate',
  throttling: {
    rttMs: 40,
    throughputKbps: 10 * 1024,
    cpuSlowdownMultiplier: 4,
    requestLatencyMs: 0,
    downloadThroughputKbps: 0,
    uploadThroughputKbps: 0,
  },
};

const NAV_AUDITS = [
  'largest-contentful-paint',
  'cumulative-layout-shift',
  'total-blocking-time',
  'first-contentful-paint',
  'max-potential-fid',
  'total-byte-weight',
  'bootup-time',
  'mainthread-work-breakdown',
  'dom-size-insight',
  // элемент LCP и разложение LCP на фазы — здесь только чтобы попасть в onlyAudits; разбирается в lcpDetails()
  'lcp-breakdown-insight',
];
const TIMESPAN_AUDITS = [
  'interaction-to-next-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
  'mainthread-work-breakdown',
];

// Считаем только нужные аудиты (+ 'metrics' ради observed*-значений) вместо всей категории
// performance (~49 аудитов) и не делаем полностраничный скриншот: ~10% времени прогона.
// Speed Index убран — не используется. onlyCategories не задаём: вместе с onlyAudits он их объединяет.
LH_FLAGS.onlyAudits = [...new Set([...NAV_AUDITS, ...TIMESPAN_AUDITS, 'metrics'])];
LH_FLAGS.disableFullPageScreenshot = true;

/** Timespan не поддерживает simulate — здесь замедление реально применяется через DevTools. */
const TIMESPAN_FLAGS: Flags = { ...LH_FLAGS, throttlingMethod: 'devtools' };

/** Сокращённые имена для итоговых таблиц. */
const SHORT: Record<string, string> = {
  'largest-contentful-paint': 'lcp',
  'cumulative-layout-shift': 'cls',
  'total-blocking-time': 'tbt',
  'first-contentful-paint': 'fcp',
  'max-potential-fid': 'mpfid',
  'total-byte-weight': 'bytes',
  'bootup-time': 'bootup',
  'mainthread-work-breakdown': 'mainthread',
  'dom-size-insight': 'dom',
  'interaction-to-next-paint': 'inp',
};

function extract(lhr: Result, audits: string[]): Metrics {
  const m: Metrics = {};
  for (const id of audits) {
    if (id === 'lcp-breakdown-insight') continue; // не число — разбирается в lcpDetails()
    m[SHORT[id] ?? id] = lhr.audits[id]?.numericValue ?? null;
  }
  // При simulate Lighthouse также отдаёт наблюдаемые (без моделирования) значения —
  // сохраняем их, чтобы потом сравнить шумность двух подходов.
  const details = lhr.audits.metrics?.details as { items?: Record<string, unknown>[] } | undefined;
  const item = details?.items?.[0];
  if (item) {
    for (const [k, v] of Object.entries(item)) {
      if (k.startsWith('observed') && !k.endsWith('Ts') && typeof v === 'number') m[k] = v;
    }
  }
  return m;
}

/**
 * Элемент LCP и фазы LCP (наблюдаемые по трассе, без моделирования), из lcp-breakdown-insight.
 * Элемент нужен, чтобы отличать реальное ускорение/замедление от смены LCP-элемента
 * (крупнейшим стал другой блок — метрика изменилась, производительность нет);
 * фазы — чтобы видеть, за счёт чего изменился LCP: сеть (TTFB, загрузка ресурса) или отрисовка.
 */
function lcpDetails(lhr: Result): { phases: Metrics; element?: LcpElement } {
  const details = lhr.audits['lcp-breakdown-insight']?.details as { type?: string; items?: any[] } | undefined;
  const phases: Metrics = {};
  let element: LcpElement | undefined;
  for (const part of details?.type === 'list' ? (details.items ?? []) : []) {
    if (part?.type === 'table') {
      for (const row of part.items ?? []) {
        if (typeof row.subpart === 'string' && typeof row.duration === 'number') phases[`lcp_${row.subpart}`] = row.duration;
      }
    } else if (part?.type === 'node') {
      element = {
        selector: String(part.selector ?? '').slice(0, 200),
        label: String(part.nodeLabel ?? '').slice(0, 120),
        snippet: String(part.snippet ?? '').slice(0, 300),
      };
    }
  }
  return { phases, element };
}

/**
 * Язык браузера фиксирован: без флага Chrome берёт язык системы, а приложения подстраивают под
 * него текст — excalidraw (собран до этой правки) измерялся на русском, и его LCP-элементом был
 * русский заголовок приветствия: обновления переводов меняли LCP на ±240 мс.
 */
export const BROWSER_LANG = 'en-US';

async function launch(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    // свежий временный профиль на каждый запуск => холодный кеш
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1350,940',
      `--lang=${BROWSER_LANG}`,
    ],
    env: { ...process.env, LANG: BROWSER_LANG, LANGUAGE: BROWSER_LANG },
    defaultViewport: null,
  });
}

/**
 * Один прогон одной страницы: навигация (LCP/CLS/TBT) + сценарий взаимодействий (INP).
 * `blocked` — шаблоны URL внешних ресурсов (реклама, аналитика, чужие CDN), которые блокируются:
 * их время ответа зависит от интернета, а не от коммита, и только добавляет шум.
 */
/**
 * Записи localStorage из конфига страницы — до запуска её скриптов, при каждой загрузке документа
 * (Lighthouse перед навигацией очищает хранилище, скрипт выполняется уже после очистки).
 */
async function presetStorage(tab: Awaited<ReturnType<Browser['newPage']>>, page: PageConfig) {
  if (!page.localStorage) return;
  await tab.evaluateOnNewDocument((items: Record<string, string>) => {
    for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
  }, page.localStorage);
}

export async function measurePage(baseUrl: string, page: PageConfig, blocked: string[] = []): Promise<PageRun> {
  const browser = await launch();
  try {
    const tab = await browser.newPage();
    await presetStorage(tab, page);
    // пустой список не передаём вовсе — настройки прогона остаются ровно такими, как раньше
    const extra: Flags = blocked.length ? { blockedUrlPatterns: blocked } : {};
    const navFlags = { ...LH_FLAGS, ...extra };
    const flow = await startFlow(tab, { flags: navFlags });
    await flow.navigate(baseUrl + page.path, navFlags);
    if (page.flow) {
      await flow.startTimespan({ ...TIMESPAN_FLAGS, ...extra });
      await page.flow(tab);
      await flow.endTimespan();
    }
    const { steps } = await flow.createFlowResult();
    return {
      navigation: { ...extract(steps[0].lhr, NAV_AUDITS), ...lcpDetails(steps[0].lhr).phases },
      lcpElement: lcpDetails(steps[0].lhr).element,
      interaction: page.flow ? extract(steps[1].lhr, TIMESPAN_AUDITS) : null,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Лёгкий прогрев версии без Lighthouse: одна загрузка страницы в Chrome.
 * Прогревает дисковый кеш ОС и сервер — для этого полный прогон не нужен.
 * Заодно возвращает внешние домены, к которым обращалась страница (и отдельно — заблокированные):
 * по ним видно, что ещё стоит добавить в blockedUrlPatterns конфига.
 */
export async function warmup(
  baseUrl: string,
  page: PageConfig,
  blocked: string[] = [],
): Promise<{ external: string[]; blocked: string[] }> {
  const browser = await launch();
  const external = new Set<string>();
  const blockedHosts = new Set<string>();
  const local = new URL(baseUrl).host;
  try {
    const tab = await browser.newPage();
    await presetStorage(tab, page);
    if (blocked.length) {
      const cdp = await tab.createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: blocked });
    }
    // Заблокированное определяем по совпадению с шаблоном: блокировка выставлена через отдельную
    // CDP-сессию, и события requestfailed Puppeteer для таких запросов не получает.
    const rx = blocked.map((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
    tab.on('request', (r) => {
      const u = new URL(r.url());
      if (!u.protocol.startsWith('http') || u.host === local) return;
      (rx.some((x) => x.test(r.url())) ? blockedHosts : external).add(u.host);
    });
    await tab.goto(baseUrl + page.path, { waitUntil: 'networkidle0', timeout: 60_000 });
  } finally {
    await browser.close().catch(() => {});
  }
  return { external: [...external].sort(), blocked: [...blockedHosts].sort() };
}

export async function chromeVersion(): Promise<string> {
  const b = await launch();
  try {
    return await b.version();
  } finally {
    await b.close();
  }
}
