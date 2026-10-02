export function templateRoundCases(){
 const values=[2.675,-2.675,1.005,-1.005,0,-0,Number.MIN_VALUE,Number.MAX_VALUE,1e-300,-1e-300,1e23,-1e23,1e100,-1e100];let seed=123;for(let i=0;i<150;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;values.push((seed/2**32-.5)*10**(i%40-20));}
 const adjacent=new DataView(new ArrayBuffer(8));for(let p=0;p<16;p++)for(const odd of [1,3,21,127])for(const sign of [-1,1]){const value=sign*odd/2**(p+1);adjacent.setFloat64(0,value);const bits=adjacent.getBigUint64(0);for(const offset of [-1n,0n,1n]){adjacent.setBigUint64(0,bits+offset);values.push(adjacent.getFloat64(0));}}
 const cases=values.flatMap(value=>[-324,-323,-308,-23,-2,...Array.from({length:16},(_,i)=>i),23,100,308,309,324].flatMap(precision=>['common','ceil','floor'].map(method=>({value:Object.is(value,-0)?'-0.0':String(value),precision,method}))));
 return cases;
}
