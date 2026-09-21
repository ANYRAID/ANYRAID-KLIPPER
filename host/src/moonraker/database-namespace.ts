import type {DatabaseStore} from './database.ts';
import {databaseNamespace,type DatabaseKey} from './database-record.ts';
import {ApiError,type Json} from './rpc.ts';
/** Trusted component convenience wrapper, not an authorization capability.
 * Only public API access is restricted by the registered namespace policy. */
export class DatabaseNamespace {
 readonly #store:DatabaseStore;readonly namespace:string;readonly parseKeys:boolean;
 constructor(store:DatabaseStore,namespace:string,parseKeys:boolean){databaseNamespace(namespace);if(typeof parseKeys!=='boolean')throw new ApiError(400,'Invalid namespace key mode');this.#store=store;this.namespace=namespace;this.parseKeys=parseKeys;}
 #key(key:DatabaseKey):DatabaseKey{return typeof key==='string'&&!this.parseKeys?[key]:key;}
 insert(key:DatabaseKey,value:Json){return this.#store.insert(this.namespace,this.#key(key),value);}
 updateChild(key:DatabaseKey,value:Json){return this.#store.update(this.namespace,this.#key(key),value);}
 async get(key:DatabaseKey,defaultValue:Json=null):Promise<Json>{try{return await this.#store.get(this.namespace,this.#key(key));}catch(error){if(error instanceof ApiError&&error.status===404)return defaultValue;throw error;}}
 all(){return this.#store.get(this.namespace);}
 delete(key:DatabaseKey){return this.#store.delete(this.namespace,this.#key(key));}
 update(values:Record<string,Json>){return this.#store.insertBatch(this.namespace,values);}
 sync(values:Record<string,Json>){return this.#store.syncNamespace(this.namespace,values);}
 getBatch(keys:readonly string[]){return this.#store.getBatch(this.namespace,keys);}
 deleteBatch(keys:readonly string[]){return this.#store.deleteBatch(this.namespace,keys);}
 moveBatch(from:readonly string[],to:readonly string[]){return this.#store.moveBatch(this.namespace,from,to);}
 clear(){return this.#store.clearNamespace(this.namespace);}
 contains(key:DatabaseKey){return this.#store.namespaceContains(this.namespace,this.#key(key));}
 keys(){return this.#store.namespaceKeys(this.namespace);}
 values(){return this.#store.namespaceValues(this.namespace);}
 items(){return this.#store.namespaceItems(this.namespace);}
 async pop(key:DatabaseKey,...fallback:[]|[Json]):Promise<Json>{try{return await this.delete(key);}catch(error){if(error instanceof ApiError&&error.status===404&&fallback.length)return fallback[0];throw error;}}
 length(){return this.#store.namespaceLength(this.namespace);}
}
