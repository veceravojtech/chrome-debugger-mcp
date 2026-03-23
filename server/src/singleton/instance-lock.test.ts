import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { acquireInstanceLock, getLockDir, getLockPath } from './instance-lock.js';

function getPort(): number {
  return 9300 + Math.floor(Math.random() * 600);
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
});
