// GPL-3.0-or-later. Protect capture directory entries during atomic export.
import {realpath} from 'node:fs/promises';
import {resolve,dirname,basename,join} from 'node:path';
/** Resolve parent symlinks: rename replaces the final entry, not its target.
 * This is a local CLI guard, not isolation against concurrent directory changes. */
export async function validateMotanOutput(prefix:string,output:string):Promise<void>{
 const entry=async(path:string)=>{const absolute=resolve(path);return join(await realpath(dirname(absolute)),basename(absolute));};
 const destination=await entry(output);
 for(const suffix of ['.json.gz','.index.gz']){
  if(destination===await entry(prefix+suffix))throw new Error('Output must not replace a Motan capture');
 }
}
