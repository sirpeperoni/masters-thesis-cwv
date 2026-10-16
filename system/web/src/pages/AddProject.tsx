import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.ts';

// примеры — открытые фронтенд-проекты разного размера (клик подставляет ссылку)
const EXAMPLES = [
  ['preactjs/preact', 'Preact — React-совместимая библиотека'],
  ['sveltejs/kit', 'SvelteKit — фреймворк приложений'],
  ['excalidraw/excalidraw', 'Excalidraw — редактор схем'],
  ['mantinedev/mantine', 'Mantine — UI-библиотека React'],
  ['alpinejs/alpine', 'Alpine.js'],
] as const;

const SIZES = [
  [100, 'быстро — 100 коммитов (≈2 мин)'],
  [200, 'обычно — 200 коммитов (≈4 мин)'],
  [500, 'подробно — 500 коммитов (≈10 мин)'],
] as const;

export function AddProjectPage({ onAdded }: { onAdded: () => void }) {
  const nav = useNavigate();
  const [url, setUrl] = useState('');
  const [history, setHistory] = useState(200);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const add = async (u = url) => {
    setBusy(true);
    setErr(undefined);
    try {
      const { slug } = await api.addExternal(u, history);
      onAdded();
      nav(`/projects/${slug}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <h2>Добавить проект</h2>
      <p className="lead">
        Любой открытый репозиторий GitHub. Панель скачает историю, посчитает признаки изменений и оценит риск регрессии
        для каждого из последних коммитов и для открытых pull request'ов. Сборка и замеры не нужны.
      </p>

      <div className="card">
        <form className="add-form" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/владелец/репозиторий" />
          <button className="primary" disabled={busy || !url.trim()}>{busy ? 'Добавляю…' : 'Добавить'}</button>
        </form>

        <div className="muted" style={{ margin: '14px 0 8px' }}>или выберите пример — одним нажатием:</div>
        <div className="chips">
          {EXAMPLES.map(([name, title]) => (
            <button key={name} type="button" className="chip" disabled={busy} onClick={() => { setUrl(name); add(name); }}>
              <strong>{name}</strong><span className="muted">{title}</span>
            </button>
          ))}
        </div>

        <div className="muted" style={{ margin: '18px 0 8px' }}>Сколько истории учитывать (шкала «обычного» коммита проекта):</div>
        <div className="tabs">
          {SIZES.map(([n, label]) => (
            <button key={n} type="button" className={history === n ? 'on' : ''} onClick={() => setHistory(n)}>{label}</button>
          ))}
        </div>
        {err && <p className="error">{err}</p>}
      </div>

      <div className="notice">
        Для сторонних проектов доступен прогноз. Замер на стенде требует описания сборки и сценария проекта
        (<code>bench/repos/</code>) — его панель не создаёт автоматически.
      </div>
    </>
  );
}
