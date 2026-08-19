/*
 * The AnubisPow API surface, exposed as a global by the bundle entries so the
 * dev pages and Blob workers can use it without modules.
 */
import { K, H0, schedule, rounds, compress, hexOfState, sha256hex, midstate, masks, nonceString } from "./core.ts";
import { cpuSolve } from "./cpu.ts";
import { gpuSolve, gpuInit } from "./gpu.ts";

export const AnubisPow = {
	K, H0, schedule, rounds, compress, hexOfState, sha256hex, midstate, masks, nonceString,
	cpuSolve, gpuSolve, gpuInit,
};

export function exposeGlobal(): void {
	(globalThis as { AnubisPow?: typeof AnubisPow }).AnubisPow = AnubisPow;
}
