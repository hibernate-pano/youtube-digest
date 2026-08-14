/**
 * ESM entry for Cloudflare Workers. The implementation stays CommonJS
 * (src/index.js) so the node:test suite can require() it directly.
 */
import worker from "./index.js";

export default worker;
