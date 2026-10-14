import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Vercel disables experimental require(ESM). Exercise the same restriction
// against the installed production dependency tree, rather than tsx's loader.
const require = createRequire(import.meta.url);
require('rpc-websockets');
const { default: handler } = await import('../build/api/public-workspace.js');
const response = {
  statusCode: 0,
  body: null,
  setHeader() {},
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
};
await handler({ method: 'GET', url: '/api/config' }, response);
assert.equal(response.statusCode, 200);
assert.equal(response.body.fundingEnabled, false);
assert.equal(response.body.automationEnabled, false);
assert.equal(response.body.programId, null);
console.log('Compiled public API starts with native Node; funding and automation disabled.');
