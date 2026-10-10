import { Buffer } from "buffer";
globalThis.Buffer ??= Buffer;
globalThis.global ??= globalThis;
globalThis.process ??= { env: {}, version: "", browser: true };
