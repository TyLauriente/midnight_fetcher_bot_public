/**
 * Generate a random 64-bit nonce (16 hex characters)
 * CRITICAL: Must be exactly 16 hex chars (64 bits)
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  const nonce = Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Guard: Verify output is exactly 16 hex characters
  if (nonce.length !== 16) {
    throw new Error(`Generated nonce has invalid length: ${nonce.length}, expected 16`);
  }

  return nonce;
}
