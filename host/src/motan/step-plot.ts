// GPL-3.0-or-later. Step vertices compatible with Matplotlib's drawstyle rules.
export type MotanDrawStyle='default'|'steps'|'steps-pre'|'steps-post'|'steps-mid';
export const motanDrawStyles:readonly string[]=['default','steps','steps-pre','steps-post','steps-mid'];
export function motanStepPointCount(count:number,drawstyle:MotanDrawStyle):number{
 if(!Number.isSafeInteger(count)||count<0||!motanDrawStyles.includes(drawstyle))throw new RangeError('Invalid step plot request');
 return count===0?0:drawstyle==='default'?count:drawstyle==='steps-mid'?2*count:2*count-1;
}
export function motanStepVertices(x:readonly number[],y:readonly number[],drawstyle:MotanDrawStyle):{x:number[];y:number[]}{
 const size=motanStepPointCount(x.length,drawstyle);
 if(x.length!==y.length||size>500000)throw new RangeError('Step plot point limit or length mismatch');
 for(let i=0;i<x.length;i++)if(!Number.isFinite(x[i])||!Number.isFinite(y[i]))throw new Error('Nonfinite step plot coordinate');
 const xx=new Array<number>(size),yy=new Array<number>(size);
 if(!size)return {x:xx,y:yy};
 if(drawstyle==='default'){for(let i=0;i<x.length;i++){xx[i]=x[i];yy[i]=y[i];}}
 else if(drawstyle==='steps-mid'){
  xx[0]=x[0];yy[0]=y[0];
  for(let i=0;i<x.length-1;i++){
   const middle=(x[i]+x[i+1])/2;if(!Number.isFinite(middle))throw new Error('Step midpoint overflow');
   xx[2*i+1]=xx[2*i+2]=middle;yy[2*i+1]=y[i];yy[2*i+2]=y[i+1];
  }
  xx[size-1]=x.at(-1)!;yy[size-1]=y.at(-1)!;
 }else{
  for(let i=0;i<x.length;i++){
   xx[2*i]=x[i];yy[2*i]=y[i];
   if(i<x.length-1){xx[2*i+1]=drawstyle==='steps-post'?x[i+1]:x[i];yy[2*i+1]=drawstyle==='steps-post'?y[i]:y[i+1];}
  }
 }
 return {x:xx,y:yy};
}
