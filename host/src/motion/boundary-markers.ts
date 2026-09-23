import {Move} from './lookahead.ts';
export function validateEndMarkers(markers:readonly number[]|undefined):void{
 if(markers===undefined)return;
 if(!Array.isArray(markers)||markers.length>64)throw new RangeError('Invalid motion boundary markers');
 const seen=new Set<number>();for(const id of markers){if(!Number.isSafeInteger(id)||id<1||seen.has(id))throw new RangeError('Invalid motion boundary markers');seen.add(id);}
}
export function copyEndMarkers(markers:readonly number[]|undefined):readonly number[]|undefined{
 if(markers===undefined)return;validateEndMarkers(markers);return Object.freeze([...markers]);
}
export function markMoveEnd(move:Move,id:number):void{
 if(!(move instanceof Move)||move.distance<=0)throw new Error('Motion endpoint required for marker');
 const markers=[...move.endMarkers??[],id];validateEndMarkers(markers);move.endMarkers=Object.freeze(markers);
}
