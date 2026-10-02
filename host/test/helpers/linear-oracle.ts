import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
export function linearOracle(): string {
  const source = execFileSync(
    'git',
    ['show', '29367dc3:klippy/extras/adc_temperature.py'],
    { cwd: resolve(import.meta.dirname, '../../..') },
  );
  return `import base64,json,sys,time
exec(base64.b64decode('${source.toString('base64')}'))
class Config:
 def __init__(self,c): self.c=c
 def getfloat(self,k,d,**kwargs): return self.c.get(k,d)
 def get_name(self): return 'oracle'
 def error(self,msg): return ValueError(msg)
`;
}
