import { Link } from 'react-router-dom';
import { api, useData } from '../api.ts';
import { date, num, pct } from '../format.ts';

export function ProjectsPage() {
  const p = useData(api.projects);
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
        <table>
          <thead>
            <tr>
              <th>Проект</th><th>Роль</th><th className="num">Коммитов</th><th className="num">Измерено</th>
              <th className="num">Регрессий</th><th className="num">Доля среди измеренных</th><th className="num">PR</th><th>Период</th>
            </tr>
          </thead>
          <tbody>
            {p.data.map((x) => (
              <tr key={x.name}>
                <td><Link to={`/projects/${x.name}`}>{x.name}</Link></td>
                <td className="muted">{x.group_name === 'study' ? 'обучение модели' : 'новый проект'}</td>
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
