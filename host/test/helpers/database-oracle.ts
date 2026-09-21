import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function databaseOracle():string{
 const ref=JSON.parse(readFileSync(new URL('../../contracts/moonraker-database.json',import.meta.url),'utf8'));
 if(createHash('sha256').update(ref.source).digest('hex')!==ref.sourceSha256)throw new Error('Database source hash mismatch');
 return `import ast,json,sys,sqlite3,struct,operator,logging,types,textwrap,base64,time,pathlib
from functools import reduce
from typing import Dict
class ServerError(Exception):
 def __init__(self,message,status=500): super().__init__(message);self.status=status
class Server:
 error=ServerError
 def is_verbose_enabled(self): return False
Sentinel=types.SimpleNamespace(MISSING=object())
jsonw=types.SimpleNamespace(dumps=lambda x:json.dumps(x,ensure_ascii=False,separators=(',',':')).encode(),loads=json.loads)
source=ast.parse(${JSON.stringify(ref.source)})
names={'RECORD_ENCODE_FUNCS','RECORD_DECODE_FUNCS','encode_record','decode_record','getitem_with_default','parse_namespace_key'}
nodes=[n for n in source.body if getattr(n,'name',None) in names or isinstance(n,ast.AnnAssign) and getattr(n.target,'id',None) in names]
exec('from __future__ import annotations\\n'+ast.unparse(ast.Module(body=nodes,type_ignores=[])))
provider=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='SqliteProvider')
methods={'_insert_record','_get_record','get_namespace','get_namespace_length','drop_empty_namespace','insert_item','update_item','insert_batch','get_batch','delete_batch','move_batch','backup_database','compact_database','delete_item','get_item'}
body=[n for n in provider.body if isinstance(n,ast.FunctionDef) and n.name in methods]
exec('from __future__ import annotations\\nclass Provider:\\n'+textwrap.indent(ast.unparse(ast.Module(body=body,type_ignores=[])),'    '))
NAMESPACE_TABLE='namespace_store'
SCHEMA='CREATE TABLE namespace_store (namespace TEXT NOT NULL,key TEXT NOT NULL,value record NOT NULL,PRIMARY KEY(namespace,key))'
sqlite3.register_converter('record',decode_record)
def create(path=':memory:'):
 conn=sqlite3.connect(path,detect_types=sqlite3.PARSE_DECLTYPES);conn.execute(SCHEMA)
 owner=Provider();owner.server=Server();owner._namespaces=set();return owner,conn
def main():
 data=json.load(sys.stdin);owner,conn=create(data.get('path',':memory:'));result=[]
 for op in data['operations']:
  try:
   method=op[0];args=op[1:]
   if method=='insert': owner.insert_item(conn,*args);value=None
   elif method=='update': owner.update_item(conn,*args);value=None
   elif method=='insertBatch': owner.insert_batch(conn,*args);value=None
   elif method=='getBatch': value=owner.get_batch(conn,*args)
   elif method=='deleteBatch': value=owner.delete_batch(conn,*args)
   elif method=='moveBatch': owner.move_batch(conn,*args);value=None
   elif method=='delete': value=owner.delete_item(conn,*args);owner.drop_empty_namespace(conn,args[0])
   else: value=owner.get_item(conn,*args)
   result.append({'value':value})
  except ServerError as error: result.append({'error':error.status})
 conn.close();print(json.dumps(result))
main()
`;
}
