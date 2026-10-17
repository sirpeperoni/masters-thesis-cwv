import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useData } from '../api.ts';
import { matches, Search, SortTh, type SortState, useSorted } from '../components/Table.tsx';
import { date, num, pct } from '../format.ts';

export function ProjectsPage() {
  const p = useData(api.projects);
  const [sort, setSort] = useState<SortState>({ key: 'regressions', dir: 'desc' });
  const [q, setQ] = useState('');
  const rows = useSorted((p.data ?? []).filter((x) => matches(q, x.name, x.external?.name)), sort, (x, k) =>
    k === 'share' ? (x.measured ? x.regressions / x.measured : null) : k === 'name' ? (x.external?.name ?? x.name)
      : (x as unknown as Record<string, number | string>)[k]);
  const th = (k: string, l: string, n?: boolean) => <SortTh k={k} sort={sort} onSort={setSort} num={n}>{l}</SortTh>;
  if (p.error) return <p className="error">{p.error}</p>;
  if (!p.data) return <p className="muted">Загрузка…</p>;
  return (
    <>
      <h2>Проекты</h2>
      <p className="lead">
        Четыре проекта измерены полностью — на них обучена модель, прогноз для них не показывается. На одиннадцати
        новых модель ранжировала все коммиты, стенд измерил отобранные ею и случайные.
      </p>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <div className="toolbar"><span /><Search value={q} onChange={setQ} placeholder="Поиск проекта" /></div>
        <table>
          <thead>
            <tr>
              {th('name', 'Проект')}{th('group_name', 'Роль')}{th('commits', 'Коммитов', true)}{th('measured', 'Измерено', true)}
              {th('regressions', 'Регрессий', true)}{th('share', 'Доля среди измеренных', true)}{th('prs', 'PR', true)}{th('first_date', 'Период')}
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.name}>
                <td><Link to={`/projects/${x.name}`}>{x.external?.name ?? x.name}</Link></td>
                <td className="muted">{x.group_name === 'study' ? 'обучение модели' : x.group_name === 'external' ? 'ваш проект' : 'новый проект'}</td>
                <td className="num">{num(x.commits)}</td>
                <td className="num">{num(x.measured)}</td>
                <td className="num">{x.regressions ? <span className="res-regression">{num(x.regressions)}</span> : '0'}</td>
                <td className="num">{x.measured ? pct(x.regressions / x.measured, 1) : '—'}</td>
                <td className="num">{x.prs || '—'}</td>
                <td className="muted">{date(x.first_date)} – {date(x.last_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">Доля среди измеренных у новых проектов смещена вверх: измерялись в основном коммиты, отобранные моделью.</p>
    </>
  );
}
