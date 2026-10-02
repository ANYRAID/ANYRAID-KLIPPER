#!/usr/bin/env node
// GPL-3.0-or-later. Read-only native product service preparation.
import {productServiceUnitCLI} from '../host/src/runtime/product-service-unit.ts';
try{await productServiceUnitCLI(process.argv.slice(2),text=>process.stdout.write(text));}
catch(error){process.stderr.write('Product Service Error: '+(error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;}
