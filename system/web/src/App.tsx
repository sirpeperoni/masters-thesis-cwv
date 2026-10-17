import { useEffect, useState } from 'react';
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { api, type Project, useData } from './api.ts';
import { AddProjectPage } from './pages/AddProject.tsx';
import { CheckPage } from './pages/Check.tsx';
import { ProjectPage } from './pages/Project.tsx';
import { ProjectsPage } from './pages/Projects.tsx';
import { QueuePage } from './pages/Queue.tsx';
import { SummaryPage } from './pages/Summary.tsx';

const pending = (p: Project) => !!p.external && p.external.status !== 'ready' && p.external.status !== 'error';

// HashRouter: адреса вида #/projects/x — статическая копия работает на GitHub Pages без настройки сервера
type Theme = 'auto' | 'light' | 'dark';
const THEME_KEY = 'cwv-risk:theme';
const readTheme = (): Theme => {
  try { return (localStorage.getItem(THEME_KEY) as Theme) || 'auto'; } catch { return 'auto'; }
};

export function App() {
  const meta = useData(api.meta, [], { pollMs: 30000, poll: (m) => m.live }); // плашка «сервер устарел» — без перезагрузки
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* приватный режим — тема не запомнится */ }
  }, [theme]);
  // список проектов в меню; пока сторонние проекты считаются — обновляется каждые 3 с
  const projects = useData(api.projects, [], { pollMs: 3000, poll: (ps) => ps.some(pending) });
  const groups: [string, Project[]][] = [
    ['Ваши проекты', (projects.data ?? []).filter((p) => p.group_name === 'external')],
    ['Проверка на новых проектах', (projects.data ?? []).filter((p) => p.group_name === 'new')],
    ['Обучение модели', (projects.data ?? []).filter((p) => p.group_name === 'study')],
  ];

  return (
    <HashRouter>
      <div className="app">
        <nav className="nav">
          <h1>cwv-risk</h1>
          <div className="sub">прогноз регрессий Core Web Vitals</div>
          <NavLink to="/" end>Сводка</NavLink>
          <NavLink to="/check">Проверить изменение</NavLink>
          <NavLink to="/queue">Очередь замеров</NavLink>
          {meta.data?.live && <NavLink to="/add" className="add">+ Добавить проект</NavLink>}

          {groups.map(([title, list]) => list.length > 0 && (
            <div key={title} className="group">
              <div className="group-title">{title}</div>
              {list.map((p) => (
                <NavLink key={p.name} to={`/projects/${p.name}`} title={p.external?.name ?? p.name}>
                  <span className="pname">{p.external?.name ?? p.name}</span>
                  {pending(p) && <span className="pct">{p.external!.total ? Math.round((100 * p.external!.done) / p.external!.total) : 0}%</span>}
                  {p.external?.status === 'error' && <span className="pct error">ошибка</span>}
                </NavLink>
              ))}
            </div>
          ))}

          <div className="theme" role="radiogroup" aria-label="Тема">
            {([['auto', 'Авто'], ['light', 'Светлая'], ['dark', 'Тёмная']] as [Theme, string][]).map(([t, l]) => (
              <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>{l}</button>
            ))}
          </div>

          {meta.data && (
            <div className="foot">
              {meta.data.live ? 'сервер' : 'статическая копия'}
              {meta.data.ingested && <><br />данные от {new Date(meta.data.ingested).toLocaleString('ru-RU')}</>}
              <br />
              <NavLink to="/projects" className="plain">все проекты таблицей</NavLink>
              <br />
              <a href="https://github.com/sirpeperoni/masters-thesis-cwv" target="_blank" rel="noreferrer">код и данные ↗</a>
            </div>
          )}
        </nav>
        <main>
          {meta.error && <p className="error">Нет связи с API: {meta.error}</p>}
          {meta.data?.stale && (
            <div className="notice error-notice">
              <strong>Код сервера обновился после запуска.</strong> Новые возможности заработают после перезапуска:
              в окне сервера Ctrl+C, затем <code>python -m cwv_risk web serve</code> (или с <code>--reload</code> — перезапускается сам).
            </div>
          )}
          {meta.data && (
            <Routes>
              <Route path="/" element={<SummaryPage meta={meta.data} />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:name" element={<ProjectPage meta={meta.data} onProjectsChanged={projects.reload} />} />
              <Route path="/add" element={<AddProjectPage onAdded={projects.reload} />} />
              <Route path="/queue" element={<QueuePage meta={meta.data} />} />
              <Route path="/check" element={<CheckPage meta={meta.data} projects={projects.data ?? []} />} />
            </Routes>
          )}
        </main>
      </div>
    </HashRouter>
  );
}
