'use client';

import { useEffect, useRef, useState } from 'react';
import { tilesFor, frameFor, toPx, unproject, project, TILE } from '../lib/slippy';
import TileImg from './TileImg';

/**
 * Interactive single-pin map for intake (user ask 2026-08-20): auto-detect
 * drops the dot mid-park — "Bayfront Park, south side" needs a staff nudge.
 * Drag pans, wheel zooms (page scroll locked while hovering, same fix as the
 * call map), CLICK MOVES THE PIN. Works pin-less too: first click places it.
 */
export default function PinMap({ lat, lng, focusKey = 0, onPick, height = 300 }: {
  lat: number | null; lng: number | null;
  /** bump to recenter on the pin (a NEW geocode result); pin nudges don't */
  focusKey?: number;
  onPick: (lat: number, lng: number) => void;
  height?: number;
}) {
  const [center, setCenter] = useState({ lat: lat ?? 25.78, lng: lng ?? -80.22 });
  const [z, setZ] = useState(lat != null ? 16 : 12);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(660);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const w = Math.floor(es[0].contentRect.width);
      if (w > 260) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // recenter only when a NEW geocode result arrives — not on manual nudges
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (lat != null && lng != null) {
      setCenter({ lat, lng });
      setZ((zz) => Math.max(zz, 16));
    }
  }, [focusKey]);

  // wheel-to-zoom anchored at the cursor (native non-passive listener)
  const mapRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ z, center, W });
  stateRef.current = { z, center, W };
  const lastWheel = useRef(0);
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel.current < 110) return;
      lastWheel.current = now;
      const { z: cz, center: cc, W: cw } = stateRef.current;
      const nz = Math.min(19, Math.max(10, cz + (e.deltaY < 0 ? 1 : -1)));
      if (nz === cz) return;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const f = frameFor(cc.lat, cc.lng, cz, cw, heightRef.current);
      const under = unproject(f.left + cx, f.top + cy, cz);
      const { px, py } = project(under.lat, under.lng, nz);
      setZ(nz);
      setCenter(unproject(px - cx + cw / 2, py - cy + heightRef.current / 2, nz));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const heightRef = useRef(height);
  heightRef.current = height;

  // hover scroll-lock — wheel over the map must only zoom
  const lockRef = useRef<{ ovf: string; pad: string } | null>(null);
  function lockScroll() {
    if (lockRef.current) return;
    const b = document.body;
    lockRef.current = { ovf: b.style.overflow, pad: b.style.paddingRight };
    const sw = window.innerWidth - document.documentElement.clientWidth;
    b.style.overflow = 'hidden';
    if (sw > 0) b.style.paddingRight = `${sw}px`;
  }
  function unlockScroll() {
    if (!lockRef.current) return;
    document.body.style.overflow = lockRef.current.ovf;
    document.body.style.paddingRight = lockRef.current.pad;
    lockRef.current = null;
  }
  useEffect(() => unlockScroll, []);

  // drag pans; a real drag suppresses the click that follows it
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const draggedRef = useRef(false);
  function onPointerDown(e: React.PointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.moved = true;
    draggedRef.current = true;
    d.x = e.clientX; d.y = e.clientY;
    setCenter((c) => {
      const { px, py } = project(c.lat, c.lng, z);
      return unproject(px - dx, py - dy, z);
    });
  }
  function onPointerUp() {
    drag.current = null;
    setTimeout(() => { draggedRef.current = false; }, 0);
  }

  const frame = frameFor(center.lat, center.lng, z, W, height);
  const tiles = tilesFor(center.lat, center.lng, z, W, height);
  const pinPx = lat != null && lng != null ? toPx(lat, lng, frame) : null;

  return (
    <div ref={wrapRef}>
      <div ref={mapRef}
        style={{ position: 'relative', width: W, height, maxWidth: '100%', overflow: 'hidden',
          border: '1px solid var(--border)', borderRadius: 8, background: '#eef1f5',
          cursor: 'crosshair', touchAction: 'none', userSelect: 'none' }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerEnter={lockScroll}
        onPointerLeave={() => { onPointerUp(); unlockScroll(); }}
        onClick={(e) => {
          if (draggedRef.current) return;
          const rect = (e.currentTarget as Element).getBoundingClientRect();
          const p = unproject(frame.left + (e.clientX - rect.left),
            frame.top + (e.clientY - rect.top), z);
          onPick(p.lat, p.lng);
        }}>
        {tiles.map((t) => (
          <TileImg key={`${t.z}/${t.x}/${t.y}`} src={`/api/helpline/tile/${t.z}/${t.x}/${t.y}`}
            size={TILE} left={t.sx} top={t.sy} />
        ))}
        {pinPx && (
          <div aria-hidden="true" style={{ position: 'absolute', left: pinPx.x, top: pinPx.y,
            transform: 'translate(-50%,-92%)', fontSize: 30, zIndex: 3, pointerEvents: 'none',
            textShadow: '0 1px 2px rgba(0,0,0,.35)' }}>📍</div>
        )}
        <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 4,
          display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button className="tbtn" type="button" style={{ width: 32, fontWeight: 700, background: 'var(--card)' }}
            onClick={(e) => { e.stopPropagation(); setZ((v) => Math.min(19, v + 1)); }}
            aria-label="Zoom in">+</button>
          <button className="tbtn" type="button" style={{ width: 32, fontWeight: 700, background: 'var(--card)' }}
            onClick={(e) => { e.stopPropagation(); setZ((v) => Math.max(10, v - 1)); }}
            aria-label="Zoom out">−</button>
        </div>
        <div style={{ position: 'absolute', right: 4, bottom: 2, fontSize: 9, zIndex: 3,
          color: '#5c6a7d', background: 'rgba(255,255,255,.75)', padding: '0 4px', borderRadius: 3 }}>
          © OpenStreetMap contributors</div>
      </div>
    </div>
  );
}
