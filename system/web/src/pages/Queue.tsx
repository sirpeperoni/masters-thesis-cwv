import { useState } from 'react';
import { api, type Assessment, type Meta, useData } from '../api.ts';
import { LevelBadge } from '../components/Badges.tsx';
import { date, num, pct, topShare } from '../format.ts';

export function QueuePage({ meta }: { meta: Meta }) {
  const q = useData(api.queue);
  return (
    <>
      <h2>Очередь замеров</h2>
      <p className="lead">
        GitHub Action ставит pull request с высоким риском в очередь (метка <code>cwv-risk: measure</code>); агент на машине
        со стендом (<code>python -m cwv_risk queue</code>) измеряет его и дописывает результат в комментарий PR.
        Опрашиваемые репозитории: {meta.queues.map((x) => x.github).join(', ')}.
      </p>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {q.error && <p className="error" style={{ padding: 14 }}>{q.error}</p>}
        {!q.data && !q.error && <p className="muted" style={{ padding: 14 }}>Опрашиваю GitHub…</p>}
        {q.data && (
          <table>
            <thead><tr><th>Pull request</th><th>Репозиторий</th><th>Состояние</th><th>Результат</th><th>Обновлён</th></tr></thead>
            <tbody>
              {q.data.filter((x) => x.number).map((x) => (
                <tr key={x.github + x.number}>
                  <td><a href={x.url} target="_blank" rel="noreferrer">#{x.number}</a> {x.title}</td>
                  <td className="muted">{x.github}</td>
                  <td>{x.state === 'queued' ? '⏳ в очереди' : x.state === 'measured' ? '✓ измерен' : '—'}{x.pr_state === 'CLOSED' || x.pr_state === 'MERGED' ? <span className="muted"> · {x.pr_state === 'MERGED' ? 'слит' : 'закрыт'}</span> : null}</td>
                  <td>{x.result === 'regression' ? <span className="res-regression">▲ регрессия</span> : x.result === 'ok' ? <span className="res-ok">✓ регрессии нет</span> : <span className="muted">—</span>}</td>
                  <td className="muted">{x.updated ? date(x.updated) : '—'}</td>
                </tr>
              ))}
              {q.data.filter((x) => x.error).map((x) => (
                <tr key={x.github}><td colSpan={5} className="error">{x.github}: {x.error}</td></tr>
              ))}
              {!q.data.length && <tr><td colSpan={5} className="muted">Очередь пуста.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      {!meta.live && <p className="muted">Статическая копия: очередь — снимок на момент выгрузки.</p>}
    </>
  );
}

export function CheckPage({ meta }: { meta: Meta }) {
  const projects = useData(api.projects);
  const [form, setForm] = useState({ project: 'bentopdf', base: '', head: '' });
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Assessment>();
  const [err, setErr] = useState<string>();

  if (!meta.live) {
    return (
      <>
        <h2>Проверить изменение</h2>
        <div className="notice">Это статическая копия панели — оценка доступна в панели с сервером или в консольной утилите:
          <code> python -m cwv_risk score --repo &lt;путь&gt; --base &lt;ветка&gt; --head &lt;коммит&gt;</code></div>
      </>
    );
  }
  const run = async () => {
    setBusy(true); setErr(undefined); setRes(undefined);
    try { setRes(await api.assess(form)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <h2>Проверить изменение</h2>
      <p className="lead">Оценка произвольного изменения «база → коммит» в клоне проекта (work/repos/&lt;проект&gt;). Первый
        запуск на проекте считает признаки истории — до пары минут.</p>
      <div className="card row" style={{ alignItems: 'end' }}>
        <label className="field">Проект
          <select value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })}>
            {(projects.data ?? []).map((p) => <option key={p.name}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">База (ветка или sha)
          <input value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} placeholder="origin/main" />
        </label>
        <label className="field">Коммит
          <input value={form.head} onChange={(e) => setForm({ ...form, head: e.target.value })} placeholder="sha" />
        </label>
        <button className="primary" disabled={busy || !form.base || !form.head} onClick={run}>{busy ? 'Оцениваю…' : 'Оценить'}</button>
      </div>
      {err && <p className="error">{err}</p>}
      {res && (
        <div className="card">
          <h3><LevelBadge level={res.level} /></h3>
          <p>{topShare(res.place)} среди {num(res.history)} последних коммитов проекта; на этом уровне в проверке регрессией
            оказывалось {pct(res.expected_rate, 1)} изменений. Изменение: {num(res.files)} файлов, +{num(res.lines_added)} / −{num(res.lines_deleted)} строк.</p>
          {res.level !== 'low' && res.reasons.length > 0 && (
            <ul>{res.reasons.map((r) => <li key={r.feature}>{r.label}: <strong>{num(r.value, r.value % 1 ? 2 : 0)}</strong> <span className="muted">— больше, чем у {pct(r.percentile)} коммитов</span></li>)}</ul>
          )}
        </div>
      )}
    </>
  );
}
