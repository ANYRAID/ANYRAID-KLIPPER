import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {BedTiltProbePlan} from './bed-tilt.ts';
/** Default nozzle positions match DeltaCalibrate; probe offsets do not translate
 * these travel targets. Only the measured trigger Z is compared to z_offset. */
export function readDeltaCalibrationPlan(reader:ConfigurationReader):BedTiltProbePlan|undefined{
 if(!reader.hasSection('delta_calibrate'))return undefined;
 if(reader.section('printer').get('kinematics')!=='delta')throw new Error('Delta calibration requires Delta kinematics');
 const s=reader.section('delta_calibrate'),radius=s.getFloat('radius',{above:0});
 const scatter=[.95,.90,.85,.70,.75,.80];
 const defaults:[number,number][]=[[0,0],...scatter.map((scale,i):[number,number]=>{const angle=(90+60*i)*Math.PI/180;return [Math.cos(angle)*radius*scale,Math.sin(angle)*radius*scale];})];
 const points=s.hasOption('points')?s.getLists('points',{type:'float',separators:['\n',','],count:[null,2]}) as [number,number][]:defaults;
 if(points.length<6||points.length>999||points.some(p=>p.length!==2||!p.every(Number.isFinite)))throw new Error('Delta calibration requires 6 to 999 finite probe points');
 return Object.freeze({points:Object.freeze(points.map(p=>Object.freeze(p))),horizontalHeight:s.getFloat('horizontal_move_z',{defaultValue:5}),travelSpeed:s.getFloat('speed',{defaultValue:50,above:0})});
}
