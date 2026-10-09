import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailNotifier } from '../src/notifier';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MailNotifier', () => {
  it('sends a digest email with the given lines', () => {
    const sendEmail = vi.fn();
    vi.stubGlobal('MailApp', { sendEmail });

    new MailNotifier('travis.cella@gmail.com').digest(['one thing', 'another thing']);

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'travis.cella@gmail.com', body: 'one thing\nanother thing' }),
    );
  });

  it('sends nothing when there are no lines', () => {
    const sendEmail = vi.fn();
    vi.stubGlobal('MailApp', { sendEmail });

    new MailNotifier('travis.cella@gmail.com').digest([]);

    expect(sendEmail).not.toHaveBeenCalled();
  });
});
