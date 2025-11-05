/**
 * Difficulty validation following Hash Engine reference implementation.
 *
 * Reference: hashengine/src/lib.rs hash_structure_good() lines 414-433
 *
 * Hash Engine logic:
 * - Converts difficulty hex string to required zero bits count
 * - Checks if hash has that many leading zero bits
 * - Example: "000FFFFF" = 12 leading zero bits required (3 full zero bytes)
 *
 * LEGACY MODES (preserved for rollback via DIFFICULTY_MODE env var):
 * - 'hashengine': Use Hash Engine zero-bits counting (DEFAULT)
 * - 'legacy_spec': Old spec (hashPrefix & ~mask) === 0
 * - 'legacy_server_mask': (hashPrefix & mask) === 0
 * - 'legacy_server_le': Little-endian spec rule
 * - 'legacy_threshold': Numeric comparison hashPrefix <= mask
 * - 'legacy_threshold_le': LE threshold comparison
 */
export type DifficultyMode = 'hashengine' | 'legacy_spec' | 'legacy_server_mask' | 'legacy_server_le' | 'legacy_threshold' | 'legacy_threshold_le';

export function getDifficultyMode(): DifficultyMode {
  const envMode = (process.env.DIFFICULTY_MODE || '').trim().toLowerCase();
  if (envMode === 'legacy_spec' || envMode === 'legacy_server_mask' || envMode === 'legacy_server_le' || envMode === 'legacy_threshold' || envMode === 'legacy_threshold_le') {
    return envMode as DifficultyMode;
  }
  return 'hashengine';
}

/**
 * Convert difficulty hex string to required zero bits count
 * Reference: hashengine difficulty_to_zero_bits() in lib.rs:484-496
 */
function difficultyToZeroBits(difficultyHex: string): number {
  // Decode hex string to bytes
  const bytes: number[] = [];
  for (let i = 0; i < difficultyHex.length; i += 2) {
    bytes.push(parseInt(difficultyHex.slice(i, i + 2), 16));
  }

  let zeroBits = 0;
  for (const byte of bytes) {
    if (byte === 0x00) {
      zeroBits += 8;
    } else {
      // Count leading zeros in this byte
      let b = byte;
      let leadingZeros = 0;
      for (let bit = 7; bit >= 0; bit--) {
        if ((b & (1 << bit)) === 0) {
          leadingZeros++;
        } else {
          break;
        }
      }
      zeroBits += leadingZeros;
      break; // Stop after first non-zero byte
    }
  }
  return zeroBits;
}

/**
 * Check if hash has required leading zero bits
 * Reference: hashengine hash_structure_good() in lib.rs:414-433
 */
function hashStructureGood(hashBytes: Uint8Array, zeroBits: number): boolean {
  const fullBytes = Math.floor(zeroBits / 8);
  const remainingBits = zeroBits % 8;

  // Check full zero bytes
  if (hashBytes.length < fullBytes) {
    return false;
  }
  for (let i = 0; i < fullBytes; i++) {
    if (hashBytes[i] !== 0) {
      return false;
    }
  }

  if (remainingBits === 0) {
    return true;
  }

  if (hashBytes.length > fullBytes) {
    // Mask for the most significant bits
    const mask = 0xFF << (8 - remainingBits);
    return (hashBytes[fullBytes] & mask) === 0;
  }

  return false;
}

