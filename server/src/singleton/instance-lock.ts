import { open, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { logger } from '../logger.js';
import { McpError } from '../errors/mcp-error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { SINGLETON_LOCK_TIMEOUT_MS, SIGKILL_TIMEOUT_MS } from '../types.js';

const POLL_INTERVAL_MS = 100;
const CLAIM_RETRY_INTERVAL_MS = 200;
const CLAIM_TIMEOUT_MS = 10_000;

export function getLockDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return path.join(xdg, 'chrome-debugger-mcp');
  return path.join(os.tmpdir(), `chrome-debugger-mcp-${process.getuid!()}`);
}

export function getLockPath(port: number): string {
  return path.join(getLockDir(), `server-${port}.lock`);
}

function getClaimPath(port: number): string {
  return path.join(getLockDir(), `server-${port}.claim`);
}

async function isOurProcess(pid: number): Promise<boolean> {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf-8');
    return cmdline.includes('chrome-debugger-mcp');
  } catch {
    return false; // Process doesn't exist
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessDeath(pid: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (!isProcessAlive(pid)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('PROCESS_TIMEOUT'));
        return;
      }
      setTimeout(check, POLL_INTERVAL_MS);
    };
    check();
  });
}

interface LockInfo {
  pid: number;
  port: number;
}

async function readLockFile(lockPath: string): Promise<LockInfo | null> {
  try {
    const content = await readFile(lockPath, 'utf-8');
    const lines = content.trim().split('\n');
    const pid = parseInt(lines[0], 10);
    const port = parseInt(lines[1], 10);
    if (isNaN(pid) || isNaN(port)) return null;
    return { pid, port };
  } catch {
    return null;
  }
}

async function writeLockFile(lockPath: string, pid: number, port: number): Promise<void> {
  const tmpPath = lockPath + '.tmp';
  await writeFile(tmpPath, `${pid}\n${port}\n`, { mode: 0o600 });
  await rename(tmpPath, lockPath);
}

/**
 * Acquire an exclusive claim using O_EXCL (atomic kernel-level create-or-fail).
 * Returns true if we won the claim, false if another process claimed first.
 * Stale claims (owner dead) are cleaned up and retried.
 */
async function tryAcquireClaim(port: number): Promise<boolean> {
  const claimPath = getClaimPath(port);
  const content = `${process.pid}\n`;

  try {
    // O_WRONLY | O_CREAT | O_EXCL — fails atomically if file already exists
    const fh = await open(claimPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await fh.write(content, 0);
    await fh.close();
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    // Claim file exists — check if the claimer is still alive
    const claimInfo = await readLockFile(claimPath);
    if (claimInfo && isProcessAlive(claimInfo.pid)) {
      return false; // Another live process owns the claim
    }

    // Stale claim — remove and retry
    try {
      await unlink(claimPath);
    } catch {
      // Another process may have already cleaned it up
    }
    return tryAcquireClaim(port);
  }
}

/**
 * Wait until we can acquire the claim, with timeout.
 */
async function acquireClaim(port: number): Promise<void> {
  const deadline = Date.now() + CLAIM_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await tryAcquireClaim(port)) return;
    await new Promise((r) => setTimeout(r, CLAIM_RETRY_INTERVAL_MS));
  }

  throw new McpError(
    ErrorCode.SINGLETON_TAKEOVER_FAILED,
    'Timed out waiting to acquire singleton claim',
    { port },
    'Another server instance is already performing a takeover. Try again.',
    true,
  );
}

async function releaseClaim(port: number): Promise<void> {
  try {
    await unlink(getClaimPath(port));
  } catch {
    // Already removed
  }
}

