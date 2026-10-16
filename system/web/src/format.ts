// Форматирование по-русски: десятичная запятая, неразрывный пробел перед знаком процента и единицами.
import type { Level, MetricKey } from './api.ts';

export const NBSP = ' ';

export const num = (v: number, digits = 0) =>
  v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const pct = (v: number, digits = 0) => `${num(v * 100, digits)}${NBSP}%`;

export const signed = (v: number, digits = 0) => (v > 0 ? '+' : v < 0 ? '−' : '') + num(Math.abs(v), digits);

export const date = (iso: string) =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

export const short = (sha: string) => sha.slice(0, 8);

/** «верхние X %» по месту в списке риска (0 — самый рискованный). */
export const topShare = (place: number) => `верхние ${Math.max(1, Math.round(place * 100))}${NBSP}%`;

export const LEVEL: Record<Level, { name: string; advice: string }> = {
  high: { name: 'высокий', advice: 'измерить до слияния' },
  elevated: { name: 'повышенный', advice: 'измерить, если есть время' },
  low: { name: 'низкий', advice: 'замеры можно пропустить' },
};

export const METRIC: Record<MetricKey, { name: string; unit: string; digits: number }> = {
  lcp: { name: 'LCP — отрисовка основного содержимого', unit: 'мс', digits: 0 },
  inp: { name: 'INP — отклик на действие', unit: 'мс', digits: 0 },
  cls: { name: 'CLS — сдвиг вёрстки', unit: '', digits: 3 },
  tbt: { name: 'TBT загрузки', unit: 'мс', digits: 0 },
  tbtFlow: { name: 'TBT сценария', unit: 'мс', digits: 0 },
  lcpObs: { name: 'LCP наблюдаемый (доп.)', unit: 'мс', digits: 0 },
};

export const withUnit = (v: number, key: MetricKey) => {
  const m = METRIC[key];
  return num(v, m.digits) + (m.unit ? NBSP + m.unit : '');
};
