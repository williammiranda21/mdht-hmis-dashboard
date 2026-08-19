'use client';

/** window.print() → the browser's Print / Save-as-PDF dialog. */
export default function PrintButton() {
  return (
    <button className="btn primary" onClick={() => window.print()}>
      🖨 Print / Save as PDF
    </button>
  );
}
