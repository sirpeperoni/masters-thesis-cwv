/**
 * Скриншоты страниц и предразметка для разметки изображений (лабораторная «Разметка изображений»).
 * Вызывается из trial.ts с --shots: после сборки версия раздаётся тем же сервером, открывается в Chrome
 * с теми же размером окна, языком, блокировкой и localStorage, что при замерах, и снимается первый экран.
 *
 * Предразметка — рамки областей страницы:
 *   - LCP-элемент — по PerformanceObserver (largest-contentful-paint), с признаком is_lcp;
 *   - области по селекторам конфигурации ниже (основной контент, баннер, шапка…) — приблизительно;
 *   - источники сдвигов вёрстки (layout-shift) — признак shifts_layout у пересекающихся областей.
 * Классы и признаки — docs/annotation-schema.md, раздел «Изображения».
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { BROWSER_LANG, CHROME_PATH } from './measure.ts';
import { serveStatic } from './server.ts';
import type { PageConfig, RepoConfig } from './types.ts';

export const VIEWPORT = { width: 1350, height: 940 };

export const LABELS = ['main_content', 'workarea', 'banner', 'modal', 'navigation', 'footer', 'error_message'] as const;
export type Label = (typeof LABELS)[number];

/** Области страницы по селекторам: первый видимый на первом экране элемент из списка. Старые версии
 *  приложений вёрстаны иначе — поэтому по нескольку селекторов, а итог проверяется вручную в CVAT. */
const REGIONS: Record<string, [Label, string][]> = {
  excalidraw: [
    ['workarea', 'canvas.excalidraw__canvas.interactive, canvas.excalidraw__canvas, canvas'],
    ['main_content', '.welcome-screen-center, .welcome-screen-decor'],
    ['navigation', '.App-toolbar, .App-menu_top, .layer-ui__wrapper__top-right'],
    ['footer', '.layer-ui__wrapper__footer, .App-menu_bottom'],
    ['modal', '[role="dialog"], .Modal'],
  ],
  'mermaid-live-editor': [
    ['workarea', '.monaco-editor'],
    ['main_content', '#container, #view, [data-testid="view"]'],
    ['navigation', '.navbar, nav, header'],
    ['navigation', '[class*="toolbar"], [class*="Toolbar"]'],
    ['banner', 'a.col-start-1, [class*="promo"], [class*="announcement"]'],
    ['error_message', '#errorContainer'],
    ['modal', '[role="dialog"], dialog[open]'],
  ],
  // одна строка — одна область; селекторы через запятую — варианты для разных версий вёрстки
  'vuejs-docs': [
    ['main_content', '.vt-doc, .VPContentDoc, main'],
    ['navigation', '.VPNav, .vt-nav'],
    ['navigation', '.VPSidebar, aside.VPSidebar'],
    ['navigation', '.VPDocAside, .aside, .VPContentDocOutline'],
    ['modal', '[class*="tooltip"], [class*="Tooltip"], [class*="popover"], [class*="preference"] [role="tooltip"]'],
    ['banner', '.banner, .vuemastery-banner-wrapper, [class*="Banner"]'],
    ['footer', 'footer'],
    ['modal', '[role="dialog"]'],
  ],
  monkeytype: [
    ['main_content', '#typingTest, #words, #wordsWrapper'],
    ['navigation', 'header, #top'],
    ['banner', '#bannerCenter, .psa, .banner, [class*="banner"]'],
    ['footer', 'footer'],
    ['modal', 'dialog[open], .modalWrapper:not(.hidden), #cookiesModal:not(.hidden)'],
  ],
};

export interface Box {
  label: Label | 'lcp_element';
  x: number;
  y: number;
  w: number;
  h: number;
  is_lcp: boolean;
  shifts_layout: boolean;
  above_fold: boolean;
  source: 'lcp' | 'selector';
  selector?: string;
  text?: string;
}

export interface ShotMeta {
  sha: string;
  repo: string;
  page: string;
  file: string;
  width: number;
  height: number;
  lcp: { selector: string; text: string; tag: string; time: number } | null;
  layoutShifts: { value: number; rects: { x: number; y: number; w: number; h: number }[] }[];
  boxes: Box[];
}

