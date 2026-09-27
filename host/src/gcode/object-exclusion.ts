// GPL-3.0-or-later. Motion semantics from klippy/extras/exclude_object.py.
// Copyright (C) 2019 Eric Callahan; (C) 2021 Troy Jacobson.
import type {MovePort} from './move.ts';
export interface ExclusionAdmission {admitted:boolean;extrusionDelta:number;}
interface State {last:number[];printed:number[];excluded:number[];offset:number[];maxPrinted:number;maxExcluded:number;adjust:number;warmup:number;inside:boolean;}
function position(value:readonly number[]):number[]{if(value.length!==4||!value.every(Number.isFinite))throw new RangeError('Object exclusion requires finite XYZE coordinates');return [...value];}
function compareNames(a:string,b:string):number{let i=0,j=0;while(i<a.length&&j<b.length){const x=a.codePointAt(i)!,y=b.codePointAt(j)!;if(x!==y)return x-y;i+=x>65535?2:1;j+=y>65535?2:1;}return a.length-i-(b.length-j);}
function name(value:string):string{if(typeof value!=='string'||!value||value.length>256||/[\x00-\x1f\x7f]/u.test(value))throw new RangeError('Invalid object name');return value;}
/** Single-extruder motion transform. The owner supplies canonical object names,
 * installs this before bed compensation and resets it at each file boundary.
 * Already admitted motion is retained; exclusion applies to future admissions.
 * Receipts report accepted physical E deltas for downstream print accounting. */
export class ObjectExclusionTransform {
 readonly #port:MovePort;#state:State|undefined;#physical:number[];#current:string|null=null;#excluded=new Set<string>();
 constructor(port:MovePort){this.#port=port;this.#physical=position(port.position());}
 get active(){return this.#state!==undefined;}
 get status(){return {current_object:this.#current,excluded_objects:[...this.#excluded].sort(compareNames),active:this.active};}
 /** Diagnostic state is copied: callers cannot change transformation history. */
 get state(){const s=this.#state;return s?{...s,last:[...s.last],printed:[...s.printed],excluded:[...s.excluded],offset:[...s.offset]}:null;}
 start(object:string):void{this.#current=name(object);}
 end():void{this.#current=null;}
 exclude(object:string):void{
  name(object);if(!this.#excluded.has(object)&&this.#excluded.size>=1024)throw new RangeError('Excluded object capacity exceeded');
  if(!this.#state){const initial=position(this.#port.position());this.#physical=[...initial];this.#state={last:[...initial],printed:[...initial],excluded:[...initial],offset:[0,0,0,0],maxPrinted:0,maxExcluded:0,adjust:0,warmup:5,inside:false};}
  this.#excluded.add(object);
 }
 unexclude(object?:string):void{if(object===undefined)this.#excluded.clear();else this.#excluded.delete(name(object));}
 reset():void{const next=position(this.#port.position());this.#state=undefined;this.#physical=next;this.#current=null;this.#excluded.clear();}
 position():number[]{
  const physical=position(this.#port.position()),s=this.#state,next=s?physical.map((v,i)=>v+s.offset[i]):physical;
  if(!next.every(Number.isFinite))throw new RangeError('Excluded position overflow');this.#physical=physical;if(s)s.last=[...next];return next;
 }
 move(target:readonly number[],speed:number):ExclusionAdmission{
  const next=position(target);if(!Number.isFinite(speed)||speed<=0)throw new RangeError('Invalid excluded motion speed');
  const previous=this.#state;
  if(!previous){this.#port.move(next,speed);const extrusionDelta=next[3]-this.#physical[3];this.#physical=next;return {admitted:true,extrusionDelta};}
  // Transactional admission: a rejected downstream move must not consume the
  // warmup or correction that a retry still needs. Preserve binary64 order.
  const s={...previous,last:[...previous.last],printed:[...previous.printed],excluded:[...previous.excluded],offset:[...previous.offset]};
  const ignore=this.#current!==null&&this.#excluded.has(this.#current)&&s.warmup===0;
  if(ignore){
   for(let i=0;i<4;i++)if(i!==3)s.offset[i]=next[i]-s.printed[i];
   s.offset[3]=s.offset[3]+next[3]-s.last[3];s.last=next;s.excluded=[...next];s.maxExcluded=Math.max(s.maxExcluded,next[3]);s.inside=true;
   if(!s.offset.every(Number.isFinite))throw new RangeError('Excluded offset overflow');this.#state=s;return {admitted:false,extrusionDelta:0};
  }
  if(s.inside){s.adjust=s.maxExcluded-s.excluded[3]-(s.maxPrinted-s.printed[3]);s.inside=false;}
  if(s.warmup>0&&s.last[3]!==next[3])s.warmup--;
  s.last=next;s.printed=[...next];s.maxPrinted=Math.max(s.maxPrinted,next[3]);
  if((s.offset[0]!==0||s.offset[1]!==0)&&(next[0]!==s.excluded[0]||next[1]!==s.excluded[1])){
   for(let i=0;i<4;i++)if(i!==3)s.offset[i]=0;s.offset[3]+=s.adjust;s.adjust=0;
  }
  if(s.offset[2]!==0&&next[2]!==s.excluded[2])s.offset[2]=0;
  if(s.adjust!==0&&next[3]!==s.excluded[3]){s.offset[3]+=s.adjust;s.adjust=0;}
  const physical=next.map((v,i)=>v-s.offset[i]);
  if(![...physical,...s.offset,s.adjust].every(Number.isFinite))throw new RangeError('Excluded motion overflow');
  this.#port.move(physical,speed);const extrusionDelta=physical[3]-this.#physical[3];this.#physical=physical;this.#state=s;return {admitted:true,extrusionDelta};
 }
}
