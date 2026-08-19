/*
 * WebGPU compute solver.
 */
import { K, sha256hex, midstate, masks, nonceString } from "./core.ts";
import type { SolveResult } from "./cpu.ts";

export interface GpuSolveOptions {
	maxHashes?: number;
	timeLimitMs?: number;
	onProgress?: (hashes: number) => void;
	fastPoll?: boolean;
}

const GPU_STEPS = 256; // hashes per invocation per dispatch
const WG_SIZE = 64;

function wgslSource(): string {
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

@group(0) @binding(0) var<uniform> P: InParams;
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
	device: GPUDevice;
	pipeline: GPUComputePipeline;
	// Learned dispatch size (in workgroups), carried across solve calls.
	tunedWgs = 4096;
	info: string;
	dead = false;
	inBuf: GPUBuffer;
	outBuf: GPUBuffer;
	staging: GPUBuffer;
	bindGroup: GPUBindGroup;

	static async create(): Promise<GpuSolver> {
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

	constructor(device: GPUDevice, pipeline: GPUComputePipeline, adapter: GPUAdapter) {
		this.device = device;
		this.pipeline = pipeline;
		const inf = adapter.info;
		this.info = inf ? [inf.vendor, inf.architecture || inf.device].filter(Boolean).join(" ") : "unknown adapter";
		device.lost.then(() => { this.dead = true; });
		const S = GPUBufferUsage;
		this.inBuf = device.createBuffer({ size: 64, usage: S.UNIFORM | S.COPY_DST });
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

	// Reads back the result buffer. Firefox invokes WebGPU callbacks from a
	// ~100 ms poll timer (Bugzilla 1870699), but every queue submission also
	// polls; with fastPoll, empty command buffers are submitted while the
	// readback is pending, cutting the wait to a few ms at the cost of some
	// busy-work. Off by default.
	async readResult(fastPoll?: boolean): Promise<Uint32Array> {
		const map = this.staging.mapAsync(GPUMapMode.READ);
		if (fastPoll) {
			let pending = true;
			map.then(() => { pending = false; }, () => { pending = false; });
			(async () => {
				while (pending && !this.dead) {
					this.device.queue.submit([this.device.createCommandEncoder().finish()]);
					await new Promise(r => setTimeout(r, 3));
				}
			})();
		}
		await map;
		const res = new Uint32Array(this.staging.getMappedRange().slice(0));
		this.staging.unmap();
		return res;
	}

	async solve(data: string, difficulty: number, opts: GpuSolveOptions = {}): Promise<SolveResult> {
		if (this.dead) throw new Error("GPU device lost");
		if (difficulty > 16) throw new Error("difficulty > 16 unsupported");
		const bytes = new TextEncoder().encode(data);
		if (bytes.length % 64 !== 0)
			throw new Error("GPU path requires data length to be a multiple of 64");
		const { mid } = midstate(bytes);
		const [mask0, mask1] = masks(difficulty);

		// Dispatch size is adaptive (in workgroups). Start with the expected
		// work for the difficulty (easy challenges stay low-latency), capped
		// by the size learned from previous rounds. Browsers add fixed
		// per-round-trip overhead, so peak throughput needs hundreds of
		// millions of hashes per dispatch, while slow GPUs must shrink to
		// stay clear of watchdog timeouts. Round times are latency-quantized
		// on some browsers, so a proportional controller stalls below peak;
		// instead keep doubling while rounds come back quickly and back off
		// only when clearly over budget.
		const GROW_BELOW_MS = 220, SHRINK_ABOVE_MS = 400, SHRINK_TARGET_MS = 250;
		const HASHES_PER_WG = WG_SIZE * GPU_STEPS;
		const maxWgs = Math.min(65535, this.device.limits.maxComputeWorkgroupsPerDimension);
		let wgs = Math.min(this.tunedWgs, Math.max(1,
			Math.ceil(16 ** Math.min(difficulty, 8) / HASHES_PER_WG)));

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
			pass.dispatchWorkgroups(wgs);
			pass.end();
			enc.copyBufferToBuffer(this.outBuf, 0, this.staging, 0, 48);
			this.device.queue.submit([enc.finish()]);

			const roundT0 = performance.now();
			const res = await this.readResult(opts.fastPoll);
			const roundMs = Math.max(performance.now() - roundT0, 1);
			base += wgs * HASHES_PER_WG;
			if (roundMs < GROW_BELOW_MS) wgs = Math.min(maxWgs, wgs * 2);
			else if (roundMs > SHRINK_ABOVE_MS) wgs = Math.max(1, Math.ceil(wgs / roundMs * SHRINK_TARGET_MS));
			this.tunedWgs = Math.max(this.tunedWgs, wgs);

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

	destroy(): void {
		this.device.destroy();
		this.dead = true;
	}
}

// Cached instance behind a plain function, so the API mirrors cpuSolve.
// Calls are serialized because the instance's GPU buffers are shared.
let gpuSolver: GpuSolver | null = null;
let gpuBusy: Promise<unknown> = Promise.resolve();

// Warms up the device and pipeline. Returns the adapter description.
export async function gpuInit(): Promise<string> {
	if (!gpuSolver || gpuSolver.dead) gpuSolver = await GpuSolver.create();
	return gpuSolver.info;
}

export function gpuSolve(data: string, difficulty: number, opts: GpuSolveOptions = {}): Promise<SolveResult> {
	const run = gpuBusy.then(async () => {
		try {
			await gpuInit();
			return await gpuSolver!.solve(data, difficulty, opts);
		} catch (e) {
			gpuSolver = null; // retry from scratch on the next call
			throw e;
		}
	});
	gpuBusy = run.catch(() => {});
	return run;
}
