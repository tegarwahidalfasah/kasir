// Hash kata sandi bersama untuk API dan provisioning offline. Tidak membuka DB.
import crypto from 'node:crypto';

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return `s2:${salt}:${hash}`;
}

export function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [tag, salt, hash] = stored.split(':');
  if (tag !== 's2' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(plain), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}
