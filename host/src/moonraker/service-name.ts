/** Wire names preserve the supervisor group. Provider controls still enforce
 * their own exact trusted catalogue; this syntax grants no authority. */
export function validServiceName(value:unknown):value is string{return typeof value==='string'&&value.length<=240&&/^[A-Za-z0-9][A-Za-z0-9_.@-]*(?::[A-Za-z0-9][A-Za-z0-9_.@-]*)?$/u.test(value);}
