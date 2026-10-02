import {readFileSync} from 'node:fs';
import type {ArcPlane} from '../../src/gcode/arcs.ts';
export const arcsReference=JSON.parse(readFileSync(new URL('../../contracts/arcs-reference.json',import.meta.url),'utf8')) as {
 source:string;sourceSha256:string;origin:number[];
 cases:{plane:ArcPlane;clockwise:boolean;absolute:boolean;resolution:number;params:Record<string,number>}[];
 reference:{results:Record<string,number>[][];times:number[];checksum:number};
};
