// Regression and outlier model from klippy/clocksync.py, GPL-3.0-or-later.
// Copyright (C) 2016-2018 Kevin O'Connor.
const DECAY=1/30,RTT_AGE=.000010/3600;
export interface ClockSample {clock32:number;sentTime:number;receiveTime:number;}
export interface ClockEstimate {sampleTime:number;origin:bigint;clockOffset:number;frequency:number;}
export interface ReleaseEstimate {frequency:number;sampleTime:number;clock:bigint;}
function finiteTime(value:number):void {if(!Number.isFinite(value)||value<0) throw new RangeError('Invalid monotonic time');}
function integerOffset(origin:bigint,offset:number):bigint {
  if(!Number.isFinite(offset)||Math.abs(offset)>Number.MAX_SAFE_INTEGER) throw new RangeError('Clock offset exceeds exact integer range');
  const whole=Math.trunc(offset),fraction=offset-whole;
  let result=origin+BigInt(whole);
  if(result>0n&&fraction<0) result--;
  else if(result<0n&&fraction>0) result++;
  return result;
}
/** Clock estimator only: scheduling the .9839 s queries and transport integration live above it. */
export class ClockSync {
  readonly nominalFrequency:number;
  #origin:bigint;
  #lastClock:bigint;
  #timeAvg:number;
  #timeVariance=0;
  #clockAvg=0;
  #clockCovariance=0;
  #predictionVariance:number;
  #lastPredictionTime=0;
  #minHalfRtt=999999999.9;
  #minRttTime=0;
  #estimateTime:number;
  #estimateOffset=0;
  #frequency:number;
  #lastSent:number;
  #pending=0;
  #revision=0;
  #invalid=false;
  constructor(frequency:number,uptimeClock:bigint,sentTime:number) {
    if(!Number.isFinite(frequency)||frequency<=0||!Number.isFinite(frequency**2)||uptimeClock<0n||uptimeClock>0xffffffffffffffffn)
      throw new RangeError('Invalid MCU clock initialization');
    finiteTime(sentTime);
    this.nominalFrequency=this.#frequency=frequency;this.#origin=this.#lastClock=uptimeClock;
    this.#timeAvg=this.#estimateTime=this.#lastSent=sentTime;this.#predictionVariance=(.001*frequency)**2;
  }
  get revision():number{return this.#revision;}
  get lastClock():bigint {return this.#lastClock;}
  get active():boolean {return !this.#invalid&&this.#pending<=4;}
  get estimate():ClockEstimate {return {sampleTime:this.#estimateTime,origin:this.#origin,clockOffset:this.#estimateOffset,frequency:this.#frequency};}
  invalidate():void{this.#invalid=true;this.#revision++;}
  querySent():void {if(this.#invalid)throw new Error('Clock estimator is invalidated');this.#pending++;}
  /** Calibration warmup mirrors the initial eight upstream samples. */
  accept(sample:ClockSample,warmup=false):ReleaseEstimate|null {
    if(this.#invalid)throw new Error('Clock estimator is invalidated');
    const {clock32,sentTime,receiveTime}=sample;
    if(!Number.isInteger(clock32)||clock32<0||clock32>0xffffffff) throw new RangeError('Invalid MCU clock sample');
    finiteTime(sentTime);finiteTime(receiveTime);
    if(sentTime && (receiveTime<sentTime||sentTime<this.#lastSent)) throw new RangeError('Stale or inverted clock sample');
    // Replies advance monotonically modulo 2^32, unlike nearest-clock conversion.
    const clock=this.#lastClock+BigInt.asUintN(32,BigInt(clock32)-this.#lastClock);
    if(clock>0xffffffffffffffffn) throw new RangeError('MCU uptime overflow');
    this.#revision++;this.#lastClock=clock;this.#pending=0;
    if(warmup) this.#lastPredictionTime=-9999;
    if(!sentTime) return null; // retransmission: departure timestamp is ambiguous
    this.#lastSent=sentTime;
    // Rebase before floating point regression loses tick resolution.
    if(clock-this.#origin>0x10000000000n) {
      const shift=clock-this.#origin;
      if(shift>BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Clock sampling gap is too large');
      this.#clockAvg-=Number(shift);this.#estimateOffset-=Number(shift);this.#origin=clock;
    }
    const relative=Number(clock-this.#origin);
    const expected=(sentTime-this.#timeAvg)*this.#frequency+this.#clockAvg;
    const error2=(relative-expected)**2;
    if(error2>25*this.#predictionVariance && error2>(.000500*this.nominalFrequency)**2) {
      if(relative>expected && sentTime<this.#lastPredictionTime+10) return null;
      this.#predictionVariance=(.001*this.nominalFrequency)**2;
    } else {
      this.#lastPredictionTime=sentTime;
      this.#predictionVariance=(1-DECAY)*(this.#predictionVariance+error2*DECAY);
    }
    const diffTime=sentTime-this.#timeAvg;
    // Repeated departure timestamps do not contain enough frequency information.
    if(!this.#timeVariance && diffTime===0) return null;
    this.#timeAvg+=DECAY*diffTime;
    this.#timeVariance=(1-DECAY)*(this.#timeVariance+diffTime**2*DECAY);
    const diffClock=relative-this.#clockAvg;
    this.#clockAvg+=DECAY*diffClock;
    this.#clockCovariance=(1-DECAY)*(this.#clockCovariance+diffTime*diffClock*DECAY);
    const frequency=this.#clockCovariance/this.#timeVariance;
    if(!Number.isFinite(frequency)||frequency<=0) throw new RangeError('Invalid estimated MCU frequency');
    const halfRtt=.5*(receiveTime-sentTime),age=(sentTime-this.#minRttTime)*RTT_AGE;
    if(halfRtt<this.#minHalfRtt+age) {this.#minHalfRtt=halfRtt;this.#minRttTime=sentTime;}
    this.#estimateTime=this.#timeAvg+this.#minHalfRtt;this.#estimateOffset=this.#clockAvg;this.#frequency=frequency;
    return {frequency,sampleTime:this.#timeAvg+.001,clock:integerOffset(this.#origin,this.#clockAvg-3*Math.sqrt(this.#predictionVariance))};
  }
  getClock(eventTime:number):bigint {
    finiteTime(eventTime);return integerOffset(this.#origin,this.#estimateOffset+(eventTime-this.#estimateTime)*this.#frequency);
  }
  systemTime(clock:bigint):number {
    const delta=clock-this.#origin;
    if(delta>BigInt(Number.MAX_SAFE_INTEGER)||delta< -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Requested clock too far from estimate');
    return (Number(delta)-this.#estimateOffset)/this.#frequency+this.#estimateTime;
  }
  nearestClock(clock32:number):bigint {
    if(!Number.isInteger(clock32)||clock32<0||clock32>0xffffffff) throw new RangeError('Invalid MCU clock');
    return this.#lastClock+BigInt.asIntN(32,BigInt(clock32)-this.#lastClock);
  }
}
