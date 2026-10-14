'use strict';
// No native addon or install script. This replaces the vulnerable optional C binding.
function bytes(input) { if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) throw new TypeError('Expected bytes'); if (input.length > 1048576) throw new RangeError('Buffer exceeds conversion limit'); return Buffer.from(input); }
function toBigIntBE(input) { const hex = bytes(input).toString('hex'); return hex ? BigInt('0x' + hex) : 0n; }
function toBigIntLE(input) { return toBigIntBE(bytes(input).reverse()); }
function toBufferBE(value, width) {
 if (typeof value !== 'bigint' || value < 0n) throw new RangeError('Expected unsigned bigint');
 if (!Number.isSafeInteger(width) || width < 0 || width > 1048576) throw new RangeError('Invalid byte width');
 if (value === 0n && width === 0) return Buffer.alloc(0);
 const hex = value.toString(16); if (hex.length > width * 2) throw new RangeError('Integer does not fit byte width');
 return Buffer.from(hex.padStart(width * 2, '0'), 'hex');
}
function toBufferLE(value, width) { return toBufferBE(value, width).reverse(); }
module.exports = {toBigIntBE, toBigIntLE, toBufferBE, toBufferLE};
