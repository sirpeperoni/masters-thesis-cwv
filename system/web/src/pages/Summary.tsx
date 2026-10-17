import { api, type Meta, useData } from '../api.ts';
import { BudgetChart } from '../components/BudgetChart.tsx';
import { LEVEL, num, pct } from '../format.ts';
import { Hint } from '../components/Hint.tsx';

export function SummaryPage({ meta }: { meta: Meta }) {
  const s = useData(api.summary);
  if (s.error) return <p className="error">{s.error}</p>;
  if (!s.data) return <p className="muted">Загрузка…</p>;
  const d = s.data;
  return (
    <>
      <h2>Прогноз регрессий Core Web Vitals</h2>
      <p className="lead">
        Система оценивает риск регрессии по изменению кода — до сборки и замеров — и советует, какие изменения
        измерить на стенде. Ниже — проверка на проектах, которых модель не видела: она ранжировала все их коммиты,
        затем стенд измерил верхние 20 % списка и случайную выборку остальных.
      </p>

      <div className="tiles">
        <Tile v={num(d.projects)} k="проектов" />
        <Tile v={num(d.scored)} k="коммитов с прогнозом (11 новых проектов)" />
        <Tile v={num(d.measured)} k="пар «база → коммит» измерено стендом" />
        <Tile v={num(d.regressions)} k="регрессий подтверждено замером" />
        <Tile v={num(d.prs)} k="pull request измерено очередью" />
      </div>

      {meta.budget_curve && (
        <div className="card">
          <h3>Сколько регрессий находит проверка части коммитов</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Коммиты проекта упорядочены по прогнозу риска; по горизонтали — какую долю проверяем (с самых рискованных),
            по вертикали — какую долю всех регрессий проекта она находит. 11 проектов, ≈{num(meta.budget_curve.total)} регрессий
            по оценке.
          </p>
          <BudgetChart curve={meta.budget_curve} />
        </div>
      )}

      <div className="card">
        <h3>Уровни риска</h3>
        <table>
          <thead>
            <tr><th>Уровень <Hint k="level" /></th><th>Место среди коммитов проекта <Hint k="place" /></th><th className="num">Доля регрессий в проверке</th><th>Рекомендация</th></tr>
          </thead>
          <tbody>
            {meta.levels.map((l, i) => (
              <tr key={l.level}>
                <td><span className={`badge lvl-${l.level}`}><span className="dot" />{LEVEL[l.level].name}</span></td>
                <td>{i === 0 ? `верхние ${pct(l.top)}` : `${pct(meta.levels[i - 1].top)} – ${pct(l.top)}`}</td>
                <td className="num"><strong>{pct(l.rate, 1)}</strong></td>
                <td>{LEVEL[l.level].advice}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0 }}>
          Доли — по замерам на 11 новых проектах (верхние 5 %: 25 из 291, 5–20 %: 24 из 869, ниже: 2 из 279 случайных).
          Модель: {meta.model.kind}, обучена на {num(meta.model.pairs)} изменениях ({meta.model.regressions} регрессий) проектов{' '}
          {meta.model.trained_on.join(', ')}.
        </p>
      </div>
    </>
  );
}

function Tile({ v, k }: { v: string; k: string }) {
  return (
    <div className="tile">
      <div className="v">{v}</div>
      <div className="k">{k}</div>
    </div>
  );
}
