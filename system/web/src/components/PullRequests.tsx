import { useState } from 'react';
import { api, type Assessment, type Meta, type PullRequest, useData } from '../api.ts';
import { date, num, pct, topShare } from '../format.ts';
import { LevelBadge } from './Badges.tsx';

type Result = Assessment & { pr: number; title: string; url: string };

/** Открытые pull request'ы проекта на GitHub: оценка одним нажатием (или всех сразу), подробности — по строке. */
export function PullRequests({ project, meta, onAssessed }: { project: string; meta: Meta; onAssessed: () => void }) {
  const prs = useData(() => api.prs(project), [project]);
  const [running, setRunning] = useState<number[]>([]);
  const [results, setResults] = useState<Record<number, Result>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<number>();

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
        <div className="row" style={{ padding: '12px 14px', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="muted">Открытых: {prs.data.length}. Первая оценка в проекте считает историю — до пары минут.</span>
          {left > 0 && meta.live && (
            <button className="primary" disabled={running.length > 0} onClick={assessAll}>Оценить все ({left})</button>
          )}
        </div>
        <table>
          <thead><tr><th>PR</th><th>Заголовок</th><th>Автор</th><th className="num">Строк +/−</th><th>Обновлён</th><th>Риск</th></tr></thead>
          <tbody>
            {prs.data.map((p: PullRequest) => {
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
          <dl>
            <dt>Прогноз</dt><dd><LevelBadge level={shown.level} /></dd>
            <dt>Место</dt><dd>{topShare(shown.place)} среди {num(shown.history)} коммитов проекта</dd>
            <dt>Регрессий на уровне</dt><dd>{pct(shown.expected_rate, 1)} (проверка на 11 проектах)</dd>
            <dt>Изменение</dt><dd>{num(shown.files)} файлов, +{num(shown.lines_added)} / −{num(shown.lines_deleted)} строк</dd>
          </dl>
          <h3>Почему такой прогноз</h3>
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
