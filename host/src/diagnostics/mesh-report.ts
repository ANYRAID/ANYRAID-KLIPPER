// GPL-3.0-or-later. Bounded analysis of bed_mesh/dump_mesh data.
import {meshGrid,meshStatistics,meshDifference,analyzeMeshPaths,type MeshGrid,type MeshParams,type MeshPoint} from './mesh-analysis.ts';
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Expected mesh object');return value as Record<string,unknown>;}
export function analyzeMeshDump(value:unknown){
 const data=object(value),calibration=object(data.calibration),paths=analyzeMeshPaths(calibration.points as MeshPoint[],calibration.probe_path as MeshPoint[],calibration.rapid_path as [MeshPoint,boolean][]),profiles=object(data.profiles),current=object(data.current_mesh);
 const names=Object.keys(profiles);if(names.length>32)throw new RangeError('Mesh profile limit exceeded');const meshes=new Map<string,MeshGrid>();let cells=0;
 const add=(name:string,source:Record<string,unknown>,field:string)=>{if(!name||name.length>1024||/[\r\n\0]/.test(name))throw new RangeError('Invalid mesh name');const matrix=source[field] as number[][];if(!Array.isArray(matrix)||!Array.isArray(matrix[0]))throw new RangeError('Invalid mesh matrix');cells+=matrix.length*matrix[0].length;if(cells>2000000)throw new RangeError('Combined mesh limit exceeded');meshes.set(name,meshGrid(matrix,object(source.mesh_params) as unknown as MeshParams));};
 if(Object.keys(current).length){if(typeof current.name!=='string')throw new TypeError('Invalid current mesh name');add(current.name,current,'probed_matrix');}
 for(const name of names)if(!meshes.has(name))add(name,object(profiles[name]),'points');
 const entries=[...meshes.entries()],statistics: {name:string;statistics:ReturnType<typeof meshStatistics>}[]=[],comparisons:{from:string;to:string;statistics:ReturnType<typeof meshStatistics>|null;reason?:string}[]=[];let work=0;
 for(let i=entries.length-1;i>=0;i--){const [name,grid]=entries[i];statistics.push({name,statistics:meshStatistics(grid)});for(let j=0;j<i;j++){const [other,b]=entries[j];work+=grid.z.length+b.z.length;if(work>64000000)throw new RangeError('Mesh comparison work limit exceeded');const delta=meshDifference(grid,b);comparisons.push(delta?{from:name,to:other,statistics:meshStatistics(delta)}:{from:name,to:other,statistics:null,reason:'Coordinates do not match exactly'});}}
 return {paths,meshes:statistics,comparisons};
}
export function formatMeshReport(report:ReturnType<typeof analyzeMeshDump>):string{
 const p=report.paths,lines=['Analyzing Travel Path...',`  Original point count: ${p.originalCount}`,`  Probe path count: ${p.probeCount}`,`  Rapid scan sample count: ${p.rapidSampleCount}`,`  Rapid scan move count: ${p.rapidMoveCount}`,p.matches?'  Rapid scan points match probe path points':'  ERROR: Rapid scan points do not match probe points'];
 if(!p.matches)lines.push(`  Rapid-only points: ${JSON.stringify(p.rapidOnly)}`,`  Probe-only points: ${JSON.stringify(p.probeOnly)}`);
 for(const [name,duplicates] of [['probe',p.probeDuplicates],['rapid scan',p.rapidDuplicates]] as const)for(const d of duplicates)lines.push(`  WARNING: Duplicate ${name} point ${JSON.stringify(d.point)} (${d.count} occurrences)`);
 const describe=(s:ReturnType<typeof meshStatistics>)=>[`  Mesh range: min ${s.minimum.value.toFixed(4)} (${s.minimum.x.toFixed(2)}, ${s.minimum.y.toFixed(2)}), max ${s.maximum.value.toFixed(4)} (${s.maximum.x.toFixed(2)}, ${s.maximum.y.toFixed(2)})`,`  Mean: ${s.mean.toFixed(6)}, Standard Deviation: ${s.standardDeviation.toFixed(6)}`,`  Absolute Max: ${s.absoluteMaximum.toFixed(6)}, Absolute Mean: ${s.absoluteMean.toFixed(6)}`];
 for(const m of report.meshes)lines.push(`\nAnalyzing Probed Mesh ${m.name}...`,`  Rows: ${m.statistics.rows}, Columns: ${m.statistics.columns}`,...describe(m.statistics));
 for(const c of report.comparisons)lines.push(`\nDelta ${c.from} - ${c.to}:`,...(c.statistics?describe(c.statistics):[`  Skipped: ${c.reason}`]));return lines.join('\n')+'\n';
}
