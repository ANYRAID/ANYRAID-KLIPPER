import {MachineControlError} from './machine-control.ts';
import type {SystemdProperties} from './system-bus-owner.ts';
export interface ServiceInstallationIdentity {
 read(signal:AbortSignal):Promise<SystemdProperties>;
 current(proof:SystemdProperties):boolean;
}
/** The privileged deployment receipt proves bytes. This independent read-only
 * owner proves the actual current process service; neither replaces the other. */
export class ServiceInstallationProof {
 readonly #source:ServiceInstallationIdentity|undefined;#proof:SystemdProperties|undefined;
 constructor(source:ServiceInstallationIdentity|undefined){if(source&&(!source||typeof source.read!=='function'||typeof source.current!=='function'))throw new TypeError('Invalid installation service identity');this.#source=source;}
 get current(){return !this.#source||this.#proof!==undefined&&this.#source.current(this.#proof);}
 async refresh(signal:AbortSignal,expectedUnit?:string){if(!this.#source)return;const proof=await this.#source.read(signal);signal.throwIfAborted();const value=proof.values;if(!Number.isSafeInteger(proof.generation)||proof.generation<0||!value||typeof value.Id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/u.test(value.Id)||expectedUnit!==undefined&&value.Id!==expectedUnit||value.MainPID!==process.pid||value.LoadState!=='loaded'||typeof value.FragmentPath!=='string'||!value.FragmentPath.startsWith('/')||!this.#source.current(proof))throw new MachineControlError('identity','Installation service properties are unavailable or stale');this.#proof=proof;}
}
