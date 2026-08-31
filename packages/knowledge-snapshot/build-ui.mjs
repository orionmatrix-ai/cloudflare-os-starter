// Deterministic local build input, no network. Embed the installed browser RPC module.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const library = await readFile(new URL(import.meta.resolve('capnweb')), 'utf8');
if (/[^\x00-\x7f]/.test(library)) throw new Error('Expected ASCII capnweb browser bundle');
const target = new URL('./src/generated/', import.meta.url);
await mkdir(target, { recursive: true });
await writeFile(new URL('browser-rpc.ts', target),
  'export default ' + JSON.stringify('data:text/javascript;base64,' + Buffer.from(library).toString('base64')) + ';\n');
