/**
 * Idle sign-out policy (user directive 2026-08-20): away for 1 hour = signed
 * out. HMIS security baseline expects automatic logoff, and Supabase sessions
 * otherwise persist indefinitely in cookies.
 *
 * Design — CLOCKS NEVER MIX (a client PC with a skewed clock must not be able
 * to lock itself out, so no client-written time is ever compared to server
 * time):
 * - SERVER side: /api/seen stamps IDLE_COOKIE (httpOnly, server clock) and
 *   profiles.last_seen_at. Middleware compares that stamp to server-now and
 *   kills the session when it's stale or MISSING (fail closed — so every
 *   session-creating flow pings /api/seen: LoginForm and SignupForm fetch it,
 *   /auth/callback seeds the cookie itself). /api/seen is exempt from the
 *   middleware idle check — it's the seeding endpoint (chicken-and-egg).
 * - CLIENT side: components/IdleLogout.tsx measures idleness with the CLIENT
 *   clock (localStorage, shared across tabs), warns IDLE_WARN_MS before the
 *   hour, signs out through /auth/signout at the hour, and pings /api/seen
 *   (throttled) while the user is active so the server stamp stays fresh.
 * - Middleware deliberately never refreshes the stamp from request traffic:
 *   requests aren't proof a human is present (a future polling feature would
 *   silently defeat the timeout). Only the client's activity ping refreshes.
 */
export const IDLE_MS = 60 * 60 * 1000;          // 1 hour of inactivity
export const IDLE_WARN_MS = 5 * 60 * 1000;      // warn 5 minutes before
export const IDLE_COOKIE = 'hmis-last-active';  // server-written, httpOnly
export const IDLE_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
/** localStorage key for the client-side (client-clock) activity stamp. */
export const IDLE_LOCAL_KEY = 'hmis-idle-last';
/** Client ping throttle — the server stamp is at most this much behind real
 *  activity, so the effective server-side timeout is IDLE_MS + this. */
export const IDLE_PING_MS = 5 * 60 * 1000;
