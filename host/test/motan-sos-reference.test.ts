import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,copyFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sosOracle,type SOSCase} from './helpers/motan-sos-oracle.ts';
const hash = (bytes:string|Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixture = ():SOSCase => ({source:Array(80).fill(3),mode:'filt',kind:'lowpass',order:3,cutoff:40});
const metadataURL = new URL('../contracts/motan-sos-reference.json',import.meta.url);
const dataURL = new URL('../contracts/motan-sos-reference.bin',import.meta.url);

test('fixed independent SOS references reject any changed request and return independent outputs',() => {
  const c = fixture(), first = sosOracle([c])[0], expected = [...first.values];
  first.values[0] = 123; first.sos[0][0] = 123;
  assert.deepEqual(sosOracle([c])[0].values,expected);
  assert.notEqual(sosOracle([c])[0].sos[0][0],123);
  const changed = {...c,source:[...c.source]}; changed.source[79] = 3.5;
  for (const input of [changed,{...c,order:4},{...c,fs:1001}])
    assert.throws(() => sosOracle([input]),/Unknown Motan SOS/);
  assert.throws(() => sosOracle([c],true),/Unknown Motan SOS/);
  assert.throws(() => sosOracle([c],false,true),/Unknown Motan SOS/);
  const impulse = {...c,source:Array.from({length:80},(_,i) => i === 0 || i === 79 ? 1 : 0)};
  assert.equal(sosOracle([impulse])[0].values.length,80);
  impulse.source[1] = -0;
  assert.throws(() => sosOracle([impulse]),/Unknown Motan SOS/);
});

test('all independent SOS records have intact digests, bounded lengths and complete nonoverlapping ranges',() => {
  const manifest = JSON.parse(readFileSync(metadataURL,'utf8')), data = readFileSync(dataURL);
  assert.equal(manifest.schema,1); assert.equal(data.length,manifest.data.bytes); assert.equal(hash(data),manifest.data.sha256);
  assert.deepEqual(manifest.counts,{sos:140,scalar:34,design:1}); assert.equal(manifest.total,175);
  const entries = Object.entries(manifest.groups).flatMap(([group,rows]) => Object.entries(rows as Record<string,{offset:number; compressedBytes:number; bytes:number; sha256:string}>).map(([key,entry]) => ({group,key,...entry}))).sort((a,b) => a.offset-b.offset);
  let offset = 0;
  for (const entry of entries) {
    assert.equal(entry.offset,offset); assert(entry.compressedBytes > 0 && entry.bytes > 0 && entry.bytes <= 8*1024**2);
    const bytes = gunzipSync(data.subarray(offset,offset+entry.compressedBytes),{maxOutputLength:8*1024**2});
    assert.equal(bytes.length,entry.bytes); assert.equal(hash(bytes),entry.sha256);
    const row = JSON.parse(bytes.toString('utf8')); assert.equal(row.inputSha256,entry.key);
    if (entry.group === 'sos') {
      assert(Array.isArray(row.reference.sos)); assert(Array.isArray(row.reference.values));
      if (row.reference.preciseValues) assert.equal(row.reference.preciseValues.length,row.reference.values.length);
    } else if (entry.group === 'scalar') {
      assert.equal(typeof row.reference.dtype,'string');
      assert(row.reference.error || row.reference.bits.every((bits:string) => /^[0-9a-f]{16}$/.test(bits)));
    } else assert(row.reference.every((ms:number[]) => ms.length === 7 && ms.every(x => Number.isFinite(x) && x >= 0)));
    offset += entry.compressedBytes;
  }
  assert.equal(entries.length,175); assert.equal(offset,data.length);
});

test('corrupt SOS archives and out-of-range or mismatched records fail without a fallback',async () => {
  const request = {case:fixture(),bench:false,highPrecision:false}, key = hash(JSON.stringify(request));
  const original = readFileSync(dataURL), manifest = JSON.parse(readFileSync(metadataURL,'utf8'));
  for (const kind of ['archive','range','record'] as const) {
    const dir = await mkdtemp(join(tmpdir(),'motan-sos-corruption-'));
    try {
      const helpers = join(dir,'host/test/helpers'), contracts = join(dir,'host/contracts');
      await mkdir(helpers,{recursive:true}); await mkdir(contracts,{recursive:true});
      await copyFile(new URL('./helpers/motan-sos-reference.ts',import.meta.url),join(helpers,'motan-sos-reference.ts'));
      const metadata = structuredClone(manifest), data = Buffer.from(original);
      if (kind === 'archive') data[0] ^= 1;
      else if (kind === 'range') metadata.groups.sos[key].offset = -1;
      else metadata.groups.sos[key].sha256 = '0'.repeat(64);
      await writeFile(join(contracts,'motan-sos-reference.bin'),data);
      await writeFile(join(contracts,'motan-sos-reference.json'),JSON.stringify(metadata));
      const reader = await import(pathToFileURL(join(helpers,'motan-sos-reference.ts')).href);
      assert.throws(() => reader.motanSOSReference('sos',request),assert.AssertionError);
    } finally { await rm(dir,{recursive:true,force:true}); }
  }
});
