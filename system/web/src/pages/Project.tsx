import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type Change, type ExternalState, type Meta, type MetricKey, useData } from '../api.ts';
import { LevelBadge, ResultBadge } from '../components/Badges.tsx';
import { ChangePanel } from '../components/ChangePanel.tsx';
import { Hint } from '../components/Hint.tsx';
import { PullRequests } from '../components/PullRequests.tsx';
import { matches, Search, SortTh, type SortState, useSorted } from '../components/Table.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { date, num, short, signed } from '../format.ts';

type Filter = 'regressions' | 'measured' | 'high' | 'elevated' | 'pr' | 'all';
const PAGE = 100;
const busy = (e?: ExternalState | null) => !!e && e.status !== 'ready' && e.status !== 'error';

/**
 * Страница проекта. Состояние — в адресе (#/projects/x?tab=…&f=…&q=…&sort=…&sel=…): ссылкой можно поделиться,
 * после обновления страницы открыто то же самое.
 */
export function ProjectPage({ meta, onProjectsChanged }: { meta: Meta; onProjectsChanged: () => void }) {
  const { name = '' } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v == null || v === '' ? next.delete(k) : next.set(k, v));
    setParams(next, { replace: true });
  };
  const tab = params.get('tab') === 'prs' ? 'prs' : 'commits';
  const q = params.get('q') ?? '';
  const limit = Number(params.get('n') ?? PAGE);

  const res = useData(() => api.project(name), [name], { pollMs: 2000, poll: (d) => busy(d.project.external) });
  const data = res.data?.project.name === name ? res.data : undefined; // не показывать прошлый проект при переходе
  const changes = useMemo(() => data?.changes ?? [], [data]);
  const p = data?.project;
  const ext = p?.external;
  const hasMeasured = changes.some((c) => c.measured);
  const scored = changes.some((c) => c.place != null);

  const filters = useMemo(() => {
    const all: [Filter, string, (c: Change) => boolean][] = [
      ['regressions', 'Регрессии', (c) => c.label === 'regression'],
      ['high', 'Высокий риск', (c) => c.level === 'high'],
      ['elevated', 'Повышенный', (c) => c.level === 'elevated'],
      ['measured', 'Измеренные', (c) => !!c.measured],
      ['pr', 'Pull request', (c) => c.kind === 'pr'],
      ['all', 'Все', () => true],
    ];
    return all.filter(([k]) => (hasMeasured || (k !== 'regressions' && k !== 'measured')) && (scored || (k !== 'high' && k !== 'elevated'))
      && (k !== 'pr' || changes.some((c) => c.kind === 'pr')));
  }, [hasMeasured, scored, changes]);
  const fParam = params.get('f') as Filter | null;
  const active = fParam && filters.some(([k]) => k === fParam) ? fParam : filters[0]?.[0];

  const sort: SortState = {
    key: params.get('sort') ?? (scored ? 'risk' : 'date'),
    dir: (params.get('dir') as SortState['dir']) ?? (params.get('sort') ? 'asc' : scored ? 'asc' : 'desc'),
  };
  const filtered = useMemo(() => {
    const f = filters.find(([k]) => k === active)?.[2] ?? (() => true);
    return changes.filter((c) => f(c) && matches(q, c.subject, c.sha, c.pr ? `#${c.pr}` : null));
  }, [changes, filters, active, q]);
  const rows = useSorted(filtered, sort, (c, k) =>
    k === 'risk' ? c.place : k === 'date' ? c.date : k === 'subject' ? c.subject : k === 'size' ? (c.k_la ?? 0) + (c.k_ld ?? 0)
      : k === 'result' ? (c.measured ? (c.label === 'regression' ? 0 : 1) : null) : c.metrics?.[k as MetricKey]?.delta ?? null);

  const selSha = params.get('sel');
  const current = selSha ? changes.find((c) => c.sha === selSha && c.kind === (params.get('kind') ?? c.kind)) : undefined;
  const select = (c?: Change) => set({ sel: c?.sha ?? null, kind: c ? c.kind : null });

  if (res.error && !data) return <p className="error">{res.error}</p>;
  if (!data || !p) return <p className="muted">Загрузка…</p>;
  const title = ext?.name ?? p.name;
  const sortTh = (k: string, label: React.ReactNode, num?: boolean) => (
    <SortTh k={k} sort={sort} num={num} onSort={(s) => set({ sort: s.key, dir: s.dir })}>{label}</SortTh>
  );

  const refresh = async () => { await api.refreshExternal(p.name); onProjectsChanged(); res.reload(); };
  const remove = async () => {
    if (!confirm(`Удалить проект ${title} из панели (вместе с клоном)?`)) return;
    await api.deleteExternal(p.name);
    onProjectsChanged();
    nav('/');
  };

  return (
    <>
      <div className="title-row">
        <div>
          <h2>{title}</h2>
          <p className="lead" style={{ marginBottom: 12 }}>
            {p.url && <a href={p.url} target="_blank" rel="noreferrer">открыть на GitHub ↗</a>}
            {p.commits > 0 && <> · {num(p.commits)} коммитов{hasMeasured && <>, {num(p.measured)} измерено, регрессий: {num(p.regressions)}</>}</>}
            {ext?.branch && <> · ветка <code>{ext.branch}</code></>}
            {ext?.history && <> · шкала — {num(ext.history)} коммитов <Hint k="history" /></>}
          </p>
        </div>
        {ext && meta.live && (
          <div className="row" style={{ gap: 8 }}>
            <button className="ghost" disabled={busy(ext)} onClick={refresh} title="Подтянуть новые коммиты и пересчитать прогноз">↻ Обновить</button>
            <button className="ghost danger" onClick={remove}>Удалить</button>
          </div>
        )}
      </div>

      {busy(ext) && <Progress e={ext!} />}
      {ext?.status === 'ready' && ext.message && ext.message !== 'готово' && <div className="notice">{ext.message.replace(/^готово;\s*/, '')}</div>}
      {ext?.status === 'error' && (
        <div className="notice error-notice">Не удалось подготовить проект: {ext.message}
          {meta.live && <> · <button className="link" onClick={refresh}>попробовать снова</button></>}</div>
      )}

      {!busy(ext) && ext?.status !== 'error' && (
        <>
          <div className="tabs big">
            <button className={tab === 'commits' ? 'on' : ''} onClick={() => set({ tab: null })}>Коммиты</button>
            {p.url?.startsWith('https://github.com/') && meta.live && (
              <button className={tab === 'prs' ? 'on' : ''} onClick={() => set({ tab: 'prs', sel: null, kind: null })}>Pull request'ы</button>
            )}
          </div>

          {tab === 'prs' ? (
            <PullRequests project={p.name} meta={meta} onAssessed={() => res.reload()}
                          open={Number(params.get('pr')) || undefined} onOpen={(n) => set({ pr: n ? String(n) : null })} />
          ) : (
            <>
              {scored ? (
                <div className="card">
                  <h3>Прогноз{hasMeasured ? ' и замеры' : ''} во времени <Hint k="forecast" /></h3>
                  <Timeline changes={changes} selected={current?.sha} onSelect={select} />
                </div>
              ) : (
                <div className="notice">
                  Модель обучалась на этом проекте — прогноз для его коммитов не показывается (он был бы нечестным).
                  Ниже — все замеры стенда.
                </div>
              )}

              <div className={current ? 'layout-split' : ''}>
                <div className="card" style={{ padding: '14px 0 0', overflowX: 'auto' }}>
                  <div className="toolbar">
                    <div className="tabs" style={{ margin: 0 }}>
                      {filters.map(([k, label, f]) => (
                        <button key={k} className={active === k ? 'on' : ''} onClick={() => set({ f: k, n: null })}>
                          {label} ({changes.filter(f).length})
                        </button>
                      ))}
                    </div>
                    <Search value={q} onChange={(v) => set({ q: v, n: null })} placeholder="Поиск: заголовок, хеш, #PR" />
                  </div>
                  <table>
                    <thead>
                      <tr>
                        {sortTh('date', 'Дата')}
                        <th>Изменение</th>
                        {sortTh('subject', 'Заголовок')}
                        {scored && sortTh('risk', <>Прогноз <Hint k="level" /></>)}
                        {hasMeasured && sortTh('result', <>Замер <Hint k="measure" /></>)}
                        {!current && hasMeasured && <>{sortTh('lcp', <>Δ LCP, мс <Hint k="lcp" /></>, true)}{sortTh('inp', <>Δ INP, мс <Hint k="inp" /></>, true)}{sortTh('tbt', <>Δ TBT, мс <Hint k="tbt" /></>, true)}</>}
                        {!current && !hasMeasured && sortTh('size', 'Строк +/−', true)}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, limit).map((c) => (
                        <tr key={c.sha + c.kind} className={`click${current?.sha === c.sha ? ' sel' : ''}`} onClick={() => select(c)}>
                          <td className="muted">{date(c.date)}</td>
                          <td className="mono">{c.kind === 'pr' ? `PR #${c.pr}` : short(c.sha)}</td>
                          <td className="subject" style={current ? { maxWidth: 240 } : undefined} title={c.subject}>{c.subject || '—'}</td>
                          {scored && <td><LevelBadge level={c.level} place={current ? undefined : c.place} /></td>}
                          {hasMeasured && <td><ResultBadge change={c} /></td>}
                          {!current && hasMeasured && <><Delta c={c} k="lcp" /><Delta c={c} k="inp" /><Delta c={c} k="tbt" /></>}
                          {!current && !hasMeasured && <td className="num muted">+{num(c.k_la ?? 0)} / −{num(c.k_ld ?? 0)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length > limit && (
                    <p style={{ padding: '0 14px' }}><button className="primary" onClick={() => set({ n: String(limit + PAGE) })}>Показать ещё ({rows.length - limit})</button></p>
                  )}
                  {!rows.length && <p className="muted" style={{ padding: '0 14px' }}>{q ? `Ничего не найдено по «${q}».` : 'Нет изменений в этом фильтре.'}</p>}
                </div>
                {current && (
                  <ChangePanel change={current} project={p} meta={meta} onClose={() => select(undefined)}
                               onUpdate={() => res.reload()} />
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

const STEPS: [ExternalState['status'], string][] = [
  ['queued', 'В очереди'], ['clone', 'Скачивание истории'], ['features', 'Признаки изменений'], ['scoring', 'Прогноз'],
];

function Progress({ e }: { e: ExternalState }) {
  const idx = STEPS.findIndex(([s]) => s === e.status);
  const share = e.status === 'features' && e.total ? e.done / e.total : idx >= 3 ? 1 : 0;
  return (
    <div className="card">
      <h3>Готовлю проект — это займёт несколько минут</h3>
      <ol className="steps">
        {STEPS.map(([s, label], i) => (
          <li key={s} className={i < idx ? 'done' : i === idx ? 'now' : ''}>{i < idx ? '✓ ' : ''}{label}</li>
        ))}
      </ol>
      <div className="bar"><div style={{ width: `${Math.round(share * 100)}%` }} /></div>
      <p className="muted" style={{ marginBottom: 0 }}>
        {e.message}{e.status === 'features' && e.total ? ` — ${num(e.done)} из ${num(e.total)} коммитов` : ''}. Страницу можно не держать
        открытой: проект появится в меню слева.
      </p>
    </div>
  );
}

function Delta({ c, k }: { c: Change; k: MetricKey }) {
  const m = c.metrics?.[k];
  if (!m || m.delta == null) return <td className="num muted">—</td>;
  return <td className={`num${m.label === 'regression' ? ' res-regression' : ''}`}>{signed(m.delta)}</td>;
}
