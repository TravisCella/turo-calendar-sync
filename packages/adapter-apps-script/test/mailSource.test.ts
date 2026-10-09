import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeGmailThread, makeFakeGmailApp } from './fakes';
import { GmailMailSource, PROCESSED_LABEL } from '../src/mailSource';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GmailMailSource', () => {
  it('fetchNew excludes already-processed threads and returns oldest first', () => {
    const newer = new FakeGmailThread([
      { id: 'm2', date: new Date('2026-09-20T00:00:00Z'), from: 'noreply@mail.turo.com', subject: 'B', body: 'b' },
    ]);
    const older = new FakeGmailThread([
      { id: 'm1', date: new Date('2026-09-10T00:00:00Z'), from: 'noreply@mail.turo.com', subject: 'A', body: 'a' },
    ]);
    const processed = new FakeGmailThread(
      [{ id: 'm0', date: new Date('2026-09-01T00:00:00Z'), from: 'noreply@mail.turo.com', subject: 'Old', body: 'x' }],
      new Set([PROCESSED_LABEL]),
    );

    vi.stubGlobal('GmailApp', makeFakeGmailApp([newer, older, processed]));

    const emails = new GmailMailSource().fetchNew();

    expect(emails.map((e) => e.messageId)).toEqual(['m1', 'm2']);
    expect(emails[0].subject).toBe('A');
    expect(emails[0].textBody).toBe('a');
  });

  it('markProcessed labels the message thread', () => {
    const thread = new FakeGmailThread([
      { id: 'm1', date: new Date(), from: 'noreply@mail.turo.com', subject: 'A', body: 'a' },
    ]);
    vi.stubGlobal('GmailApp', makeFakeGmailApp([thread]));

    new GmailMailSource().markProcessed('m1');

    expect(thread.hasLabel(PROCESSED_LABEL)).toBe(true);
  });
});
