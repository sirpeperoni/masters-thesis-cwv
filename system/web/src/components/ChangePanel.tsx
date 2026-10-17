import { useEffect, useRef, useState } from 'react';
import { api, type Change, type Meta, type MetricKey, type Project } from '../api.ts';
import { date, LEVEL, METRIC, NBSP, num, pct, short, signed, topShare, withUnit } from '../format.ts';
import { LevelBadge, ResultBadge } from './Badges.tsx';
import { Hint, HINTS } from './Hint.tsx';

const KEYS: MetricKey[] = ['lcp', 'inp', 'cls', 'tbt', 'tbtFlow'];

/** Карточка изменения: прогноз, объяснение, замер на стенде, ссылки. */
export function ChangePanel({ change, project, meta, onUpdate, onClose }: {
  change: Change; project: Project; meta: Meta; onUpdate: (c: Change) => void; onClose?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const asked = useRef(new Set<string>());
  const queue = meta.queues.find((q) => q.bench === project.name);
  const commitUrl = change.kind === 'pr' && queue && change.pr
    ? `https://github.com/${queue.github}/pull/${change.pr}`
    : project.url ? `${project.url}/commit/${change.sha}` : null;

  const explain = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.explain(project.name, change.sha);
      onUpdate({ ...change, reasons: r.reasons });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // объяснение — сразу при открытии карточки (один раз на изменение), без отдельной кнопки
  useEffect(() => {
    if (meta.live && change.level && !change.reasons && !asked.current.has(change.sha)) {
      asked.current.add(change.sha);
      explain();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change.sha]);

  return (
    <div className="card panel">
      <div className="panel-head">
        <h3>{change.kind === 'pr' ? `Pull request #${change.pr}` : 'Коммит'} <span className="mono muted">{short(change.sha)}</span></h3>
        {onClose && <button className="close" onClick={onClose} aria-label="Закрыть">×</button>}
      </div>
      <p style={{ margin: '0 0 12px' }}>{change.subject || '—'}</p>
      <dl>
        <dt>Дата</dt><dd>{date(change.date)}</dd>
        <dt>Прогноз <Hint k="forecast" /></dt><dd><LevelBadge level={change.level} /></dd>
        {change.place != null && <><dt>Место <Hint k="place" /></dt><dd>{topShare(change.place)} коммитов проекта по риску</dd></>}
        {change.level && <><dt>Рекомендация</dt><dd>{LEVEL[change.level].advice}</dd></>}
        {change.k_la != null && <><dt>Размер</dt><dd>+{num(change.k_la)} / −{num(change.k_ld ?? 0)} строк</dd></>}
        {(change.measured || project.measured > 0) && <><dt>Замер <Hint k="measure" /></dt><dd><ResultBadge change={change} /></dd></>}
        {change.selection && <><dt>В эксперименте</dt><dd>{change.selection === 'risk' ? 'отобран моделью' : change.selection.startsWith('random') ? 'случайный контроль' : 'отобран моделью (5–20 %)'}</dd></>}
      </dl>

      {change.metrics && Object.keys(change.metrics).length > 0 && (
        <table style={{ marginBottom: 14 }}>
          <thead><tr><th>Метрика</th><th className="num">База</th><th className="num">Изменение</th><th>Итог <Hint k="q" /></th></tr></thead>
          <tbody>
            {KEYS.filter((k) => change.metrics?.[k]).map((k) => {
              const m = change.metrics![k]!;
              return (
                <tr key={k}>
                  <td>{METRIC[k].name.split(' — ')[0]} <Hint text={HINTS[k as keyof typeof HINTS]} /></td>
                  <td className="num">{m.base != null ? withUnit(m.base, k) : '—'}</td>
                  <td className="num">
                    {m.delta != null ? signed(m.delta, METRIC[k].digits) + (METRIC[k].unit ? NBSP + METRIC[k].unit : '') : '—'}
                    {/* проценты при почти нулевой базе бессмысленны (0 → 35 мс = «+17 000 %») */}
                    {m.rel != null && m.base && Math.abs(m.rel) < 10 ? <span className="muted"> ({signed(m.rel * 100)}{NBSP}%)</span> : null}
                  </td>
                  <td className={`res-${m.label === 'regression' ? 'regression' : m.label === 'improvement' ? 'improvement' : 'none'}`}>
                    {m.label === 'regression' ? 'регрессия' : m.label === 'improvement' ? 'улучшение' : m.q != null && m.q < 0.05 ? 'ниже порога' : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: 6 }}>Почему такой прогноз <Hint k="reasons" /></h3>
      {change.reasons?.length ? (
        <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
          {change.reasons.map((r) => (
            <li key={r.feature}>{r.label}: <strong>{num(r.value, r.value % 1 ? 2 : 0)}</strong> <span className="muted">— больше, чем у {pct(r.percentile)} коммитов</span></li>
          ))}
        </ul>
      ) : change.reasons ? (
        <p className="muted">Изменение ничем не выделяется среди коммитов проекта.</p>
      ) : meta.live && change.level ? (
        <p className="muted">{busy ? 'Считаю объяснение… (первый раз в проекте — до пары минут)' : err ? '' : 'Готовлю объяснение…'}</p>
      ) : (
        <p className="muted">{change.level ? 'Объяснение доступно в панели с сервером.' : 'Прогноза нет: модель обучалась на этом проекте.'}</p>
      )}
      {err && <p className="error">{err}</p>}

      {commitUrl && <p style={{ margin: 0 }}><a href={commitUrl} target="_blank" rel="noreferrer">Открыть на GitHub ↗</a></p>}
    </div>
  );
}
