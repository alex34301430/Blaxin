import React, { useEffect, useRef } from 'react';
import { useAppStore, ActivityLine } from '../../utils/store';

// ACTIVITY rail — bottom ticker fed by the REAL activity feed (real
// agent events only). Duplicated once so the 60s CSS scroll loops
// seamlessly (translateX(-50%)).

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderLine(l: ActivityLine): string {
  const text = l.text.length > 90 ? `${l.text.slice(0, 90)}…` : l.text;
  return `> [${fmtClock(l.time)}] ${text}`;
}

export function ActivityTicker() {
  const activityFeed = useAppStore((s) => s.activityFeed);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep the newest lines in view: scroll shows the tail of the feed.
  const lines = activityFeed.slice(-12);
  const text = lines.length > 0 ? lines.map(renderLine).join('  ◈  ') : '> BLAXIN agent online — awaiting commands  ◈  All systems operational';

  return (
    <div className="jh-rail" data-testid="activity-ticker">
      <div className="jh-rail-label">◈ ACTIVITY</div>
      <div className="jh-rail-ticker-wrap" ref={wrapRef}>
        <div className="jh-rail-ticker">
          {text}  ◈  {text}  ◈
        </div>
      </div>
    </div>
  );
}
