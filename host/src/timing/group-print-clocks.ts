import {SecondarySync} from './secondary-sync.ts';
import {snapshotPrintClock} from './print-clock.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import type {MCUGroup} from '../runtime/mcu-group.ts';
import type {FanClock} from '../config/cooling-fan.ts';
/** Cold-start mapping at one host monotonic instant. Primary print time follows
 * its nominal clock; secondary clocks use the existing calibrated sync model.
 * This snapshot does not update a running motion generation's calibration. */
export function captureGroupPrintClocks(group:MCUGroup,primaryId:string,eventTime=serialClock.now()):ReadonlyMap<string,FanClock>{
 if(!Number.isFinite(eventTime)||eventTime<0)throw new RangeError('Invalid group clock capture time');
 group.assertActive();
 const primary=group.session(primaryId).clock.sync,result=new Map<string,FanClock>();
 for(const {id} of group.status.devices){
  const local=group.session(id).clock.sync;
  if(!primary.active||!local.active)throw new Error('Cannot capture inactive MCU clocks');
  const synchronizer=id===primaryId?undefined:new SecondarySync(primary,local,eventTime),calibration=synchronizer?.mapping??{offset:0,frequency:primary.nominalFrequency};
  const mapping=snapshotPrintClock(calibration),currentPrintTime=mapping.printTimeAtClock(local.getClock(eventTime));
  if(currentPrintTime<0)throw new RangeError('Invalid captured print time');
  result.set(id,Object.freeze({currentPrintTime,synchronizer,calibration:Object.freeze({offset:mapping.offset,frequency:mapping.frequency})}));
 }
 group.assertActive();return result;
}
