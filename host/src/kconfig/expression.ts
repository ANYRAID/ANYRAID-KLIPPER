// Kconfig expression grammar follows lib/kconfiglib/kconfiglib.py (ISC).
export type KToken={kind:'word'|'string'|'operator';value:string};
export type KExpression={kind:'symbol'|'literal';value:string}|{kind:'not';value:KExpression}|{kind:'binary';operator:string;left:KExpression;right:KExpression};
export function tokenizeKconfig(source:string):KToken[]{
 if(source.length>65536)throw new Error('Kconfig line limit');const tokens:KToken[]=[];let i=0;
 while(i<source.length){const c=source[i];if(/\s/.test(c)){i++;continue;}if(c==='#')break;
  if(c==='"'||c==="'"){const quote=c;let value='',closed=false;i++;while(i<source.length){const char=source[i++];if(char===quote){closed=true;break;}if(char==='\\'){if(i===source.length)throw new Error('Kconfig dangling escape');value+=source[i++];}else value+=char;}if(!closed)throw new Error('Kconfig unclosed string');tokens.push({kind:'string',value});}
  else{const op=/^(?:&&|\|\||!=|<=|>=|[!()=<>])/.exec(source.slice(i));if(op){tokens.push({kind:'operator',value:op[0]});i+=op[0].length;}else{const word=/^[A-Za-z0-9_./+-]+/.exec(source.slice(i));if(!word)throw new Error('Unsupported Kconfig token at '+i);tokens.push({kind:'word',value:word[0]});i+=word[0].length;}}
  if(tokens.length>4096)throw new Error('Kconfig token limit');
 }return tokens;
}
export function parseKconfigExpression(tokens:readonly KToken[]):KExpression{
 let i=0,depth=0;const atom=():KExpression=>{const t=tokens[i++];if(!t||t.kind==='operator')throw new Error('Expected Kconfig operand');return {kind:t.kind==='string'?'literal':'symbol',value:t.value};};
 const factor=():KExpression=>{if(++depth>128)throw new Error('Kconfig expression depth limit');try{const t=tokens[i];if(t?.value==='!'&&t.kind==='operator'){i++;return {kind:'not',value:factor()};}if(t?.value==='('&&t.kind==='operator'){i++;const value=or();const close=tokens[i++];if(close?.kind!=='operator'||close.value!==')')throw new Error('Expected Kconfig closing parenthesis');return value;}let left=atom();const op=tokens[i];if(op?.kind==='operator'&&['=','!=','<','>','<=','>='].includes(op.value)){i++;left={kind:'binary',operator:op.value,left,right:atom()};}return left;}finally{depth--;}};
 const and=():KExpression=>{let value=factor();while(tokens[i]?.kind==='operator'&&tokens[i]?.value==='&&'){i++;value={kind:'binary',operator:'&&',left:value,right:factor()};}return value;};
 const or=():KExpression=>{let value=and();while(tokens[i]?.kind==='operator'&&tokens[i]?.value==='||'){i++;value={kind:'binary',operator:'||',left:value,right:and()};}return value;};
 const result=or();if(i!==tokens.length)throw new Error('Unexpected Kconfig expression token');return result;
}
export const kconfigYes:KExpression=Object.freeze({kind:'symbol',value:'y'});
