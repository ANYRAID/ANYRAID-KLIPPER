import {GCodeDispatch,GCodeError} from '../gcode/dispatch.ts';
import {KlipperSaveSession} from './klipper-save-session.ts';
/** The runtime owns motion drain, safe heater shutdown and process restart.
 * This adapter never equates the request completing with configuration activation. */
export function registerSaveConfig(dispatch:GCodeDispatch,session:KlipperSaveSession,requestRestart:(signal:AbortSignal)=>void|Promise<void>):void{
 if(typeof requestRestart!=='function')throw new TypeError('Restart handler required');
 dispatch.register('SAVE_CONFIG',async command=>{
  try{
   const result=await session.save(command.signal);if(!result)return;
   command.signal.throwIfAborted();
   if(result.pending)throw new GCodeError('Configuration saved, but newer changes remain pending; save again before restart');
   session.sealForRestart();dispatch.setReady(false,'Configuration saved; restart required');
   await requestRestart(command.signal);
  }catch(error){if(session.status.state==='recovery-required')dispatch.setReady(false,'Configuration save requires recovery');if(error instanceof GCodeError)throw error;throw new GCodeError('SAVE_CONFIG failed: '+(error instanceof Error?error.message:String(error)),{cause:error});}
 });
}
