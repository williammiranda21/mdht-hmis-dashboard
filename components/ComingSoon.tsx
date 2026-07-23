export default function ComingSoon({ title }: { title: string }) {
  return (
    <div className="panel">
      <div className="empty">
        <strong>{title}</strong>
        <div style={{ marginTop: 8, color: 'var(--muted)' }}>This tab is being migrated next.</div>
      </div>
    </div>
  );
}
