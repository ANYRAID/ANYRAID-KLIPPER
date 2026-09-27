#!/usr/bin/env node
import {enableCompileCache} from 'node:module';
try {
    if (Number(process.versions.node.split('.')[0]) !== 26)
        throw new Error('Node.js 26 is required');
    enableCompileCache();
    const {runKconfigMenu} = await import('../host/src/kconfig/menu-cli.ts');
    await runKconfigMenu();
} catch (error) {
    console.error('Kconfig menu failed: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
}
