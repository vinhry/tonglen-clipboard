// ── Reverse-proxy awareness ──────────────────────────────────
// Forwarded headers are only honoured when TRUST_PROXY is set, because a
// client that reaches the server directly can put anything in them.

export const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? "");

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, "").toLowerCase())
    .filter(Boolean),
);

export interface IPSource {
  requestIP(req: Request): { address: string } | null;
}

export function getClientIP(req: Request, server: IPSource): string {
  if (TRUST_PROXY) {
    // The proxy appends the address it saw, so the rightmost entry is the one we can trust
    const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return server.requestIP(req)?.address ?? "unknown";
}

/**
 * Block cross-site WebSocket connections. Browsers always send Origin, and for
 * the page's own address it matches the Host the browser connected to.
 */
export function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  const hosts = [req.headers.get("host")];
  if (TRUST_PROXY) hosts.push(req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? null);
  if (hosts.some((h) => h?.toLowerCase() === originHost)) return true;

  return ALLOWED_ORIGINS.has(origin.replace(/\/+$/, "").toLowerCase());
}
