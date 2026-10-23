/** Restore one MAIN-world script from reviewed, ordered functional source parts.
 * Chrome and the shell fixture require the shared lexical closure and original
 * event identity; loading these parts as independent scripts would be unsafe.
 */
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'extension', 'fiber-src');
const output = path.join(root, 'extension', 'fiber.js');
const files = (await readdir(dir)).filter(name => /^\d\d-[\w-]+\.part\.js$/.test(name)).sort();
if (files.length !== 12 || files.some((name, at) => !name.startsWith(String(at).padStart(2, '0') + '-'))) {
  throw new Error('Incomplete or reordered fiber source parts');
}
const buffers = [];
for (const name of files) {
  const bytes = await readFile(path.join(dir, name));
  if (!bytes.length || bytes.length > 20000) throw new Error(`Invalid fiber part size: ${name}`);
  buffers.push(bytes);
}
const compiled = Buffer.concat(buffers);
if (process.argv.includes('--check')) {
  const existing = await readFile(output);
  if (!compiled.equals(existing)) throw new Error('Generated fiber.js differs from source parts');
} else {
  const temp = output + '.tmp-' + process.pid;
  await writeFile(temp, compiled);
  await rename(temp, output);
}
const sha = createHash('sha256').update(compiled).digest('hex');
console.log(`fiber.js: ${compiled.length} bytes, sha256 ${sha}`);
