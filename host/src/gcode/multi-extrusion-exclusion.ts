// GPL-3.0-or-later. Motion semantics from klippy/extras/exclude_object.py.
// Copyright (C) 2019 Eric Callahan; (C) 2021 Troy Jacobson.
import type {MovePort} from './move.ts';
export interface ExclusionAdmission {admitted:boolean;extrusionDelta:number;}
interface State {last:number[];printed:number[];excluded:number[];offset:number[];maxPrinted:number[];maxExcluded:number[];adjust:number[];warmup:number;inside:boolean;}
function position(value:readonly number[]):number[]{if(value.length<4||value.length>16||!value.every(Number.isFinite))throw new RangeError('Object exclusion requires finite XYZE coordinates');return [...value];}
function compareNames(a:string,b:string):number{let i=0,j=0;while(i<a.length&&j<b.length){const x=a.codePointAt(i)!,y=b.codePointAt(j)!;if(x!==y)return x-y;i+=x>65535?2:1;j+=y>65535?2:1;}return a.length-i-(b.length-j);}
function name(value:string):string{if(typeof value!=='string'||!value||value.length>256||/[\x00-\x1f\x7f]/u.test(value))throw new RangeError('Invalid object name');return value;}
/** Multi-extruder physical-axis transform. The owner supplies canonical object names,
 * installs this before bed compensation and resets it at each file boundary.
 * Already admitted motion is retained; exclusion applies to future admissions.
 * Receipts report accepted physical E deltas for downstream print accounting. */
export class MultiExtrusionObjectExclusion {
 readonly #port:MovePort;#state:State|undefined;#physical:number[];#current:string|null=null;#excluded=new Set<string>();
 constructor(port:MovePort){this.#port=port;this.#physical=position(port.position());}
 get active(){return this.#state!==undefined;}
 get status(){return {current_object:this.#current,excluded_objects:[...this.#excluded].sort(compareNames),active:this.active};}
 /** Diagnostic state is copied: callers cannot change transformation history. */
 get state(){const s=this.#state;return s?{...s,last:[...s.last],printed:[...s.printed],excluded:[...s.excluded],offset:[...s.offset],maxPrinted:[...s.maxPrinted],maxExcluded:[...s.maxExcluded],adjust:[...s.adjust]}:null;}
 start(object:string):void{this.#current=name(object);}
 end():void{this.#current=null;}
 exclude(object:string):void{
  name(object);if(!this.#excluded.has(object)&&this.#excluded.size>=1024)throw new RangeError('Excluded object capacity exceeded');
  if(!this.#state){const initial=position(this.#port.position());this.#physical=[...initial];this.#state={last:[...initial],printed:[...initial],excluded:[...initial],offset:initial.map(()=>0),maxPrinted:initial.slice(3),maxExcluded:initial.slice(3),adjust:initial.slice(3).map(()=>0),warmup:5,inside:false};}
  this.#excluded.add(object);
 }
 unexclude(object?:string):void{if(object===undefined)this.#excluded.clear();else this.#excluded.delete(name(object));}
 reset():void{const next=position(this.#port.position());this.#state=undefined;this.#physical=next;this.#current=null;this.#excluded.clear();}
 position():number[]{
  const physical=position(this.#port.position()),s=this.#state,next=s?physical.map((v,i)=>v+s.offset[i]):physical;
  if(!next.every(Number.isFinite))throw new RangeError('Excluded position overflow');this.#physical=physical;if(s)s.last=[...next];return next;
 }
 move(target:readonly number[],speed:number,axis=3):ExclusionAdmission{
  const next=position(target);if(next.length!==this.#physical.length)throw new RangeError('Object coordinate shape differs');if(!Number.isFinite(speed)||speed<=0)throw new RangeError('Invalid excluded motion speed');
  if(!Number.isInteger(axis)||axis<3||axis>=next.length)throw new RangeError('Invalid active exclusion axis');
  const previous=this.#state;
  if(next.some((v,i)=>i>=3&&i!==axis&&v!==(previous?.last[i]??this.#physical[i])))throw new Error('Inactive extrusion coordinate changed');
  if(!previous){this.#port.move(next,speed);const extrusionDelta=next[axis]-this.#physical[axis];this.#physical=next;return {admitted:true,extrusionDelta};}
  // Transactional admission: a rejected downstream move must not consume the
  // warmup or correction that a retry still needs. Preserve binary64 order.
  const s={...previous,last:[...previous.last],printed:[...previous.printed],excluded:[...previous.excluded],offset:[...previous.offset],maxPrinted:[...previous.maxPrinted],maxExcluded:[...previous.maxExcluded],adjust:[...previous.adjust]};
  const ignore=this.#current!==null&&this.#excluded.has(this.#current)&&s.warmup===0;
  if(ignore){
   for(let i=0;i<3;i++)s.offset[i]=next[i]-s.printed[i];
   for(let i=3;i<next.length;i++){s.offset[i]=s.offset[i]+next[i]-s.last[i];s.maxExcluded[i-3]=Math.max(s.maxExcluded[i-3],next[i]);}s.last=next;s.excluded=[...next];s.inside=true;
   if(!s.offset.every(Number.isFinite))throw new RangeError('Excluded offset overflow');this.#state=s;return {admitted:false,extrusionDelta:0};
  }
  if(s.inside){s.adjust=s.maxExcluded.map((v,i)=>v-s.excluded[i+3]-(s.maxPrinted[i]-s.printed[i+3]));s.inside=false;}
  if(s.warmup>0&&next.slice(3).some((v,i)=>v!==s.last[i+3]))s.warmup--;
  s.last=next;for(let i=0;i<3;i++)s.printed[i]=next[i];s.printed[axis]=next[axis];s.maxPrinted[axis-3]=Math.max(s.maxPrinted[axis-3],next[axis]);
  if((s.offset[0]!==0||s.offset[1]!==0)&&(next[0]!==s.excluded[0]||next[1]!==s.excluded[1])){
   for(let i=0;i<3;i++)s.offset[i]=0;s.offset[axis]+=s.adjust[axis-3];s.adjust[axis-3]=0;
  }
  if(s.offset[2]!==0&&next[2]!==s.excluded[2])s.offset[2]=0;
  if(s.adjust[axis-3]!==0&&next[axis]!==s.excluded[axis]){s.offset[axis]+=s.adjust[axis-3];s.adjust[axis-3]=0;}
  const physical=next.map((v,i)=>i>=3&&i!==axis?this.#physical[i]:v-s.offset[i]);
  if(![...physical,...s.offset,...s.adjust].every(Number.isFinite))throw new RangeError('Excluded motion overflow');
  this.#port.move(physical,speed);const extrusionDelta=physical[axis]-this.#physical[axis];this.#physical=physical;this.#state=s;return {admitted:true,extrusionDelta};
 }
}
