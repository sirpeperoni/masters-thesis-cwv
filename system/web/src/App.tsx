import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { api, useData } from './api.ts';
import { ProjectPage } from './pages/Project.tsx';
import { ProjectsPage } from './pages/Projects.tsx';
import { CheckPage, QueuePage } from './pages/Queue.tsx';
import { SummaryPage } from './pages/Summary.tsx';

// HashRouter: адреса вида #/projects/x — статическая копия работает на GitHub Pages без настройки сервера
export function App() {
  const meta = useData(api.meta);
  return (
    <HashRouter>
      <div className="app">
        <nav className="nav">
          <h1>cwv-risk</h1>
          <div className="sub">прогноз регрессий Core Web Vitals</div>
          <NavLink to="/" end>Сводка</NavLink>
          <NavLink to="/projects">Проекты</NavLink>
          <NavLink to="/queue">Очередь замеров</NavLink>
          <NavLink to="/check">Проверить изменение</NavLink>
          {meta.data && (
            <div className="foot">
              {meta.data.live ? 'сервер' : 'статическая копия'}
              {meta.data.ingested && <><br />данные от {new Date(meta.data.ingested).toLocaleString('ru-RU')}</>}
              <br />
              <a href="https://github.com/sirpeperoni/masters-thesis-cwv" target="_blank" rel="noreferrer">код и данные ↗</a>
            </div>
          )}
        </nav>
        <main>
          {meta.error && <p className="error">Нет связи с API: {meta.error}</p>}
          {meta.data && (
            <Routes>
              <Route path="/" element={<SummaryPage meta={meta.data} />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:name" element={<ProjectPage meta={meta.data} />} />
              <Route path="/queue" element={<QueuePage meta={meta.data} />} />
              <Route path="/check" element={<CheckPage meta={meta.data} />} />
            </Routes>
          )}
        </main>
      </div>
    </HashRouter>
  );
}
