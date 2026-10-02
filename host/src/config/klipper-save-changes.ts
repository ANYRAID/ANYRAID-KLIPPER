import {buildKlipperSave,type SavedConfiguration} from './klipper-save.ts';
export interface SaveChangesSnapshot {readonly revision:number;readonly values:SavedConfiguration;}
export type SaveChange = {readonly kind:'set';readonly section:string;readonly option:string;readonly value:string}
 | {readonly kind:'remove';readonly section:string};
type Values=Record<string,Record<string,string>>;
type Pending=Record<string,Record<string,string>|null>;
const dict=<T>():Record<string,T>=>Object.create(null);
function copy(input:SavedConfiguration):Values{const out=dict<Record<string,string>>();for(const [section,values] of Object.entries(input)){if(!values||typeof values!=='object'||Array.isArray(values))throw new RangeError('Invalid saved section values');out[section]=dict<string>();for(const [key,value] of Object.entries(values)){if(typeof value!=='string')throw new TypeError('Saved values must be strings');const normalized=key.toLowerCase();if(Object.hasOwn(out[section],normalized))throw new RangeError('Duplicate saved option');out[section][normalized]=value;}}return out;}
function validate(values:Values){if(Object.keys(values).some(s=>s!=='DEFAULT'))buildKlipperSave('',values);else buildKlipperSave('',{...values,'validation-only':{}});}
/** Session-owned pending values. No filesystem writes or activation. */
export class KlipperSaveChanges {
 #values:Values;#pending:Pending=dict();#changed=false;#revision=0;#snapshots=new WeakSet<object>();
 constructor(initial:SavedConfiguration={}){const values=copy(initial);validate(values);this.#values=values;}
 #next():number{if(this.#revision>=Number.MAX_SAFE_INTEGER)throw new RangeError('Save revision exhausted');return this.#revision+1;}
 set(section:string,option:string,value:string):void{this.apply([{kind:'set',section,option,value}]);}
 removeSection(section:string):void{this.apply([{kind:'remove',section}]);}
 /** Atomically publish the ordered operations after validating the final config.
  * Intermediate values are staged, never exposed. One batch advances one revision. */
 apply(changes:readonly SaveChange[]):void{
  if(!Array.isArray(changes)||changes.length>100000)throw new RangeError('Save change batch budget exceeded');
  if(!changes.length)return;
  const next=copy(this.#values),pending:Pending=Object.assign(dict(),this.#pending);let changed=false;
  for(const change of changes){
   if(!change||typeof change.section!=='string')throw new TypeError('Invalid save change');
   const section=change.section;
   if(change.kind==='remove'){
    if(section==='DEFAULT'||!Object.hasOwn(next,section))continue;
    delete next[section];pending[section]=null;changed=true;
   }else if(change.kind==='set'){
    if(section==='DEFAULT')throw new RangeError('Cannot set DEFAULT as a saved section');
    if(typeof change.option!=='string'||typeof change.value!=='string')throw new TypeError('Saved options and values must be strings');
    next[section]??=dict();next[section][change.option.toLowerCase()]=change.value;
    pending[section]={...(Object.hasOwn(pending,section)?pending[section]:null),[change.option]:change.value};changed=true;
   }else throw new TypeError('Invalid save change kind');
  }
  if(!changed)return;
  validate(next);const revision=this.#next();
  this.#values=next;this.#pending=pending;this.#changed=true;this.#revision=revision;
 }
 get status():{save_config_pending:boolean;save_config_pending_items:Pending}{const pending=dict<Record<string,string>|null>();for(const [name,values] of Object.entries(this.#pending))pending[name]=values===null?null:{...values};return {save_config_pending:this.#changed,save_config_pending_items:pending};}
 capture():SaveChangesSnapshot{const values=copy(this.#values);for(const v of Object.values(values))Object.freeze(v);const snapshot=Object.freeze({revision:this.#revision,values:Object.freeze(values)});this.#snapshots.add(snapshot);return snapshot;}
 /** Call only after that exact snapshot has been durably saved. A stale success
  * never clears newer pending calibration values. Activation is separate. */
 acknowledge(snapshot:SaveChangesSnapshot):void{if(!this.#snapshots.has(snapshot)||snapshot.revision!==this.#revision)throw new Error('Stale or foreign save snapshot');const revision=this.#next();this.#pending=dict();this.#changed=false;this.#revision=revision;}
}
