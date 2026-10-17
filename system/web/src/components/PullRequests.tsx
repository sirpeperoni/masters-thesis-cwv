import { useEffect, useState } from 'react';
import { api, type Assessment, type Meta, type PullRequest, useData } from '../api.ts';
import { date, num, pct, topShare } from '../format.ts';
import { LevelBadge } from './Badges.tsx';
import { Hint } from './Hint.tsx';
import { matches, Search, SortTh, type SortState, useSorted } from './Table.tsx';

type Result = Assessment & { pr: number; title: string; url: string };

/** Открытые pull request'ы проекта на GitHub: оценка одним нажатием (или всех сразу), подробности — по строке. */
export function PullRequests({ project, meta, onAssessed, open, onOpen }: {
  project: string; meta: Meta; onAssessed: () => void; open?: number; onOpen: (n?: number) => void;
}) {
  const prs = useData(() => api.prs(project), [project]);
  const [running, setRunning] = useState<number[]>([]);
  const [results, setResults] = useState<Record<number, Result>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'updated', dir: 'desc' });
  const setOpen = onOpen;
  const level = (p: PullRequest) => results[p.number]?.place ?? p.assessed?.place ?? null;
  const rows = useSorted((prs.data ?? []).filter((p) => matches(q, p.title, p.author, `#${p.number}`)), sort, (p, k) =>
    k === 'number' ? p.number : k === 'title' ? p.title : k === 'author' ? p.author : k === 'size' ? p.additions + p.deletions
      : k === 'risk' ? level(p) : p.updatedAt);

  const assess = async (n: number) => {
    setRunning((r) => [...r, n]);
    try {
      const r = await api.assessPr(project, n);
      setResults((x) => ({ ...x, [n]: r }));
      setOpen(n);
      onAssessed();
    } catch (e) {
      setErrors((x) => ({ ...x, [n]: (e as Error).message }));
    } finally {
      setRunning((r) => r.filter((x) => x !== n));
    }
  };
  // PR открыт по ссылке (…&pr=N), а оценки в памяти нет — получить её (история проекта в кеше — секунды)
  useEffect(() => {
    if (open && prs.data?.some((p) => p.number === open) && !results[open] && !running.includes(open) && meta.live) assess(open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prs.data]);

  const assessAll = async () => {
    for (const p of prs.data ?? []) if (!p.assessed && !results[p.number]) await assess(p.number);
  };

  if (prs.error) return <div className="notice error-notice">GitHub: {prs.error}</div>;
  if (!prs.data) return <p className="muted">Получаю pull request'ы с GitHub…</p>;
  if (!prs.data.length) return <p className="muted">Открытых pull request'ов нет.</p>;
  const left = prs.data.filter((p) => !p.assessed && !results[p.number]).length;
  const shown = open != null ? results[open] : undefined;

  return (
    <div className={shown ? 'layout-split' : ''}>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <div className="toolbar">
          <span className="muted">Открытых: {prs.data.length}. Первая оценка в проекте считает историю — до пары минут.</span>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <Search value={q} onChange={setQ} placeholder="Поиск: заголовок, автор, #номер" />
            {left > 0 && meta.live && (
              <button className="primary" disabled={running.length > 0} onClick={assessAll}>Оценить все ({left})</button>
            )}
          </div>
        </div>
        <table>
          <thead><tr>
            {([['number', 'PR'], ['title', 'Заголовок'], ['author', 'Автор']] as const).map(([k, l]) => <SortTh key={k} k={k} sort={sort} onSort={setSort}>{l}</SortTh>)}
            <SortTh k="size" sort={sort} onSort={setSort} num>Строк +/−</SortTh>
            <SortTh k="updated" sort={sort} onSort={setSort}>Обновлён</SortTh>
            <SortTh k="risk" sort={sort} onSort={setSort}>Риск <Hint k="level" /></SortTh>
          </tr></thead>
          <tbody>
            {!rows.length && <tr><td colSpan={6} className="muted">Ничего не найдено по «{q}».</td></tr>}
            {rows.map((p: PullRequest) => {
              const r = results[p.number];
              const lvl = r ? { level: r.level, place: r.place } : p.assessed;
              return (
                <tr key={p.number} className={`click${open === p.number ? ' sel' : ''}`}
                    onClick={() => (r ? setOpen(p.number) : !running.includes(p.number) && assess(p.number))}>
                  <td><a href={p.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>#{p.number}</a></td>
                  <td className="subject" style={shown ? { maxWidth: 220 } : undefined} title={p.title}>{p.isDraft && <span className="muted">[черновик] </span>}{p.title}</td>
                  <td className="muted">{p.author ?? '—'}</td>
                  <td className="num muted">+{num(p.additions)} / −{num(p.deletions)}</td>
                  <td className="muted">{date(p.updatedAt)}</td>
                  <td>
                    {running.includes(p.number) ? <span className="muted">оцениваю…</span>
                      : lvl ? <LevelBadge level={lvl.level} place={shown ? undefined : lvl.place} />
                      : errors[p.number] ? <span className="error" title={errors[p.number]}>ошибка</span>
                      : <button className="ghost small" onClick={(e) => { e.stopPropagation(); assess(p.number); }}>Оценить</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown && (
        <div className="card panel">
          <div className="panel-head">
            <h3>PR #{shown.pr}</h3>
            <button className="close" onClick={() => setOpen(undefined)} aria-label="Закрыть">×</button>
          </div>
          <p style={{ margin: '0 0 12px' }}>{shown.title}</p>
          {shown.scale === 'pooled' && <div className="notice">В истории проекта меньше 30 коммитов — изменение сравнивается с коммитами проектов, на которых обучена модель (менее точно).</div>}
          <dl>
            <dt>Прогноз <Hint k="forecast" /></dt><dd><LevelBadge level={shown.level} /></dd>
            <dt>Место <Hint k="place" /></dt><dd>{topShare(shown.place)} среди {num(shown.history)} коммитов проекта</dd>
            <dt>Регрессий на уровне</dt><dd>{pct(shown.expected_rate, 1)} (проверка на 11 проектах)</dd>
            <dt>Изменение</dt><dd>{num(shown.files)} файлов, +{num(shown.lines_added)} / −{num(shown.lines_deleted)} строк</dd>
          </dl>
          <h3>Почему такой прогноз <Hint k="reasons" /></h3>
          {shown.level !== 'low' && shown.reasons.length ? (
            <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
              {shown.reasons.map((r) => <li key={r.feature}>{r.label}: <strong>{num(r.value, r.value % 1 ? 2 : 0)}</strong> <span className="muted">— больше, чем у {pct(r.percentile)} коммитов</span></li>)}
            </ul>
          ) : <p className="muted">Изменение ничем не выделяется среди коммитов проекта.</p>}
          <p style={{ margin: 0 }}><a href={shown.url} target="_blank" rel="noreferrer">Открыть PR на GitHub ↗</a></p>
        </div>
      )}
    </div>
  );
}
