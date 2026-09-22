'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Share-by-QR for app links (2026-09-22, built for /field). The code is
 * generated locally (qrcode pkg) — the URL never touches an external
 * service. Scanning opens the login page unless the phone already has a
 * session: the QR shares the ADDRESS, access still comes from account
 * grants. Reuses the BNL modal shell + tbtn pills — no new design language.
 */
export default function QrShare({ path, label = 'QR code', title = 'Scan to open the Field app' }: {
  path: string; label?: string; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [img, setImg] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const url = `${window.location.origin}${path}`;
    setLink(url);
    QRCode.toDataURL(url, { width: 560, margin: 2 })
      .then(setImg)
      .catch(() => setImg(null));
  }, [open, path]);

  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = link;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      } catch { return false; }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(link).then(done, () => { if (fallback()) done(); });
    } else if (fallback()) done();
  };

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <>
      <button type="button" className="tbtn" onClick={() => setOpen(true)}
        title="Show a QR code others can scan to open this link">▦ {label}</button>
      {open && (
        <div className="bnl-ov" onClick={() => setOpen(false)}>
          <div className="bnl-modal" onClick={(e) => e.stopPropagation()} role="dialog"
            aria-label={title} style={{ maxWidth: 420, textAlign: 'center' }}>
            <button className="bnl-x" onClick={() => setOpen(false)} aria-label="Close">✕</button>
            <h3>{title}</h3>
            {/* white card = the QR quiet zone; scannable in dark mode too */}
            <div style={{ background: '#fff', borderRadius: 12, padding: 12,
              margin: '12px auto 8px', width: 260, maxWidth: '100%' }}>
              {img
                // eslint-disable-next-line @next/next/no-img-element -- local data URL, no optimizer needed
                ? <img src={img} alt={`QR code for ${link}`} style={{ width: '100%', display: 'block' }} />
                : <div style={{ padding: 40, color: '#333', fontSize: 12 }}>Generating…</div>}
            </div>
            <div className="bnl-sub" style={{ wordBreak: 'break-all' }}>{link}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" className="tbtn" onClick={copy}>
                {copied ? '✓ Copied' : 'Copy link'}</button>
              {canShare && (
                <button type="button" className="tbtn"
                  onClick={() => { navigator.share({ title, url: link }).catch(() => { /* user closed the sheet */ }); }}>
                  Share…</button>
              )}
            </div>
            <div className="bnl-sub" style={{ marginTop: 10 }}>
              They&rsquo;ll sign in with their dashboard account — the code shares the
              address, not access.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
