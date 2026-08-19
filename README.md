# anubis_webgpu

Solve [Anubis](https://github.com/TecharoHQ/anubis) proof-of-work challenges natively in the browser with WebGPU, falling back to an optimized pure-JS solver on CPU.

This project was inspired by [anubis_offload](https://github.com/DavidBuchanan314/anubis_offload) and is a native recreation of the same idea. Big thanks to David Buchanan for the original work. Note that [anubis_offload](https://github.com/DavidBuchanan314/anubis_offload) is still perfect if you want to offload the solve to another device on your network, e.g. from a slow laptop to a fast workstation with a GPU.

## Install

Install [`anubis_webgpu.user.js`](https://github.com/kasper93/anubis_webgpu/raw/refs/heads/master/anubis_webgpu.user.js) with Tampermonkey/Violentmonkey. That's it.

## Performance

Sustained hash rates (2 s at difficulty 16, so a solution is never found):

| Backend | Firefox 156.0a1 (20260816214904) | Chromium/Chrome/Electron/Edge/... |
|---|---|---|
| WebGPU | 3255.7 MH/s | 5547.2 MH/s |
| CPU x1 (JS) | 4.6 MH/s | 5.8 MH/s |
| CPU x32 (JS) | 62.1 MH/s | 82.1 MH/s |
| stock Anubis page | ~0.5 MH/s | ~0.6 MH/s |

Measured on a Ryzen 7950X and a Radeon RX 9070 XT. Your numbers will differ, the ratios are what matter.

Notes:

- An end-to-end difficulty-6 solve (~24M hashes for this challenge) takes ~17 ms on the GPU in Chromium, but ~184 ms in Firefox. [bug 1870699](https://bugzilla.mozilla.org/show_bug.cgi?id=1870699) makes Firefox fire WebGPU callbacks from a ~100 ms poll timer, flooring every solve round trip at ~100 ms. Since every queue submission also polls, the optional `fastPoll` solve option submits empty command buffers while a readback is pending, cutting the wait to a few ms. It is off by default, no need to burn CPU, and ~100 ms is fine for solving a challenge; to turn it on, set `FAST_POLL = true` in [src/hook.ts](src/hook.ts) and rebuild. It will improve once the mentioned bug is fixed.
- The GPU dispatch size adapts each round, it starts near the expected work for the difficulty and grows while rounds return quickly, so short solves stay low-latency while long ones reach peak throughput.
- WebGPU spin-up is a one-time cost and varies a lot between browsers. Device and pipeline creation took ~50 ms in Firefox and ~740 ms in Chromium-based browsers on my box. That is why difficulty <= 4 goes straight to the CPU. It's also why raw GPU throughput is better on Chromium-based browsers: the WGSL kernel is unrolled there during compilation, while Firefox does not seem to optimize it. I tested manually unrolling and I can get the same performance on Firefox, but it's not really worth the complexity, it's fast enough.
- The CPU solver is deliberately not hyper-optimized, it's mainly used for <= 4 difficulty, where a solve takes ~15 ms on a single thread. It's fine for this purpose.

## How

Anubis computes PoW in Web Workers, hashing `data + nonce` with WebCrypto per attempt. The userscript hooks `Worker.postMessage`, intercepts messages that look like Anubis PoW challenges, and solves them itself:

- difficulty <= 4: pure-JS CPU (a few ms, not worth GPU spin-up)
- difficulty 5-9: WebGPU compute shader, JS fallback if WebGPU is unavailable
- difficulty > 9: refused

On any failure the original messages are replayed to the page's own workers, so stock Anubis still works.

Progress is reported the same way the stock worker does (numeric messages), so the Anubis progress bar keeps working. The stock "Speed:" readout only refreshes after one second, longer than a solve takes, so the hook updates its text in place with the real rate. On pages without it, a small corner badge is shown instead.

Both solvers re-hash only the final SHA-256 block per attempt (midstate trick) and use the octal-nonce encoding from [anubis_offload](https://github.com/DavidBuchanan314/anubis_offload): the nonce string is `"1"` + 18 octal digits of the counter, built branchlessly, and happens to be a valid decimal integer. Every result is verified against a full JS SHA-256 before being handed to the page.

The CPU solver ([src/cpu.ts](src/cpu.ts)) additionally memoizes everything the fast-moving nonce digits can't reach: compression rounds before the first dynamic message word are computed once per carry event instead of per hash, and the Davies-Meyer feed-forward is elided down to the two output words the difficulty mask tests. The per-hash rounds are an unrolled kernel (emitted by [src/kernelgen.ts](src/kernelgen.ts)) with the message schedule fused into 16 locals, shaped as a 16-round loop - the best single compromise between V8 and SpiderMonkey, which disagree about how much unrolling they like.

## Build

TypeScript sources live in `src/`; `anubis_webgpu.user.js` is a committed build artifact for convenience.

```sh
npm install
npm run build
npm test        # correctness vs node:crypto
npm run check   # tsc --noEmit
```

WebGPU needs Chrome 113+ or Firefox 141+ and a secure context (https).
