import React from 'react';

// Panel base — faithful port of the approved design panel chrome
// (title bar, icon, status dot, corner brackets, scanline overlay).

interface PanelProps {
  name: string;
  icon?: string;
  dot?: 'green' | 'amber' | 'none';
  className?: string;
  children: React.ReactNode;
  bodyStyle?: React.CSSProperties;
  bodyClassName?: string;
}

export function Panel({ name, icon = '◈', dot = 'green', className, children, bodyStyle, bodyClassName }: PanelProps) {
  return (
    <div className={`jh-panel ${className || ''}`}>
      <div className="jh-panel-title">
        <span className="jh-panel-icon">{icon}</span>
        <span className="jh-panel-name">{name}</span>
        {dot !== 'none' && <div className={`jh-panel-dot ${dot === 'amber' ? 'amber' : ''}`} />}
      </div>
      <div className={`jh-panel-body ${bodyClassName || ''}`} style={bodyStyle}>
        {children}
      </div>
      <div className="jh-corner-br" />
    </div>
  );
}
