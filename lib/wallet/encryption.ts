import crypto from 'crypto';

export interface EncryptedData {
  iv: string;
  salt: string;
  ciphertext: string;
  tag: string;
}

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const SCRYPT_N = 16384; // CPU/memory cost (reduced from 32768 for compatibility)
const SCRYPT_R = 8;     // Block size
const SCRYPT_P = 1;     // Parallelization
const SCRYPT_MAXMEM = 32 * 1024 * 1024; // 32 MB max memory

/**
 * Derive a key from passphrase using scrypt
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Encrypt plaintext with passphrase using AES-256-GCM
 */
export function encrypt(plaintext: string, passphrase: string): EncryptedData {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
    ciphertext,
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt ciphertext with passphrase using AES-256-GCM
 */
export function decrypt(encrypted: EncryptedData, passphrase: string): string {
  const salt = Buffer.from(encrypted.salt, 'hex');
  const key = deriveKey(passphrase, salt);
  const iv = Buffer.from(encrypted.iv, 'hex');
  const tag = Buffer.from(encrypted.tag, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let plaintext = decipher.update(encrypted.ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');

  return plaintext;
}
