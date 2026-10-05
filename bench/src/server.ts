import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { createGzip } from 'node:zlib';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
};
/** Префикс путей, на которые сервер отвечает 404 (см. заглушку бэкенда ниже). */
export const STUB_PREFIX = '/__stub/';

const GZIP = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest', '.txt']);

/**
 * Статический сервер для сборки: gzip как у типичного CDN, SPA-fallback.
 * Один и тот же сервер для всех проектов, чтобы сетевой слой не влиял на сравнение коммитов.
 *
 * Поиск файла по пути /a/b: сам файл → /a/b/index.html → /a/b.html (так раскладывают
 * страницы SvelteKit adapter-static и VitePress) → резервная SPA-страница (`fallback`).
 */
export async function serveStatic(
  root: string,
  opts: { fallback?: string } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const fallback = opts.fallback ?? 'index.html';
  const isFile = (p: string) => existsSync(p) && !statSync(p).isDirectory();
  const server: Server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    // Заглушка бэкенда: приложение собирается с адресом API «/__stub» (тот же источник — без CORS)
    // и на любой запрос получает 404. Так оно ведёт себя, как при штатной ошибке API, а не как при
    // недоступной сети (у monkeytype сетевая ошибка включает баннер «server down» — он становился LCP).
    if (urlPath.startsWith(STUB_PREFIX)) {
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"message":"no backend in bench"}');
      return;
    }
    let file = normalize(join(root, urlPath));
    if (!file.startsWith(normalize(root))) {
      res.writeHead(403).end();
      return;
    }
    if (!isFile(file)) {
      const candidates = [join(file, 'index.html'), file.replace(/[\\/]+$/, '') + '.html', join(root, fallback)];
      file = candidates.find(isFile) ?? join(root, 'index.html');
    }
    const ext = extname(file).toLowerCase();
    const headers: Record<string, string> = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    };
    const gzip = GZIP.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (gzip) headers['content-encoding'] = 'gzip';
    res.writeHead(200, headers);
    const stream = createReadStream(file);
    (gzip ? stream.pipe(createGzip({ level: 6 })) : stream).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
