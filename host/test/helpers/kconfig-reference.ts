import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
/** Check provenance against the retired oracle, not a live Python dependency. */
export async function assertKconfigOracle(reference:{sourceSha256:string;source?:string}):Promise<void>{
 const oracle=JSON.parse(await readFile(new URL('../../contracts/kconfig-retired-oracle.json',import.meta.url),'utf8'));
 assert.equal(reference.sourceSha256,oracle.sourceSha256);
 if(reference.source!==undefined)assert.equal(reference.source,oracle.source);
}
