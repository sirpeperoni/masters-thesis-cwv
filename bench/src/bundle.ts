import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BundleStats } from './types.ts';

const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.txt', '.webmanifest']);

/** Размер сборки по типам файлов (raw и gzip). Source maps не учитываем. */
export function bundleStats(distDir: string): BundleStats {
  const stats: BundleStats = { files: 0, byExt: {}, totalRaw: 0, totalGzip: 0 };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const ext = extname(name).toLowerCase() || '(none)';
      if (ext === '.map') continue;
      const buf = readFileSync(full);
      const gzip = COMPRESSIBLE.has(ext) ? gzipSync(buf, { level: 9 }).length : buf.length;
      const bucket = (stats.byExt[ext] ??= { files: 0, raw: 0, gzip: 0 });
      bucket.files++;
      bucket.raw += buf.length;
      bucket.gzip += gzip;
      stats.files++;
      stats.totalRaw += buf.length;
      stats.totalGzip += gzip;
    }
  };
  walk(distDir);
  return stats;
}

/** Хеш содержимого сборки (пути + байты, без source maps): одинаковый хеш — одинаковое приложение. */
export function distHash(distDir: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (extname(name).toLowerCase() !== '.map') files.push(full);
    }
  };
  walk(distDir);
  const h = createHash('sha256');
  for (const f of files.map((f) => relative(distDir, f).replaceAll('\\', '/')).sort()) {
    h.update(f).update('\0').update(readFileSync(join(distDir, f))).update('\0');
  }
  return h.digest('hex');
}
