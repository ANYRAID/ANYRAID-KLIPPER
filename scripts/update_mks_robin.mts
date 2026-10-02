#!/usr/bin/env node
// GPL-3.0-or-later. Node.js 26 firmware format converter.
import {firmwareCLI} from '../host/src/build/firmware-cli.ts';
try{await firmwareCLI('robin');}catch(error){console.error(error instanceof Error?error.message:'Firmware conversion failed');process.exitCode=1;}
