'use client';

import { useState } from 'react';

/**
 * Copy-all button. The one bit of client interactivity on this page — and if
 * Web Isolation swallows the click, the IDs are still selectable in the list
 * below, so nothing is lost. Newline-separated so it pastes into a spreadsheet
 * column or an HMIS batch lookup.
 */
export default function CopyIds({ ids }: { ids: string[] }) {
  const [done, setDone] = useState(false);
  if (!ids.length) return null;
  return (
    <button
      className="btn"
      onClick={() => {
        navigator.clipboard?.writeText(ids.join('\n'));
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'Copied ✓' : '⧉ Copy all IDs'}
    </button>
  );
}
