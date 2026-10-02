// Klipper Stats diagnostics, GPL-3.0-or-later.
// Based on scripts/graphstats.py, Copyright (C) 2016-2025 Kevin O'Connor.
export interface StatsSample {time:number;values:Readonly<Record<string,string>>;}
export interface StatsCurve {label:string;axis:0|1;style:'line'|'points';times:number[];values:number[];}
export interface StatsPlot {title:string;axes:readonly string[];curves:StatsCurve[];}
const prefixed=new Set(['mcu_awake','mcu_task_avg','mcu_task_stddev','bytes_write','bytes_read','bytes_retransmit','freq','adj','target','temp','pwm']);
const whitespace=/[\t-\r\x1c-\x20\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
function number(value:string|undefined):number{if(value===undefined)throw new Error('Missing statistics field');const normalized=value.replace(/(?<=\d)_(?=\d)/g,'');if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized))throw new Error('Invalid statistics number');const result=Number(normalized);if(!Number.isFinite(result))throw new Error('Nonfinite statistics number');return result;}
function field(sample:StatsSample,key:string,fallback?:string):number{return number(sample.values[key]??fallback);}
export class StatsLogParser {
 #samples:StatsSample[]=[];#mcu:string;#limit:number;#bytes=0;#maxBytes:number;
 constructor(mcu='mcu',maxSamples=1000000,maxBytes=64*1024**2){if(typeof mcu!=='string'||!Number.isSafeInteger(maxSamples)||maxSamples<1||maxSamples>1000000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>512*1024**2)throw new RangeError('Invalid statistics parser options');this.#mcu=mcu+':';this.#limit=maxSamples;this.#maxBytes=maxBytes;}
 line(line:string):void{
  if(line.length>1024**2)throw new RangeError('Statistics line limit exceeded');const parts=line.split(whitespace).filter(Boolean);if(!['Stats','INFO:root:Stats'].includes(parts[0]))return;
  let prefix='';const values:Record<string,string>=Object.create(null);for(const part of parts.slice(2)){const at=part.indexOf('=');if(at<0){prefix=part===this.#mcu?'':part;continue;}const key=part.slice(0,at);values[prefixed.has(key)?prefix+key:key]=part.slice(at+1);}
  if(!Object.hasOwn(values,'print_time'))return;const bytes=Buffer.byteLength(line);if(this.#bytes+bytes>this.#maxBytes)throw new RangeError('Statistics input byte limit exceeded');if(this.#samples.length>=this.#limit)throw new RangeError('Statistics sample limit exceeded');if(parts[1]===undefined)throw new Error('Missing statistics time');const time=number(parts[1].slice(0,-1));delete values['#sampletime'];this.#samples.push(Object.freeze({time,values:Object.freeze(values)}));this.#bytes+=bytes;
 }
 samples():readonly StatsSample[]{return Object.freeze([...this.#samples]);}
}
export function parseStats(text:string,mcu='mcu'):readonly StatsSample[]{const parser=new StatsLogParser(mcu);for(const line of text.split(/\r\n|\r|\n/))parser.line(line);return parser.samples();}
export function findPrintRestarts(data:readonly StatsSample[]):Set<number>{
 const runoff=new Map<number,{stall:boolean;samples:number[]}>();let start=0,lastBuffer=0,lastTime=0,lastStall=0n;
 for(let i=data.length-1;i>=0;i--){const d=data[i],buffer=field(d,'buffer_time','0');if(start&&lastTime-d.time<5&&buffer>lastBuffer)runoff.get(start)!.samples.push(d.time);else if(buffer<1){start=d.time;runoff.set(start,{stall:false,samples:[d.time]});}else start=0;lastBuffer=buffer;lastTime=d.time;const raw=d.values.print_stall?.replace(/(?<=\d)_(?=\d)/g,'');if(raw===undefined||!/^[-+]?\d+$/.test(raw))throw new Error('Invalid print stall integer');const stall=BigInt(raw);if(stall<lastStall&&start)runoff.get(start)!.stall=true;lastStall=stall;}
 return new Set([...runoff.values()].flatMap(value=>value.stall?[]:value.samples));
}
const curve=(label:string,axis:0|1=0,style:'line'|'points'='line'):StatsCurve=>({label,axis,style,times:[],values:[]});
function push(c:StatsCurve,time:number,value:number){if(!Number.isFinite(time)||time< -62135596800||time>=253402300800)throw new RangeError('Statistics time outside datetime range');if(!Number.isFinite(value))throw new RangeError('Nonfinite statistics curve');c.times.push(time);c.values.push(value);}
function requireData(data:readonly StatsSample[]){if(!data.length)throw new Error('No statistics samples');}
export function mcuStatsPlot(data:readonly StatsSample[],maxBandwidth=25000):StatsPlot{
 requireData(data);if(!Number.isFinite(maxBandwidth)||maxBandwidth<=0)throw new RangeError('Invalid maximum bandwidth');const base=data[0].time,resets=findPrintRestarts(data);let last=base,bandwidth=field(data[0],'bytes_write')+field(data[0],'bytes_retransmit');const curves=['Bandwidth','MCU load','Host buffer','Awake time'].map(name=>curve(name));
 for(const d of data){const dt=d.time-last;if(dt<=0)continue;const next=field(d,'bytes_write')+field(d,'bytes_retransmit');if(next<bandwidth){bandwidth=next;continue;}let load=field(d,'mcu_task_avg')+3*field(d,'mcu_task_stddev');if(d.time-base<15)load=0;field(d,'print_time');const buffer=field(d,'buffer_time');push(curves[0],d.time,100*(next-bandwidth)/(maxBandwidth*dt));push(curves[1],d.time,100*load/.0025);push(curves[2],d.time,buffer>=1||resets.has(d.time)?0:100*(1-buffer));push(curves[3],d.time,100*field(d,'mcu_awake','0')/5);last=d.time;bandwidth=next;}
 return {title:'MCU bandwidth and load utilization',axes:['Usage (%)'],curves};
}
export function systemStatsPlot(data:readonly StatsSample[]):StatsPlot{
 requireData(data);let last=data[0].time,cpu=field(data[0],'cputime');const curves=[curve('system load'),curve('process time'),curve('system memory',1)];for(const d of data){const dt=d.time-last;if(dt<=0)continue;last=d.time;const next=field(d,'cputime');push(curves[0],d.time,field(d,'sysload')*100);push(curves[1],d.time,Math.max(0,Math.min(1.5,(next-cpu)/dt))*100);push(curves[2],d.time,field(d,'memavail'));cpu=next;}
 return {title:'System load utilization',axes:['Load (% of a core)','Available memory (KB)'],curves};
}
function sum(values:readonly number[]):number{let hi=0,lo=0;for(const value of values){const next=hi+value;lo+=Math.abs(hi)>=Math.abs(value)?(hi-next)+value:(value-next)+hi;hi=next;}return hi+lo;}
function roundEven(value:number):number{const low=Math.floor(value),fraction=value-low;return fraction<.5?low:fraction>.5?low+1:low%2===0?low:low+1;}
export function frequencyStatsPlot(data:readonly StatsSample[],mcu?:string):StatsPlot{
 const keys=new Set<string>();for(const d of data)for(const key of Object.keys(d.values))if(key==='freq'||key==='adj'||mcu===undefined&&(key.endsWith(':freq')||key.endsWith(':adj')))keys.add(key);
 const curves:StatsCurve[]=[];for(const key of [...keys].sort((a,b)=>{const x=Array.from(a),y=Array.from(b);for(let i=0;i<Math.min(x.length,y.length);i++){const delta=x[i].codePointAt(0)!-y[i].codePointAt(0)!;if(delta)return delta;}return x.length-y.length;})){const c=curve(key,0,'points');for(const d of data){const value=d.values[key];if(value!==undefined&&value!=='0'&&value!=='1')push(c,d.time,number(value));}if(mcu===undefined){if(!c.values.length)throw new RangeError('No frequency values');const mhz=roundEven((sum(c.values)/c.values.length)/1000000);if(!Number.isFinite(mhz)||mhz===0)throw new RangeError('Invalid estimated MCU frequency');c.label=`${key}(${mhz}Mhz)`;c.values=c.values.map(value=>(value-mhz*1000000)/mhz);if(c.values.some(value=>!Number.isFinite(value)))throw new RangeError('Nonfinite MCU frequency deviation');}curves.push(c);}
 return {title:mcu===undefined?'MCU frequencies':`MCU '${mcu}' frequency`,axes:[mcu===undefined?'Microsecond deviation':'Frequency'],curves};
}
export function temperatureStatsPlot(data:readonly StatsSample[],heaters:string):StatsPlot{
 const curves:StatsCurve[]=[];for(const name of heaters.split(',')){const heater=name.replace(/^[\t-\r\x1c-\x20\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,''),temp=curve(heater+' temp'),target=curve(heater+' target'),pwm=curve(heater+' pwm',1);for(const d of data){if(d.values[heater+':temp']===undefined)continue;push(temp,d.time,field(d,heater+':temp'));push(target,d.time,field(d,heater+':target','0'));push(pwm,d.time,field(d,heater+':pwm','0'));}curves.push(temp);if(target.values.some(Boolean))curves.push(target);if(pwm.values.some(Boolean))curves.push(pwm);}
 return {title:'Temperature of '+heaters,axes:['Temperature','pwm'],curves};
}
