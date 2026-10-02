import { createReadStream } from 'node:fs';
/** Strict UTF-8 with Python universal newlines, preserving an initial BOM. */
export async function* utf8LineBatches(
  filename: string,
): AsyncGenerator<string[]> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let pending = '';
  function* consume(final = false) {
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i];
      if (c !== '\r' && c !== '\n') continue;
      if (c === '\r' && i === pending.length - 1 && !final) break;
      yield pending.slice(start, i);
      if (c === '\r' && pending[i + 1] === '\n') i++;
      start = i + 1;
    }
    pending = pending.slice(start);
  }
  for await (const chunk of createReadStream(filename)) {
    pending += decoder.decode(chunk as Buffer, { stream: true });
    yield [...consume()];
  }
  pending += decoder.decode();
  const tail = [...consume(true)];
  if (pending) tail.push(pending);
  if (tail.length) yield tail;
}
