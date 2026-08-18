// Correctness tests for pow-core.js against Node's native SHA-256.
// Run: node test_core.mjs
import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert";

const src = fs.readFileSync(new URL("./pow-core.js", import.meta.url), "utf8");
const AnubisPow = new Function(src + "\nreturn AnubisPow;")();

for (const msg of ["", "abc", "A".repeat(64), "x".repeat(200)]) {
	const want = crypto.createHash("sha256").update(msg).digest("hex");
	assert.strictEqual(AnubisPow.sha256hex(msg), want);
}

// octal nonce encoding incl. the 32-bit lo/hi seam (digits 10 and 11)
assert.strictEqual(AnubisPow.nonceString(0, 0), "1" + "0".repeat(18));
assert.strictEqual(AnubisPow.nonceString(0, 0o755), "1" + "0".repeat(15) + "755");
assert.strictEqual(
	AnubisPow.nonceString(3, 0xFFFFFFFF),
	"1" + BigInt("0x3FFFFFFFF").toString(8).padStart(18, "0"));
assert.strictEqual(
	AnubisPow.nonceString(0x12345, 0x9ABCDEF0),
	"1" + BigInt("0x123459ABCDEF0").toString(8).padStart(18, "0"));

for (const [len, diff] of [[64, 4], [64, 5], [100, 4], [32, 3], [128, 4]]) {
	const data = "a".repeat(len);
	const res = await AnubisPow.cpuSolve(data, diff, { chunkSize: 1 << 20 });
	assert.ok(res.found);
	assert.match(res.nonce, /^1[0-7]{18}$/);
	const h = crypto.createHash("sha256").update(data + res.nonce).digest("hex");
	assert.strictEqual(res.hash, h);
	assert.ok(h.startsWith("0".repeat(diff)), h);
	console.log(`len=${len} diff=${diff}: ${res.hashes} hashes in ${res.ms.toFixed(1)}ms ` +
		`(${(res.hashes / res.ms / 1000).toFixed(2)} MH/s) nonce=${res.nonce}`);
}

// start/stride splitting (multi-worker lanes)
{
	const data = "b".repeat(64);
	const res = await AnubisPow.cpuSolve(data, 4, { start: 3, stride: 7 });
	const h = crypto.createHash("sha256").update(data + res.nonce).digest("hex");
	assert.strictEqual(res.hash, h);
	assert.ok(h.startsWith("0000"));
}

// unsupported length throws, give-up thresholds return found:false
await assert.rejects(AnubisPow.cpuSolve("c".repeat(101), 2));
{
	const res = await AnubisPow.cpuSolve("d".repeat(64), 16, { maxHashes: 10000 });
	assert.strictEqual(res.found, false);
}

console.log("all core tests passed");
