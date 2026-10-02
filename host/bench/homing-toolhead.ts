import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {homingToolheadPositions} from '../src/homing/toolhead-position.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {DeltaKinematics} from '../src/kinematics/delta.ts';
const kinds=['cartesian','corexy','corexz','delta'] as const,names=['a','b','c'];
const fixtures=kinds.flatMap(kind=>{
 const geometry=kind==='delta'?new DeltaKinematics({radius:100,printRadius:80,arms:[250,250,250],angles:[210,330,90],endstops:[300,300,300],stepDistances:[.01,.01,.01],minimumZ:-200,maxVelocity:100,maxAccel:1000,maxZVelocity:50,maxZAccel:500}):new LinearKinematics({kind,ranges:[[-300,300],[-300,300],[-300,300]],maxVelocity:100,maxAccel:1000,maxZVelocity:50,maxZAccel:500});
 const calculate=(p:ReadonlyMap<string,number>)=>geometry.calcPosition([p.get('a')!,p.get('b')!,p.get('c')!]);
 return Array.from({length:1000},(_,i)=>{
  const base=[150+i%17*.1,150+i%23*.1,150+i%31*.1],steps=names.map((_,j)=>[i*7+j,i*7+j+(i%401-200)*(j+1),i*7+j+(i%401-200)*(j+1)+(i%9-4)*(j+1)]),reference=[...geometry.calcPosition(base as [number,number,number]),42,17];
  return {kind,probe:i%2===0,base,steps,reference,options:{mode:i%2===0?'probe' as const:'home' as const,reference,calculate,actuators:names.map((id,j)=>({id,member:0,oid:j,commanded:base[j],stepDistance:.01})),offsets:steps.map(([a,b,c],oid)=>({member:0,oid,start:BigInt(a),trigger:BigInt(b),halt:BigInt(c),triggerOffset:BigInt(b-a),haltOffset:BigInt(c-a),overshoot:BigInt(c-b)}))}};
 });
});
const python=String.raw`
import ast,json,sys,math,types,time
root=sys.argv[1];data=json.load(sys.stdin);scope={'math':math};methods={}
def method(path,cls,name):
 source=open(root+'/'+path).read();tree=ast.parse(source);node=next(c for c in tree.body if isinstance(c,ast.ClassDef) and c.name==cls);fn=next(n for n in node.body if isinstance(n,ast.FunctionDef) and n.name==name);exec(compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),path,'exec'),scope);return scope[name]
source=ast.parse(open(root+'/klippy/mathutil.py').read());nodes=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in ['trilateration','matrix_cross','matrix_dot','matrix_magsq','matrix_add','matrix_sub','matrix_mul']];exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),'mathutil','exec'),scope);scope['mathutil']=types.SimpleNamespace(**scope)
calc=method('klippy/extras/homing.py','HomingMove','calc_toolhead_pos')
tree=ast.parse(open(root+'/klippy/extras/homing.py').read());cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='HomingMove');move=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='homing_move');branch=next(n for n in move.body if isinstance(n,ast.If) and isinstance(n.test,ast.Name) and n.test.id=='probe_pos')
fn=ast.parse('def resolve(self,kin_spos,movepos,probe_pos):\n kin=self.toolhead.get_kinematics()').body[0]
fn.body.extend([branch,ast.Return(value=ast.Tuple(elts=[ast.Name(id='trigpos',ctx=ast.Load()),ast.Name(id='haltpos',ctx=ast.Load())],ctx=ast.Load()))]);exec(compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),'homing-branch','exec'),scope);resolve=scope['resolve']
for kind,clsname in [('cartesian','CartKinematics'),('corexy','CoreXYKinematics'),('corexz','CoreXZKinematics'),('delta','DeltaKinematics')]:
 methods[kind]=method('klippy/kinematics/'+kind+'.py',clsname,'calc_position')
act=method('klippy/kinematics/delta.py','DeltaKinematics','_actuator_to_cartesian');prepared=[]
for f in data:
 steppers=[types.SimpleNamespace(get_name=lambda n=n:n,get_step_dist=lambda:.01,get_commanded_position=lambda v=v:v) for n,v in zip('abc',f['base'])];kin=types.SimpleNamespace(rails=steppers,dc_module=None,towers=[(math.cos(a*math.pi/180)*100,math.sin(a*math.pi/180)*100) for a in [210,330,90]],arm2=[250**2]*3);kin.get_steppers=lambda s=steppers:s;kin.calc_position=types.MethodType(methods[f['kind']],kin);kin._actuator_to_cartesian=types.MethodType(act,kin)
 tool=types.SimpleNamespace(position=f['reference'][:]);tool.get_position=lambda t=tool:t.position;tool.get_kinematics=lambda k=kin:k;tool.set_position=lambda p,t=tool:setattr(t,'position',p)
 obj=types.SimpleNamespace(toolhead=tool,stepper_positions=[types.SimpleNamespace(stepper_name=n,start_pos=a,trig_pos=b,halt_pos=c,verify_no_probe_skew=lambda p:None) for n,(a,b,c) in zip('abc',f['steps'])]);obj.calc_toolhead_pos=types.MethodType(calc,obj);prepared.append((obj,dict(zip('abc',f['base'])),f['reference'],f['probe']))
times=[];expected=[]
for run in range(14):
 start=time.perf_counter()
 for args in prepared:
  args[0].toolhead.position=args[2];result=resolve(*args)
  if run==0:expected.append(result)
 if run>=3:times.append((time.perf_counter()-start)*1000)
print(json.dumps({'expected':expected,'times':sorted(times),'python':sys.version.split()[0]}))
`;
const ref=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../',import.meta.url))],{input:JSON.stringify(fixtures.map(({options,...f})=>f)),encoding:'utf8',maxBuffer:4*1024*1024,timeout:60000});assert.equal(ref.status,0,ref.stderr);const parsed=JSON.parse(ref.stdout),times:number[]=[];let maximumError=0;
for(let round=0;round<14;round++){const start=performance.now();for(let i=0;i<fixtures.length;i++){const actual=homingToolheadPositions(fixtures[i].options);if(round===0)for(const [j,values] of [actual.trigger,actual.halt].entries())for(let axis=0;axis<values.length;axis++){const error=Math.abs(values[axis]-parsed.expected[i][j][axis]);maximumError=Math.max(maximumError,error);assert(error<1e-9,`fixture ${i} axis ${axis}: ${error}`);}}if(round>=3)times.push(performance.now()-start);}
times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,python:parsed.python,cases:fixtures.length,maximumError,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:parsed.times[5],pythonP95Ms:parsed.times[10],scope:'original HomingMove probe/home branch and inverse kinematics; coordinate reconstruction only, no native reset or physical homing'}));
assert(times[5]<=parsed.times[5]*1.5,'Coordinate reconstruction median exceeded 50% regression budget');
