import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function historyOracle():string{
 const ref=JSON.parse(readFileSync(new URL('../../contracts/moonraker-history.json',import.meta.url),'utf8'));
 if(createHash('sha256').update(ref.source).digest('hex')!==ref.sourceSha256)throw new Error('History source hash mismatch');
 return `import ast,json,sys,inspect,asyncio,sqlite3,types,time
source=ast.parse(${JSON.stringify(ref.source)})
SqlTableDefinition=object
HIST_TABLE='job_history'
TOTALS_TABLE='job_totals'
selected=[n for n in source.body if isinstance(n,ast.ClassDef) and n.name in {'HistorySqlDefinition','TotalsSqlDefinition','PrinterJob'}]
exec('from __future__ import annotations\\n'+ast.unparse(ast.Module(body=selected,type_ignores=[])))
history=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='History')
methods=[n for n in history.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in {'_handle_jobs_list','_prep_requested_job'}]
exec('from __future__ import annotations\\nclass History:\\n'+__import__('textwrap').indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '))
class Cursor:
 def __init__(self,cursor): self.cursor=cursor
 async def set_arraysize(self,n): self.cursor.arraysize=n
 async def fetchall(self): return self.cursor.fetchall()
class Table:
 async def execute(self,sql,values): return Cursor(conn.execute(sql,values))
class Request:
 def __init__(self,data):self.data=data
 def get_float(self,k,d):return self.data.get(k,d)
 def get_int(self,k,d):return self.data.get(k,d)
 def get_str(self,k,d):return self.data.get(k,d)
data=json.load(sys.stdin)
sqlite3.register_converter('pyjson',json.loads)
conn=sqlite3.connect(':memory:',detect_types=sqlite3.PARSE_DECLTYPES);conn.row_factory=sqlite3.Row
prototypes=[inspect.cleandoc(HistorySqlDefinition.prototype),inspect.cleandoc(TotalsSqlDefinition.prototype)]
for prototype in prototypes:conn.execute('CREATE TABLE '+prototype)
for row in data['rows']:
 conn.execute('INSERT INTO job_history VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[row['id'],'No User','part.gcode','completed',row['start'],row['end'],1,2,2.675,json.dumps({}).encode(),json.dumps([]).encode(),'default'])
owner=History();owner.request_lock=asyncio.Lock();owner.history_table=Table();owner.file_manager=types.SimpleNamespace(check_file_exists=lambda *args:False)
owner.server=types.SimpleNamespace(error=lambda *args:ValueError(str(args)))
async def main():
 results=[]
 for query in data['queries']:results.append(await owner._handle_jobs_list(Request(query)))
 return results
print(json.dumps({'prototypes':prototypes,'results':asyncio.run(main())},allow_nan=False))
`;
}
export function historyMutationOracle():string{return historyOracle().split('async def main():')[0]+String.raw`
methods=[n for n in history.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in {'_handle_job_request','_handle_job_total_reset','_handle_job_totals','_update_aux_totals'}]
exec('from __future__ import annotations\nclass Mutations(History):\n'+__import__('textwrap').indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '))
fn=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='_create_totals_list')
exec('from __future__ import annotations\n'+ast.unparse(fn))
BASE_TOTALS=dict(total_jobs=0,total_time=0.,total_print_time=0.,total_filament_used=0.,longest_job=0.,longest_print=0.)
RequestType=types.SimpleNamespace(GET='GET',DELETE='DELETE')
class Cursor:
 def __init__(self,cursor):self.cursor=cursor;self.rowcount=cursor.rowcount
 async def set_arraysize(self,n):self.cursor.arraysize=n
 async def fetchall(self):return self.cursor.fetchall()
 async def fetchone(self):return self.cursor.fetchone()
class Table:
 async def execute(self,sql,values):return Cursor(conn.execute(sql,values))
 async def executemany(self,sql,values):conn.executemany(sql,values)
 async def __aenter__(self):return self
 async def __aexit__(self,kind,value,trace):
  if kind is None:conn.commit()
  else:conn.rollback()
class Request:
 def __init__(self,data):self.data=data
 def get_request_type(self):return 'GET' if self.data['method']=='get' else 'DELETE'
 def get_str(self,key,default=None):return self.data.get(key,default)
 def get_boolean(self,key,default=False):return self.data['method']=='deleteAll' if key=='all' else self.data.get(key,default)
class Failure(Exception):
 def __init__(self,message,status=400):super().__init__(message);self.status=status
owner=Mutations();owner.request_lock=asyncio.Lock();owner.history_table=owner.totals_table=Table();owner.current_job=None;owner.auxiliary_fields=[];owner.aux_totals=[]
owner.job_totals=dict(total_jobs=3,total_time=6.,total_print_time=3.,total_filament_used=2.675*3,longest_job=2.,longest_print=1.)
owner.file_manager=types.SimpleNamespace(check_file_exists=lambda *args:False);owner.server=types.SimpleNamespace(error=Failure)
conn.executemany('INSERT INTO job_totals VALUES(?,?,?,?,?)',_create_totals_list(owner.job_totals,[]));conn.commit()
async def mutate():
 results=[]
 for operation in data['operations']:
  try:
   if operation['method']=='reset':result=await owner._handle_job_total_reset(Request(operation))
   elif operation['method']=='totals':result=await owner._handle_job_totals(Request(operation))
   else:result=await owner._handle_job_request(Request(operation))
   results.append({'value':result})
  except Failure as error:results.append({'error':error.status})
 return results
print(json.dumps(asyncio.run(mutate()),allow_nan=False))
`;}
