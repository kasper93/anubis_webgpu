# anubis_webgpu

Solve [Anubis](https://github.com/TecharoHQ/anubis) proof-of-work challenges natively in the browser with WebGPU, falling back to an optimized pure-JS solver on CPU.

This project was inspired by [anubis_offload](https://github.com/DavidBuchanan314/anubis_offload) and is a native recreation of the same idea. Big thanks to David Buchanan for the original work. Note that [anubis_offload](https://github.com/DavidBuchanan314/anubis_offload) is still perfect if you want to offload the solve to another device on your network, e.g. from a slow laptop to a fast workstation with a GPU.

## Install

Install [`anubis_webgpu.user.js`](https://github.com/kasper93/anubis_webgpu/raw/refs/heads/master/anubis_webgpu.user.js) with Tampermonkey/Violentmonkey. That's it.

## Performance

Sample measurements, a workload of roughly 25-34 million hashes (difficulty 6):

| Backend | Firefox 156.0a1 (20260816214904) | Chromium/Chrome/Electron/Edge/... |
|---|---|---|
| WebGPU | 173.9 MH/s | 3374.20 MH/s |
| CPU x1 (JS) | 3.0 MH/s | 2.9 MH/s |
| CPU x32 (JS) | 54.1 MH/s | 56.0 MH/s |
| stock Anubis page | ~0.5 MH/s | ~0.6 MH/s |

Your performance may vary. The exact numbers are not as important as the ratio between them.

## How

Anubis computes PoW in Web Workers, hashing `data + nonce` with WebCrypto per attempt. The userscript hooks `Worker.postMessage`, intercepts messages that look like Anubis PoW challenges, and solves them itself:

- difficulty <= 4: pure-JS CPU (a few ms, not worth GPU spin-up)
- difficulty 5-9: WebGPU compute shader, JS fallback if WebGPU is unavailable
- difficulty > 9: refused

On any failure the original messages are replayed to the page's own workers, so stock Anubis still works.

Progress is reported the same way the stock worker does (numeric messages), so the Anubis progress bar keeps working. The stock "Speed:" readout only refreshes after one second, longer than a solve takes, so the hook updates its text in place with the real rate. On pages without it, a small corner badge is shown instead.

Both solvers re-hash only the final SHA-256 block per attempt (midstate trick) and use the octal-nonce encoding from [anubis_offload](https://github.com/DavidBuchanan314/anubis_offload): the nonce string is `"1"` + 18 octal digits of the counter, built branchlessly, and happens to be a valid decimal integer. Every result is verified against a full JS SHA-256 before being handed to the page.

WebGPU needs Chrome 113+ or Firefox 141+ and a secure context (https).
