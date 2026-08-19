// Entry for the userscript: API global (handy for the console) plus the
// Anubis Worker hook.
import { exposeGlobal } from "./api.ts";
import { installHook } from "./hook.ts";

exposeGlobal();
installHook();
