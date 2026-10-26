import { randomBytes } from 'node:crypto';

// Public IDs: TypeIDs, a registered prefix and a UUID v7 in 26 Crockford base32 characters.
// Integer primary keys never leave packages/server; rows referenced from outside carry one of these.
const PREFIXES = {
  computer: 'cmp',
  computerSession: 'cs',
  browser: 'brw',
  organization: 'org',
  membership: 'mem',
  invitation: 'inv',
  apiKey: 'key',
} as const;
export type PublicIdKind = keyof typeof PREFIXES;
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

// 130 bits for 128: the first character carries 3 bits, so it is 0–7.
const encode = (bytes: Buffer) => {
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let text = '';
  for (let i = 0; i < 26; i++) {
    text = ALPHABET[Number(value & 31n)] + text;
    value >>= 5n;
  }
  return text;
};
// RFC 9562 UUID v7: a 48-bit millisecond timestamp, then random bits, so IDs sort by creation time.
function uuidv7(now: number) {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}
export const newPublicId = (kind: PublicIdKind, now = Date.now()) => `${PREFIXES[kind]}_${encode(uuidv7(now))}`;
// Matches only well-formed IDs of this kind, so a wrong or malformed ID is refused before any query.
export const publicIdPattern = (kind: PublicIdKind) => new RegExp(`^${PREFIXES[kind]}_[0-7][${ALPHABET}]{25}$`);
