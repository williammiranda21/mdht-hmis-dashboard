'use client';

/**
 * "Where do clients go" — ALL exits by destination for one project + month
 * (Pillar 3). Data = dest_profile jsonb {code: count, _n: total}; codes are
 * grouped into HUD tiers with the same sets generate_pathways.py uses
 * (PH / temporary / institutional / back-to-homelessness / unknown).
 */

const TIERS: { key: string; label: string; codes: Set<number>; color: string }[] = [
  { key: 'ph', label: 'Permanent housing', codes: new Set([410, 411, 421, 422, 423, 426, 435]), color: 'var(--accent)' },
  { key: 'temp', label: 'Temporary / informal', codes: new Set([302, 312, 313, 314, 327, 329, 332]), color: 'var(--warn)' },
  { key: 'inst', label: 'Institutional', codes: new Set([204, 205, 206, 207, 225, 215]), color: 'var(--muted)' },
  { key: 'home', label: 'Back to homelessness', codes: new Set([116, 101, 118]), color: 'var(--danger)' },
];

const LABELS: Record<string, string> = {
  '410': 'Rental, no subsidy', '411': 'Owned, no subsidy', '421': 'Owned, with subsidy',
  '422': 'Family, permanent', '423': 'Friends, permanent', '426': 'HOPWA PH', '435': 'Rental, with subsidy',
  '302': 'Transitional housing', '312': 'Family, temporary', '313': 'Friends, temporary',
  '314': 'Hotel/motel, no voucher', '327': 'HOPWA TH', '329': 'Residential project', '332': 'Host home',
  '204': 'Psychiatric facility', '205': 'Substance-use facility', '206': 'Hospital',
  '207': 'Jail / prison', '215': 'Foster care', '225': 'Nursing home',
  '116': 'Place not meant for habitation', '101': 'Emergency shelter', '118': 'Safe Haven',
  '8': "Client doesn't know", '9': 'Client refused', '17': 'Other', '24': 'Deceased',
  '30': 'No exit interview', '99': 'Data not collected', '-1': 'Destination missing (blank)',
};

export default function DestProfile({ profile, periodLabel }: {
  profile: Record<string, number> | null; periodLabel: string;
}) {
  // Never vanish silently (user report 2026-08-12: "the card does not provide
  // destination types" — the section was hidden because the selected period
  // had no row). With the API's latest-complete-month fallback, a null here
  // means the project truly has no exits in the loader's trailing window.
  if (!profile || !(profile['_n'] ?? 0)) {
    return (
      <div className="hc-sub">
        Where do clients go — no exits recorded in the trailing 3 years
      </div>
    );
  }
  const total = profile['_n'] ?? 0;

  const entries = Object.entries(profile).filter(([k]) => k !== '_n');
  const tierOf = (code: string): string => {
    const n = Number(code);
    for (const t of TIERS) if (t.codes.has(n)) return t.key;
    return 'unk';
  };
  const groups = new Map<string, { n: number; codes: [string, number][] }>();
  for (const [code, n] of entries) {
    const t = tierOf(code);
    const g = groups.get(t) ?? { n: 0, codes: [] };
    g.n += n; g.codes.push([code, n]);
    groups.set(t, g);
  }
  const tierList = [...TIERS, { key: 'unk', label: 'Unknown / other', codes: new Set<number>(), color: 'var(--faint)' }]
    .map((t) => ({ ...t, g: groups.get(t.key) }))
    .filter((t) => t.g && t.g.n > 0);

  return (
    <>
      <div className="hc-sub">Where do clients go — all {total.toLocaleString()} exits, {periodLabel}</div>
      {tierList.map((t) => {
        const pct = (t.g!.n / total) * 100;
        return (
          <div key={t.key} style={{ marginBottom: 10 }}>
            <div className="hc-row" style={{ marginBottom: 5 }}>
              <div className="hc-bwrap">
                <div className="hc-blab">
                  <span>{t.label}</span>
                  <b>{t.g!.n.toLocaleString()} ({Number(pct.toFixed(1))}%)</b>
                </div>
                <div className="hc-bar"><i style={{ width: `${Math.min(100, pct)}%`, background: t.color }} /></div>
              </div>
            </div>
            {/* One line + bar PER DESTINATION (user request 2026-08-13 — was a
                bundled top-3 text). Sub-bars share the tier's 0-100% axis so
                widths compare across the whole section. */}
            {t.g!.codes.sort((a, b) => b[1] - a[1]).map(([c, n]) => {
              const p = (n / total) * 100;
              return (
                <div className="hc-row dp-sub" key={c}>
                  <div className="hc-bwrap">
                    <div className="hc-blab">
                      <span>{LABELS[c] ?? `Destination ${c}`}</span>
                      <b>{n.toLocaleString()} ({Number(p.toFixed(1))}%)</b>
                    </div>
                    <div className="hc-bar dp-subbar"><i style={{ width: `${Math.min(100, p)}%`, background: t.color }} /></div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
