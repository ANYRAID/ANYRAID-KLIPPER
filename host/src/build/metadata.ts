// Compile-time metadata generators from scripts/buildcommands.py; GPL-3.0-or-later.
// Original Copyright (C) 2016-2024 Kevin O'Connor.
type EnumValue=number|[number,number];
function integer(text:string):number {
 if(!/^[+-]?(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|0+|[1-9]\d*)$/.test(text))throw new Error('Invalid build integer');
 const sign=text.startsWith('-')?-1:1,value=Number(BigInt(text.replace(/^[+-]/,'')))*sign;
 if(!Number.isSafeInteger(value))throw new Error('Build integer exceeds exact range');return value;
}
function unquote(value:string):string {value=value.trim();return value.startsWith('"')&&value.endsWith('"')?value.slice(1,-1):value;}
export class BuildMetadata {
 #calls=new Map<string,string[]>([['ctr_run_initfuncs',[]]]);#strings:string[]=[];
 #enums=new Map<string,Map<string,EnumValue>>();#constants=new Map<string,string|number>();#pins:string[]=[];#irqs=new Map<number,string>();
 #constant(name:string,value:string|number):void {if(this.#constants.has(name)&&this.#constants.get(name)!==value)throw new Error('Conflicting constant '+name);this.#constants.set(name,value);}
 #enumeration(group:string,name:string,value:EnumValue):void {
  let enums=this.#enums.get(group);if(!enums)this.#enums.set(group,enums=new Map());
  if(enums.has(name)&&JSON.stringify(enums.get(name))!==JSON.stringify(value))throw new Error('Conflicting enumeration '+group+' '+name);enums.set(name,value);
 }
 /** False means the request belongs to another buildcommands handler. */
 accept(line:string):boolean {
  line=line.trimStart();if(!line)return true;const match=/^(\S+)\s*([\s\S]*)$/.exec(line)!,command=match[1],rest=match[2],args=rest.trim().split(/\s+/);
  const count=(n:number)=>{if(args.length!==n||!rest.trim())throw new Error('Malformed '+command);};
  switch(command) {
   case '_DECL_CALLLIST':{count(2);const list=this.#calls.get(args[0])??[];list.push(args[1]);this.#calls.set(args[0],list);break;}
   case '_DECL_STATIC_STR':if(!rest)throw new Error('Empty static string');else if(!this.#strings.includes(rest)){if(this.#strings.length>=253)throw new Error('Static string ID exhausted');this.#strings.push(rest);}break;
   case 'DECL_ENUMERATION':count(3);this.#enumeration(args[0],args[1],integer(args[2]));break;
   case 'DECL_ENUMERATION_RANGE':{count(4);const start=integer(args[2]),n=integer(args[3]);if(n<0||n>65536||!Number.isSafeInteger(start+n))throw new Error('Invalid enumeration range');this.#enumeration(args[0],args[1],[start,n]);break;}
   case 'DECL_CONSTANT':count(2);this.#constant(args[0],integer(args[1]));break;
   case 'DECL_CONSTANT_STR':{const m=/^(\S+)\s+([\s\S]*)$/.exec(rest);if(!m)throw new Error('Malformed string constant');this.#constant(m[1],unquote(m[2]));break;}
   case 'DECL_INITIAL_PINS':{const pins=unquote(rest);if(pins){this.#pins=pins.split(',').map(p=>p.trim());this.#constant('INITIAL_PINS',this.#pins.join(','));}break;}
   case 'DECL_ARMCM_IRQ':{count(2);const num=integer(args[1]);if(num>4095)throw new Error('IRQ table too large');if(this.#irqs.has(num)&&this.#irqs.get(num)!==args[0])throw new Error('Conflicting IRQ '+num);this.#irqs.set(num,args[0]);break;}
   default:return false;
  }
  return true;
 }
 dictionary():{enumerations:Record<string,Record<string,EnumValue>>;config:Record<string,string|number>} {
  this.#strings.forEach((s,i)=>this.#enumeration('static_string_id',s,i+2));
  return {enumerations:Object.fromEntries([...this.#enums].map(([name,entries])=>[name,Object.fromEntries([...entries].map(([k,v])=>[k,Array.isArray(v)?[...v]:v]))])),config:Object.fromEntries(this.#constants)};
 }
 generate():string {
  let code='';
  for(const [name,funcs] of this.#calls) {
   let lines=funcs.map(f=>`    extern void ${f}(void);\n    ${f}();`);
   if(name==='ctr_run_taskfuncs'){lines=lines.map(line=>'    irq_poll();\n'+line);lines.push('    irq_poll();\n');}
   code+=`\nvoid\n${name}(void)\n{\n    ${lines.join('\n').trim()}\n}\n`;
  }
  const strings=this.#strings.map((s,i)=>`    if (__builtin_strcmp(str, "${s}") == 0)\n        return ${i+2};\n`).join('').trim();
  code+=`\nuint8_t __always_inline\nctr_lookup_static_string(const char *str)\n{\n    ${strings}\n    return 0xff;\n}\n`;
  const pinmap=new Map<string,number>();
  for(const [name,value] of this.#enums.get('pin')??[]) {
   if(typeof value==='number'){pinmap.set(name,value);continue;}
   const m=/^(.*?)(\d*)$/.exec(name)!,start=m[2]?Number(m[2]):0;
   for(let i=0;i<value[1];i++)pinmap.set(m[1]+(start+i),value[0]+i);
  }
  const pins=this.#pins.map(pin=>{const low=pin.startsWith('!'),name=low?pin.slice(1).trim():pin;if(!pinmap.has(name))throw new Error('Unknown initial pin '+name);return `\n    {${pinmap.get(name)}, ${low?'0':'IP_OUT_HIGH'}}, // ${name}`;}).join('');
  code+=`\nconst struct initial_pin_s initial_pins[] PROGMEM = {${pins}\n};\nconst int initial_pins_size PROGMEM = ARRAY_SIZE(initial_pins);\n`;
  if(this.#irqs.has(-15)) {
   const table=Array(Math.max(...this.#irqs.keys())+17).fill('    DefaultHandler,\n');let defs='';
   for(const [num,func] of this.#irqs){if(num< -15)throw new Error('Invalid IRQ '+num);defs+=`extern void ${func}(void);\n`;table[num+16]=`    ${func},\n`;}
   table[0]='    &_stack_end,\n';code+=`\nextern void DefaultHandler(void);\nextern uint32_t _stack_end;\n${defs}\nconst void *VectorTable[] __visible __section(".vector_table") = {\n${table.join('')}};\n`;
  }
  return code;
 }
}
