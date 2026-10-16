import { delimiter, join } from 'node:path';

/**
 * PATH с bench/shims в начале — для проектов, чей скрипт сборки сам вызывает `pnpm`/`yarn`
 * (у нас они есть только через corepack). Имя переменной берём как есть (на Windows — «Path»).
 */
export function withShimsInPath(): Record<string, string> {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const shims = join(import.meta.dirname, '..', 'shims');
  return { [key]: `${shims}${delimiter}${process.env[key] ?? ''}` };
}

const CACHE = {
  npm: join(import.meta.dirname, '..', '..', 'work', 'cache', 'npm'),
  yarn: join(import.meta.dirname, '..', '..', 'work', 'cache', 'yarn'),
};

/**
 * Щадящая сеть для установки зависимостей: при выборочном сборе lock-файл меняется почти на каждом коммите,
 * npm/pnpm ставят пакеты заново и по умолчанию открывают 15–50 соединений сразу — это забивало домашний
 * роутер (10.10: у других устройств пропадал интернет). На сборку и замеры не влияет — только скорость скачивания.
 */
export function gentleNetwork(): Record<string, string> {
  return {
    npm_config_maxsockets: '4', // npm: соединений с реестром
    npm_config_network_concurrency: '4', // pnpm: параллельных загрузок (по умолчанию 16)
    YARN_NETWORK_CONCURRENCY: '4', // yarn 1 (по умолчанию 8)
    // Браузеры из зависимостей не скачивать: стенд запускает установленный Chrome (CHROME_PATH). 11.10 установки
    // pdf.js (devDependency puppeteer) скачали 17 версий Chrome и Firefox — 11,5 ГБ в ~/.cache/puppeteer — и диск C:
    // заполнился до нуля (ENOSPC, install_failed).
    PUPPETEER_SKIP_DOWNLOAD: '1',
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: '1',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    // Кеши менеджеров пакетов — на диске проекта (E:), а не в профиле на C: (npm-cache и Yarn выросли до 18 ГБ каждый)
    npm_config_cache: CACHE.npm,
    YARN_CACHE_FOLDER: CACHE.yarn,
  };
}
