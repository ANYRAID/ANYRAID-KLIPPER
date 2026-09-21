import {MetadataScanIntents,type MetadataScanIntent} from './metadata-intents.ts';
import {scanFileMetadata,type MetadataScanOptions} from './metadata-scan.ts';
export class MetadataIntentScanError extends Error {
 readonly intent:MetadataScanIntent;
 constructor(intent:MetadataScanIntent,cause:unknown){super('Metadata scan requires intent reconciliation',{cause});this.intent=intent;}
}
/** Durable intent precedes processing/publication. Success also retains intent:
 * an in-memory cache commit is not durable metadata or retirement confirmation. */
export async function scanFileMetadataWithIntent(intents:MetadataScanIntents,options:Omit<MetadataScanOptions,'bundleId'>){
 let intent:MetadataScanIntent;
 try{intent=await intents.begin(options.ticket.filename,options.signal);}
 catch(error){options.cache.fail(options.ticket);try{if(options.source.fd>=0)await options.source.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Metadata intent scan admission cleanup failed');}throw error;}
 try{return {intent,result:await scanFileMetadata({...options,bundleId:intent.bundleId})};}
 catch(error){throw new MetadataIntentScanError(intent,error);}
}
