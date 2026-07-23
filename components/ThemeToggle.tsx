'use client';

import { useEffect, useState } from 'react';

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    const saved = (localStorage.getItem('hmis-theme') as 'light' | 'dark') || 'dark';
    setTheme(saved);
    document.documentElement.setAttribute('data-theme', saved);
  }, []);

  function apply(t: 'light' | 'dark') {
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem('hmis-theme', t);
    } catch {}
  }

  return (
    <div className="toggle" role="group" aria-label="Theme">
      <button className={theme === 'light' ? 'on' : ''} onClick={() => apply('light')}>
        Light
      </button>
      <button className={theme === 'dark' ? 'on' : ''} onClick={() => apply('dark')}>
        Dark
      </button>
    </div>
  );
}
