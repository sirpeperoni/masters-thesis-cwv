import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Assessment, type Meta, type Project, useData } from '../api.ts';
import { LevelBadge } from '../components/Badges.tsx';
import { date, LEVEL, num, pct, short, topShare } from '../format.ts';

type Kind = 'pr' | 'commit' | 'branch';

/** Оценка изменения только выбором из списков: проект → что проверить → «Оценить». */
export function CheckPage({ meta, projects }: { meta: Meta; projects: Project[] }) {
  const ready = projects.filter((p) => !p.external || p.external.status === 'ready');
  const [project, setProject] = useState('');
  const [kind, setKind] = useState<Kind>('pr');
  const [target, setTarget] = useState('');
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Assessment & { title?: string }>();
  const [err, setErr] = useState<string>();

  useEffect(() => { if (!project && ready.length) setProject((ready.find((p) => p.group_name === 'external') ?? ready.find((p) => p.name === 'bentopdf') ?? ready[0]).name); }, [ready, project]);
  const refs = useData(() => (project ? api.refs(project) : Promise.resolve(undefined)), [project]);
  const prs = useData(() => (project && kind === 'pr' ? api.prs(project).catch(() => []) : Promise.resolve([])), [project, kind]);
  useEffect(() => { setTarget(''); setRes(undefined); setErr(undefined); }, [project, kind]);
  useEffect(() => { if (refs.data) setBase(refs.data.default); }, [refs.data]);

  const options = useMemo(() => {
    if (kind === 'pr') return (prs.data ?? []).map((p) => ({ value: String(p.number), label: `#${p.number} · ${p.title}` }));
    if (kind === 'commit') return (refs.data?.commits ?? []).map((c) => ({ value: c.sha, label: `${date(c.date)} · ${short(c.sha)} · ${c.subject}` }));
    return (refs.data?.branches ?? []).filter((b) => b !== refs.data?.default).map((b) => ({ value: b, label: b.replace(/^origin\//, '') }));
  }, [kind, prs.data, refs.data]);

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
    try {
      if (kind === 'pr') {
        setRes(await api.assessPr(project, Number(target)));
      } else {
        // коммит основной ветки — против своего родителя; ветка — против основной ветки
        const head = target;
        const b = kind === 'commit' ? `${head}^` : base;
        const r = await api.assess({ project, base: b, head });
        setRes({ ...r, title: options.find((o) => o.value === target)?.label });
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <h2>Проверить изменение</h2>
      <p className="lead">Выберите проект и изменение — риск регрессии оценивается по коду, без сборки и замеров.
        Нужного проекта нет? <Link to="/add">Добавьте его</Link> по ссылке на GitHub.</p>

      <div className="card form-grid">
        <label className="field">1. Проект
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            {ready.map((p) => <option key={p.name} value={p.name}>{p.external?.name ?? p.name}</option>)}
          </select>
        </label>

        <div className="field">2. Что проверить
          <div className="tabs" style={{ margin: 0 }}>
            {([['pr', "Pull request"], ['commit', 'Коммит основной ветки'], ['branch', 'Ветку']] as [Kind, string][]).map(([k, l]) => (
              <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>
            ))}
          </div>
        </div>

        <label className="field">3. {kind === 'pr' ? 'Pull request' : kind === 'commit' ? 'Коммит' : 'Ветка'}
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!options.length}>
            <option value="">{(kind === 'pr' ? prs.loading : refs.loading) ? 'загрузка…' : options.length ? '— выберите —' : kind === 'pr' ? 'открытых PR нет' : 'нет вариантов'}</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label.length > 110 ? o.label.slice(0, 110) + '…' : o.label}</option>)}
          </select>
        </label>

        {kind === 'branch' && (
          <details>
            <summary className="muted">Дополнительно: с чем сравнивать (сейчас — {base.replace(/^origin\//, '') || 'основная ветка'})</summary>
            <select value={base} onChange={(e) => setBase(e.target.value)} style={{ marginTop: 8 }}>
              {(refs.data?.branches ?? []).map((b) => <option key={b} value={b}>{b.replace(/^origin\//, '')}</option>)}
            </select>
          </details>
        )}

        <div><button className="primary big" disabled={busy || !target} onClick={run}>{busy ? 'Оцениваю…' : 'Оценить риск'}</button></div>
      </div>

      {err && <div className="notice error-notice">{err}</div>}
      {res && (
        <div className="card">
          <h3 style={{ fontSize: 20 }}><LevelBadge level={res.level} /> <span className="muted" style={{ fontSize: 15, fontWeight: 400 }}>— {LEVEL[res.level].advice}</span></h3>
          {res.title && <p className="muted" style={{ marginTop: 0 }}>{res.title}</p>}
          <p>{topShare(res.place)} среди {num(res.history)} последних коммитов проекта по риску; среди изменений этого уровня
            в проверке на 11 проектах регрессией оказывалось {pct(res.expected_rate, 1)}. Изменение: {num(res.files)} файлов,
            +{num(res.lines_added)} / −{num(res.lines_deleted)} строк.</p>
          {res.level !== 'low' && res.reasons.length > 0 && (
            <>
              <h3>Почему</h3>
              <ul>{res.reasons.map((r) => <li key={r.feature}>{r.label}: <strong>{num(r.value, r.value % 1 ? 2 : 0)}</strong> <span className="muted">— больше, чем у {pct(r.percentile)} коммитов</span></li>)}</ul>
            </>
          )}
        </div>
      )}
    </>
  );
}
