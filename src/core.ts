/*
 * Shared SHA-256 primitives. Readable reference implementation, used for
 * midstate setup, verification, and the CPU solver's cold paths; the per-hash
 * hot loops live in the generated kernels (see kernelgen.ts).
 * Only the final SHA-256 block is re-hashed per attempt (midstate trick).
 * The nonce is "1" + 18 octal digits, a valid decimal literal sent as a string.
 */

export const K = new Int32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export const H0 = new Int32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
	0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

// Message-schedule expansion of w[16..63] from w[0..15].
export function schedule(w: Int32Array): void {
	for (let t = 16; t < 64; t++) {
		const x2 = w[t - 2], x15 = w[t - 15];
		w[t] = (((((x2 >>> 17) | (x2 << 15)) ^ ((x2 >>> 19) | (x2 << 13)) ^ (x2 >>> 10)) + w[t - 7]) +
		        ((((x15 >>> 7) | (x15 << 25)) ^ ((x15 >>> 18) | (x15 << 14)) ^ (x15 >>> 3)) + w[t - 16])) | 0;
	}
}

// Compression rounds [from, to) over an expanded schedule; state in s, no feed-forward.
export function rounds(s: Int32Array, w: Int32Array, from: number, to: number): void {
	let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
	for (let t = from; t < to; t++) {
		const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
			(g ^ (e & (f ^ g))) + K[t] + w[t]) | 0;
		const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) +
			((a & b) ^ (a & c) ^ (b & c))) | 0;
		h = g; g = f; f = e; e = (d + t1) | 0;
		d = c; c = b; b = a; a = (t1 + t2) | 0;
	}
	s[0] = a; s[1] = b; s[2] = c; s[3] = d; s[4] = e; s[5] = f; s[6] = g; s[7] = h;
}

const tmpState = new Int32Array(8);

export function compress(s: Int32Array, w: Int32Array): void {
	schedule(w);
	tmpState.set(s);
	rounds(tmpState, w, 0, 64);
	for (let i = 0; i < 8; i++) s[i] = (s[i] + tmpState[i]) | 0;
}

export function hexOfState(s: Int32Array): string {
	let out = "";
	for (let i = 0; i < 8; i++) out += (s[i] >>> 0).toString(16).padStart(8, "0");
	return out;
}

export function sha256hex(input: string | Uint8Array): string {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const bitlen = bytes.length * 8;
	const dv = new DataView(padded.buffer);
	dv.setUint32(padded.length - 8, Math.floor(bitlen / 4294967296));
	dv.setUint32(padded.length - 4, bitlen >>> 0);
	const s = Int32Array.from(H0);
	const w = new Int32Array(64);
	for (let o = 0; o < padded.length; o += 64) {
		for (let i = 0; i < 16; i++) w[i] = dv.getInt32(o + i * 4);
		compress(s, w);
	}
	return hexOfState(s);
}

// State after all full blocks. The remainder is returned raw.
export function midstate(bytes: Uint8Array): { mid: Int32Array; rem: Uint8Array } {
	const mid = Int32Array.from(H0);
	const w = new Int32Array(64);
	const nBlocks = Math.floor(bytes.length / 64);
	for (let b = 0; b < nBlocks; b++) {
		for (let i = 0; i < 16; i++) {
			const o = b * 64 + i * 4;
			w[i] = (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
		}
		compress(mid, w);
	}
	return { mid, rem: bytes.subarray(nBlocks * 64) };
}

// difficulty = leading zero hex chars. Masks apply to hash words 0 and 1.
export function masks(difficulty: number): [number, number] {
	const m = (bits: number) => bits === 0 ? 0 : (-1 << (32 - bits)) | 0;
	return [m(Math.min(difficulty, 8) * 4), m(Math.min(Math.max(difficulty - 8, 0), 8) * 4)];
}

// "1" + 18 octal digits of the 54-bit counter (hi:lo).
export function nonceString(hi: number, lo: number): string {
	let out = "1";
	for (let k = 17; k >= 0; k--) {
		let d;
		if (k >= 11) d = (hi >>> (3 * k - 32)) & 7;
		else if (k === 10) d = ((lo >>> 30) | (hi << 2)) & 7;
		else d = (lo >>> (3 * k)) & 7;
		out += d;
	}
	return out;
}
