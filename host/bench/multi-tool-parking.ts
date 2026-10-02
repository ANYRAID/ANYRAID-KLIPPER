import {NativePauseParking} from '../src/operations/native-pause-parking.ts';
const signal=new AbortController().signal,single:number[]=[],multi:number[]=[];
for(let round=0;round<8;round++)for(const dual of round%2?[true,false]:[false,true]){
 let position=dual?[10,20,30,40,50]:[10,20,30,40];
 const port={pause:async()=>({position:[...position],sourceTime:1}),validatePausedPath(legs:readonly {position:readonly number[]}[]){if(legs.some(l=>l.position.length!==position.length||!l.position.every(Number.isFinite)))throw Error('Invalid path');},movePaused:async(p:readonly number[])=>{position=[...p];},resumeStream:async()=>{},motorOff:async()=>{throw Error('Unexpected stop');}};
 const parking=new NativePauseParking(port,{parkXY:[5,6],retract:1,lift:2,travelSpeed:30,liftSpeed:5,retractSpeed:10},undefined,dual?()=>4:undefined),start=performance.now();
 for(let i=0;i<1000;i++){await parking.pause(signal);await parking.resume(signal);}const elapsed=performance.now()-start;
 if(position[3]!==40||dual&&position[4]!==50)throw Error('Extrusion coordinate drift');if(round>=3)(dual?multi:single).push(elapsed/1000);
}
console.log(JSON.stringify({runtime:process.version,scope:'Per pause/resume orchestration over in-memory acknowledged port, six moves and complete path validation, 1000 cycles per sample; excludes native planning, MCU IO and physical travel',single:{samplesMs:single,medianMs:[...single].sort((a,b)=>a-b)[2]},multi:{samplesMs:multi,medianMs:[...multi].sort((a,b)=>a-b)[2]}},null,2));
