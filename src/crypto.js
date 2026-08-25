// crypto.js — AES-GCM envelope over the event log.
//
// WebCrypto only. No library, no build step, nothing to install or keep upgraded.
//
// SCOPE OF THIS ENCRYPTION, stated plainly so the trade is chosen and not assumed:
// it protects the copy that sits at GitHub. The phone's own copy is plaintext in
// IndexedDB, because encrypting that too would mean a passphrase on every open,
// which destroys the one-tap goal. Safe against GitHub, the network and a leaked
// repo. Not a defence against someone holding the unlocked phone.

export const ENVELOPE_VERSION = 1;
export const KDF_ITERATIONS = 310000;

const enc = new TextEncoder();
const dec = new TextDecoder();

// btoa() corrupts non-ASCII, and Arabic will land in a note field eventually.
// Always go through bytes.
export function bytesToB64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Object -> envelope object ready to be JSON.stringify'd and committed. */
export async function encryptDoc(doc, passphrase) {
  if (!passphrase) throw new Error('No passphrase set');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh IV every write
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(doc)));
  return {
    v: ENVELOPE_VERSION,
    alg: 'AES-GCM-256',
    kdf: 'PBKDF2-SHA256',
    iter: KDF_ITERATIONS,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(ct)),
  };
}

export class DecryptError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'DecryptError';
  }
}

/** Envelope object -> the original document. Throws loudly on a wrong passphrase. */
export async function decryptDoc(envelope, passphrase) {
  if (!envelope || typeof envelope !== 'object') throw new DecryptError('Not an envelope');
  if (envelope.v !== ENVELOPE_VERSION) throw new DecryptError('Unsupported envelope version: ' + envelope.v);
  if (!passphrase) throw new DecryptError('No passphrase set');

  const salt = b64ToBytes(envelope.salt);
  const iv = b64ToBytes(envelope.iv);
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: envelope.iter || KDF_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64ToBytes(envelope.ct));
  } catch {
    // AES-GCM authentication failed. Almost always the wrong passphrase.
    throw new DecryptError('Could not decrypt — wrong passphrase, or the file is corrupt');
  }

  try {
    return JSON.parse(dec.decode(plain));
  } catch {
    throw new DecryptError('Decrypted, but the contents are not valid JSON');
  }
}
