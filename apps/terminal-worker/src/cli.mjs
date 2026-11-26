import { createTerminalClient } from './client.mjs';

const controlDir = process.env.DEVA_TERMINAL_CONTROL_DIR ?? '/run/deva-pty-control';
const [, , action, ...extra] = process.argv;

if (extra.length || !['serve', 'check'].includes(action)) {
  process.stderr.write('Usage: node cli.mjs serve|check\n');
  process.exitCode = 2;
} else if (process.platform !== 'linux' || typeof process.geteuid !== 'function' ||
    process.geteuid() === 0 || process.geteuid() !== process.getuid()) {
  process.stderr.write('The terminal viewer needs a non-root Linux account\n');
  process.exitCode = 1;
} else if (action === 'check') {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    process.exitCode = (await createTerminalClient({ runDir: controlDir }).probe({ signal: controller.signal })) ? 0 : 1;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
} else {
  let service;
  let stopping = false;
  const stop = () => {
    stopping = true;
    service?.close().catch(() => {
      process.stderr.write('Terminal worker cleanup failed\n');
      process.exitCode = 1;
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    const { startTerminalServer } = await import('./server.mjs');
    service = await startTerminalServer({ runDir: controlDir });
    if (stopping) stop();
  } catch {
    process.stderr.write('Terminal worker failed to start\n');
    process.exitCode = 1;
  }
}
