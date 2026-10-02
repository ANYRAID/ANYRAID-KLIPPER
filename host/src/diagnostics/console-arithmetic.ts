// GPL-3.0-or-later. Exact, bounded arithmetic for diagnostic MCU commands.
// No eval, calls, property access, containers, or implicit Number conversion.
export interface ConsoleNumber {readonly numerator:bigint;readonly denominator:bigint;}
const limit=(n:bigint)=>{if(n>=1n<<512n||n<=-(1n<<512n))throw new RangeError('Console arithmetic exceeds 512 bits');return n;};
function rational(n:bigint,d=1n):ConsoleNumber{
 limit(n);limit(d);if(!d)throw new RangeError('Division by zero');if(d<0n){n=-n;d=-d;}
 let a=n<0n?-n:n,b=d;while(b){const next=a%b;a=b;b=next;}return {numerator:n/a,denominator:d/a};
}
export function consoleNumber(text:string):ConsoleNumber{
 if(text.length>160)throw new RangeError('Console number too long');
 if(/^[+-]?0[xob][0-9a-f]+$/i.test(text)){const negative=text[0]==='-',body=/^[+-]/.test(text)?text.slice(1):text;return rational((negative?-1n:1n)*BigInt(body));}
 const match=/^([+-]?)(\d*(?:\.\d*)?)(?:e([+-]?\d+))?$/i.exec(text);if(!match||!/[0-9]/.test(match[2]))throw new TypeError('Invalid console number');
 const exponent=Number(match[3]??0)-(match[2].split('.')[1]?.length??0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>150)throw new RangeError('Console exponent too large');
 const n=BigInt(match[2].replace('.',''))*(match[1]==='-'?-1n:1n);return exponent>=0?rational(n*10n**BigInt(exponent)):rational(n,10n**BigInt(-exponent));
}
const integer=(v:ConsoleNumber)=>{if(v.denominator!==1n)throw new TypeError('Integer operand required');return v.numerator;};
const floor=(n:bigint,d:bigint)=>{if(d<0n){n=-n;d=-d;}if(!d)throw new RangeError('Division by zero');return n/d-(n<0n&&n%d!==0n?1n:0n);};
const precedence:Record<string,number>={'|':1,'^':2,'&':3,'<<':4,'>>':4,'+':5,'-':5,'*':6,'/':6,'//':6,'%':6,'**':8};
function binary(op:string,a:ConsoleNumber,b:ConsoleNumber):ConsoleNumber{
 const n=a.numerator,d=a.denominator,m=b.numerator,e=b.denominator;
 switch(op){case '+':return rational(n*e+m*d,d*e);case '-':return rational(n*e-m*d,d*e);case '*':return rational(n*m,d*e);case '/':return rational(n*e,d*m);
 case '//':return rational(floor(n*e,d*m));case '%':{const q=floor(n*e,d*m);return rational(n*e-q*m*d,d*e);}
 case '**':{const p=integer(b);if(p< -32n||p>32n)throw new RangeError('Power exceeds console limit');return p<0n?rational(d**(-p),n**(-p)):rational(n**p,d**p);}
 case '<<':case '>>':{const shift=integer(b);if(shift<0n||shift>511n)throw new RangeError('Shift exceeds console limit');return rational(op==='<<'?integer(a)<<shift:integer(a)>>shift);}
 case '&':return rational(integer(a)&integer(b));case '|':return rational(integer(a)|integer(b));case '^':return rational(integer(a)^integer(b));default:throw new Error('Unknown console operator');}
}
/** Python-like arithmetic precedence; decimal fractions are exact rational values.
 * Integer conversion happens only at command substitution (truncation toward zero). */
export function evaluateConsoleArithmetic(source:string,variables:ReadonlyMap<string,ConsoleNumber|bigint>):ConsoleNumber{
 if(source.length>2048)throw new RangeError('Console expression too long');const tokens:string[]=[];let offset=0;
 while(offset<source.length){if(/\s/.test(source[offset])){offset++;continue;}const token=/^(?:0[xob][0-9a-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|\*\*|\/\/|<<|>>|[()+\-*/%&|^~])/i.exec(source.slice(offset))?.[0];if(!token)throw new TypeError('Unsupported console expression');tokens.push(token);if(tokens.length>512)throw new RangeError('Too many console tokens');offset+=token.length;}
 let at=0,depth=0;
 const parse=(minimum:number):ConsoleNumber=>{
  if(++depth>64)throw new RangeError('Console expression nested too deeply');let value:ConsoleNumber;const token=tokens[at++];
  if(token==='+'||token==='-'||token==='~'){const operand=parse(7);value=token==='+'?operand:token==='-'?rational(-operand.numerator,operand.denominator):rational(~integer(operand));}
  else if(token==='('){value=parse(0);if(tokens[at++]!==')')throw new TypeError('Unclosed console expression');}
  else if(token&&/^[A-Za-z_]/.test(token)){const found=variables.get(token);if(found===undefined)throw new TypeError('Unknown console variable: '+token);value=typeof found==='bigint'?rational(found):rational(found.numerator,found.denominator);}
  else if(token)value=consoleNumber(token);else throw new TypeError('Missing console operand');
  while(at<tokens.length){const op=tokens[at],priority=precedence[op];if(priority===undefined||priority<minimum)break;at++;value=binary(op,value,parse(op==='**'?priority:priority+1));}
  depth--;return value;
 };
 const value=parse(0);if(at!==tokens.length)throw new TypeError('Unexpected console token');return value;
}
export function substituteConsoleArithmetic(line:string,variables:ReadonlyMap<string,ConsoleNumber|bigint>):string{
 if(line.length>8192)throw new RangeError('Console command too long');let result='',at=0,count=0;
 while(at<line.length){const open=line.indexOf('{',at);if(open<0){result+=line.slice(at);break;}result+=line.slice(at,open);const close=line.indexOf('}',open+1);if(close<0||++count>64)throw new TypeError('Invalid console substitutions');const v=evaluateConsoleArithmetic(line.slice(open+1,close),variables);result+=(v.numerator/v.denominator).toString();at=close+1;}
 if(/[{}]/.test(result))throw new TypeError('Invalid console braces');if(result.length>8192)throw new RangeError('Expanded console command too long');return result;
}
