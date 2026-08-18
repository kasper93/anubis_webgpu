/*
 * AnubisPow: in-browser Anubis proof-of-work solver.
 * Backends: WebGPU compute (GpuSolver) and pure-JS CPU (cpuSolve).
 * Only the final SHA-256 block is re-hashed per attempt (midstate trick).
 * The nonce is "1" + 18 octal digits, a valid decimal literal sent as a string.
 */
var AnubisPow = (function () {
"use strict";

const K = new Int32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Int32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
	0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function compress(s, w) {
	for (let t = 16; t < 64; t++) {
		const x2 = w[t - 2], x15 = w[t - 15];
		w[t] = (((((x2 >>> 17) | (x2 << 15)) ^ ((x2 >>> 19) | (x2 << 13)) ^ (x2 >>> 10)) + w[t - 7]) +
		        ((((x15 >>> 7) | (x15 << 25)) ^ ((x15 >>> 18) | (x15 << 14)) ^ (x15 >>> 3)) + w[t - 16])) | 0;
	}
	let a = s[0], b = s[1], c = s[2], d = s[3], e = s[4], f = s[5], g = s[6], h = s[7];
	for (let t = 0; t < 64; t++) {
		const t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
			(g ^ (e & (f ^ g))) + K[t] + w[t]) | 0;
		const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) +
			((a & b) ^ (a & c) ^ (b & c))) | 0;
		h = g; g = f; f = e; e = (d + t1) | 0;
		d = c; c = b; b = a; a = (t1 + t2) | 0;
	}
	s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0; s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
	s[4] = (s[4] + e) | 0; s[5] = (s[5] + f) | 0; s[6] = (s[6] + g) | 0; s[7] = (s[7] + h) | 0;
}

function hexOfState(s) {
	let out = "";
	for (let i = 0; i < 8; i++) out += (s[i] >>> 0).toString(16).padStart(8, "0");
	return out;
}

