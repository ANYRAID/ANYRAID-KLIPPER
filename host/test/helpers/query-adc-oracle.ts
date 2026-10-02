import {execFileSync} from 'node:child_process';
export function queryADCOracle():string{
 const source=execFileSync('git',['show','6950d00f:klippy/extras/query_adc.py'],{encoding:'utf8'});
 return source+`
import json,sys
class Sample:
 def __init__(self,pair): self.pair=pair
 def get_last_value(self): return self.pair
class Command:
 def __init__(self,params): self.params=params
 def get(self,key,default): return self.params.get(key,default)
 def get_float(self,key,default,above):
  value=self.params.get(key,default)
  if value is None: return value
  value=float(value)
  if value<=above: raise ValueError('invalid pullup')
  return value
 def respond_info(self,value): self.result=value
query=QueryADC.__new__(QueryADC)
results=[]
for case in json.load(sys.stdin):
 query.adc={name:Sample(pair) for name,pair in case['sources'].items()}
 command=Command(case['params'])
 query.cmd_QUERY_ADC(command)
 results.append(command.result)
print(json.dumps(results))
`;
}
