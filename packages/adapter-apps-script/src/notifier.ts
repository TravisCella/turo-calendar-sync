// MailApp-backed Notifier.

import type { Notifier } from '@turo-sync/core';

export class MailNotifier implements Notifier {
  constructor(private recipient: string) {}

  digest(lines: string[]): void {
    if (lines.length === 0) return;
    MailApp.sendEmail({
      to: this.recipient,
      subject: 'Turo Sync: daily digest',
      body: lines.join('\n'),
    });
  }
}
