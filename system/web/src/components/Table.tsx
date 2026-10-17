// Сортировка и поиск для таблиц: заголовок-кнопка со стрелкой, поле поиска.
import { useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc';
export interface SortState { key: string; dir: SortDir }

/** Заголовок колонки, сортирующий по клику (повторный клик — обратный порядок). */
export function SortTh({ k, sort, onSort, children, num, title }: {
  k: string; sort: SortState; onSort: (s: SortState) => void; children: React.ReactNode; num?: boolean; title?: string;
}) {
  const on = sort.key === k;
  return (
    <th className={`${num ? 'num ' : ''}sortable${on ? ' on' : ''}`} title={title}
        aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort({ key: k, dir: on && sort.dir === 'asc' ? 'desc' : 'asc' })}>
        {children}<span className="arrow" aria-hidden>{on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

/** Отсортировать строки по значению get(row, key); null — всегда в конце. */
export function useSorted<T>(rows: T[], sort: SortState, get: (row: T, key: string) => number | string | null | undefined) {
  return useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const x = get(a, sort.key), y = get(b, sort.key);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ru');
      return sort.dir === 'asc' ? c : -c;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort.key, sort.dir]);
}

/** Поле поиска; matches(строка поиска, поля строки) — без учёта регистра. */
export function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="search">
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </div>
  );
}

export const matches = (q: string, ...fields: (string | number | null | undefined)[]) => {
  const s = q.trim().toLowerCase();
  return !s || fields.some((f) => f != null && String(f).toLowerCase().includes(s));
};

export function useLocalSort(initial: SortState) {
  return useState<SortState>(initial);
}
