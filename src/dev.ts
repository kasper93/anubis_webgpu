// Entry for dist/anubis_pow.js: the API as a global, no page hook. Used by
// the dev/bench pages and their Blob workers.
import { exposeGlobal } from "./api.ts";

exposeGlobal();
