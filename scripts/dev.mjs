import { spawn } from 'node:child_process';

const commands = [
  {
    name: 'api',
    command: process.execPath,
    args: ['server/index.mjs'],
  },
  {
    name: 'vite',
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['vite', '--host', '0.0.0.0'],
  },
];

let shuttingDown = false;

const children = commands.map(({ name, command, args }) => {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });
  child.on('exit', (code) => {
    if (code && !shuttingDown) {
      shutdown(code);
    }
  });

  return child;
});

function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    child.kill();
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
