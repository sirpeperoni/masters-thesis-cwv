import { api, type Meta, useData } from '../api.ts';
import { date } from '../format.ts';

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