async function killExistingServer(lockPath: string): Promise<void> {
  const info = await readLockFile(lockPath);
  if (!info) {
    logger.warn('Could not read lock file contents, proceeding with takeover');
    return;
  }

  const { pid } = info;

  // Check if the process is still alive
  if (!isProcessAlive(pid)) {
    logger.info('Stale lock file found, previous process already dead', { pid });
    return;
  }

  // Validate it's our process
  const ours = await isOurProcess(pid);
  if (!ours) {
    throw new McpError(
      ErrorCode.SINGLETON_TAKEOVER_FAILED,
      `Port held by unrelated process (PID ${pid})`,
      { pid },
      'Another process is using this port. Stop it manually or choose a different port.',
      false,
    );
  }

  // It's our process — send SIGTERM
  logger.info('Sending SIGTERM to existing server', { pid });
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process may have already exited
    return;
  }

  // Wait for process death with timeout
  try {
    await waitForProcessDeath(pid, SINGLETON_LOCK_TIMEOUT_MS);
    logger.info('Existing server terminated via SIGTERM', { pid });
  } catch {
    // Escalate to SIGKILL
    logger.warn('SIGTERM timeout — escalating to SIGKILL', { pid });
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already dead
      return;
    }

    try {
      await waitForProcessDeath(pid, SIGKILL_TIMEOUT_MS);
      logger.info('Existing server terminated via SIGKILL', { pid });
    } catch {
      throw new McpError(
        ErrorCode.SINGLETON_TAKEOVER_FAILED,
        'Failed to kill existing server after SIGKILL',
        { pid },
        'Could not take over the existing server instance.',
        false,
      );
    }
  }
}

/**
 * Find the PID of a process listening on a given port via /proc/net/tcp.
 * Fallback for when no lock file exists (e.g. legacy server without singleton module).
 */
export async function findPidOnPort(port: number): Promise<number | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const { stdout } = await execFileAsync('ss', ['-tlnp', `sport = :${port}`]);
    // Parse ss output for pid=NNNN
    const match = stdout.match(/pid=(\d+)/);
    if (match) return parseInt(match[1], 10);
  } catch {
    // ss not available or failed
  }
  return null;
}

export async function acquireInstanceLock(port: number): Promise<void> {
  const lockDir = getLockDir();
  const lockPath = getLockPath(port);

  // Ensure lock directory exists
  await mkdir(lockDir, { recursive: true, mode: 0o700 });

  // Acquire exclusive claim (serializes concurrent acquirers via O_EXCL)
  await acquireClaim(port);

  try {
    // Check for existing lock
    const existing = await readLockFile(lockPath);
    if (existing && isProcessAlive(existing.pid)) {
      logger.info('Lock held by existing server, initiating takeover', { port, existingPid: existing.pid });
      await killExistingServer(lockPath);
    }

    // Write our PID atomically
    await writeLockFile(lockPath, process.pid, port);

    logger.info('Singleton lock acquired', { port, pid: process.pid, lockPath });
  } finally {
    // Release claim — the lock file now serves as the persistent record
    await releaseClaim(port);
  }
}

/**
 * Kill whatever process holds the port — fallback when no lock file exists.
 * Used when bridge.ready() fails with EADDRINUSE after lock was acquired.
 */
export async function killProcessOnPort(port: number): Promise<void> {
  const pid = await findPidOnPort(port);
  if (!pid) {
    logger.warn('Could not find process on port — may be TIME_WAIT', { port });
    // Wait for TIME_WAIT to clear
    await new Promise((r) => setTimeout(r, 1000));
    return;
  }

  if (pid === process.pid) return; // Don't kill ourselves

  const ours = await isOurProcess(pid);
  if (!ours) {
    throw new McpError(
      ErrorCode.SINGLETON_TAKEOVER_FAILED,
      `Port ${port} held by unrelated process (PID ${pid})`,
      { pid, port },
      'Another process is using this port. Stop it manually or choose a different port.',
      false,
    );
  }

  logger.info('Killing legacy server on port (no lock file)', { pid, port });
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  try {
    await waitForProcessDeath(pid, SINGLETON_LOCK_TIMEOUT_MS);
    logger.info('Legacy server terminated', { pid });
  } catch {
    logger.warn('SIGTERM timeout for legacy server — escalating to SIGKILL', { pid });
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return;
    }
    await waitForProcessDeath(pid, SIGKILL_TIMEOUT_MS).catch(() => {
      throw new McpError(
        ErrorCode.SINGLETON_TAKEOVER_FAILED,
        'Failed to kill legacy server after SIGKILL',
        { pid, port },
        'Could not take over the port.',
        false,
      );
    });
  }

  // Wait for port to be released
  await new Promise((r) => setTimeout(r, 300));
}
