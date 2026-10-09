import type { Clock } from '@turo-sync/core';

export class RealClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}
