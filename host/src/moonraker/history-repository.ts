// Moonraker history.py persistence semantics. GPL-3.0-or-later.
// Original Copyright (C) 2024 Eric Callahan.
import {DatabaseStore} from './database.ts';
import {ApiError,type Json} from './rpc.ts';
import {encodeDatabaseRecord,decodeDatabaseRecord} from './database-record.ts';
import type {SqlOperation,SqlValue,SqlResult} from './database-sql.ts';
export const historyTables=[
 {name:'job_history',prototype:'job_history (\n    job_id INTEGER PRIMARY KEY ASC,\n    user TEXT NOT NULL,\n    filename TEXT,\n    status TEXT NOT NULL,\n    start_time REAL NOT NULL,\n    end_time REAL,\n    print_duration REAL NOT NULL,\n    total_duration REAL NOT NULL,\n    filament_used REAL NOT NULL,\n    metadata pyjson,\n    auxiliary_data pyjson NOT NULL,\n    instance_id TEXT NOT NULL\n)',version:1},
 {name:'job_totals',prototype:'job_totals (\n    provider TEXT NOT NULL,\n    field TEXT NOT NULL,\n    maximum REAL,\n    total REAL,\n    instance_id TEXT NOT NULL,\n    PRIMARY KEY (provider, field, instance_id)\n)',version:1},
];
export const historyTotalFields=['total_jobs','total_time','total_print_time','total_filament_used','longest_job','longest_print'] as const;
export interface HistoryStats {filename:string;total_duration:number;print_duration:number;filament_used:number;}
export interface HistoryMarker {job_id:string;print_start_time:number;}
export interface HistoryStart extends HistoryStats {metadata_generation?:string;user?:string;start_time:number;metadata?:Record<string,Json>;auxiliary_data?:Json[];}
export interface HistoryJob extends HistoryStats {job_id:string;user:string;status:string;start_time:number;end_time:number|null;metadata:Record<string,Json>;auxiliary_data:Json[];}
export interface HistoryList {before?:number;since?:number;limit?:number;start?:number;order?:string;}
const markerTable={name:'history_metadata',prototype:'history_metadata (filename TEXT NOT NULL, instance_id TEXT NOT NULL, generation TEXT NOT NULL, job_id INTEGER NOT NULL, print_start_time REAL NOT NULL, PRIMARY KEY (filename, instance_id))',version:1,migrations:{}};
const tables=['job_history','job_totals','history_metadata'],instance='default';
function generation(value:string):string{if(typeof value!=='string'||!value||!value.isWellFormed()||Buffer.byteLength(value)>256)throw new ApiError(400,'Invalid metadata generation');return value;}
const number=(n:unknown)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<0)throw new ApiError(400,'Invalid history number');return n;};
const text=(s:unknown)=>{if(typeof s!=='string'||!s.isWellFormed()||Buffer.byteLength(s)>4096)throw new ApiError(400,'Invalid history text');return s;};
function stats(data:HistoryStats):HistoryStats{return {filename:text(data.filename),total_duration:number(data.total_duration),print_duration:number(data.print_duration),filament_used:number(data.filament_used)};}
function sqlId(uid:string):SqlValue{if(typeof uid!=='string'||!/^[0-9a-fA-F]{1,16}$/.test(uid))throw new ApiError(400,'Invalid history uid');const id=BigInt('0x'+uid);if(id<1n||id>(1n<<63n)-1n)throw new ApiError(400,'Invalid history uid');return {integer:String(id)};}
function uid(id:SqlValue):string{const n=typeof id==='number'&&Number.isSafeInteger(id)?BigInt(id):id&&typeof id==='object'&&'integer' in id?BigInt(id.integer):0n;if(n<1n)throw new ApiError(422,'Invalid stored job ID');return n.toString(16).toUpperCase().padStart(6,'0');}
function jsonBinding(value:Record<string,Json>|Json[],object:boolean):SqlValue{if(!value||typeof value!=='object'||Array.isArray(value)===object)throw new ApiError(400,'Invalid history JSON shape');const bytes=encodeDatabaseRecord(value);if(bytes.length>1024*1024)throw new ApiError(413,'History metadata exceeds limit');return {blob:bytes.toString('base64')};}
function decoded(value:SqlValue,object:boolean):Record<string,Json>|Json[]{
 const bytes=typeof value==='string'?Buffer.from(value):value&&typeof value==='object'&&'blob' in value?Buffer.from(value.blob,'base64'):undefined;
 if(!bytes||bytes.length>1024*1024)throw new ApiError(422,'Invalid history JSON');
 const data=decodeDatabaseRecord(bytes);if(!data||typeof data!=='object'||Array.isArray(data)===object)throw new ApiError(422,'Invalid history JSON shape');return data;
}
function job(result:SqlResult,index=0):HistoryJob{
 const row=result.rows[index];if(!row)throw new ApiError(404,'Unknown history job');const data=Object.fromEntries(result.columns.map((name,i)=>[name,row[i]]));
 try{
  return {...stats(data as unknown as HistoryStats),job_id:uid(data.job_id),user:text(data.user),status:text(data.status),start_time:number(data.start_time),end_time:data.end_time===null?null:number(data.end_time),metadata:decoded(data.metadata,true) as Record<string,Json>,auxiliary_data:decoded(data.auxiliary_data,false) as Json[]};
 }catch(error){if(error instanceof ApiError&&error.status===400)throw new ApiError(422,'Invalid stored history job');throw error;}
}
const rowQuery=(id:SqlValue):SqlOperation=>({sql:'SELECT * FROM job_history WHERE job_id=? AND instance_id=?',params:[id,instance]});
const totalsQuery=():SqlOperation=>({
 sql:"SELECT field,maximum,total FROM job_totals WHERE provider='history' AND instance_id=? AND ((field IN ('total_jobs','total_time','total_print_time','total_filament_used') AND maximum IS NULL AND typeof(total) IN ('real','integer') AND total>=0) OR (field IN ('longest_job','longest_print') AND total IS NULL AND typeof(maximum) IN ('real','integer') AND maximum>=0)) AND (field!='total_jobs' OR (total<=9007199254740991 AND total=CAST(total AS INTEGER)))",
 params:[instance],expectRows:6,
});
export class HistoryRepository {
 readonly #db:DatabaseStore;
 private constructor(db:DatabaseStore){this.#db=db;}
 static async open(db:DatabaseStore):Promise<HistoryRepository>{
  if(await db.namespaceLength('history'))throw new ApiError(409,'Legacy history namespace requires migration');
  try{await db.get('moonraker','history');throw new ApiError(409,'Legacy history totals require migration');}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;}
  const seeds=historyTotalFields.map(field=>"INSERT INTO job_totals VALUES('history','"+field+"',"+(field.startsWith('total_')?'NULL,0':'0,NULL')+",'default')");
  for(const table of historyTables)await db.registerTable({...table,migrations:table.name==='job_totals'?{'0':seeds}:{}});
  await db.registerTable(markerTable);
  const repository=new HistoryRepository(db);await repository.totals();
  await db.sql(tables,[{sql:"UPDATE job_history SET status='interrupted' WHERE status='in_progress' AND instance_id=?",params:[instance]}]);
  return repository;
 }
 async start(input:HistoryStart):Promise<HistoryJob>{
  const data=stats(input),metadata=jsonBinding(input.metadata??{},true),auxiliary=jsonBinding(input.auxiliary_data??[],false);
  const operations:SqlOperation[]=[{sql:'INSERT INTO job_history VALUES(NULL,?,?,?,?,?,?,?,?,?,?,?) RETURNING *',params:[text(input.user??'No User'),data.filename,'in_progress',{real:number(input.start_time)},null,{real:data.print_duration},{real:data.total_duration},{real:data.filament_used},metadata,auxiliary,instance]}];
  if(input.metadata_generation!==undefined)operations.push({sql:'INSERT INTO history_metadata VALUES(?,?,?,last_insert_rowid(),?) ON CONFLICT(filename,instance_id) DO UPDATE SET generation=excluded.generation,job_id=excluded.job_id,print_start_time=excluded.print_start_time',params:[data.filename,instance,generation(input.metadata_generation),{real:input.start_time}]});
  const result=await this.#db.sql(tables,operations);return job(result[0]);
 }
 async metadataMarker(filename:string,version:string):Promise<HistoryMarker|undefined>{
  const [result]=await this.#db.sql(tables,[{sql:'SELECT job_id,print_start_time FROM history_metadata WHERE filename=? AND instance_id=? AND generation=?',params:[text(filename),instance,generation(version)]}]);
  if(!result.rows.length)return;const [id,time]=result.rows[0];try{return {job_id:uid(id),print_start_time:number(time)};}catch{throw new ApiError(422,'Invalid stored history metadata marker');}
 }
 async get(id:string):Promise<HistoryJob>{return job((await this.#db.sql(tables,[rowQuery(sqlId(id))]))[0]);}
 async list(options:HistoryList={}):Promise<{count:number;jobs:HistoryJob[]}>{
  const order=(options.order??'desc').toUpperCase(),limit=options.limit??50,start=options.start??0;
  if(!['ASC','DESC'].includes(order)||!Number.isSafeInteger(limit)||!Number.isSafeInteger(start) )throw new ApiError(400,'Invalid history pagination');
  const params:SqlValue[]=[instance];let sql='SELECT * FROM job_history WHERE instance_id=?';
  for(const [value,column,operator] of [[options.before,'end_time','<'],[options.since,'start_time','>']] as const)if(value!==undefined&&value!==-1){sql+=' AND '+column+operator+'?';if(!Number.isFinite(value))throw new ApiError(400,'Invalid history time filter');params.push({real:value});}
  sql+=' ORDER BY job_id '+order;if(limit>0){sql+=' LIMIT ? OFFSET ?';params.push(limit,start);}
  const [result]=await this.#db.sql(tables,[{sql,params}]),jobs=result.rows.map((_,i)=>job(result,i));return {count:jobs.length,jobs};
 }
 async totals():Promise<Record<string,number>>{
  const [result]=await this.#db.sql(tables,[totalsQuery()]);return this.#totals(result);
 }
 #totals(result:SqlResult):Record<string,number>{
  const totals:Record<string,number>={};for(const [field,maximum,total] of result.rows){if(typeof field!=='string'||!historyTotalFields.includes(field as typeof historyTotalFields[number]))throw new ApiError(422,'Invalid history total field');const value=maximum===null?total:maximum;if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new ApiError(422,'Invalid history total');totals[field]=value;}
  if(Object.keys(totals).length!==6)throw new ApiError(422,'Missing history totals');return totals;
 }
 owns(database:DatabaseStore):boolean{return this.#db===database;}
 async delete(id:string):Promise<{deleted_jobs:string[]}>{
  const key=sqlId(id);
  const result=await this.#db.sql(tables,[
   {sql:"SELECT job_id FROM job_history WHERE job_id=? AND instance_id=? AND status='in_progress' LIMIT 1",params:[key,instance],expectRows:0},
   {sql:'DELETE FROM job_history WHERE job_id=? AND instance_id=? RETURNING job_id',params:[key,instance]},
  ]);
  if(!result[1].rows.length)throw new ApiError(404,'Unknown history job');return {deleted_jobs:[id]};
 }
 async deleteAll():Promise<{deleted_jobs:string[]}>{
  const result=await this.#db.sql(tables,[
   {sql:"SELECT job_id FROM job_history WHERE instance_id=? AND status='in_progress' LIMIT 1",params:[instance],expectRows:0},
   {sql:"DELETE FROM job_history WHERE instance_id=? RETURNING printf('%06X',job_id)",params:[instance]},
  ]);
  return {deleted_jobs:result[1].rows.map(row=>String(row[0])).sort((a,b)=>a.length-b.length||a.localeCompare(b,'en'))};
 }
 async resetTotals():Promise<{last_totals:Record<string,number>;last_auxiliary_totals:Json[]}>{
  const result=await this.#db.sql(tables,[
   {sql:"SELECT job_id FROM job_history WHERE instance_id=? AND status='in_progress' LIMIT 1",params:[instance],expectRows:0},
   totalsQuery(),
   {sql:"UPDATE job_totals SET maximum=CASE WHEN maximum IS NULL THEN NULL ELSE 0 END,total=CASE WHEN total IS NULL THEN NULL ELSE 0 END WHERE provider='history' AND field IN ('total_jobs','total_time','total_print_time','total_filament_used','longest_job','longest_print') AND instance_id=?",params:[instance]},
  ]);
  return {last_totals:this.#totals(result[1]),last_auxiliary_totals:[]};
 }
 async finish(id:string,status:string,input:HistoryStats,endTime:number,metadata?:Record<string,Json>):Promise<HistoryJob>{
  if(!['completed','error','cancelled','klippy_shutdown','klippy_disconnect','server_exit'].includes(status))throw new ApiError(400,'Invalid final history status');
  const replacement=metadata===undefined?null:jsonBinding(metadata,true),key=sqlId(id),data=stats(input),end=number(endTime),current=await this.get(id);
  const accepted=data.filename===current.filename&&data.total_duration>=current.total_duration?data:current;
  const values=[1,accepted.total_duration,accepted.print_duration,accepted.filament_used,accepted.total_duration,accepted.print_duration];
  const operations:SqlOperation[]=historyTotalFields.map((field,i)=>({
   sql:field.startsWith('total_')?"UPDATE job_totals SET total=total+? WHERE provider='history' AND field=? AND instance_id=? AND EXISTS(SELECT 1 FROM job_history WHERE job_id=? AND instance_id=? AND status='in_progress')":"UPDATE job_totals SET maximum=max(maximum,?) WHERE provider='history' AND field=? AND instance_id=? AND EXISTS(SELECT 1 FROM job_history WHERE job_id=? AND instance_id=? AND status='in_progress')",
   params:[{real:values[i]},field,instance,key,instance],
  }));
  operations.unshift(totalsQuery());
  operations.push({sql:"UPDATE job_history SET status=?,end_time=?,print_duration=?,total_duration=?,filament_used=?,metadata=COALESCE(?,metadata) WHERE job_id=? AND instance_id=? AND status='in_progress'",params:[status,{real:end},{real:accepted.print_duration},{real:accepted.total_duration},{real:accepted.filament_used},replacement,key,instance]},rowQuery(key),totalsQuery());
  const result=await this.#db.sql(tables,operations);return job(result[result.length-2]);
 }
}
