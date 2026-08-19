// Correctness tests against Node's native SHA-256. Run: npm test
// (node --test with native type stripping; generates src/gen/kernels.ts first)
import { test } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import { writeKernelsModule } from "../src/kernelgen.ts";
import { sha256hex, nonceString } from "../src/core.ts";

await writeKernelsModule();
const { cpuSolve } = await import("../src/cpu.ts"); // after kernel generation

const nodeSha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

test("sha256hex matches node:crypto", () => {
	for (const msg of ["", "abc", "A".repeat(64), "x".repeat(200)])
		assert.strictEqual(sha256hex(msg), nodeSha(msg));
});

test("octal nonce encoding incl. the 32-bit lo/hi seam (digits 10 and 11)", () => {
	assert.strictEqual(nonceString(0, 0), "1" + "0".repeat(18));
	assert.strictEqual(nonceString(0, 0o755), "1" + "0".repeat(15) + "755");
	assert.strictEqual(
		nonceString(3, 0xFFFFFFFF),
		"1" + BigInt("0x3FFFFFFFF").toString(8).padStart(18, "0"));
	assert.strictEqual(
		nonceString(0x12345, 0x9ABCDEF0),
		"1" + BigInt("0x123459ABCDEF0").toString(8).padStart(18, "0"));
});

test("cpuSolve finds verifiable nonces across lengths and difficulties", async () => {
	for (const [len, diff] of [[64, 4], [64, 5], [64, 6], [100, 4], [100, 5], [32, 3], [32, 4], [128, 4], [1, 4], [36, 4], [65, 4]]) {
		const data = "a".repeat(len);
		const res = await cpuSolve(data, diff, { chunkSize: 1 << 20 });
		assert.ok(res.found, `len=${len} diff=${diff} not found`);
		assert.match(res.nonce!, /^1[0-7]{18}$/);
		const h = nodeSha(data + res.nonce);
		assert.strictEqual(res.hash, h, `len=${len} diff=${diff} hash mismatch`);
		assert.ok(h.startsWith("0".repeat(diff)), h);
	}
});

test("start/stride splitting (worker lanes)", async () => {
	for (const [start, stride] of [[3, 7], [1, 4], [123456, 997]]) {
		const data = "b".repeat(64);
		const res = await cpuSolve(data, 4, { start, stride });
		const h = nodeSha(data + res.nonce);
		assert.strictEqual(res.hash, h);
		assert.ok(h.startsWith("0000"));
	}
});

test("unsupported length throws, give-up thresholds return found:false", async () => {
	await assert.rejects(cpuSolve("c".repeat(101), 2));
	const res = await cpuSolve("d".repeat(64), 16, { maxHashes: 10000 });
	assert.strictEqual(res.found, false);
});
