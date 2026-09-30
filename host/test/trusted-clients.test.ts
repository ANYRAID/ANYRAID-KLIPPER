import test from 'node:test';
import assert from 'node:assert/strict';
import {TrustedClients} from '../src/moonraker/trusted-clients.ts';
import {readAuthorizationOptions} from '../src/moonraker/authorization-config.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
test('explicit trusted IP/CIDR handles boundaries, IPv6 and mapped IPv4; rejects ambiguous policy',()=>{
 const policy=new TrustedClients(['127.0.0.1','192.168.10.0/24','2001:db8::/48','::1']);
 for(const address of ['127.0.0.1','::ffff:127.0.0.1','192.168.10.0','192.168.10.255','2001:db8::','2001:db8:0:ffff::1','::1'])assert(policy.matches(address),address);
 for(const address of ['127.0.0.2','192.168.9.255','192.168.11.0','2001:db8:1::','printer.test','::1%lo',undefined])assert(!policy.matches(address),String(address));
 for(const rule of ['192.168.1.2/24','2001:db8::1/64','192.168.1.0/33','::/129','::/x','*','printer.test','127.1','127.0.0.1/8/3'])assert.throws(()=>new TrustedClients([rule]),TypeError,rule);
 assert(!new TrustedClients().matches('127.0.0.1'));
 const reader=new ConfigurationReader(new ConfigurationSource('/config/main.conf',{server:{},authorization:{trusted_clients:'127.0.0.1, ::1\n192.168.10.0/24'}},[]));assert.deepEqual(readAuthorizationOptions(reader,'http://printer.test').trustedClients,['127.0.0.1','::1','192.168.10.0/24']);assert.equal(reader.validate().length,0);
});
