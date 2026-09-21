import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const source=String.raw`
import sys,types,runpy,json,configparser,time,logging
logging.disable(logging.WARNING)
state=[]
class Stub:
 def __getattr__(self,n): return lambda *a,**k:None
class Axis(Stub):
 def __init__(self): self.curves=[];state.append(self.curves)
 def plot(self,x,y,**kw): self.curves.append(dict(times=x,values=y))
def subplots(**kw):
 state.clear();axes=[Axis() for _ in range(kw.get('nrows',1))];return Stub(),axes if len(axes)>1 else axes[0]
m=types.ModuleType('matplotlib');m.pyplot=types.SimpleNamespace(subplots=subplots);m.font_manager=types.SimpleNamespace(FontProperties=Stub);sys.modules['matplotlib']=m
r=runpy.run_path(sys.argv[1]);sys.path.insert(0,sys.argv[2]);from extras import thermistor,adc_temperature
request=json.load(sys.stdin);settings={'pullup_resistor':request.get('pullup',4700),'adc_voltage':request.get('voltage',5)};config=r['DummyConfig'](settings)
cfg=configparser.ConfigParser();cfg.read(sys.argv[2]+'/extras/temperature_sensors.cfg')
def create(name):
 for sensor,params in adc_temperature.DefaultVoltageSensors:
  if sensor==name:return adc_temperature.LinearVoltage(config,params)
 for sensor,params in adc_temperature.DefaultResistanceSensors:
  if sensor==name:return adc_temperature.LinearResistance(config,params)
 params=cfg['thermistor '+name];sensor=thermistor.Thermistor(settings['pullup_resistor'],0)
 if 'beta' in params:sensor.setup_coefficients_beta(float(params['temperature1']),float(params['resistance1']),float(params['beta']))
 else:sensor.setup_coefficients(*[float(params[k+str(i)]) for i in range(1,4) for k in ['temperature','resistance']])
 return sensor
config.do_create_sensor=create;samples=[]
for i in range(request.get('runs',1)):
 start=time.perf_counter();r['plot_resistance' if request.get('resistance') else 'plot_adc_resolution'](config,request['sensors']);samples.append((time.perf_counter()-start)*1000)
print(json.dumps(dict(curves=state,samples=samples,legacyImportAvailable=hasattr(thermistor,'load_config')),allow_nan=False))
`;
export function temperatureGraphReference(options:{sensors:readonly string[];pullup?:number;voltage?:number;resistance?:boolean;runs?:number}):{curves:{times:number[];values:number[]}[][];samples:number[];legacyImportAvailable:boolean}{return JSON.parse(execFileSync('/usr/bin/python3',['-c',source,fileURLToPath(new URL('../../scripts/graph_temp_sensor.py',import.meta.url)),fileURLToPath(new URL('../../klippy',import.meta.url))],{input:JSON.stringify(options),encoding:'utf8',maxBuffer:16*1024**2}));}
