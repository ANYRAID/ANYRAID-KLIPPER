import {KlipperSaveChanges,type SaveChange} from './klipper-save-changes.ts';
import type {SavedConfiguration} from './klipper-save.ts';
import {prepareKlipperSave} from './klipper-save-preflight.ts';
import {commitKlipperSave,KlipperSaveCommitError} from './klipper-save-commit.ts';
import {inspectKlipperConfiguration,type KlipperFileLimits} from './klipper-files.ts';
export type ConfigurationSaveState='idle'|'saving'|'saved'|'failed'|'recovery-required';
/** Owns one loaded configuration session. Saving never activates parameters or
 * restarts a device. After an uncertain commit, reload/recovery needs a new session. */
export class KlipperSaveSession {
 readonly #path:string;readonly #changes:KlipperSaveChanges;readonly #limits:KlipperFileLimits;
 #current:string;#state:ConfigurationSaveState='idle';#restartRequired=false;#sealedForRestart=false;#error:unknown;
 static async load(path:string,limits:KlipperFileLimits={}){
  const loaded=await inspectKlipperConfiguration(path,limits);
  return Object.freeze({source:loaded.source,session:new KlipperSaveSession(loaded.source.primaryFile,loaded.mainText,loaded.autosave,limits)});
 }
 constructor(path:string,current:string,saved:SavedConfiguration={},limits:KlipperFileLimits={}){
  this.#path=path;this.#current=current;this.#changes=new KlipperSaveChanges(saved);this.#limits={...limits};
 }
 apply(changes:readonly SaveChange[]):void{if(this.#sealedForRestart)throw new Error('Configuration session sealed for restart');this.#changes.apply(changes);}
 sealForRestart():void{if(this.#state!=='saved'||this.#changes.status.save_config_pending||this.#sealedForRestart)throw new Error('Configuration is not ready for restart');this.#sealedForRestart=true;}
 get status(){return {...this.#changes.status,state:this.#state,restartRequired:this.#restartRequired,sealedForRestart:this.#sealedForRestart,error:this.#error};}
 hasSavedSection(section:string):boolean{return Object.hasOwn(this.#changes.capture().values,section);}
 async save(signal?:AbortSignal,options:{allowEmpty?:boolean;absentSections?:readonly string[]}={}){
  if(this.#sealedForRestart)throw new Error('Configuration session sealed for restart');
  if(this.#state==='saving')throw new Error('Configuration save already in progress');
  if(this.#state==='recovery-required')throw new Error('Configuration save requires recovery and reload',{cause:this.#error});
  const snapshot=this.#changes.capture();this.#state='saving';this.#error=undefined;
  const signals=[this.#limits.signal,signal].filter((s):s is AbortSignal=>s!==undefined);
  const limits={...this.#limits,signal:signals.length?AbortSignal.any(signals):undefined};
  try{
   const prepared=await prepareKlipperSave(this.#path,this.#current,snapshot.values,limits,options.allowEmpty);
   // Match original SAVE_CONFIG: no non-default saved sections means no write.
   if(!prepared){this.#state='idle';return null;}
   for(const section of options.absentSections??[])if(Object.hasOwn(prepared.source.original,section))throw new Error('Removed configuration section remains defined in ordinary configuration or includes');
   const committed=await commitKlipperSave(prepared,limits);
   this.#current=prepared.text;this.#restartRequired=true;this.#state='saved';
   // No await between version comparison and acknowledgement. New updates made
   // during filesystem I/O remain pending and can be saved against the new text.
   if(this.#changes.capture().revision===snapshot.revision)this.#changes.acknowledge(snapshot);
   return Object.freeze({...committed,pending:this.#changes.status.save_config_pending,restartRequired:true as const});
  }catch(error){
   this.#error=error;this.#state=error instanceof KlipperSaveCommitError&&error.phase!=='before-replace'?'recovery-required':'failed';
   throw error;
  }
 }
}
