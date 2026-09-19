// Pin aliases and sharing rules derived from klippy/pins.py (GPL-3.0-or-later).
export class PinError extends Error {}
function valid(pin:string){return typeof pin==='string'&&pin.length>0&&pin.length<=128&&!/[\s^~!:]/u.test(pin);}
export class PinResolver {
 #aliases=new Map<string,string>();#reserved=new Map<string,string>();#active=new Map<string,string>();#validate:boolean;
 constructor(validateAliases=true){this.#validate=validateAliases;}
 clone():PinResolver{const result=new PinResolver(this.#validate);result.#aliases=new Map(this.#aliases);result.#reserved=new Map(this.#reserved);result.#active=new Map(this.#active);return result;}
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
export interface PinBinding<T> {readonly chip:T;readonly chipName:string;readonly pin:string;readonly invert:0|1;readonly pullup:-1|0|1;readonly shareType?:string}
/** Registration and ownership only. Actuator-specific setup belongs to the chip. */
export class PrinterPins<T> {
 #chips=new Map<string,T>();#resolvers=new Map<string,PinResolver>();#active=new Map<string,PinBinding<T>>();#multi=new Set<string>();
 register(name:string,chip:T):void{name=name.trim();if(!valid(name)||this.#chips.has(name))throw new PinError('Invalid or duplicate chip name');this.#chips.set(name,chip);this.#resolvers.set(name,new PinResolver());}
 resolver(name:string):PinResolver{const resolver=this.#resolvers.get(name);if(!resolver)throw new PinError(`Unknown chip ${name}`);return resolver;}
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
  if(previous){if(!this.#multi.has(key)){if(options.shareType===undefined||options.shareType!==previous.shareType)throw new PinError(`Pin ${binding.pin} used multiple times`);if(binding.invert!==previous.invert||binding.pullup!==previous.pullup)throw new PinError('Shared pin must have same polarity');}return previous;}
  this.#active.set(key,binding);return binding;
 }
 allowMultiUse(description:string):void{const p=this.parse(description);this.#multi.add(`${p.chipName}:${p.pin}`);}
 resetSharing(binding:PinBinding<T>):void{const key=`${binding.chipName}:${binding.pin}`;if(this.#active.get(key)!==binding)throw new PinError('Unknown pin binding');this.#active.delete(key);}
}
