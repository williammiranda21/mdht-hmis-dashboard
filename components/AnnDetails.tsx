/**
 * Renders announcement details: plain lines become paragraphs; a line of the
 * form "[img]<path>" renders the screenshot via /api/ann-image (private
 * bucket, approved-read). Pure component — used by the banner (client) and
 * the /dashboard/announcements history page (server).
 */
export default function AnnDetails({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 13, lineHeight: 1.55 }}>
      {text.split('\n').map((raw, i) => {
        const line = raw.trim();
        if (!line) return null;
        const img = /^\[img\]\s*(.+)$/.exec(line);
        if (img) {
          return (
            <img key={i} src={`/api/ann-image?p=${encodeURIComponent(img[1])}`} alt=""
              style={{ display: 'block', maxWidth: '100%', maxHeight: 360,
                borderRadius: 8, border: '1px solid var(--border)', margin: '8px 0' }} />
          );
        }
        return <p key={i} style={{ margin: '4px 0' }}>{line}</p>;
      })}
    </div>
  );
}
