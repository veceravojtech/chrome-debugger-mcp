import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface ConnectionEvents {
  'ws:connected': { version?: string };
  'ws:disconnected': { reason: string };
  'ws:reconnecting': { attempt: number; delayMs: number };
}

const VALID_TRANSITIONS: Record<ConnectionState, ConnectionState[]> = {
  disconnected: ['connecting'],
  connecting: ['connected', 'disconnected'],
  connected: ['disconnected'],
};

export class ConnectionStateMachine extends EventEmitter {
  private state: ConnectionState = 'disconnected';

  get current(): ConnectionState {
    return this.state;
  }

  transition(newState: ConnectionState, payload?: Record<string, unknown>): void {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(newState)) {
      throw new Error(
        `Invalid state transition: ${this.state} → ${newState}`,
      );
    }

    const previousState = this.state;
    this.state = newState;

    logger.info('Connection state changed', {
      from: previousState,
      to: newState,
    });

    if (newState === 'connected') {
      this.emit('ws:connected', payload ?? {});
    } else if (newState === 'disconnected') {
      this.emit('ws:disconnected', payload ?? { reason: 'unknown' });
    }
  }
}
