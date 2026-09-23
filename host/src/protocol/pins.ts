// Pin aliases and sharing rules derived from klippy/pins.py (GPL-3.0-or-later).
export class PinError extends Error {}
function valid(pin:string){return typeof pin==='string'&&pin.length>0&&pin.length<=128&&!/[\s^~!:]/u.test(pin);}
export class PinResolver {
 #aliases=new Map<string,string>();#reserved=new Map<string,string>();#active=new Map<string,string>();#validate:boolean;
 constructor(validateAliases=true){this.#validate=validateAliases;}
 clone():PinResolver{const result=new PinResolver(this.#validate);result.#aliases=new Map(this.#aliases);result.#reserved=new Map(this.#reserved);result.#active=new Map(this.#active);return result;}
 get reservedPins():readonly string[]{return Object.freeze([...this.#reserved.keys()].map(pin=>this.#aliases.get(pin)??pin));}
 reserve(pin:string,owner:string):void{if(!valid(pin)||!owner||owner.length>256)throw new PinError('Invalid pin reservation');const previous=this.#reserved.get(pin);if(previous!==undefined&&previous!==owner)throw new PinError(`Pin ${pin} reserved for ${previous}`);this.#reserved.set(pin,owner);}
 alias(alias:string,pin:string):void{
  if(!valid(alias)||!valid(pin))throw new PinError('Invalid pin alias');const previous=this.#aliases.get(alias);
  if(previous!==undefined&&previous!==pin)throw new PinError(`Alias ${alias} already mapped to ${previous}`);
  pin=this.#aliases.get(pin)??pin;if(pin===alias)throw new PinError('Cyclic pin alias');
  this.#aliases.set(alias,pin);for(const [name,target] of this.#aliases)if(target===alias)this.#aliases.set(name,pin);
 }
 /** Atomic alias usage validation across config, restart and init commands. */
 resolve(commands:readonly string[]):string[]{
  const active=new Map(this.#active);
  const result=commands.map(command=>command.replace(/([ _]pin=)([^ ]*)/g,(_match,prefix:string,name:string)=>{
   const pin=this.#aliases.get(name)??name;if(!valid(pin))throw new PinError('Invalid command pin');
   const previous=active.get(pin);if(previous!==undefined&&previous!==name&&this.#validate)throw new PinError(`Pin ${name} is an alias for ${previous}`);
   const reservation=this.#reserved.get(pin);if(reservation!==undefined)throw new PinError(`Pin ${name} is reserved for ${reservation}`);
   active.set(pin,name);return prefix+pin;
  }));this.#active=active;return result;
 }
}
export interface PinOptions {canInvert?:boolean;canPullup?:boolean;shareType?:string}
export interface PinRequest {description:string;options?:PinOptions;exclusive?:boolean}
export interface PhysicalPinMap {pins:Readonly<Record<string,number>>;reserved?:readonly number[]}
interface PhysicalPins {fingerprint:string;pins:Map<string,number>;reserved:Set<number>}
export interface PinBinding<T> {readonly chip:T;readonly chipName:string;readonly pin:string;readonly invert:0|1;readonly pullup:-1|0|1;readonly shareType?:string}
/** Registration and ownership only. Actuator-specific setup belongs to the chip. */
export class PrinterPins<T> {
 #chips=new Map<string,T>();#resolvers=new Map<string,PinResolver>();#active=new Map<string,PinBinding<T>>();#multi=new Set<string>();
 #wire=new Map<string,PhysicalPins>();#held=new WeakMap<PinBinding<T>,string>();#exclusive=new WeakSet<PinBinding<T>>();
 register(name:string,chip:T):void{name=name.trim();if(!valid(name)||this.#chips.has(name))throw new PinError('Invalid or duplicate chip name');if([...this.#wire.keys()].some(n=>this.#chips.get(n)===chip))throw new PinError('Mapped physical chip already has a name');this.#chips.set(name,chip);this.#resolvers.set(name,new PinResolver());}
 chip(name:string):T{if(!this.#chips.has(name))throw new PinError(`Unknown chip ${name}`);return this.#chips.get(name)!;}
 resolver(name:string):PinResolver{const resolver=this.#resolvers.get(name);if(!resolver)throw new PinError(`Unknown chip ${name}`);return resolver;}
 get claimedPins():readonly PinBinding<T>[] {return Object.freeze([...this.#active.values()]);}
 parse(description:string,options:PinOptions={}):PinBinding<T>{
  let text=description.trim(),pullup: -1|0|1=0,invert:0|1=0;
  if(options.canPullup&&(text[0]==='^'||text[0]==='~')){pullup=text[0]==='^'?1:-1;text=text.slice(1).trim();}
  if(options.canInvert&&text[0]==='!'){invert=1;text=text.slice(1).trim();}
  const colon=text.indexOf(':'),chipName=colon<0?'mcu':text.slice(0,colon).trim(),pin=colon<0?text:text.slice(colon+1).trim();
  if(!this.#chips.has(chipName))throw new PinError(`Unknown chip ${chipName}`);if(!valid(pin))throw new PinError('Invalid pin description');
  return Object.freeze({chip:this.#chips.get(chipName)!,chipName,pin,invert,pullup,shareType:options.shareType});
 }
 lookup(description:string,options:PinOptions={}):PinBinding<T>{
  const binding=this.parse(description,options),key=`${binding.chipName}:${binding.pin}`,previous=this.#active.get(key);
  if(this.#wire.has(binding.chipName))return this.lookupBatch([{description,options}])[0];
  if(previous){if(this.#exclusive.has(previous))throw new PinError(`Pin ${binding.pin} is exclusively owned`);if(!this.#multi.has(key)){if(options.shareType===undefined||options.shareType!==previous.shareType)throw new PinError(`Pin ${binding.pin} used multiple times`);if(binding.invert!==previous.invert||binding.pullup!==previous.pullup)throw new PinError('Shared pin must have same polarity');}return previous;}
  this.#active.set(key,binding);return binding;
 }
 /** Atomic multi-pin acquisition. Existing owners survive failed validation.
  * Alias resolution uses copies, so no resolver state is published on failure. */
 lookupBatch(requests:readonly PinRequest[],mappings:ReadonlyMap<string,PhysicalPinMap>=new Map()):readonly PinBinding<T>[] {
  if(!requests.length||requests.length>512)throw new PinError('Invalid pin batch size');
  const wire=new Map(this.#wire);
  for(const [name,mapping] of mappings){
   const entries=Object.entries(mapping.pins).sort(([a],[b])=>a<b?-1:a>b?1:0),reserved=[...new Set(mapping.reserved??[])].sort((a,b)=>a-b),validId=(n:number)=>Number.isInteger(n)&&n>=0&&n<=0xffffffff;
   if(!this.#chips.has(name)||!entries.length||entries.length>100000||entries.some(([pin,id])=>!valid(pin)||!validId(id))||reserved.some(id=>!validId(id)))throw new PinError('Invalid physical pin mapping');
   if([...this.#chips].some(([other,chip])=>other!==name&&chip===this.#chips.get(name)))throw new PinError('Physical chip has multiple names');
   const fingerprint=JSON.stringify([entries,reserved]),previous=wire.get(name);if(previous&&previous.fingerprint!==fingerprint)throw new PinError('Physical pin mapping changed');
   wire.set(name,{fingerprint,pins:new Map(entries),reserved:new Set(reserved)});
  }
  const active=new Map(this.#active),physical=new Map<string,PinBinding<T>>(),resolvers=new Map([...this.#resolvers].map(([name,r])=>[name,r.clone()]));
  const identities=new Map<PinBinding<T>,string>(),exclusive=new Set<PinBinding<T>>();
  const key=(p:PinBinding<T>)=>{
   const resolver=resolvers.get(p.chipName)!,pin=resolver.resolve([`claim pin=${p.pin}`])[0].slice(10),mapping=wire.get(p.chipName);
   if(!mapping)return `${p.chipName}:name:${pin}`;
   const id=mapping.pins.get(pin);if(id===undefined)throw new PinError('Unknown physical pin');
   if(mapping.reserved.has(id)||resolver.reservedPins.some(name=>mapping.pins.get(name)===id))throw new PinError('Physical pin is reserved');
   const identity=`${p.chipName}:wire:${id}`,held=this.#held.get(p);if(held!==undefined&&held!==identity)throw new PinError('Pin alias changed after acquisition');identities.set(p,identity);return identity;
  };
  for(const p of active.values()){const k=key(p);if(physical.has(k)&&physical.get(k)!==p)throw new PinError('Existing pin aliases overlap');physical.set(k,p);}
  const result=requests.map(request=>{
   const options=request.options??{},binding=this.parse(request.description,options),raw=`${binding.chipName}:${binding.pin}`,canonical=key(binding),previous=physical.get(canonical);
   if(previous){if(request.exclusive||exclusive.has(previous)||this.#exclusive.has(previous)||!this.#multi.has(raw)){if(request.exclusive||exclusive.has(previous)||this.#exclusive.has(previous)||options.shareType===undefined||options.shareType!==previous.shareType)throw new PinError(`Pin ${binding.pin} used multiple times`);if(binding.invert!==previous.invert||binding.pullup!==previous.pullup)throw new PinError('Shared pin must have same polarity');}return previous;}
   active.set(raw,binding);physical.set(canonical,binding);if(request.exclusive)exclusive.add(binding);return binding;
  });
  this.#active=active;this.#wire=wire;for(const [binding,id] of identities)this.#held.set(binding,id);requests.forEach((request,i)=>{if(request.exclusive)this.#exclusive.add(result[i]);});return Object.freeze(result);
 }
 allowMultiUse(description:string):void{const p=this.parse(description);this.#multi.add(`${p.chipName}:${p.pin}`);}
 resetSharing(binding:PinBinding<T>):void{const key=`${binding.chipName}:${binding.pin}`;if(this.#active.get(key)!==binding)throw new PinError('Unknown pin binding');if(this.#exclusive.has(binding))throw new PinError('Exclusive pin requires a new hardware registry');this.#active.delete(key);}
}
