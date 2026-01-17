import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from './canonicalJson.js';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function sha256CanonicalJsonHex(value: unknown): string {
  return sha256Hex(canonicalJsonStringify(value));
}
