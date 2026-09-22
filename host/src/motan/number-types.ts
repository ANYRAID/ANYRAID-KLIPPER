/** Optional JSON integer-token provenance. Ordinary values remain Numbers so
 * timing/configuration consumers keep their existing contracts. Metadata lives
 * outside the JSON objects and follows the explicit clone/merge operations. */
const integers=new WeakMap<object,Map<string,number>>(),trees=new WeakSet<object>();
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object';
export function parseTypedMotanJson(text:string):unknown{
 let count=0;
 return JSON.parse(text,function(this:Record<string,unknown>,key:string,value:unknown,context?:{source?:string}){
  if(typeof value==='number'){
   const source=context?.source;
   if(source&&/^-?\d+$/.test(source)){
    if(source.length-(source[0]==='-'?1:0)>4300)throw new Error('Motan integer digit limit');
    if(!Number.isSafeInteger(value))return BigInt(source);
    if(++count>65536)throw new Error('Motan integer metadata limit');
    let fields=integers.get(this);if(!fields){fields=new Map();integers.set(this,fields);}fields.set(key,value);trees.add(this);
   }else if(!Number.isFinite(value))throw new Error('Non-finite Motan number');
  }else if(object(value)&&trees.has(value))trees.add(this);
  return value;
 });
}
/** Only a token proven to be an integer is promoted. A changed tracked value
 * fails rather than applying stale metadata to a caller mutation. */
export function motanTypedValue(container:Record<string,unknown>,key:string):unknown{
 const value=container[key],fields=integers.get(container);
 if(!fields?.has(key))return value;
 if(!Object.is(value,fields.get(key)))throw new Error('Mutated Motan numeric token');
 return BigInt(value as number);
}
function copyTypes(source:Record<string,unknown>,target:Record<string,unknown>,depth:number):void{
 if(depth>64)throw new Error('Motan numeric metadata nesting limit');
 if(!trees.has(source))return;trees.add(target);
 const fields=integers.get(source);if(fields)integers.set(target,new Map(fields));
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
 trees.add(result);const fields=new Map(integers.get(first));
 for(const key of Object.keys(second))fields.delete(key);
 for(const [key,value]of integers.get(second)??[])fields.set(key,value);
 if(fields.size)integers.set(result,fields);return result;
}

/** Status roots contain object-valued entries. Copy the old root only; the
 * caller installs merged child objects. Include metadata ancestry of updates
 * even when the previous snapshot contained no integer tokens. */
export function copyMotanStatusRoot(first:Readonly<Record<string,unknown>>,update:Readonly<Record<string,unknown>>):Record<string,unknown>{
 const result={...first};if(trees.has(first)||trees.has(update))trees.add(result);return result;
}
