// Coordinate state port from klippy/extras/gcode_move.py; GPL-3.0-or-later.
// Original Copyright (C) 2016-2025 Kevin O'Connor.
export interface MovePort {position():readonly number[];move(position:readonly number[],speed:number):void;}
export interface CoordinateState {
  absoluteCoordinates:boolean;absoluteExtrude:boolean;
  base:number[];position:number[];homing:number[];
  speed:number;speedFactor:number;extrudeFactor:number;
}
export type Parameters=Readonly<Record<string,string|number>>;
function number(params:Parameters,key:string,fallback?:number,positive=false):number|undefined {
  if(!Object.hasOwn(params,key)) return fallback;
  const raw=params[key];
  if(typeof raw==='string'&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())) throw new RangeError(`Invalid ${key}`);
  const value=Number(raw);
  if(!Number.isFinite(value)||(positive&&value<=0)) throw new RangeError(`Invalid ${key}`);
  return value;
}
function moveRequested(params:Parameters):boolean {
  const value=number(params,'MOVE',0)!;
  if(!Number.isInteger(value)) throw new RangeError('Invalid MOVE');return value!==0;
}
function copy(state:CoordinateState):CoordinateState {return {...state,base:[...state.base],position:[...state.position],homing:[...state.homing]};}
export class GCodeMove {
  #port:MovePort;
  #state:CoordinateState;
  #axes=new Map([['X',0],['Y',1],['Z',2],['E',3]]);
  #saved=new Map<string,CoordinateState>();
  constructor(port:MovePort) {
    this.#port=port;
    const position=[...port.position()];
    if(position.length<4||!position.every(Number.isFinite)) throw new RangeError('Invalid initial position');
    this.#state={absoluteCoordinates:true,absoluteExtrude:true,base:position.map(()=>0),position,homing:[0,0,0,0],speed:25,speedFactor:1/60,extrudeFactor:1};
  }
  get state():CoordinateState {return copy(this.#state);}
  get gcodePosition():number[] {
    const s=this.#state,p=s.position.map((v,i)=>v-s.base[i]);p[3]/=s.extrudeFactor;return p;
  }
  usesPort(port:MovePort):boolean {return this.#port===port;}
  /** Bind transformed position/motion functions before dispatching movement. */
  setPort(port:MovePort):MovePort {const previous=this.#port;this.#port=port;return previous;}
  resetPosition():void {
    const position=[...this.#port.position()];
    if(position.length!==this.#state.position.length||!position.every(Number.isFinite)) throw new RangeError('Invalid transformed position');
    this.#state.position=position;
  }
  home(axes:readonly number[]):void {
    if(axes.some(i=>!Number.isInteger(i)||i<0||i>2)) throw new RangeError('Invalid homing axis');
    this.resetPosition();for(const i of axes)this.#state.base[i]=this.#state.homing[i];
  }
  activateExtruder():void {this.resetPosition();this.#state.extrudeFactor=1;this.#state.base[3]=this.#state.position[3];}
  updateExtraAxes(axes:Readonly<Record<string,number>>):void {
    const position=[...this.#port.position()];
    if(position.length<4||!position.every(Number.isFinite)) throw new RangeError('Invalid axis position');
    const next=new Map([['X',0],['Y',1],['Z',2],['E',3]]),indices=new Set<number>();
    for(const [name,index] of Object.entries(axes)) {
      if(!/^[A-Z]$/.test(name)||'XYZEFN'.includes(name)||!Number.isInteger(index)||index<4||index>=position.length||indices.has(index)) throw new RangeError('Invalid extra axis');
      next.set(name,index);indices.add(index);
    }
    this.#axes=next;this.#state.position=position;
    this.#state.base=[...this.#state.base.slice(0,4),...position.slice(4).map(()=>0)];
  }
  /** Typed command dispatch. Port must synchronously accept or reject admission. */
  execute(command:string,params:Parameters={}):void {
    const name=command.toUpperCase(),s=copy(this.#state);
    let target:number[]|undefined,moveSpeed=s.speed;
    switch(name) {
      case 'G0':case 'G1':
        for(const [axis,index] of this.#axes) {
          let value=number(params,axis);if(value===undefined)continue;
          let absolute=s.absoluteCoordinates;
          if(axis==='E') {value*=s.extrudeFactor;if(!s.absoluteExtrude)absolute=false;}
          s.position[index]=absolute?value+s.base[index]:s.position[index]+value;
        }
        if(Object.hasOwn(params,'F'))s.speed=number(params,'F',undefined,true)!*s.speedFactor;
        target=s.position;moveSpeed=s.speed;break;
      case 'G20':throw new Error('Machine does not support G20 (inches) command');
      case 'G21':break;
      case 'G90':s.absoluteCoordinates=true;break;
      case 'G91':s.absoluteCoordinates=false;break;
      case 'M82':s.absoluteExtrude=true;break;
      case 'M83':s.absoluteExtrude=false;break;
      case 'G92': {
        let any=false;
        for(let i=0;i<4;i++) {let offset=number(params,'XYZE'[i]);if(offset===undefined)continue;any=true;if(i===3)offset*=s.extrudeFactor;s.base[i]=s.position[i]-offset;}
        if(!any)for(let i=0;i<4;i++)s.base[i]=s.position[i];break;
      }
      case 'M220': {
        const factor=number(params,'S',100,true)!/6000;s.speed=s.speed/s.speedFactor*factor;s.speedFactor=factor;break;
      }
      case 'M221': {
        const factor=number(params,'S',100,true)!/100;
        const extrusion=(s.position[3]-s.base[3])/s.extrudeFactor;
        s.base[3]=s.position[3]-extrusion*factor;s.extrudeFactor=factor;break;
      }
      case 'SET_GCODE_OFFSET': {
        const delta=[0,0,0,0];
        for(let i=0;i<4;i++) {
          const axis='XYZE'[i];let offset=number(params,axis);
          if(offset===undefined) {const adjustment=number(params,axis+'_ADJUST');if(adjustment===undefined)continue;offset=adjustment+s.homing[i];}
          delta[i]=offset-s.homing[i];s.base[i]+=delta[i];s.homing[i]=offset;
        }
        if(moveRequested(params)) {moveSpeed=number(params,'MOVE_SPEED',s.speed,true)!;for(let i=0;i<4;i++)s.position[i]+=delta[i];target=s.position;}
        break;
      }
      case 'SAVE_GCODE_STATE': {
        const key=String(params.NAME??'default');
        if(!key||key.length>128||(!this.#saved.has(key)&&this.#saved.size>=128))throw new RangeError('Saved state limit');
        this.#saved.set(key,s);return;
      }
      case 'RESTORE_GCODE_STATE': {
        const saved=this.#saved.get(String(params.NAME??'default'));if(!saved)throw new Error('Unknown g-code state');
        s.absoluteCoordinates=saved.absoluteCoordinates;s.absoluteExtrude=saved.absoluteExtrude;
        for(let i=0;i<4;i++)s.base[i]=saved.base[i];s.homing=[...saved.homing];
        s.speed=saved.speed;s.speedFactor=saved.speedFactor;s.extrudeFactor=saved.extrudeFactor;
        s.base[3]+=s.position[3]-saved.position[3];
        if(moveRequested(params)) {moveSpeed=number(params,'MOVE_SPEED',s.speed,true)!;for(let i=0;i<3;i++)s.position[i]=saved.position[i];target=s.position;}
        break;
      }
      default:throw new Error(`Unsupported coordinate command: ${command}`);
    }
    if(![...s.position,...s.base,...s.homing,s.speed,s.speedFactor,s.extrudeFactor].every(Number.isFinite)
      ||s.speed<=0||s.speedFactor<=0||s.extrudeFactor<=0)throw new RangeError('Coordinate state overflow');
    if(target)this.#port.move([...target],moveSpeed);
    this.#state=s;
  }
}
