import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawEmail } from '../../src/types';

export const FIXTURES_DIR = join(__dirname, '..', '..', 'fixtures', 'turo');

export function loadFixtureEmail(name: string): RawEmail {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.txt`), 'utf-8');
  const separatorIndex = raw.indexOf('\n\n');
  const headerBlock = raw.slice(0, separatorIndex);
  const textBody = raw.slice(separatorIndex + 2);

  const headers: Record<string, string> = {};
  for (const line of headerBlock.split('\n')) {
    const colonIndex = line.indexOf(': ');
    headers[line.slice(0, colonIndex)] = line.slice(colonIndex + 2);
  }

  return {
    messageId: headers['Message-Id'],
    receivedAt: headers['Received-At'],
    from: headers['From'],
    subject: headers['Subject'],
    textBody,
  };
}

export function loadFixtureExpected(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.expected.json`), 'utf-8'));
}
