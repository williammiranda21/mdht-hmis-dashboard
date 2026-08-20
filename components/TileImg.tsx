'use client';

import { useState } from 'react';

/**
 * OSM proxy tile that RETRIES itself. A throttled upstream moment otherwise
 * leaves a permanent broken-image cell on the call map / case popup /
 * dispatch sheet (user report 2026-08-20). Up to 3 attempts with backoff;
 * the cache-buster query makes the browser actually re-request (the tile
 * route ignores it, and its own no-store retry path re-fetches upstream).
 */
export default function TileImg({ src, size, left, top }: {
  src: string; size: number; left: number; top: number;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={attempt ? `${src}?r=${attempt}` : src} alt="" width={size} height={size}
      draggable={false}
      style={{ position: 'absolute', left, top, display: 'block', maxWidth: 'none' }}
      onError={() => {
        if (attempt < 3) setTimeout(() => setAttempt(attempt + 1), 400 * (attempt + 1));
      }} />
  );
}
