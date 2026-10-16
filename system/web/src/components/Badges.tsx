import type { Change, Level } from '../api.ts';
import { LEVEL, topShare } from '../format.ts';

/** Уровень прогноза: цвет + точка + слово (не только цвет). */
export function LevelBadge({ level, place }: { level: Level | null; place?: number | null }) {
  if (!level) return <span className="muted">нет прогноза</span>;
  return (
    <span className={`badge lvl-${level}`} title={LEVEL[level].advice}>
      <span className="dot" aria-hidden />
      {LEVEL[level].name}
      {place != null && <span className="muted">· {topShare(place)}</span>}
    </span>
  );
}

/** Итог замера на стенде. */
export function ResultBadge({ change }: { change: Pick<Change, 'measured' | 'label' | 'status'> }) {
  if (!change.measured) return <span className="res-none">не измерен</span>;
  if (change.status && change.status !== 'ok' && change.status !== 'identical_build')
    return <span className="res-none">сбой: {change.status}</span>;
  if (change.label === 'regression') return <span className="badge res-regression">▲ регрессия</span>;
  if (change.label === 'improvement') return <span className="badge res-improvement">▼ улучшение</span>;
  return <span className="badge res-ok">✓ регрессии нет</span>;
}
