import {GCodeDispatch,GCodeError} from './dispatch.ts';
import {parseCommand} from './parser.ts';
/** Bounded live UTF-8 ingress. Keep reading while dispatch waits so M112 is visible. */
export class GCodeInput {
  #dispatch:GCodeDispatch;#decoder=new TextDecoder('utf-8',{fatal:true});
  #partial='';#lines:string[]=[];#characters=0;#count=0;
  #running:Promise<void>|undefined;#failure:Error|undefined;#ended=false;
  constructor(dispatch:GCodeDispatch) {this.#dispatch=dispatch;}
  get pendingLines():number{return this.#count;}
  get bufferedCharacters():number{return this.#characters+this.#partial.length;}
  #fail(error:Error):never {
    if(!this.#failure) {
      this.#failure=error;this.#lines=[];this.#partial='';this.#characters=0;this.#count=0;
      this.#dispatch.emergencyStop(error.message);
    }
    throw this.#failure;
  }
  receive(chunk:Uint8Array):void {
    if(this.#failure)throw this.#failure;
    if(this.#ended)throw new GCodeError('G-code input is closed');
    if(chunk.byteLength>65536)this.#fail(new GCodeError('G-code input chunk limit'));
    let text='';
    try{text=this.#decoder.decode(chunk,{stream:true});}catch{this.#fail(new GCodeError('Invalid G-code UTF-8'));}
    const parts=(this.#partial+text).split('\n');this.#partial=parts.pop()!;
    // Scan every complete line before admitting this chunk's ordinary commands.
    // Full parsing detects compact/checksummed M112; text in M117/comments is inert.
    for(let line of parts) {
      if(line.endsWith('\r'))line=line.slice(0,-1);
      if(line.length>65536||/[\r\0]/.test(line))this.#fail(new GCodeError('Invalid G-code input line'));
      if(/[mM]112/.test(line)&&parseCommand(line).command==='M112')
        this.#fail(new GCodeError('Shutdown due to M112 command'));
    }
    if(this.#partial.length>65536)this.#fail(new GCodeError('G-code input line limit'));
    const size=parts.reduce((sum,line)=>sum+line.length+1,0);
    if(this.#characters+size+this.#partial.length>1048576||this.#count+parts.length>16384)
      this.#fail(new GCodeError('G-code input buffer limit'));
    this.#characters+=size;this.#count+=parts.length;this.#lines.push(...parts);
    this.#start();
  }
  #start():void {
    if(!this.#running&&this.#lines.length&&!this.#failure)
      this.#running=this.#pump().finally(()=>{this.#running=undefined;this.#start();});
  }
  async #pump():Promise<void> {
    try {
      while(this.#lines.length&&!this.#failure) {
        const batch=this.#lines.splice(0,128);
        await this.#dispatch.execute(batch.join('\n'),{acknowledge:true});
        if(!this.#failure){this.#count-=batch.length;this.#characters-=batch.reduce((sum,line)=>sum+line.length+1,0);}
      }
    }catch(error) {
      // Store the error for idle()/receive(); never leave an unhandled background rejection.
      if(!this.#failure)try{this.#fail(error instanceof Error?error:new GCodeError('G-code input failed'));}catch{}
    }
  }
  async idle():Promise<void> {while(this.#running)await this.#running;if(this.#failure)throw this.#failure;}
  /** EOF requires complete lines; never execute an unterminated movement command. */
  async end():Promise<void> {
    if(this.#failure)throw this.#failure;this.#ended=true;
    try{this.#decoder.decode();}catch{this.#fail(new GCodeError('Truncated G-code UTF-8'));}
    if(this.#partial.length)this.#fail(new GCodeError('Unterminated G-code input line'));
    await this.idle();
  }
}
