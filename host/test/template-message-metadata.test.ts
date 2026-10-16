import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
interface Handle{render(context:string,names:string[],id:number,timeout:number):void;close():void;}
interface Executor{readonly callProtocol?:number;createTemplate(source:string,secrets:string,file:string,type:string,ui:boolean):Handle;respond(id:number,call:number,value?:string):boolean;close():void;}
const addon=createRequire(import.meta.url)('../build/template.node') as {NativeTemplateExecutor:new(callback:(message:unknown,id:number,failed:boolean)=>void,structured?:boolean)=>Executor};
for(const overflow of[false,true])test(`complete message cap includes maximum render identity and two-digit call sequence (${overflow})`,{timeout:10000},async()=>{
 for(const structured of[false,true]){
  const id=0xffffffff,name='fetch',overhead=Buffer.byteLength(JSON.stringify({render:id,call:64,name,args:[['string','']],kwargs:[]})),payload='x'.repeat(65536-overhead+(overflow?1:0)),completed=Promise.withResolvers<{message:unknown;failed:boolean}>();let calls=0,native:Executor|undefined,handle:Handle|undefined;
  const timer=setTimeout(()=>completed.reject(new Error('Metadata boundary regression timed out')),5000);
  try{
   native=new addon.NativeTemplateExecutor((message,render,failed)=>{try{
    if(render!==0){assert.equal(render,id);completed.resolve({message,failed});return;}
    const row=typeof message==='string'?JSON.parse(message):message as any;assert.equal(native!.callProtocol===2,typeof message==='object');assert.equal(row.render,id);assert.equal(row.call,++calls);assert.equal(row.name,name);assert.deepEqual(row.args,[['string',payload]]);assert.deepEqual(row.kwargs,[]);
    const bytes=Buffer.byteLength(JSON.stringify(row));assert(bytes<=65536);if(calls===64)assert.equal(bytes,65536);assert.equal(native!.respond(id,calls,'["none"]'),true);
   }catch(error){completed.reject(error);}},structured);
   handle=native.createTemplate('{% for i in range(64) %}{{fetch(message)}}{% endfor %}','{}','','json',true);handle.render(JSON.stringify({message:payload}),[name],id,5000);
   const result=await completed.promise;assert.equal(result.failed,overflow);assert.equal(calls,overflow?9:64);if(!overflow)assert.equal(result.message,'None'.repeat(64));
  }finally{clearTimeout(timer);handle?.close();native?.close();}
 }
});
