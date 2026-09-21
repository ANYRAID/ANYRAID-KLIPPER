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
