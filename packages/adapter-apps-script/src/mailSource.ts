// GmailApp-backed MailSource. Query and label from Spec.md "v1 runtime".

import type { MailSource, RawEmail } from '@turo-sync/core';

export const PROCESSED_LABEL = 'TuroSync/Processed';
const SYNC_DAYS = 30;
const BACKFILL_DAYS = 365;

function searchQuery(newerThanDays: number): string {
  return `from:mail.turo.com -label:${PROCESSED_LABEL} newer_than:${newerThanDays}d`;
}

function getOrCreateProcessedLabel(): GoogleAppsScript.Gmail.GmailLabel {
  return GmailApp.getUserLabelByName(PROCESSED_LABEL) ?? GmailApp.createLabel(PROCESSED_LABEL);
}

function threadToEmails(thread: GoogleAppsScript.Gmail.GmailThread): RawEmail[] {
  return thread.getMessages().map((message) => ({
    messageId: message.getId(),
    receivedAt: message.getDate().toISOString(),
    from: message.getFrom(),
    subject: message.getSubject(),
    textBody: message.getPlainBody(),
  }));
}

export class GmailMailSource implements MailSource {
  private fetch(newerThanDays: number): RawEmail[] {
    const threads = GmailApp.search(searchQuery(newerThanDays));
    const emails = threads.flatMap(threadToEmails);
    emails.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
    return emails;
  }

  /** Unprocessed platform emails from the last 30 days, oldest first. */
  fetchNew(): RawEmail[] {
    return this.fetch(SYNC_DAYS);
  }

  /** Unprocessed platform emails from the last 365 days, oldest first — for the first backfill run. */
  fetchBackfill(): RawEmail[] {
    return this.fetch(BACKFILL_DAYS);
  }

  markProcessed(messageId: string): void {
    const message = GmailApp.getMessageById(messageId);
    message.getThread().addLabel(getOrCreateProcessedLabel());
  }
}
