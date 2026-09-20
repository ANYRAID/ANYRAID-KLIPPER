/** Preserve native JSON parsing for normal printer coordinates. When a source
 * may contain a large integer or exponent, inspect numeric tokens before the
 * parsed value can leave this boundary. Never scan digits inside strings. */
export class JsonNumberError extends Error {}
const needsNumberCheck=/\d{16}|[eE][+-]?\d{3,}/;
export function parseRequestJson(text:string):unknown{
 // Native validation happens first, so the scan only handles valid JSON and
 // does not implement a second JSON grammar or recursive object traversal.
 const result:unknown=JSON.parse(text);if(!needsNumberCheck.test(text))return result;
 for(let i=0;i<text.length;){
  const code=text.charCodeAt(i);
  if(code===34){
   let end=text.indexOf('"',i+1);
   for(;;){let previous=end-1;while(text.charCodeAt(previous)===92)previous--;if((end-previous-1)%2===0)break;end=text.indexOf('"',end+1);}
   i=end+1;continue;
  }
  if(code===45||code>=48&&code<=57){
   const start=i;let integer=true;i++;
   for(;i<text.length;i++){const next=text.charCodeAt(i);if(next>=48&&next<=57||next===45||next===43)continue;if(next===46||next===69||next===101){integer=false;continue;}break;}
   const value=Number(text.slice(start,i));if(!Number.isFinite(value))throw new JsonNumberError('JSON number exceeds finite floating-point range');
   if(integer&&!Number.isSafeInteger(value))throw new JsonNumberError('JSON integer exceeds safe range; use a string for exact integers');
   continue;
  }
  i++;
 }
 return result;
}
