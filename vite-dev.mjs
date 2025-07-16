import crypto from 'node:crypto';
if (typeof (crypto.hash) !== 'function') {
  crypto.hash = (algorithm, data, enc) =>
    crypto.createHash(algorithm).update(data).digest(enc);
}
process.env.ROLLUP_NO_BINARY = 'true';
import { join } from 'path';
import { pathToFileURL } from 'url';
await import(pathToFileURL(join(process.cwd(), 'node_modules/vite/bin/vite.js')).href);
