import {frozenKatapultReference} from './katapult-contract.ts';
export function firmwareIdentityReference(image:Uint8Array,runs=1):{identity:{mcu?:string;version?:string}|null;samples:number[];python:string}{return frozenKatapultReference('identity',{image:Buffer.from(image).toString('hex'),runs});
}
