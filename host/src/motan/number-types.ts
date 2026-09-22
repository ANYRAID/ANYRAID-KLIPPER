/** Optional JSON numeric-token provenance. Ordinary values remain Numbers so
 * timing/configuration consumers keep their existing contracts. Metadata lives
 * outside the JSON objects and follows the explicit clone/merge operations. */
export class MotanNumberMetadataError extends Error {}
const integers=new WeakMap<object,Map<string,number>>(),floats=new WeakMap<object,Map<string,number>>(),trees=new WeakSet<object>();
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object';
export function parseTypedMotanJson(text:string):unknown{
 let count=0;
 return JSON.parse(text,function(this:Record<string,unknown>,key:string,value:unknown,context?:{source?:string}){
  if(typeof value==='number'){
   const source=context?.source;
   if(source&&/^-?\d+$/.test(source)){
    if(source.length-(source[0]==='-'?1:0)>4300)throw new MotanNumberMetadataError('Motan integer digit limit');
    if(!Number.isSafeInteger(value))return BigInt(source);
    if(++count>65536)throw new MotanNumberMetadataError('Motan numeric metadata limit');
    let fields=integers.get(this);if(!fields){fields=new Map();integers.set(this,fields);}fields.set(key,value);trees.add(this);
   }else{
    if(!Number.isFinite(value))throw new Error('Non-finite Motan number');
    if(++count>65536)throw new MotanNumberMetadataError('Motan numeric metadata limit');
    let fields=floats.get(this);if(!fields){fields=new Map();floats.set(this,fields);}fields.set(key,value);trees.add(this);
   }
  }else if(object(value)&&trees.has(value))trees.add(this);
  return value;
 });
}
/** Only a token proven to be an integer is promoted. A changed tracked value
 * fails rather than applying stale metadata to a caller mutation. */
export function motanTypedValue(container:Record<string,unknown>,key:string):unknown{
 const value=container[key],fields=integers.get(container);
 if(!fields?.has(key)){const floating=floats.get(container);if(floating?.has(key)&&!Object.is(value,floating.get(key)))throw new Error('Mutated Motan numeric token');return value;}
 if(!Object.is(value,fields.get(key)))throw new Error('Mutated Motan numeric token');
 return BigInt(value as number);
}
function copyTypes(source:Record<string,unknown>,target:Record<string,unknown>,depth:number):void{
 if(depth>64)throw new Error('Motan numeric metadata nesting limit');
 if(!trees.has(source))return;trees.add(target);
 for(const registry of [integers,floats]){const fields=registry.get(source);if(fields)registry.set(target,new Map(fields));}
 for(const key of Object.keys(source)){const child=source[key];if(object(child)&&trees.has(child))copyTypes(child,target[key] as Record<string,unknown>,depth+1);}
}
export function cloneMotanJson<T extends object>(source:T):T{
 const result=structuredClone(source);if(trees.has(source))copyTypes(source as Record<string,unknown>,result as Record<string,unknown>,0);return result;
}
/** Shallow JSON object merge, including deletion of integer marks overwritten
 * by float, text, null, or an untracked value. Nested trees keep their owners. */
export function mergeMotanObjects(first:Readonly<Record<string,unknown>>,second:Readonly<Record<string,unknown>>):Record<string,unknown>{
 const result={...first,...second};
 if(!trees.has(first)&&!trees.has(second))return result;
 trees.add(result);
 for(const registry of [integers,floats]){const fields=new Map(registry.get(first));
  for(const key of Object.keys(second))fields.delete(key);
  for(const [key,value]of registry.get(second)??[])fields.set(key,value);
  if(fields.size)registry.set(result,fields);
 }return result;
}

/** Status roots contain object-valued entries. Copy the old root only; the
 * caller installs merged child objects. Include metadata ancestry of updates
 * even when the previous snapshot contained no integer tokens. */
export function copyMotanStatusRoot(first:Readonly<Record<string,unknown>>,update:Readonly<Record<string,unknown>>):Record<string,unknown>{
 const result={...first};if(trees.has(first)||trees.has(update))trees.add(result);return result;
}

/** Assign into a capture-owned object without copying all retained fields.
 * Never use this on the immutable snapshots maintained by status readers. */
export function assignMotanObject(target:Record<string,unknown>,update:Readonly<Record<string,unknown>>):void{
 for(const [key,value]of Object.entries(update)){
  Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});
  for(const registry of [integers,floats]){
   let fields=registry.get(target);fields?.delete(key);const source=registry.get(update);
   if(source?.has(key)){if(!fields){fields=new Map();registry.set(target,fields);}fields.set(key,source.get(key)!);}
  }
 }
 if(trees.has(update))trees.add(target);
}
/** Serialize the original numeric kind, not its original spelling. Float64
 * shortest round trips remain float tokens even for integral-valued doubles. */
export function motanNumberToken(container:Record<string,unknown>,key:string,value:number):string|undefined{
 const integer=integers.get(container),floating=floats.get(container);
 const fields=integer?.has(key)?integer:floating?.has(key)?floating:undefined;
 if(!fields)return undefined;
 if(!Object.is(value,fields.get(key)))throw new Error('Mutated Motan numeric token');
 if(fields===integer)return String(Object.is(value,-0)?0:value);
 if(Object.is(value,-0))return '-0.0';
 const token=String(value);return Number.isInteger(value)&&!/[eE]/.test(token)?token+'.0':token;
}
