// Moonraker 1cfb0c41 SysDepsParser / static PKGLIST semantics (GPL-3.0-or-later).
// Facts are trusted composition input, never supplied by a release or RPC.
export interface SystemDependencyFacts {id:string;like:readonly string[];version:string;vendor?:string;excluded?:readonly string[];}
const packageName=(v:string)=>/^[a-z0-9][a-z0-9+.-]{1,254}$/u.test(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.length<=4096&&v.isWellFormed()&&!/[\0\r\n]/u.test(v);
function version(value:string):Array<string|bigint>{value=value.trim();return /^\d+(?:\.\d+)*(?:(?:-|\.).+)?/u.test(value)?value.split(/[.-]/u).map(part=>/^\d+$/u.test(part)?BigInt(part):part):[value];}
function compare(a:string|Array<string|bigint>,b:typeof a):number|undefined{
 if(typeof a==='string'&&typeof b==='string')return a<b?-1:a>b?1:0;
 if(!Array.isArray(a)||!Array.isArray(b))return;
 for(let i=0;i<Math.min(a.length,b.length);i++){if(typeof a[i]!==typeof b[i])return;if(a[i]!==b[i])return a[i]!<b[i]!?-1:1;}return a.length<b.length?-1:a.length>b.length?1:0;
}
/** Upstream evaluates and/or left to right, without Python/JS precedence. */
function selected(spec:string,facts:SystemDependencyFacts):string|undefined{
 const [namePart,condition]=spec.split(';',2),name=namePart!.trim();if(!packageName(name))throw Error('Invalid system dependency package name');if(facts.excluded?.includes(name))return;
 if(condition===undefined)return name;const expressions=condition.trim().split(/( and | or )/u);if(expressions.length>127)return;let result=true,logical='and';
 for(let i=0;i<expressions.length;i++){if(i%2){logical=expressions[i]!.trim();continue;}const parts=expressions[i]!.trim().split(/(==|!=|<=|>=|<|>)/u);if(parts.length!==3)return;const field=parts[0]!.trim().toLowerCase(),right=parts[2]!.trim().replace(/^["']+|["']+$/gu,'');let left:string|Array<string|bigint>,operand:typeof left=right;
  if(field==='distro_id')left=facts.id;else if(field==='vendor')left=facts.vendor??'';else if(field==='distro_version'){if(!facts.version)return;left=version(facts.version);operand=version(right);}else return;
  const order=compare(left,operand),operator=parts[1]!;
  // Python tuple equality permits unlike member types; only ordering raises.
  if(order===undefined&&operator!=='=='&&operator!=='!=')return;const ok=({'==':order===0,'!=':order!==0,'<':order!==undefined&&order<0,'>':order!==undefined&&order>0,'<=':order!==undefined&&order<=0,'>=':order!==undefined&&order>=0} as Record<string,boolean>)[operator]!;result=logical==='and'?result&&ok:result||ok;
 }return result?name:undefined;
}
export function parseSystemDependencies(value:unknown,facts:SystemDependencyFacts):string[]{
 if(!text(facts.id)||!text(facts.version)||facts.like.length>32||facts.like.some(v=>!text(v))||facts.vendor!==undefined&&!text(facts.vendor)||facts.excluded!==undefined&&(facts.excluded.length>512||facts.excluded.some(v=>!packageName(v))))throw Error('Invalid trusted system dependency facts');
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>64)throw Error('Invalid system dependency metadata');
 for(const row of Object.values(value)){if(!Array.isArray(row)||row.length>512||row.some(v=>!text(v)))throw Error('System dependency metadata exceeds capacity');}
 if(!facts.id)return [];for(const id of [facts.id,...facts.like]){const specs=(value as Record<string,string[]>)[id];if(!specs?.length)continue;return specs.map(spec=>selected(spec,facts)).filter((name):name is string=>name!==undefined);}return [];
}
/** Read assignments only; substitutions, shell evaluation and scripts never run. */
export function parseStaticPackageList(script:string):string[]{
 if(Buffer.byteLength(script)>65536||!script.isWellFormed()||script.includes('\0'))throw Error('Invalid dependency script metadata');const result:string[]=[];
 for(const line of script.split('\n')){const match=/PKGLIST="([^"\r]*)"/u.exec(line);if(!match)continue;let packages=match[1]!.trim();if(packages.startsWith('${PKGLIST}'))packages=packages.slice(10).trim();for(const name of packages.split(/\s+/u).filter(Boolean)){if(!packageName(name))throw Error('Unsupported dependency script assignment');result.push(name);if(result.length>512)throw Error('Dependency package capacity exceeded');}}
 return result;
}
