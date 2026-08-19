/*
 * Anubis Worker hook: intercepts PoW challenge messages the page posts to its
 * workers and solves them with the GPU/CPU solvers instead.
 */
import { cpuSolve } from "./cpu.ts";
import { gpuSolve } from "./gpu.ts";

const LOG_TAG = "[anubis_webgpu]";
// Works around the Firefox ~100 ms readback floor by busy-submitting during
// readbacks. <https://bugzilla.mozilla.org/show_bug.cgi?id=1870699>
const FAST_POLL = false;
// For low difficulties, the CPU path is faster than the GPU path because of
// spin-up latency.
const CPU_DIFFICULTY_THRESHOLD = 4;
const MAX_DIFFICULTY = 9;
// Real Anubis challenges are 64 chars. Refuse huge payloads from hostile pages.
const MAX_DATA_LENGTH = 4096;
const GPU_TIME_LIMIT_MS = 60_000;
const CPU_TIME_LIMIT_MS = 120_000;

interface AnubisMessage {
	data: string;
	difficulty: number;
	nonce: number;
	threads: number;
}

const ANUBIS_KEYS = new Set(["data", "difficulty", "nonce", "threads"]);
function looksLikeAnubisPow(m: unknown): m is AnubisMessage {
	return typeof m === "object" && m !== null &&
		Object.keys(m).every(k => ANUBIS_KEYS.has(k)) &&
		typeof (m as AnubisMessage).data === "string" &&
		typeof (m as AnubisMessage).difficulty === "number" &&
		typeof (m as AnubisMessage).nonce === "number" &&
		typeof (m as AnubisMessage).threads === "number";
}

interface Challenge {
	saved: { worker: Worker; args: unknown[] }[]; // kept for replay on failure
}

const challenges = new Map<string, Challenge>();

function fmtRate(hps: number): string {
	if (hps >= 1e9) return (hps / 1e9).toFixed(2) + "GH/s";
	if (hps >= 1e6) return (hps / 1e6).toFixed(2) + "MH/s";
	return (hps / 1e3).toFixed(0) + "kH/s";
}

// Anubis renders "Speed: 0kH/s" as a text node in #status, but only refreshes
// it after 1 s, which is longer than a solve takes. Rewrite the rate token in
// place, keeping the localized "Speed:" prefix. Fallback to a small corner badge.
let rateNode: Text | null | undefined;
let hud: HTMLDivElement | null = null;
function showRate(backend: string, rate: number): void {
	try {
		if (rateNode === undefined) {
			rateNode = null;
			const status = document.getElementById("status");
			if (status) {
				const walker = document.createTreeWalker(status, NodeFilter.SHOW_TEXT);
				for (let n; (n = walker.nextNode() as Text | null); )
					if (/H\/s\s*$/.test(n.data)) { rateNode = n; break; }
			}
		}
		if (rateNode) {
			rateNode.data = rateNode.data.replace(/\S+$/, fmtRate(rate));
			return;
		}
		if (!hud) {
			hud = document.createElement("div");
			hud.style.cssText = "position:fixed;bottom:8px;right:8px;z-index:2147483647;" +
				"background:rgba(0,0,0,.8);color:#7c7;font:12px/1.4 ui-monospace,monospace;" +
				"padding:4px 8px;border-radius:4px;pointer-events:none;white-space:pre";
			(document.body || document.documentElement).appendChild(hud);
		}
		hud.textContent = `${backend}  ${fmtRate(rate)}`;
	} catch { /* no DOM, no display */ }
}
function hideRate(): void {
	hud?.remove();
	hud = null;
}

async function solve(message: AnubisMessage, worker: Worker, ch: Challenge, origPostMessage: typeof Worker.prototype.postMessage): Promise<void> {
	const { data, difficulty } = message;
	console.log(LOG_TAG, "intercepted Anubis PoW challenge, difficulty", difficulty);
	const t0 = performance.now();

	// Same channel the stock worker uses: a number is progress, an object is the solution.
	const deliver = (payload: unknown) => {
		if (typeof worker.onmessage === "function") worker.onmessage(new MessageEvent("message", { data: payload }));
		else worker.dispatchEvent(new MessageEvent("message", { data: payload }));
	};
	let backend = "";
	let lastShown = 0;
	const opts = {
		onProgress: (hashes: number) => {
			// A throwing page handler must not abort the solve.
			try { deliver(hashes); } catch (e) { console.warn(LOG_TAG, "progress delivery failed:", e); }
			const now = performance.now();
			if (now - lastShown > 100) {
				lastShown = now;
				showRate(backend, hashes / (now - t0) * 1000);
			}
		},
	};
	let res = null;

	if (difficulty <= MAX_DIFFICULTY && data.length <= MAX_DATA_LENGTH) {
		if (difficulty > CPU_DIFFICULTY_THRESHOLD && navigator.gpu) {
			try {
				backend = "webgpu";
				res = await gpuSolve(data, difficulty, { ...opts, timeLimitMs: GPU_TIME_LIMIT_MS, fastPoll: FAST_POLL });
			} catch (e) {
				console.warn(LOG_TAG, "WebGPU failed, falling back to CPU:", e);
				res = null;
			}
		}
		if (!res || !res.found) {
			try {
				backend = "cpu-js";
				res = await cpuSolve(data, difficulty, { ...opts, timeLimitMs: CPU_TIME_LIMIT_MS });
			} catch (e) {
				console.warn(LOG_TAG, "CPU path failed:", e);
				res = null;
			}
		}
	} else {
		console.warn(LOG_TAG, `implausible challenge (difficulty ${difficulty}, ${data.length} bytes), not solving`);
	}

	if (res && res.found) {
		const ms = performance.now() - t0;
		console.log(LOG_TAG, `solved via ${res.backend} in ${ms.toFixed(1)} ms ` +
			`(${res.hashes.toLocaleString()} hashes, ${(res.hashes / ms / 1000).toFixed(2)} MH/s)`);
		showRate(res.backend, res.hashes / res.ms * 1000);
		deliver({ hash: res.hash, data, difficulty, nonce: res.nonce });
	} else {
		console.warn(LOG_TAG, "replaying challenge to the page's own workers");
		hideRate();
		for (const s of ch.saved) origPostMessage.apply(s.worker, s.args as Parameters<typeof origPostMessage>);
	}
	challenges.delete(data);
}

export function installHook(): void {
	const origPostMessage = Worker.prototype.postMessage;
	Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]) {
		const message = args[0];
		if (!looksLikeAnubisPow(message)) return origPostMessage.apply(this, args as Parameters<typeof origPostMessage>);
		let ch = challenges.get(message.data);
		if (!ch) { ch = { saved: [] }; challenges.set(message.data, ch); }
		ch.saved.push({ worker: this, args }); // kept for replay on failure
		if (message.nonce === 0) solve(message, this, ch, origPostMessage);
	};
}
