/**
 * Preimage Builder
 * Following hashengine reference implementation
 */

export interface ChallengeData {
  challenge_id: string;
  difficulty: string;
  no_pre_mine: string;
  latest_submission: string;
  no_pre_mine_hour: string;
}

/**
 * Build preimage following Hash Engine reference implementation:
 * nonce + address + challenge_id + difficulty + no_pre_mine + latest_submission + no_pre_mine_hour
 *
 * Reference: hashengine/src/lib.rs build_preimage() lines 462-481
 *
 * CRITICAL: All fields are concatenated as-is, no trimming/formatting/separators
 * CRITICAL: challenge_id includes leading "**" (e.g., "**D07C10")
 * CRITICAL: difficulty must be 8-char hex with leading zeros preserved
 */
export function buildPreimage(
  nonce: string,
  address: string,
  challenge: ChallengeData,
  debug = false
): string {
  // Validate nonce is exactly 16 hex characters
  if (!/^[0-9a-f]{16}$/i.test(nonce)) {
    throw new Error(`Invalid nonce: "${nonce}" - must be exactly 16 hex characters`);
  }

  // Validate difficulty is hex
  if (!/^[0-9a-f]+$/i.test(challenge.difficulty)) {
    throw new Error(`Invalid difficulty: "${challenge.difficulty}" - must be hex characters`);
  }

  // Ensure challenge_id has ** prefix
  const challengeId = challenge.challenge_id.startsWith('**')
    ? challenge.challenge_id
    : `**${challenge.challenge_id}`;

  // Build preimage: nonce + address + challengeId + difficulty + no_pre_mine + latest_submission + no_pre_mine_hour
  // Optimized: Use array join instead of string concatenation for better performance
  const preimage = [
    nonce,
    address,
    challengeId,
    challenge.difficulty,
    challenge.no_pre_mine,
    challenge.latest_submission,
    challenge.no_pre_mine_hour
  ].join('');

  if (debug || process.env.DEBUG_PREIMAGE) {
    console.log(`[Preimage] nonce=${nonce} addr=${address.slice(0, 20)}... chal=${challengeId} diff=${challenge.difficulty}`);
    console.log(`[Preimage] Full: ${preimage.slice(0, 120)}...`);
  }

  return preimage;
}
