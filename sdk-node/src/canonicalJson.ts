export function canonicalizeJson(value: unknown): unknown {
  if (value === null) return null;

  const t = typeof value;
  if (t !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((v) => canonicalizeJson(v));
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = canonicalizeJson(v);
  }
  return out;
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}
