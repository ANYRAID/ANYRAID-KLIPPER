import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('extruder parameter retirement frees every native allocation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'anyraid-pa-lifetime-'));
 try {
  const source=join(dir,'lifetime.c'),binary=join(dir,'lifetime');
  writeFileSync(source,`
#include <stdlib.h>
#include <assert.h>
static int live;
static void *tracked_malloc(size_t n){void *p=malloc(n);assert(p);live++;return p;}
static void tracked_free(void *p){if(p){live--;assert(live>=0);}free(p);}
#define malloc tracked_malloc
#define free tracked_free
#include "kin_extruder.c"
#undef malloc
#undef free
int main(void){
 for(int round=0;round<100;round++){
  struct stepper_kinematics *sk=extruder_stepper_alloc();
  for(int i=0;i<2000;i++){
   sk->last_flush_time=i*.5;
   extruder_set_pressure_advance(sk,i*.5,(i%2+1)*.02,.04);
   assert(live<=4);
  }
  extruder_stepper_free(sk);assert(live==0);
 }
 return 0;
}
`);
  const cc=spawnSync(process.env.CC??'cc',['-O2','-I'+fileURLToPath(new URL('../../klippy/chelper/',import.meta.url)),source,fileURLToPath(new URL('../../klippy/chelper/trapq.c',import.meta.url)),'-lm','-o',binary],{encoding:'utf8',timeout:30000});assert.equal(cc.status,0,cc.stderr||String(cc.error));
  const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr||String(run.error));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