export function matchesDifficulty(hashHex: string, difficultyHex: string, debug = false): boolean {
  // Validate inputs
  if (hashHex.length < 8) {
    throw new Error(`Invalid hash length: ${hashHex.length}, expected at least 8 hex chars`);
  }
  if (difficultyHex.length !== 8) {
    throw new Error(`Invalid difficulty length: ${difficultyHex.length}, expected exactly 8 hex chars`);
  }

  const mode = getDifficultyMode();

  // Convert hash hex to bytes for hashengine mode
  const hashBytes = new Uint8Array(hashHex.length / 2);
  for (let i = 0; i < hashHex.length; i += 2) {
    hashBytes[i / 2] = parseInt(hashHex.slice(i, i + 2), 16);
  }

  // Hash Engine canonical validation (DEFAULT)
  if (mode === 'hashengine') {
    const requiredZeroBits = difficultyToZeroBits(difficultyHex);
    const ok = hashStructureGood(hashBytes, requiredZeroBits);

    if (debug || (ok && process.env.DEBUG_SOLUTIONS)) {
      console.log(
        `[Difficulty Check] mode=hashengine hash=${hashHex.slice(0, 16)}... diff=${difficultyHex} ` +
        `required_zero_bits=${requiredZeroBits} result=${ok}`
      );
    }

    return ok;
  }

  // LEGACY MODES (for rollback)
  const prefixHex = hashHex.slice(0, 8);
  const mask = parseInt(difficultyHex.slice(0, 8), 16) >>> 0;
  const hashPrefixBE = parseInt(prefixHex, 16) >>> 0;

  const hashPrefixBytes = [
    parseInt(prefixHex.slice(0, 2), 16),
    parseInt(prefixHex.slice(2, 4), 16),
    parseInt(prefixHex.slice(4, 6), 16),
    parseInt(prefixHex.slice(6, 8), 16)
  ];
  const hashPrefixLE = (hashPrefixBytes[3] << 24) | (hashPrefixBytes[2] << 16) | (hashPrefixBytes[1] << 8) | hashPrefixBytes[0];
  const hashPrefixLEU = hashPrefixLE >>> 0;

  const maskBytes = [
    parseInt(difficultyHex.slice(0, 2), 16),
    parseInt(difficultyHex.slice(2, 4), 16),
    parseInt(difficultyHex.slice(4, 6), 16),
    parseInt(difficultyHex.slice(6, 8), 16)
  ];
  const maskLE = (maskBytes[3] << 24) | (maskBytes[2] << 16) | (maskBytes[1] << 8) | maskBytes[0];
  const maskLEU = maskLE >>> 0;

  let ok: boolean;
  if (mode === 'legacy_spec') {
    ok = (hashPrefixBE & (~mask >>> 0)) === 0;
  } else if (mode === 'legacy_threshold') {
    ok = hashPrefixBE <= mask;
  } else if (mode === 'legacy_threshold_le') {
    ok = hashPrefixLEU <= maskLEU;
  } else if (mode === 'legacy_server_mask') {
    ok = (hashPrefixBE & mask) === 0;
  } else if (mode === 'legacy_server_le') {
    ok = (hashPrefixLEU & (~mask >>> 0)) === 0;
  } else {
    // Fallback to hashengine
    const requiredZeroBits = difficultyToZeroBits(difficultyHex);
    ok = hashStructureGood(hashBytes, requiredZeroBits);
  }

  if (debug || (ok && process.env.DEBUG_SOLUTIONS)) {
    const invMask = (~mask >>> 0);
    const legacySpecCheck = (hashPrefixBE & invMask) === 0;
    const legacyThresholdCheck = hashPrefixBE <= mask;
    const legacyThresholdLeCheck = hashPrefixLEU <= maskLEU;
    const legacyServerMaskCheck = (hashPrefixBE & mask) === 0;
    const legacyServerLeCheck = (hashPrefixLEU & invMask) === 0;
    console.log(
      `[Difficulty Check] mode=${mode} hash=${prefixHex} diff=${difficultyHex.slice(0, 8)} ` +
      `hashBE=0x${hashPrefixBE.toString(16).padStart(8, '0')} hashLE=0x${hashPrefixLEU.toString(16).padStart(8, '0')} ` +
      `maskBE=0x${mask.toString(16).padStart(8, '0')} maskLE=0x${maskLEU.toString(16).padStart(8, '0')} ` +
      `legacy_spec=${legacySpecCheck} legacy_threshold=${legacyThresholdCheck} legacy_threshold_le=${legacyThresholdLeCheck} ` +
      `legacy_server_mask=${legacyServerMaskCheck} legacy_server_le=${legacyServerLeCheck} result=${ok}`
    );
  }

  return ok;
}

/**
 * Calculate expected hash rate based on difficulty
 * Hash Engine: 2^{required_zero_bits}
 */
export function estimateHashesNeeded(difficultyHex: string): number {
  const mode = getDifficultyMode();

  // Hash Engine mode (DEFAULT)
  if (mode === 'hashengine') {
    const zeroBits = difficultyToZeroBits(difficultyHex);
    return Math.pow(2, zeroBits);
  }

  // LEGACY MODES
  const diffMaskBE = parseInt(difficultyHex.slice(0, 8), 16) >>> 0;

  const maskBytes = [
    parseInt(difficultyHex.slice(0, 2), 16),
    parseInt(difficultyHex.slice(2, 4), 16),
    parseInt(difficultyHex.slice(4, 6), 16),
    parseInt(difficultyHex.slice(6, 8), 16)
  ];
  const diffMaskLE = ((maskBytes[3] << 24) | (maskBytes[2] << 16) | (maskBytes[1] << 8) | maskBytes[0]) >>> 0;

  if (mode === 'legacy_server_mask') {
    let ones = 0;
    let m = diffMaskBE;
    while (m) { m &= (m - 1); ones++; }
    return Math.pow(2, ones);
  }

  if (mode === 'legacy_threshold') {
    return Math.floor(0x1_0000_0000 / (diffMaskBE + 1));
  }

  if (mode === 'legacy_threshold_le') {
    return Math.floor(0x1_0000_0000 / (diffMaskLE + 1));
  }

  // legacy_spec and legacy_server_le
  const maskForZeroCount = (mode === 'legacy_server_le') ? diffMaskLE : diffMaskBE;
  let zeroBits = 0;
  for (let i = 0; i < 32; i++) {
    if ((maskForZeroCount & (1 << i)) === 0) {
      zeroBits++;
    }
  }
  return Math.pow(2, zeroBits);
}

/**
 * Get number of leading zero bits required for a difficulty
 * Useful for debugging
 */
export function getDifficultyZeroBits(difficultyHex: string): number {
  return difficultyToZeroBits(difficultyHex);
}
