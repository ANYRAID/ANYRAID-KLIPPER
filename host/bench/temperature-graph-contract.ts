import {readFileSync} from 'node:fs';
interface RecordCase {resistance:boolean;pullup:number;voltage:number;values:number[][][];pythonSamplesMs:number[];legacyImportAvailable:boolean;}
interface Contract {version:number;sensors:string[];records:RecordCase[];provenance:{commit:string;capturedAt:string;cpu:string;sources:Record<string,string>;note:string};}
const contract=JSON.parse(readFileSync(new URL('../test/fixtures/temperature-graph/reference.json',import.meta.url),'utf8')) as Contract;
if(contract.version!==1||contract.records.length!==4||new Set(contract.sensors).size!==contract.sensors.length)throw new Error('Invalid temperature graph contract');
/** Frozen original Python output, not a second implementation of the formulas.
 * Reject uncaptured settings instead of substituting or interpolating reference data. */
export function temperatureGraphContract(options:{sensors:readonly string[];pullup?:number;voltage?:number;resistance?:boolean}){
 const record=contract.records.find(r=>r.resistance===(options.resistance??false)&&r.pullup===(options.pullup??4700)&&r.voltage===(options.voltage??5));
 if(!record||!options.sensors.length)throw new Error('Temperature settings are not captured in the reference contract');
 const indices=options.sensors.map(s=>{const i=contract.sensors.indexOf(s);if(i<0)throw new Error('Unknown reference sensor');return i;}),length=record.resistance?350:349;
 if(record.values.length!==(record.resistance?1:2)||record.values.some(p=>p.length!==contract.sensors.length||p.some(c=>c.length!==length||!c.every(Number.isFinite))))throw new Error('Invalid reference curve data');
 return {curves:record.values.map(p=>indices.map(i=>({times:Array.from({length},(_,i)=>i+1),values:[...p[i]]}))),historicalPythonSamplesMs:[...record.pythonSamplesMs],legacyImportAvailable:record.legacyImportAvailable,provenance:structuredClone(contract.provenance),sensors:[...contract.sensors]};
}
