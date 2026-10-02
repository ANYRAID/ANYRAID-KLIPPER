/** Expected cancellation of a motion generation that has been fenced by its
 * owner. It is not proof of MCU stop, execution, or acknowledgement. */
export class MotionRetiredError extends Error {
 constructor(){super('Motion transport retired');this.name='MotionRetiredError';}
}
/** Cancel the observation, while retaining rejection handlers on late work. */
export function observeRetirement(work:Promise<unknown>,signal:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason??new Error('Motion retirement cancelled'));};
  signal.addEventListener('abort',abort,{once:true});
  void work.then(()=>{signal.removeEventListener('abort',abort);resolve();},error=>{signal.removeEventListener('abort',abort);reject(error);});
  if(signal.aborted)abort();
 });
}
