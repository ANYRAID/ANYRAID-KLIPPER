/** Schedule a simulated device event no earlier than its firmware clock.
 * The owner cancels its timers when retiring a device generation. */
export function atFirmwareClock(timers:Set<ReturnType<typeof setTimeout>>,currentClock:()=>number,clock:number,initialDelay:number,emit:()=>void):void{
 const schedule=(ms:number)=>{const timer=setTimeout(()=>{timers.delete(timer);const remaining=(clock+5000-currentClock())/1000;if(remaining>0)schedule(Math.ceil(remaining));else emit();},ms);timers.add(timer);};
 schedule(initialDelay);
}
