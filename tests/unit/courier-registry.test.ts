import { describe, expect, it } from 'vitest';
import { CourierRegistry } from '../../src/couriers/courier.registry';
import { MockCourierAdapter } from '../../src/couriers/mock/mock.adapter';
import { AppError } from '../../src/errors/app-error';
import { ErrorCode } from '../../src/errors/error-codes';

function buildRegistry(): CourierRegistry {
  const registry = new CourierRegistry();
  registry.register('mock', () => new MockCourierAdapter({ latencyMs: 0, failPincode: '000000' }));
  return registry;
}

describe('CourierRegistry', () => {
  it('resolves a registered courier', () => {
    expect(buildRegistry().get('mock').name).toBe('mock');
  });

  it('memoises the adapter instance so state and connections are shared', () => {
    const registry = buildRegistry();
    expect(registry.get('mock')).toBe(registry.get('mock'));
  });

  it('constructs adapters lazily, so a misconfigured courier cannot break boot', () => {
    const registry = new CourierRegistry();
    registry.register('explodes', () => {
      throw new Error('missing credentials');
    });

    expect(registry.list()).toContain('explodes'); // registration succeeded
    expect(() => registry.get('explodes')).toThrow('missing credentials');
  });

  it('matches courier_partner case-insensitively and ignores surrounding space', () => {
    const registry = buildRegistry();
    expect(registry.get('  MOCK ').name).toBe('mock');
    expect(registry.has('Mock')).toBe(true);
  });

  it('rejects an unknown courier with a 400 that lists the supported couriers', () => {
    const registry = buildRegistry();

    let caught: AppError | undefined;
    try {
      registry.get('delhivery');
    } catch (error) {
      caught = error as AppError;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.code).toBe(ErrorCode.UNSUPPORTED_COURIER);
    expect(caught!.httpStatus).toBe(400);
    expect(caught!.details).toEqual({ supported_couriers: ['mock'] });
  });

  it('refuses a duplicate registration rather than silently shadowing', () => {
    const registry = buildRegistry();
    expect(() => registry.register('mock', () => registry.get('mock'))).toThrow(
      /already registered/i,
    );
  });

  it('lists couriers in a stable, sorted order', () => {
    const registry = buildRegistry();
    registry.register('aaa', () => registry.get('mock'));
    registry.register('zzz', () => registry.get('mock'));
    expect(registry.list()).toEqual(['aaa', 'mock', 'zzz']);
  });
});
