import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  acquireInstanceLock,
  findPidOnPort,
  getLockDir,
  getLockPath,
  isOurProcess,
} from './instance-lock.js';
import { McpError } from '../errors/mcp-error.js';
import { ErrorCode } from '../errors/error-codes.js';

function getPort(): number {
  return 9300 + Math.floor(Math.random() * 600);
}

// Spawn a long-lived node child; pass 'chrome-debugger-mcp' in argv to make it
// look like one of ours (isOurProcess matches on the full command line).
async function spawnLiveChild(...extraArgs: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...extraArgs], {
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  return child;
}

// Temporarily override process.platform to exercise non-Linux branches.
// ps and lsof exist on Linux too, so the darwin code paths run for real.
function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return fn().finally(() => {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  });
}

describe('InstanceLock', () => {
  let cleanupPaths: string[] = [];

  beforeEach(() => {
    cleanupPaths = [];
  });

  afterEach(async () => {
    for (const p of cleanupPaths) {
      try {
        await rm(p, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  describe('getLockDir', () => {
    it('should use $XDG_RUNTIME_DIR when set', () => {
      const original = process.env.XDG_RUNTIME_DIR;
      try {
        process.env.XDG_RUNTIME_DIR = '/run/user/1000';
        expect(getLockDir()).toBe('/run/user/1000/chrome-debugger-mcp');
      } finally {
        if (original !== undefined) {
          process.env.XDG_RUNTIME_DIR = original;
        } else {
          delete process.env.XDG_RUNTIME_DIR;
        }
      }
    });

    it('should fallback to /tmp/chrome-debugger-mcp-{uid} when XDG_RUNTIME_DIR unset', () => {
      const original = process.env.XDG_RUNTIME_DIR;
      try {
        delete process.env.XDG_RUNTIME_DIR;
        const uid = process.getuid!();
        expect(getLockDir()).toBe(path.join(os.tmpdir(), `chrome-debugger-mcp-${uid}`));
      } finally {
        if (original !== undefined) {
          process.env.XDG_RUNTIME_DIR = original;
        } else {
          delete process.env.XDG_RUNTIME_DIR;
        }
      }
    });
  });

  describe('getLockPath', () => {
    it('should include port in lock file name', () => {
      const lockPath = getLockPath(9222);
      expect(lockPath).toMatch(/server-9222\.lock$/);
    });
  });

  describe('acquireInstanceLock', () => {
    it('should acquire lock on first call with no existing server', async () => {
      const port = getPort();
      const lockPath = getLockPath(port);
      cleanupPaths.push(getLockDir());

      await acquireInstanceLock(port);

      const content = await readFile(lockPath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(parseInt(lines[0], 10)).toBe(process.pid);
      expect(parseInt(lines[1], 10)).toBe(port);
    });

    it('should create lock directory if it does not exist', async () => {
      const port = getPort();
      const lockDir = getLockDir();
      cleanupPaths.push(lockDir);

      // Ensure directory doesn't exist
      try {
        await rm(lockDir, { recursive: true, force: true });
      } catch {
        // May not exist
      }

      await acquireInstanceLock(port);

      const lockPath = getLockPath(port);
      const content = await readFile(lockPath, 'utf-8');
      expect(content).toContain(String(process.pid));
    });

    it('should write PID and port to lock file after acquisition', async () => {
      const port = getPort();
      cleanupPaths.push(getLockDir());

      await acquireInstanceLock(port);

      const lockPath = getLockPath(port);
      const content = await readFile(lockPath, 'utf-8');
      expect(content).toBe(`${process.pid}\n${port}\n`);
    });
  });

  describe('stale lock recovery', () => {
    it('should handle stale lock from a dead process gracefully', async () => {
      const port = getPort();
      const lockDir = getLockDir();
      const lockPath = getLockPath(port);
      cleanupPaths.push(lockDir);

      // Create a lock file with a non-existent PID
      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      await writeFile(lockPath, '999999999\n' + port + '\n', { mode: 0o600 });

      // Should still acquire — stale PID means process is dead
      await acquireInstanceLock(port);

      const content = await readFile(lockPath, 'utf-8');
      expect(parseInt(content.trim().split('\n')[0], 10)).toBe(process.pid);
    });

    it('should handle corrupt lock file', async () => {
      const port = getPort();
      const lockDir = getLockDir();
      const lockPath = getLockPath(port);
      cleanupPaths.push(lockDir);

      // Create a corrupt lock file
      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      await writeFile(lockPath, 'garbage\n', { mode: 0o600 });

      await acquireInstanceLock(port);

      const content = await readFile(lockPath, 'utf-8');
      expect(parseInt(content.trim().split('\n')[0], 10)).toBe(process.pid);
    });

    it('should handle empty lock file', async () => {
      const port = getPort();
      const lockDir = getLockDir();
      const lockPath = getLockPath(port);
      cleanupPaths.push(lockDir);

      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      await writeFile(lockPath, '', { mode: 0o600 });

      await acquireInstanceLock(port);

      const content = await readFile(lockPath, 'utf-8');
      expect(parseInt(content.trim().split('\n')[0], 10)).toBe(process.pid);
    });
  });

  describe('isOurProcess', () => {
    let children: ChildProcess[] = [];

    afterEach(() => {
      for (const child of children) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead
        }
      }
      children = [];
    });

    it('should return true for a live process with chrome-debugger-mcp in its command line', async () => {
      const child = await spawnLiveChild('chrome-debugger-mcp-marker');
      children.push(child);

      expect(await isOurProcess(child.pid!)).toBe(true);
    });

    it('should return false for a live unrelated process', async () => {
      const child = await spawnLiveChild();
      children.push(child);

      expect(await isOurProcess(child.pid!)).toBe(false);
    });

    it('should return false for a dead process', async () => {
      expect(await isOurProcess(999999999)).toBe(false);
    });

    it('should work without /proc via the ps fallback (darwin path)', async () => {
      const ours = await spawnLiveChild('chrome-debugger-mcp-marker');
      const unrelated = await spawnLiveChild();
      children.push(ours, unrelated);

      await withPlatform('darwin', async () => {
        expect(await isOurProcess(ours.pid!)).toBe(true);
        expect(await isOurProcess(unrelated.pid!)).toBe(false);
        expect(await isOurProcess(999999999)).toBe(false);
      });
    });
  });

  describe('findPidOnPort', () => {
    let server: net.Server | null = null;

    afterEach(async () => {
      if (server) {
        await new Promise((r) => server!.close(r));
        server = null;
      }
    });

    async function listenOnEphemeralPort(): Promise<number> {
      server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '127.0.0.1', resolve);
      });
      return (server!.address() as net.AddressInfo).port;
    }

    it('should find our own listener (native platform path)', async () => {
      const port = await listenOnEphemeralPort();
      expect(await findPidOnPort(port)).toBe(process.pid);
    });

    it('should find our own listener via lsof (darwin path)', async () => {
      const port = await listenOnEphemeralPort();
      await withPlatform('darwin', async () => {
        expect(await findPidOnPort(port)).toBe(process.pid);
      });
    });

    it('should return null when nothing listens on the port', async () => {
      const port = await listenOnEphemeralPort();
      await new Promise((r) => server!.close(r));
      server = null;
      expect(await findPidOnPort(port)).toBe(null);
    });
  });

  describe('takeover', () => {
    let children: ChildProcess[] = [];

    afterEach(() => {
      for (const child of children) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already dead
        }
      }
      children = [];
    });

    it('should refuse takeover when the lock is held by a live unrelated process', async () => {
      const port = getPort();
      const lockDir = getLockDir();
      const lockPath = getLockPath(port);
      cleanupPaths.push(lockDir);

      const unrelated = await spawnLiveChild();
      children.push(unrelated);

      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      await writeFile(lockPath, `${unrelated.pid}\n${port}\n`, { mode: 0o600 });

      await expect(acquireInstanceLock(port)).rejects.toMatchObject({
        code: ErrorCode.SINGLETON_TAKEOVER_FAILED,
      });
      await expect(acquireInstanceLock(port)).rejects.toBeInstanceOf(McpError);
    });

    it('should take over a live previous server (SIGTERM) — the macOS regression', async () => {
      const port = getPort();
      const lockDir = getLockDir();
      const lockPath = getLockPath(port);
      cleanupPaths.push(lockDir);

      const previous = await spawnLiveChild('chrome-debugger-mcp-marker');
      children.push(previous);

      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      await writeFile(lockPath, `${previous.pid}\n${port}\n`, { mode: 0o600 });

      await acquireInstanceLock(port);

      const content = await readFile(lockPath, 'utf-8');
      expect(parseInt(content.trim().split('\n')[0], 10)).toBe(process.pid);
      // Previous server must have been terminated by the takeover
      expect(await isOurProcess(previous.pid!)).toBe(false);
    });

    it('should take over a live previous server via the ps fallback (darwin path)', async () => {
      const port = getPort();
      const lockDir = getLockDir();
      const lockPath = getLockPath(port);
      cleanupPaths.push(lockDir);

      const previous = await spawnLiveChild('chrome-debugger-mcp-marker');
      children.push(previous);

      await mkdir(lockDir, { recursive: true, mode: 0o700 });
      await writeFile(lockPath, `${previous.pid}\n${port}\n`, { mode: 0o600 });

      await withPlatform('darwin', async () => {
        await acquireInstanceLock(port);
      });

      const content = await readFile(lockPath, 'utf-8');
      expect(parseInt(content.trim().split('\n')[0], 10)).toBe(process.pid);
    });
  });
});
