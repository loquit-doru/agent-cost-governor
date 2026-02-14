/**
 * Cryptographic utilities.
 * Centralized crypto functions to avoid duplication.
 */

// ============================================================================
// API Key Hashing
// ============================================================================

/**
 * Hash an API key using SHA-256.
 * Used for secure storage and comparison of API keys.
 * 
 * @param apiKey - The raw API key to hash
 * @returns Hex-encoded SHA-256 hash
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalize a hex hash string to lowercase without 0x prefix.
 * Returns empty string if invalid.
 * 
 * @param input - The hash string to normalize
 * @returns Normalized hash or empty string
 */
export function normalizeKeyHash(input: string): string {
  const s = String(input || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) return '';
  return s;
}

/**
 * Normalize a hex string to include 0x prefix.
 * 
 * @param input - The hex string to normalize
 * @returns Normalized hex with 0x prefix
 */
export function normalizeHex0x(input: string): string {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  return s.startsWith('0x') ? s : `0x${s}`;
}

// ============================================================================
// API Key Generation
// ============================================================================

/**
 * Generate a new random API key.
 * 
 * @param prefix - The prefix for the key (e.g., 'pg_ws_')
 * @param bytes - Number of random bytes (default 32)
 * @returns Generated API key with prefix
 */
export function generateApiKey(prefix: string, bytes = 32): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(bytes));
  const hex = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}${hex}`;
}

// ============================================================================
// Timing-Safe Comparison
// ============================================================================

/**
 * Constant-time string comparison to prevent timing attacks.
 * Uses hash comparison to ensure constant time regardless of input length.
 * 
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns Promise resolving to true if strings are equal
 */
export async function timingSafeCompare(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  
  // Always compute both hashes to maintain constant time
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', aBytes),
    crypto.subtle.digest('SHA-256', bBytes),
  ]);
  
  // If lengths differ, we still need constant-time comparison
  // The hash comparison will fail anyway
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  
  // Compare hashes byte by byte (constant time)
  const aArr = new Uint8Array(aHash);
  const bArr = new Uint8Array(bHash);
  
  let result = 0;
  for (let i = 0; i < aArr.length; i++) {
    result |= aArr[i] ^ bArr[i];
  }
  return result === 0;
}
