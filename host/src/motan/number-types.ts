/** Optional JSON numeric-token provenance. Ordinary values remain Numbers so
 * timing/configuration consumers keep their existing contracts. Metadata lives
 * outside the JSON objects and follows the explicit clone/merge operations. */
export class MotanNumberMetadataError extends Error {}
const integers=new WeakMap<object,Map<string,number>>(),floats=new WeakMap<object,Map<string,number>>(),trees=new WeakSet<object>();
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object';
const orders=new WeakMap<object,readonly string[]>();
type OrderNode=Map<string,OrderNode>|OrderNode[]|null;
/** JSON.parse has already validated syntax. Keep duplicate keys in their first
 * position, but use the last value's shape, as Python json.loads does. */
function readOrders(text:string):OrderNode{
 let pos=0,count=0;
 const space=()=>{while(pos<text.length&&text.charCodeAt(pos)<=32)pos++;};
 const string=()=>{const start=pos++;while(pos<text.length){const c=text[pos++];if(c==='"')break;if(c==='\\')pos++;}return text.slice(start,pos);};
 const read=(depth:number):OrderNode=>{
  if(depth>64)throw new MotanNumberMetadataError('Motan key metadata nesting limit');
  if(++count>65536)throw new MotanNumberMetadataError('Motan key metadata limit');
  space();const c=text[pos];
  if(c==='{'||c==='['){
   const result:Map<string,OrderNode>|OrderNode[]=c==='{'?new Map():[];pos++;space();
   const end=c==='{'?'}':']';
   while(text[pos]!==end){
    if(result instanceof Map){const key=JSON.parse(string()) as string;space();pos++;result.set(key,read(depth+1));}
    else result.push(read(depth+1));
    space();if(text[pos]!==',')break;pos++;space();
   }
   pos++;return result;
  }
  if(c==='"')string();else while(pos<text.length){const code=text.charCodeAt(pos);if(code<=32||code===44||code===93||code===125)break;pos++;}
  return null;
 };
 return read(0);
}
function attachOrders(value:unknown,node:OrderNode):void{
 if(!object(value)||node===null)return;
 if(node instanceof Map){
  const keys=[...node.keys()];
  // Only array-index property names have special ECMAScript enumeration.
  // Named ancestors need clone ancestry, but no serialization proxy.
  if(keys.some(key=>{const n=Number(key);return Number.isInteger(n)&&n>=0&&n<4294967295&&String(n)===key;})){
   orders.set(value,Object.freeze(keys));trees.add(value);
  }
  for(const [key,child]of node){attachOrders(value[key],child);if(object(value[key])&&trees.has(value[key]))trees.add(value);}
 }else for(let i=0;i<node.length;i++){const child=value[String(i)];attachOrders(child,node[i]!);if(object(child)&&trees.has(child))trees.add(value);}
}
export function hasMotanObjectOrder(value:object):boolean{return orders.has(value);}
export function motanObjectKeys(value:object):readonly string[]{
 const keys=orders.get(value);if(!keys)return Object.keys(value);
 if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.prototype.propertyIsEnumerable.call(value,key)))throw new MotanNumberMetadataError('Mutated Motan key order');
 return keys;
}
function mergedOrder(first:object,second:object):readonly string[]|undefined{
 if(!orders.has(first)&&!orders.has(second))return undefined;
 return Object.freeze([...new Set([...motanObjectKeys(first),...motanObjectKeys(second)])]);
}
/** Call before installing the update's fields. The owner must synchronously
 * finish the assignment before exposing the object to readers. */
export function mergeMotanKeyOrder(target:object,update:object):void{
 const keys=mergedOrder(target,update);if(keys){orders.set(target,keys);trees.add(target);}
}
export function parseTypedMotanJson(text:string):unknown{
 let count=0;
 const result:unknown=JSON.parse(text,function(this:Record<string,unknown>,key:string,value:unknown,context?:{source?:string}){
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
 // Ordinary named status fields cannot be reordered by ECMAScript. Escapes
 // may spell an integer key; inspect those too. Values can cause false hits.
 if(/"(?:[0-9]|\\)/.test(text))attachOrders(result,readOrders(text));
 return result;
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
 if(orders.has(source))orders.set(target,Object.freeze([...motanObjectKeys(source)]));
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
 const keys=mergedOrder(first,second);if(keys)orders.set(result,keys);
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
 const result={...first};const keys=mergedOrder(first,update);if(keys)orders.set(result,keys);if(trees.has(first)||trees.has(update))trees.add(result);return result;
}

/** Assign into a capture-owned object without copying all retained fields.
 * Never use this on the immutable snapshots maintained by status readers. */
export function assignMotanObject(target:Record<string,unknown>,update:Readonly<Record<string,unknown>>):void{
 mergeMotanKeyOrder(target,update);
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
