#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const tsxCli = require.resolve('tsx/cli');
const entry = join(__dirname, '..', 'cli', 'index.ts');
const tsconfig = join(__dirname, '..', 'cli', 'tsconfig.json');

const child = spawn(
  process.execPath,
  [tsxCli, '--tsconfig', tsconfig, entry, ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
