type ObsEvent = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function actorKey(actorId: string): Promise<string> {
  // Avoid logging raw actor IDs. Use a stable hash prefix instead.
  const h = await sha256Hex(actorId);
  return h.slice(0, 16);
}

export function logEvent(event: ObsEvent): void {
  // Structured logs (one JSON object per line).
  // Avoid PII; prefer hashed IDs and already-hashed task/step fields.
  const payload = { ts: nowIso(), ...event };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

export function txKey(txHash: string): string {
  const s = String(txHash || '').trim();
  if (!s) return '';
  // Keep only a short prefix for debugging.
  return s.length <= 12 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`;
}
