import { supabaseAdmin } from '../../../lib/supabase';
import PortalForm from './PortalForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Youth Connect' };

/**
 * Youth Connect self-entry portal — the one PUBLIC page in the app.
 *
 * Youth land here from a tokened invite link (QR code, outreach card, DM).
 * The token is validated server-side with the service role before anything
 * renders; a dead link gets a friendly dead-end, never a form whose submit
 * would fail after a youth typed everything out. Submission goes to
 * /api/yc/submit, which re-validates the token — this render-time check is
 * courtesy, not the boundary.
 */
export default async function YcPortal({ params }: { params: { token: string } }) {
  const token = params.token;
  let ok = false;
  try {
    const { data: inv } = await supabaseAdmin()
      .from('intake_invites')
      .select('expires_at, max_uses, uses, disabled')
      .eq('token', token)
      .maybeSingle();
    const expired = inv?.expires_at && new Date(inv.expires_at).getTime() < Date.now();
    ok = Boolean(inv && !inv.disabled && !expired && inv.uses < inv.max_uses);
  } catch {
    ok = false; // table missing or db unreachable — fail to the dead-end screen
  }

  if (!ok) {
    return (
      <main className="ycwrap">
        <PortalStyles />
        <div className="yccard" style={{ textAlign: 'center' }}>
          <div className="yclogo" style={{ margin: '0 auto 14px' }}>Y</div>
          <h1 className="ych">This link isn&rsquo;t active anymore.</h1>
          <p className="ycsub">
            No worries — you can still get connected. Reach Educate Tomorrow, or ask any
            outreach worker or shelter staff for a new Youth Connect link.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="ycwrap">
      <PortalStyles />
      <PortalForm token={token} />
    </main>
  );
}

/** Self-contained mint theme for the portal — deliberately NOT the dashboard's
 *  Darkone look. Youth see a warm, phone-first page with no county chrome.
 *  dangerouslySetInnerHTML on purpose: as a text child, the quoted font name
 *  hydrates differently (&quot; vs ") and React replaces the whole document. */
function PortalStyles() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      .ycwrap{min-height:100dvh;background:#eef1ef;display:flex;align-items:flex-start;
        justify-content:center;padding:22px 14px 60px;
        font-family:Inter,-apple-system,"Segoe UI",system-ui,sans-serif}
      .yccard{width:100%;max-width:430px;background:#fff;border:1px solid #e2e8e4;
        border-radius:26px;padding:26px 22px;color:#1a202c;
        box-shadow:0 10px 30px rgba(16,42,34,.10)}
      .yclogo{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;
        justify-content:center;color:#fff;font-weight:800;font-size:18px;
        background:linear-gradient(135deg,#34d399,#10b981);box-shadow:0 4px 12px rgba(16,185,129,.3)}
      .ycbrand{display:flex;align-items:center;gap:10px;margin-bottom:6px;font-weight:800;font-size:17px}
      .ych{font-size:19px;font-weight:800;margin:4px 0 2px}
      .ycsub{font-size:13.5px;opacity:.65;margin:4px 0 10px;line-height:1.5}
      .ycprog{height:5px;background:rgba(127,127,127,.15);border-radius:5px;margin:12px 0 18px;overflow:hidden}
      .ycprog i{display:block;height:5px;border-radius:5px;background:linear-gradient(90deg,#34d399,#10b981);
        transition:width .3s}
      @media (prefers-reduced-motion:reduce){.ycprog i{transition:none}}
      .yclabel{display:block;font-size:12.5px;font-weight:600;opacity:.7;margin:14px 0 5px}
      .ycinp{width:100%;box-sizing:border-box;background:transparent;border:1px solid #d4ddd7;
        border-radius:11px;padding:12px 13px;color:inherit;font-size:16px;font-family:inherit}
      .ycopts{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
      .ycopt{border:1px solid #d4ddd7;background:transparent;color:inherit;border-radius:22px;
        padding:10px 15px;font-size:13.5px;font-weight:600;min-height:42px;cursor:pointer;font-family:inherit}
      .ycopt[aria-pressed="true"]{background:rgba(16,185,129,.14);border-color:#10b981;color:#10b981}
      .yccta{display:block;width:100%;border:none;border-radius:12px;padding:14px;min-height:48px;
        margin-top:18px;background:linear-gradient(135deg,#34d399,#10b981);color:#fff;font-weight:700;
        font-size:15px;cursor:pointer;font-family:inherit;box-shadow:0 4px 10px rgba(16,185,129,.28)}
      .yccta[disabled]{opacity:.6;cursor:default}
      .ycghost{display:block;width:100%;border:1px solid #d4ddd7;background:transparent;border-radius:12px;
        padding:12px;min-height:44px;margin-top:10px;color:inherit;opacity:.7;font-weight:600;font-size:14px;
        cursor:pointer;font-family:inherit}
      .ycconsent{display:flex;gap:10px;align-items:flex-start;background:rgba(16,185,129,.1);
        border:1px solid rgba(16,185,129,.35);border-radius:12px;padding:12px;margin-top:16px;
        font-size:12.5px;line-height:1.5}
      .ycconsent input{margin-top:2px;accent-color:#10b981;width:16px;height:16px;flex-shrink:0}
      .ycdone{text-align:center;padding:18px 4px}
      .ycdone .big{width:62px;height:62px;border-radius:50%;margin:0 auto 14px;display:flex;
        align-items:center;justify-content:center;color:#fff;font-size:28px;
        background:linear-gradient(135deg,#34d399,#10b981)}
      .ycerr{background:rgba(239,77,93,.12);color:#c2333f;border-radius:10px;padding:10px 13px;
        font-size:13px;font-weight:600;margin-top:12px}
      .ychoney{position:absolute;left:-9999px;top:-9999px;height:1px;width:1px;overflow:hidden}
    ` }} />
  );
}
