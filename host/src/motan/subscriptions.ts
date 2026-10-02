// GPL-3.0-or-later. Subscription map from Klipper motan/data_logger.py.
export interface MotanSubscription {name:string;method:string;params:Record<string,string>;}
/** Python fnmatchcase syntax, with bounded greedy matching instead of a
 * backtracking regexp for the whole pattern. Character classes consume one code point. */
export function motanPattern(pattern:string):(name:string)=>boolean{
 if(typeof pattern!=='string'||pattern.length>256)throw new Error('Motan pattern too long');
 const p=Array.from(pattern),tokens:('*'|((c:string)=>boolean))[]=[];
 for(let i=0;i<p.length;){const c=p[i++];if(c==='*'){if(tokens.at(-1)!=='*')tokens.push('*');}else if(c==='?')tokens.push(()=>true);else if(c==='['){let j=i;if(p[j]==='!')j++;if(p[j]===']')j++;while(j<p.length&&p[j]!==']')j++;
  if(j===p.length){tokens.push(v=>v==='[');continue;}
  let chunks:string[][]=[];const initial=p.slice(i,j);
  if(!initial.includes('-'))chunks=[initial];else{let k=i+(p[i]==='!'?2:1);for(;;){while(k<j&&p[k]!=='-')k++;if(k>=j)break;chunks.push(p.slice(i,k));i=k+1;k+=3;}const rest=p.slice(i,j);if(rest.length)chunks.push(rest);else chunks.at(-1)!.push('-');for(let k=chunks.length-1;k>0;k--)if(chunks[k-1].at(-1)!.codePointAt(0)!>chunks[k][0].codePointAt(0)!){chunks[k-1]=chunks[k-1].slice(0,-1).concat(chunks[k].slice(1));chunks.splice(k,1);}}
  i=j+1;const negative=chunks[0]?.[0]==='!';if(negative)chunks[0].shift();const hasContent=chunks.some(v=>v.length);if(!hasContent){tokens.push(()=>negative);continue;}
  const body=chunks.map(v=>v.map(ch=>`\\u{${ch.codePointAt(0)!.toString(16)}}`).join('')).join('-'),regex=new RegExp(`^[${negative?'^':''}${body}]$`,'u');tokens.push(v=>regex.test(v));
 }else tokens.push(v=>v===c);}
 return name=>{if(name.length>1024)throw new Error('Motan subscription name too long');const chars=Array.from(name);let i=0,j=0,star=-1,retry=0;while(i<chars.length){const token=tokens[j];if(token==='*'){star=j++;retry=i;}else if(token&&token(chars[i])){i++;j++;}else if(star>=0){j=star+1;i=++retry;}else return false;}while(tokens[j]==='*')j++;return j===tokens.length;};
}
export function motanSubscriptions(status:Record<string,unknown>,patterns:readonly string[]):{available:string[];selected:MotanSubscription[]}{
 if(patterns.length>64)throw new Error('Too many Motan patterns');const available:MotanSubscription[]=[];
 const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid Motan subscription status');return v as Record<string,unknown>;};
 const motion=status.motion_report===undefined?{}:object(status.motion_report);
 for(const [key,prefix,method] of [['trapq','trapq','dump_trapq'],['steppers','stepq','dump_stepper']]){const names=motion[key]??[];if(!Array.isArray(names)||names.length>4096)throw new Error('Invalid motion subscription list');for(const name of names){if(typeof name!=='string'||name.length>1024)throw new Error('Invalid motion subscription name');available.push({name:prefix+':'+name,method:'motion_report/'+method,params:{name}});}}
 const config=object(object(status.configfile).settings),accelerometers=new Set(['adxl345','lis2dw','mpu9250','bmi160','icm20948']),drivers=new Set(['tmc2130','tmc2209','tmc2260','tmc2240','tmc5160']);
 if(Object.keys(config).length>4096)throw new Error('Too many configured objects');
 for(const name of Object.keys(config)){if(name.length>1024)throw new Error('Configuration name too long');const parts=name.split(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u).filter(Boolean),type=parts[0],sensor=parts.length>1?parts.slice(1).join(' '):type;
  if(accelerometers.has(type)||type==='lis3dh')available.push({name:'accelerometer:'+sensor,method:type==='lis3dh'?'lis2dw/dump_lis2dw':`${type}/dump_${type}`,params:{sensor}});
  else if(type==='angle')available.push({name:'angle:'+sensor,method:'angle/dump_angle',params:{sensor}});
  else if(type==='probe_eddy_current')available.push({name:'ldc1612:'+sensor,method:'ldc1612/dump_ldc1612',params:{sensor}});
  else if(type==='load_cell'||type==='load_cell_probe')available.push({name:'loadcell:'+sensor,method:'load_cell/dump_force',params:{load_cell:sensor}});
  else if(drivers.has(type))available.push({name:'stallguard:'+sensor,method:'tmc/stallguard_dump',params:{name:sensor}});
 }
 if(available.length>4096)throw new Error('Too many Motan subscriptions');const matches=patterns.map(motanPattern),byName=new Map(available.map(v=>[v.name,v]));const compare=(a:string,b:string)=>{const x=Array.from(a),y=Array.from(b);for(let i=0;i<Math.min(x.length,y.length);i++){const difference=x[i].codePointAt(0)!-y[i].codePointAt(0)!;if(difference)return difference;}return x.length-y.length;};
 return {available:available.map(v=>v.name).sort(compare),selected:[...byName.keys()].filter(name=>matches.some(m=>m(name))).sort(compare).map(name=>byName.get(name)!)};
}
