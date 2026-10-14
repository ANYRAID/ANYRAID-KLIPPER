import type {ChildProcess} from 'node:child_process';
export interface LegacyExportExit {code:number|null;signal:NodeJS.Signals|null;}
/** Own the created exporter, including paused stdout. Process exit alone does
 * not close an unread pipe; every failed import must discard it before joining. */
export function ownLegacyExportChild(child:ChildProcess,onClosed:(exit:LegacyExportExit)=>void){
 const closed=Promise.withResolvers<LegacyExportExit>();let spawnError:unknown,observationError:unknown,stopped:Promise<LegacyExportExit>|undefined;
 child.on('error',error=>{spawnError=error;});
 child.once('close',(code,signal)=>{const exit={code,signal};try{onClosed(exit);}catch(error){observationError=error;}finally{closed.resolve(exit);}});
 return {closed:closed.promise,get spawnError(){return spawnError;},get observationError(){return observationError;},stop(){
  return stopped??=(async()=>{
   let killError:unknown;try{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}catch(error){killError=error;}
   child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
   const exit=await closed.promise;if(killError)throw killError;if(observationError)throw observationError;return exit;
  })();
 }};
}
