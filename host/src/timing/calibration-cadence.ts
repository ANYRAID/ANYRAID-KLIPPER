/** Cadence state belongs to a physical clock model, not a motion generation.
 * Klipper's statistics cycle publishes MCU calibrations once per second
 * (extras/statistics.py and extras/motion_queuing.py). The four-second horizon
 * in clocksync.py predicts convergence; it is not the publication interval.
 * No timers or background callbacks: the active producer supplies safe slots. */
export class CalibrationCadence {
 #last=0;#next=0;
 due(now:number):boolean{
  if(!Number.isFinite(now)||now<0||now<this.#last)throw new RangeError('Invalid calibration scheduler time');
  return now>=this.#next;
 }
 run(now:number,attempt:()=>boolean):boolean|undefined{
  const due=this.due(now);this.#last=now;if(!due)return undefined;
  const accepted=attempt();this.#next=now+(accepted?1:.25);return accepted;
 }
}
