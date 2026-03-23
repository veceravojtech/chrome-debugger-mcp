type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let currentLevel: LogLevel = 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[currentLevel];
}

function write(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry: Record<string, unknown> = {
    level,
    timestamp: Date.now(),
    message,
    ...extra,
  };

  process.stderr.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  error(message: string, extra?: Record<string, unknown>): void {
    write('error', message, extra);
  },

  warn(message: string, extra?: Record<string, unknown>): void {
    write('warn', message, extra);
  },

  info(message: string, extra?: Record<string, unknown>): void {
    write('info', message, extra);
  },

  debug(message: string, extra?: Record<string, unknown>): void {
    write('debug', message, extra);
  },

  setLevel(level: LogLevel): void {
    currentLevel = level;
  },
};
