import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
export function objectExclusionReference(){
 const metadata=JSON.parse(readFileSync(new URL('../../contracts/object-exclusion-reference.json',import.meta.url),'utf8')),bytes=readFileSync(new URL('../../contracts/object-exclusion-reference.json.gz',import.meta.url));
 if(createHash('sha256').update(bytes).digest('hex')!==metadata.dataSha256)throw new Error('Object exclusion reference digest mismatch');
 return {metadata,...JSON.parse(gunzipSync(bytes).toString())} as {metadata:any;actions:any[];expected:any[]};
}