function sha256hex(input) {
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
function midstate(bytes) {
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
function masks(difficulty) {
	const m = bits => bits === 0 ? 0 : (-1 << (32 - bits)) | 0;
	return [m(Math.min(difficulty, 8) * 4), m(Math.min(Math.max(difficulty - 8, 0), 8) * 4)];
}

// "1" + 18 octal digits of the 54-bit counter (hi:lo).
function nonceString(hi, lo) {
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

// Options: start/stride (worker lanes), chunkSize, maxHashes, timeLimitMs, onProgress(hashes).
async function cpuSolve(data, difficulty, opts = {}) {
	if (difficulty > 16) throw new Error("difficulty > 16 unsupported");
	const bytes = new TextEncoder().encode(data);
	const { mid, rem } = midstate(bytes);
	const r = rem.length;
	if (r + 19 + 1 + 8 > 64) throw new Error("unsupported data length");
	const [mask0, mask1] = masks(difficulty);

	// Tail block: remainder | '1' | 18 octal digits | 0x80 | zeros | bitlen
	const tail = new Uint8Array(64);
	tail.set(rem, 0);
	tail[r] = 0x31;
	tail.fill(0x30, r + 1, r + 19);
	tail[r + 19] = 0x80;
	const bitlen = (bytes.length + 19) * 8;
	tail[60] = bitlen >>> 24; tail[61] = (bitlen >>> 16) & 255;
	tail[62] = (bitlen >>> 8) & 255; tail[63] = bitlen & 255;

	const firstD = r + 1, lastD = r + 18;
	function add(n) {
		let i = lastD, carry = n;
		while (carry > 0) {
			if (i < firstD) throw new Error("nonce space exhausted");
			const v = tail[i] - 48 + carry;
			tail[i] = 48 + (v & 7);
			carry = v >>> 3;
			i--;
		}
	}
	if (opts.start) add(opts.start);
	const stride = opts.stride || 1;

	const w = new Int32Array(64);
	for (let i = 0; i < 16; i++) w[i] = (tail[4 * i] << 24) | (tail[4 * i + 1] << 16) | (tail[4 * i + 2] << 8) | tail[4 * i + 3];
	const dynFirst = firstD >> 2, dynLast = lastD >> 2;
	const s = new Int32Array(8);

	const chunk = opts.chunkSize ?? (1 << 16);
	const maxHashes = opts.maxHashes ?? 2 ** 48;
	const timeLimitMs = opts.timeLimitMs ?? Infinity;
	let hashes = 0;
	const t0 = performance.now();

	for (;;) {
		const n = Math.min(chunk, maxHashes - hashes);
		for (let j = 0; j < n; j++) {
			for (let wi = dynFirst; wi <= dynLast; wi++)
				w[wi] = (tail[4 * wi] << 24) | (tail[4 * wi + 1] << 16) | (tail[4 * wi + 2] << 8) | tail[4 * wi + 3];
			s.set(mid);
			compress(s, w);
			if ((s[0] & mask0) === 0 && (s[1] & mask1) === 0) {
				let nonce = "";
				for (let i = r; i <= lastD; i++) nonce += String.fromCharCode(tail[i]);
				return {
					found: true, nonce, hash: hexOfState(s),
					hashes: hashes + j + 1, ms: performance.now() - t0, backend: "cpu-js",
				};
			}
			add(stride);
		}
		hashes += n;
		opts.onProgress?.(hashes);
		const ms = performance.now() - t0;
		if (hashes >= maxHashes || ms > timeLimitMs)
			return { found: false, hashes, ms, backend: "cpu-js" };
		await new Promise(res => setTimeout(res, 0));
	}
}

/* ------------------------------- WebGPU ------------------------------- */

const GPU_STEPS = 256;   // hashes per invocation per dispatch
const WG_SIZE = 64;
const MAX_INV = 1 << 16; // x256 steps = 16.7M hashes per dispatch

function wgslSource() {
	const kList = Array.from(K, x => "0x" + (x >>> 0).toString(16) + "u").join(", ");
	return `
struct InParams {
	s0: u32, s1: u32, s2: u32, s3: u32,
	s4: u32, s5: u32, s6: u32, s7: u32,
	base_lo: u32,
	base_hi: u32,
	bitlen: u32,
	mask0: u32,
	mask1: u32,
};

struct OutBuf {
	flag: atomic<u32>,
	nonce_lo: u32,
	nonce_hi: u32,
	hash: array<u32, 8>,
};

@group(0) @binding(0) var<storage, read> P: InParams;
@group(0) @binding(1) var<storage, read_write> R: OutBuf;

var<private> KT: array<u32, 64> = array<u32, 64>(${kList});

fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }

@compute @workgroup_size(${WG_SIZE})
fn solve(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
	let stride = nwg.x * ${WG_SIZE}u;
	var lo = P.base_lo + gid.x;
	var hi = P.base_hi;
	if (lo < P.base_lo) { hi = hi + 1u; }

	for (var step = 0u; step < ${GPU_STEPS}u; step = step + 1u) {
		// nonce string: '1' then 18 octal digits of (hi:lo), MSB first
		let d0  =  lo         & 7u;
		let d1  = (lo >>  3u) & 7u;
		let d2  = (lo >>  6u) & 7u;
		let d3  = (lo >>  9u) & 7u;
		let d4  = (lo >> 12u) & 7u;
		let d5  = (lo >> 15u) & 7u;
		let d6  = (lo >> 18u) & 7u;
		let d7  = (lo >> 21u) & 7u;
		let d8  = (lo >> 24u) & 7u;
		let d9  = (lo >> 27u) & 7u;
		let d10 = ((lo >> 30u) | (hi << 2u)) & 7u;
		let d11 = (hi >>  1u) & 7u;
		let d12 = (hi >>  4u) & 7u;
		let d13 = (hi >>  7u) & 7u;
		let d14 = (hi >> 10u) & 7u;
		let d15 = (hi >> 13u) & 7u;
		let d16 = (hi >> 16u) & 7u;
		let d17 = (hi >> 19u) & 7u;

		var w: array<u32, 16>;
		w[0] = 0x31303030u | (d17 << 16u) | (d16 << 8u) | d15;
		w[1] = 0x30303030u | (d14 << 24u) | (d13 << 16u) | (d12 << 8u) | d11;
		w[2] = 0x30303030u | (d10 << 24u) | (d9  << 16u) | (d8  << 8u) | d7;
		w[3] = 0x30303030u | (d6  << 24u) | (d5  << 16u) | (d4  << 8u) | d3;
		w[4] = 0x30303080u | (d2  << 24u) | (d1  << 16u) | (d0  << 8u);
		for (var i = 5u; i < 15u; i = i + 1u) { w[i] = 0u; }
		w[15] = P.bitlen;

		var a = P.s0; var b = P.s1; var c = P.s2; var d = P.s3;
		var e = P.s4; var f = P.s5; var g = P.s6; var h = P.s7;

		for (var t = 0u; t < 64u; t = t + 1u) {
			var wv: u32;
			if (t < 16u) {
				wv = w[t];
			} else {
				let x2  = w[(t + 14u) & 15u];
				let x7  = w[(t +  9u) & 15u];
				let x15 = w[(t +  1u) & 15u];
				let x16 = w[ t        & 15u];
				wv = (rotr(x2, 17u) ^ rotr(x2, 19u) ^ (x2 >> 10u)) + x7
				   + (rotr(x15, 7u) ^ rotr(x15, 18u) ^ (x15 >> 3u)) + x16;
				w[t & 15u] = wv;
			}
			let t1 = h + (rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u)) + (g ^ (e & (f ^ g))) + KT[t] + wv;
			let t2 = (rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u)) + ((a & b) ^ (a & c) ^ (b & c));
			h = g; g = f; f = e; e = d + t1;
			d = c; c = b; b = a; a = t1 + t2;
		}

		let r0 = P.s0 + a;
		let r1 = P.s1 + b;
		if ((r0 & P.mask0) == 0u && (r1 & P.mask1) == 0u) {
			if (atomicExchange(&R.flag, 1u) == 0u) {
				R.nonce_lo = lo;
				R.nonce_hi = hi;
				R.hash[0] = r0;       R.hash[1] = r1;
				R.hash[2] = P.s2 + c; R.hash[3] = P.s3 + d;
				R.hash[4] = P.s4 + e; R.hash[5] = P.s5 + f;
				R.hash[6] = P.s6 + g; R.hash[7] = P.s7 + h;
			}
		}

		let nl = lo + stride;
		if (nl < lo) { hi = hi + 1u; }
		lo = nl;
	}
}
`;
}

class GpuSolver {
	static async create() {
		if (typeof navigator === "undefined" || !navigator.gpu)
			throw new Error("WebGPU not available");
		const adapter = await navigator.gpu.requestAdapter();
		if (!adapter) throw new Error("no WebGPU adapter");
		const device = await adapter.requestDevice();
		const module = device.createShaderModule({ code: wgslSource() });
		const pipeline = await device.createComputePipelineAsync({
			layout: "auto",
			compute: { module, entryPoint: "solve" },
		});
		return new GpuSolver(device, pipeline, adapter);
	}

	constructor(device, pipeline, adapter) {
		this.device = device;
		this.pipeline = pipeline;
		const inf = adapter.info;
		this.info = inf ? [inf.vendor, inf.architecture || inf.device].filter(Boolean).join(" ") : "unknown adapter";
		this.dead = false;
		device.lost.then(() => { this.dead = true; });
		const S = GPUBufferUsage;
		this.inBuf = device.createBuffer({ size: 64, usage: S.STORAGE | S.COPY_DST });
		this.outBuf = device.createBuffer({ size: 48, usage: S.STORAGE | S.COPY_SRC | S.COPY_DST });
		this.staging = device.createBuffer({ size: 48, usage: S.MAP_READ | S.COPY_DST });
		this.bindGroup = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.inBuf } },
				{ binding: 1, resource: { buffer: this.outBuf } },
			],
		});
	}

	async solve(data, difficulty, opts = {}) {
		if (this.dead) throw new Error("GPU device lost");
		if (difficulty > 16) throw new Error("difficulty > 16 unsupported");
		const bytes = new TextEncoder().encode(data);
		if (bytes.length % 64 !== 0)
			throw new Error("GPU path requires data length to be a multiple of 64");
		const { mid } = midstate(bytes);
		const [mask0, mask1] = masks(difficulty);

		// Scale dispatch to expected work, tiny dispatches for easy challenges.
		const inv = Math.min(MAX_INV,
			Math.max(WG_SIZE, Math.ceil(16 ** Math.min(difficulty, 8) / GPU_STEPS / WG_SIZE) * WG_SIZE));

		const params = new Uint32Array(16);
		for (let i = 0; i < 8; i++) params[i] = mid[i] >>> 0;
		params[10] = (bytes.length + 19) * 8;
		params[11] = mask0 >>> 0;
		params[12] = mask1 >>> 0;
		this.device.queue.writeBuffer(this.outBuf, 0, new Uint32Array(12));

		const maxHashes = opts.maxHashes ?? 2 ** 48;
		const timeLimitMs = opts.timeLimitMs ?? Infinity;
		const t0 = performance.now();
		let base = 0;

		for (;;) {
			params[8] = base % 4294967296;
			params[9] = Math.floor(base / 4294967296);
			this.device.queue.writeBuffer(this.inBuf, 0, params);

			const enc = this.device.createCommandEncoder();
			const pass = enc.beginComputePass();
			pass.setPipeline(this.pipeline);
			pass.setBindGroup(0, this.bindGroup);
			pass.dispatchWorkgroups(inv / WG_SIZE);
			pass.end();
			enc.copyBufferToBuffer(this.outBuf, 0, this.staging, 0, 48);
			this.device.queue.submit([enc.finish()]);

			await this.staging.mapAsync(GPUMapMode.READ);
			const res = new Uint32Array(this.staging.getMappedRange().slice(0));
			this.staging.unmap();
			base += inv * GPU_STEPS;

			if (res[0]) {
				const nonce = nonceString(res[2], res[1]);
				let hash = "";
				for (let i = 3; i < 11; i++) hash += res[i].toString(16).padStart(8, "0");
				if (sha256hex(data + nonce) !== hash)
					throw new Error("GPU result failed verification");
				return { found: true, nonce, hash, hashes: base, ms: performance.now() - t0, backend: "webgpu" };
			}
			opts.onProgress?.(base);
			const ms = performance.now() - t0;
			if (base >= maxHashes || ms > timeLimitMs)
				return { found: false, hashes: base, ms, backend: "webgpu" };
		}
	}

	destroy() {
		this.device.destroy();
		this.dead = true;
	}
}

// Cached instance behind a plain function, so the API mirrors cpuSolve.
// Calls are serialized because the instance's GPU buffers are shared.
let gpuSolver = null;
let gpuBusy = Promise.resolve();

// Warms up the device and pipeline. Returns the adapter description.
async function gpuInit() {
	if (!gpuSolver || gpuSolver.dead) gpuSolver = await GpuSolver.create();
	return gpuSolver.info;
}

function gpuSolve(data, difficulty, opts = {}) {
	const run = gpuBusy.then(async () => {
		try {
			await gpuInit();
			return await gpuSolver.solve(data, difficulty, opts);
		} catch (e) {
			gpuSolver = null; // retry from scratch on the next call
			throw e;
		}
	});
	gpuBusy = run.catch(() => {});
	return run;
}

return { sha256hex, midstate, masks, nonceString, cpuSolve, gpuSolve, gpuInit, GPU_STEPS };
})();
