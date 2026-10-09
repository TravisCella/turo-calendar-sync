import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeProperties } from './fakes';
import {
  getLastDigestAt,
  getSpreadsheetId,
  readConfig,
  saveLastDigestAt,
  saveSpreadsheetId,
} from '../src/config';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readConfig', () => {
  it('throws when CALENDAR_ID is not set', () => {
    vi.stubGlobal('PropertiesService', { getScriptProperties: () => makeFakeProperties() });
    expect(() => readConfig()).toThrow(/CALENDAR_ID/);
  });

  it('defaults DRY_RUN to true when unset', () => {
    vi.stubGlobal('PropertiesService', {
      getScriptProperties: () => makeFakeProperties({ CALENDAR_ID: 'cal-1' }),
    });
    expect(readConfig()).toEqual({ calendarId: 'cal-1', dryRun: true });
  });

  it('only turns dry-run off when DRY_RUN is the literal string "false"', () => {
    vi.stubGlobal('PropertiesService', {
      getScriptProperties: () => makeFakeProperties({ CALENDAR_ID: 'cal-1', DRY_RUN: 'false' }),
    });
    expect(readConfig().dryRun).toBe(false);

    vi.stubGlobal('PropertiesService', {
      getScriptProperties: () => makeFakeProperties({ CALENDAR_ID: 'cal-1', DRY_RUN: 'nope' }),
    });
    expect(readConfig().dryRun).toBe(true);
  });
});

describe('spreadsheet id and digest timestamp persistence', () => {
  let props: ReturnType<typeof makeFakeProperties>;

  beforeEach(() => {
    props = makeFakeProperties();
    vi.stubGlobal('PropertiesService', { getScriptProperties: () => props });
  });

  it('round-trips the spreadsheet id', () => {
    expect(getSpreadsheetId()).toBeNull();
    saveSpreadsheetId('sheet-123');
    expect(getSpreadsheetId()).toBe('sheet-123');
  });

  it('round-trips the last digest timestamp', () => {
    expect(getLastDigestAt()).toBeNull();
    saveLastDigestAt('2026-09-01T00:00:00Z');
    expect(getLastDigestAt()).toBe('2026-09-01T00:00:00Z');
  });
});
