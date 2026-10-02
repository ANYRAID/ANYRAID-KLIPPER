// GPL-3.0-or-later. Original Python outputs captured before retirement.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import type {StatsSample, StatsPlot} from '../src/diagnostics/graphstats.ts';
export {graphstatsFixture} from '../contracts/graphstats-fixture.ts';
type Timing = {medianMs: number; p95Ms: number};
interface Reference {samples: StatsSample[]; plots: StatsPlot[]; elapsedMs: number;}
interface CapturedCase {count: number; mcu: string | null; inputSha256: string; reference: Reference;}
export const graphstatsManifest = JSON.parse(readFileSync(new URL('../contracts/graphstats-retirement.json', import.meta.url), 'utf8')) as {
  dataSha256: string; compressedSha256: string; compressedBytes: number; uncompressedBytes: number;
  cases: Omit<CapturedCase, 'reference'>[];
  before: {nodeParseAndFivePlots: Timing; pythonParseAndFivePlots: Timing};
};
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let references: CapturedCase[] | undefined;
export function graphstatsReference(text: string, mcu?: string): Reference {
  if (!references) {
    const compressed = readFileSync(new URL('../contracts/graphstats-retirement.json.gz', import.meta.url));
    assert.equal(compressed.length, graphstatsManifest.compressedBytes);
    assert.equal(hash(compressed), graphstatsManifest.compressedSha256);
    const bytes = gunzipSync(compressed, {maxOutputLength: 16 * 1024 ** 2});
    assert.equal(bytes.length, graphstatsManifest.uncompressedBytes);
    assert.equal(hash(bytes), graphstatsManifest.dataSha256);
    const captured = JSON.parse(bytes.toString('utf8')) as {cases: CapturedCase[]};
    assert.deepEqual(captured.cases.map(({reference, ...identity}) => identity), graphstatsManifest.cases);
    references = captured.cases;
  }
  const digest = hash(text), selected = references.find(c => c.inputSha256 === digest && c.mcu === (mcu ?? null));
  assert.ok(selected, 'No captured Python statistics reference for this input/MCU');
  return selected.reference;
}
