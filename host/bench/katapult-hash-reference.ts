import {frozenKatapultReference} from './katapult-contract.ts';
export function katapultHashReference(cases:{hex:string;seed:string}[],runs=1):{hashes:string[];uuids:string[];samples:number[];python:string}{return frozenKatapultReference('hash',{cases,runs});
}
