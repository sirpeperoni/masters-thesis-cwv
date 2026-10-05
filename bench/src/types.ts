import type { Page } from 'puppeteer-core';

/** Описание одного исследуемого репозитория. */
export interface RepoConfig {
  name: string;
  url: string;
  branch: string;
  /** Коммиты берутся из first-parent истории ветки в этом диапазоне дат. */
  since?: string;
  until?: string;
  /** Если задано — пропускаем коммиты, которые не трогают эти пути (git pathspec). */
  pathsFilter?: string[];
  install: string;
  build: string;
  /** Папка со статической сборкой относительно корня репозитория. */
  distDir: string;
  /** Файлы, по хешу которых решаем, нужно ли переустанавливать зависимости. */
  installInputs: string[];
  /** Переменные окружения для install и build. */
  env?: Record<string, string>;
  /** Резервная страница SPA относительно distDir (по умолчанию index.html). */
  spaFallback?: string;
  /**
   * Шаблоны URL внешних ресурсов, которые блокируются при замерах (Chrome Network.setBlockedURLs,
   * `*` — любые символы): реклама, аналитика, чужие CDN. Их время зависит от интернета, а не от коммита.
   * Что именно запрашивает страница — смотреть в externalHosts результатов.
   */
  blockedUrlPatterns?: string[];
  /**
   * Куда внедрять искусственные регрессии (режим --mutants): HTML-шаблон с <head> и модуль,
   * который выполняется при старте приложения (если его нет — будет создан).
   */
  mutation?: { html?: string; entry: string };
  pages: PageConfig[];
}

export interface PageConfig {
  name: string;
  path: string;
  /** Сценарий взаимодействия для измерения INP (Lighthouse timespan). */
  flow?: (page: Page) => Promise<void>;
  /**
   * Записи localStorage, которые появляются до запуска скриптов страницы при каждой загрузке
   * (профиль у прогона чистый): например, уже данное согласие на cookies — иначе LCP-элементом
   * становится окно согласия, а не содержимое страницы. Значения — строки, как в localStorage.
   */
  localStorage?: Record<string, string>;
}

export type Metrics = Record<string, number | null>;

export interface LcpElement {
  selector: string;
  label: string;
  snippet: string;
}

export interface PageRun {
  /** Метрики загрузки; фазы LCP — lcp_timeToFirstByte, lcp_resourceLoadDelay, … (мс, наблюдаемые). */
  navigation: Metrics;
  interaction: Metrics | null;
  /** Какой элемент Lighthouse счёл LCP (нет в данных до 29.09.2026 — excalidraw собран без него). */
  lcpElement?: LcpElement;
  /** Порядковый номер прогона внутри сравнения — для анализа дрейфа. */
  seq?: number;
  error?: string;
}

export type CommitStatus =
  | 'ok'
  /** Сборка побайтно совпала с базой — изменений производительности нет по построению. */
  | 'identical_build'
  | 'install_failed'
  | 'build_failed'
  | 'measure_failed'
  /** Нет успешно собранной базы для сравнения. */
  | 'no_base';

export interface CommitResult {
  schema: 2;
  repo: string;
  sha: string;
  parent: string | null;
  date: string;
  subject: string;
  status: CommitStatus;
  error?: string;
  /**
   * С чем сравниваем: последняя успешно собранная версия до этого коммита
   * (обычно — предыдущий коммит в first-parent истории).
   */
  base: { sha: string; distHash: string } | null;
  distHash: string | null;
  timings: { installMs: number | null; buildMs: number | null; measureMs: number | null };
  bundle: BundleStats | null;
  /** Прогоны коммита и базы, чередуемые по схеме ABBA: runs[pageName][i]. */
  runs: Record<string, PageRun[]>;
  baseRuns: Record<string, PageRun[]>;
  /** Были ли добавлены прогоны после первичной проверки. */
  extended: boolean;
  /** Контрольное A/A-сравнение: сборки одинаковые, но измерены (для оценки ложных срабатываний). */
  aa: boolean;
  /**
   * A/A «сборка против самой себя»: обе стороны — одна и та же сборка коммита.
   * Хранится отдельным файлом data/<repo>/<sha>.aa.json рядом с обычным результатом.
   */
  selfAA?: boolean;
  /** Правило расширения серии (нет в ранних файлах — там было «p<0.1 || |Δ|≥порога»). */
  method?: { pairs: number; extra: number; extendRule: string };
  /** Искусственная регрессия: коммит + внедрённый антипаттерн (data/<repo>-mutants/). */
  mutation?: { op: string; metric: string; level: number; unit: string; file: string; snippet: string };
  env: { node: string; chrome: string; lighthouse: string; settings: unknown; blockedUrlPatterns?: string[]; lang?: string };
  /** Внешние домены, к которым обращалась страница при прогреве (незаблокированные и заблокированные). */
  externalHosts?: { external: string[]; blocked: string[] };
}

export interface BundleStats {
  files: number;
  byExt: Record<string, { files: number; raw: number; gzip: number }>;
  totalRaw: number;
  totalGzip: number;
}
