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
