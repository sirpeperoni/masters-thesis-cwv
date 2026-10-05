import type { PageRun } from './types.ts';

/**
 * Целевые метрики и практические пороги значимого изменения.
 * Порог = max(abs, rel · значение базы): «изменение не меньше abs и не меньше rel от базы».
 *
 * Почему max (было min для LCP и только abs для остальных): шум зависит от приложения.
 * A/A на mermaid-live-editor (тяжёлое приложение: Monaco + mermaid) дал MDE при 15 парах
 * TBT 376 мс, INP 52 мс, LCP 184 мс — абсолютные 20–30 мс там превышаются одним шумом.
 * Для лёгкого excalidraw относительная часть почти не срабатывает (10% от TBT ≈ 3 мс).
 */
export const TARGETS = {
  lcp: { label: 'LCP', src: 'navigation', key: 'lcp', abs: 50, rel: 0.05, primary: true },
  inp: { label: 'INP', src: 'interaction', key: 'inp', abs: 20, rel: 0.1, primary: true },
  tbt: { label: 'TBT load', src: 'navigation', key: 'tbt', abs: 30, rel: 0.1, primary: true },
  tbtFlow: { label: 'TBT flow', src: 'interaction', key: 'tbt', abs: 30, rel: 0.1, primary: true },
  cls: { label: 'CLS', src: 'navigation', key: 'cls', abs: 0.01, rel: null, primary: true },
  /**
   * Дополнительная метка: наблюдаемый LCP (без моделирования Lantern, сеть localhost).
   * Мутанты показали, что моделированный LCP недооценивает блокировку главного потока
   * (задача 400 мс: Lantern +138 мс, наблюдаемый +402), а наблюдаемый не видит сеть —
   * они дополняют друг друга. Не входит в итоговую метку коммита и в решение о расширении серии.
   */
  lcpObs: { label: 'LCP obs', src: 'navigation', key: 'observedLargestContentfulPaint', abs: 50, rel: 0.05, primary: false },
} as const;
export type TargetName = keyof typeof TARGETS;
/** Основные метрики: итоговая метка коммита и расширение серии — только по ним. */
export const PRIMARY_TARGETS = (Object.keys(TARGETS) as TargetName[]).filter((t) => TARGETS[t].primary);

export function threshold(t: TargetName, baseValue: number): number {
  const { abs, rel } = TARGETS[t];
  return rel === null ? abs : Math.max(abs, rel * Math.abs(baseValue));
}

export function valuesOf(runs: PageRun[] | undefined, t: TargetName): number[] {
  const { src, key } = TARGETS[t];
  return (runs ?? [])
    .map((r) => r[src]?.[key])
    .filter((x): x is number => typeof x === 'number');
}

export function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quartiles(v: number[]): [number, number, number] | null {
  const s = [...v].sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
  };
  return [q(0.25), q(0.5), q(0.75)];
}

export const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
export const sd = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + (x - mean(v)) ** 2, 0) / (v.length - 1));

/**
 * Двусторонний тест Манна–Уитни.
 * Без связей и при малых выборках — точное распределение U, иначе нормальное приближение
 * с поправкой на связи и на непрерывность.
 */
export function mannWhitney(a: number[], b: number[]): number {
  const n1 = a.length, n2 = b.length;
  if (!n1 || !n2) return 1;
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const n = n1 + n2;
  const ranks = new Array<number>(n);
  let tieTerm = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && all[j + 1].v === all[i].v) j++;
    const t = j - i + 1;
    tieTerm += t ** 3 - t;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const r1 = all.reduce((s, x, i) => s + (x.g === 0 ? ranks[i] : 0), 0);
  const u = r1 - (n1 * (n1 + 1)) / 2;

  if (tieTerm === 0 && n1 <= 20 && n2 <= 20) return exactU(u, n1, n2);

  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieTerm / (n * (n - 1))));
  if (sigma === 0) return 1;
  const z = (Math.abs(u - mu) - 0.5) / sigma;
  return Math.min(1, 2 * (1 - phi(Math.max(0, z))));
}

/** Точное p-value: число перестановок с U ≤ u через рекуррентность f(m,n,u)=f(m-1,n,u-n)+f(m,n-1,u). */
function exactU(u: number, n1: number, n2: number): number {
  const maxU = n1 * n2;
  // dp[m][k] — распределение U для выборок размера m и k
  let prev: number[][] = [];
  for (let m = 0; m <= n1; m++) {
    const row: number[][] = [];
    for (let k = 0; k <= n2; k++) {
      if (m === 0 || k === 0) row.push([1]);
      else {
        const a = prev[k], b = row[k - 1];
        const len = m * k + 1;
        const f = new Array<number>(len).fill(0);
        for (let x = 0; x < a.length; x++) f[x + k] += a[x];
        for (let x = 0; x < b.length; x++) f[x] += b[x];
        row.push(f);
      }
    }
    prev = row;
  }
  const dist = prev[n2];
  const total = dist.reduce((s, x) => s + x, 0);
  const lo = Math.floor(Math.min(u, maxU - u));
  let tail = 0;
  for (let x = 0; x <= lo; x++) tail += dist[x];
  return Math.min(1, (2 * tail) / total);
}

function phi(z: number) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * (z / Math.SQRT2));
  const y =
    1 - ((((1.061405429 * t - 1.453152735) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + y);
}

/** Поправка Бенджамини–Хохберга: q-values в исходном порядке. */
export function benjaminiHochberg(p: number[]): number[] {
  const order = p.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const q = new Array<number>(p.length);
  let min = 1;
  for (let r = order.length - 1; r >= 0; r--) {
    const [v, i] = order[r];
    min = Math.min(min, (v * order.length) / (r + 1));
    q[i] = min;
  }
  return q;
}

export interface Comparison {
  base: number;
  head: number;
  delta: number;
  rel: number;
  p: number;
  threshold: number;
  n: [number, number];
}

/** Сравнение базы и коммита по одной метрике (медианы, Манна–Уитни). */
export function compare(baseRuns: PageRun[] | undefined, headRuns: PageRun[] | undefined, t: TargetName): Comparison | null {
  const a = valuesOf(baseRuns, t), b = valuesOf(headRuns, t);
  if (a.length < 2 || b.length < 2) return null;
  const base = median(a), head = median(b);
  return {
    base,
    head,
    delta: head - base,
    rel: base ? (head - base) / base : 0,
    p: mannWhitney(a, b),
    threshold: threshold(t, base),
    n: [a.length, b.length],
  };
}
