import { describe, it, expect, vi } from 'vitest';
import { ConnectionStateMachine } from './connection-state.js';

describe('ConnectionStateMachine', () => {
  it('should start in disconnected state', () => {
    const sm = new ConnectionStateMachine();
    expect(sm.current).toBe('disconnected');
  });

  it('should allow disconnected → connecting', () => {
    const sm = new ConnectionStateMachine();
    sm.transition('connecting');
    expect(sm.current).toBe('connecting');
  });

  it('should allow connecting → connected', () => {
    const sm = new ConnectionStateMachine();
    sm.transition('connecting');
    sm.transition('connected');
    expect(sm.current).toBe('connected');
  });

  it('should allow connecting → disconnected', () => {
    const sm = new ConnectionStateMachine();
    sm.transition('connecting');
    sm.transition('disconnected');
    expect(sm.current).toBe('disconnected');
  });

  it('should allow connected → disconnected', () => {
    const sm = new ConnectionStateMachine();
    sm.transition('connecting');
    sm.transition('connected');
    sm.transition('disconnected');
    expect(sm.current).toBe('disconnected');
  });

  it('should reject invalid transition: disconnected → connected', () => {
    const sm = new ConnectionStateMachine();
    expect(() => sm.transition('connected')).toThrow(
      'Invalid state transition: disconnected → connected',
    );
  });

  it('should reject invalid transition: connected → connecting', () => {
    const sm = new ConnectionStateMachine();
    sm.transition('connecting');
    sm.transition('connected');
    expect(() => sm.transition('connecting')).toThrow(
      'Invalid state transition: connected → connecting',
    );
  });

  it('should emit ws:connected event on connected', () => {
    const sm = new ConnectionStateMachine();
    const handler = vi.fn();
    sm.on('ws:connected', handler);

    sm.transition('connecting');
    sm.transition('connected', { version: '1.0.0' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ version: '1.0.0' });
  });

  it('should emit ws:disconnected event on disconnected', () => {
    const sm = new ConnectionStateMachine();
    const handler = vi.fn();
    sm.on('ws:disconnected', handler);

    sm.transition('connecting');
    sm.transition('connected');
    sm.transition('disconnected', { reason: 'pong timeout' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ reason: 'pong timeout' });
  });

  it('should emit ws:disconnected with default reason when no payload', () => {
    const sm = new ConnectionStateMachine();
    const handler = vi.fn();
    sm.on('ws:disconnected', handler);

    sm.transition('connecting');
    sm.transition('disconnected');

    expect(handler).toHaveBeenCalledWith({ reason: 'unknown' });
  });

  it('should not emit events for connecting transition', () => {
    const sm = new ConnectionStateMachine();
    const connected = vi.fn();
    const disconnected = vi.fn();
    sm.on('ws:connected', connected);
    sm.on('ws:disconnected', disconnected);

    sm.transition('connecting');

    expect(connected).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
  });
});
