/**
 * Shared HTTP response helpers for sidecar routes.
 *
 * All endpoints return JSON: { ok: true, data: ... } or { ok: false, error: "..." }
 */

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function ok(data: unknown = null): Response {
  return json({ ok: true, data });
}

export function fail(error: string, status = 400): Response {
  return json({ ok: false, error }, status);
}

export async function readBody<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}