/** Снимок первого экрана одной страницы собранной версии + предразметка. */
export async function shoot(cfg: RepoConfig, dist: string, sha: string, outDir: string, page: PageConfig = cfg.pages[0]): Promise<ShotMeta> {
  mkdirSync(outDir, { recursive: true });
  const server = await serveStatic(dist, { fallback: cfg.spaFallback });
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', `--lang=${BROWSER_LANG}`],
    env: { ...process.env, LANG: BROWSER_LANG, LANGUAGE: BROWSER_LANG },
    defaultViewport: VIEWPORT,
  });
  try {
    const tab = await browser.newPage();
    // tsx (esbuild, keepNames) оборачивает именованные функции в __name(…) — в странице браузера её нет,
    // и код, переданный в evaluate, падал «__name is not defined». Заглушка — строкой, до любого evaluate.
    await tab.evaluateOnNewDocument('globalThis.__name = (f) => f;');
    if (cfg.blockedUrlPatterns?.length) {
      const cdp = await tab.createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: cfg.blockedUrlPatterns });
    }
    if (page.localStorage) {
      await tab.evaluateOnNewDocument((items: Record<string, string>) => {
        for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
      }, page.localStorage);
    }
    // наблюдатели ставятся до скриптов страницы: последний кандидат LCP и все сдвиги вёрстки
    await tab.evaluateOnNewDocument(() => {
      const w = window as unknown as { __lcp: unknown; __shifts: unknown[] };
      w.__shifts = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { element?: Element; startTime: number })[]) {
          w.__lcp = { el: e.element ?? null, time: e.startTime };
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { currentRect: DOMRectReadOnly }[] })[]) {
          if (e.hadRecentInput) continue;
          w.__shifts.push({ value: e.value, rects: (e.sources ?? []).map((s) => ({ x: s.currentRect.x, y: s.currentRect.y, w: s.currentRect.width, h: s.currentRect.height })) });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await tab.goto(server.url + page.path, { waitUntil: 'networkidle0', timeout: 60_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000)); // поздние баннеры и сдвиги

    const regions = REGIONS[cfg.name] ?? [];
    const found = await tab.evaluate((regions: [string, string][], vh: number) => {
      const w = window as unknown as { __lcp?: { el: Element | null; time: number }; __shifts: { value: number; rects: { x: number; y: number; w: number; h: number }[] }[] };
      const path = (el: Element) => {
        const parts: string[] = [];
        for (let e: Element | null = el; e && parts.length < 4; e = e.parentElement) {
          parts.unshift(e.tagName.toLowerCase() + (e.id ? `#${e.id}` : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
        }
        return parts.join(' > ');
      };
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(r.width, innerWidth - Math.max(0, r.x)), h: Math.min(r.height, vh - Math.max(0, r.y)) };
      };
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 8 && r.height > 8 && r.top < vh && r.bottom > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0;
      };
      const boxes: unknown[] = [];
      for (const [label, sel] of regions) {
        for (const s of sel.split(',').map((x) => x.trim())) {
          const el = [...document.querySelectorAll(s)].find(visible);
          if (el) {
            boxes.push({ label, ...rect(el), selector: s, text: (el.textContent ?? '').trim().slice(0, 120) });
            break;
          }
        }
      }
      const lcpEl = w.__lcp?.el && w.__lcp.el.isConnected ? w.__lcp.el : null;
      return {
        lcp: lcpEl ? { ...rect(lcpEl), selector: path(lcpEl), text: (lcpEl.textContent ?? '').trim().slice(0, 120), tag: lcpEl.tagName.toLowerCase(), time: w.__lcp!.time } : null,
        shifts: w.__shifts,
        boxes,
      };
    }, regions, VIEWPORT.height);

    const file = `${sha.slice(0, 12)}.png`;
    await tab.screenshot({ path: join(outDir, file) as `${string}.png`, captureBeyondViewport: false });

    const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const shiftRects = found.shifts.flatMap((s) => s.rects);
    const boxes: Box[] = (found.boxes as (Omit<Box, 'is_lcp' | 'shifts_layout' | 'above_fold' | 'source'>)[]).map((b) => ({
      ...b,
      is_lcp: !!found.lcp && overlaps(b, found.lcp) && b.w * b.h <= found.lcp.w * found.lcp.h * 1.05,
      shifts_layout: shiftRects.some((r) => overlaps(b, r)),
      above_fold: b.y < VIEWPORT.height,
      source: 'selector' as const,
    }));
    if (found.lcp && found.lcp.w > 0 && found.lcp.h > 0) {
      // сам LCP-элемент — отдельная рамка; класс области подбирает аннотатор (по умолчанию — область, в которую он попал)
      const host = boxes.find((b) => overlaps(b, found.lcp!) && b.label !== 'workarea');
      boxes.push({
        label: host?.label ?? 'main_content', x: found.lcp.x, y: found.lcp.y, w: found.lcp.w, h: found.lcp.h,
        is_lcp: true, shifts_layout: shiftRects.some((r) => overlaps(found.lcp!, r)), above_fold: true, source: 'lcp',
        selector: found.lcp.selector, text: found.lcp.text,
      });
    }
    const meta: ShotMeta = {
      sha, repo: cfg.name, page: page.name, file, width: VIEWPORT.width, height: VIEWPORT.height,
      lcp: found.lcp ? { selector: found.lcp.selector, text: found.lcp.text, tag: found.lcp.tag, time: found.lcp.time } : null,
      layoutShifts: found.shifts, boxes: boxes.map((b) => ({ ...b, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) })),
    };
    writeFileSync(join(outDir, `${sha.slice(0, 12)}.json`), JSON.stringify(meta, null, 1));
    return meta;
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
}
