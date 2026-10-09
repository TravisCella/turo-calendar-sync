import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(__dirname, '..', 'src');
const APPSSCRIPT_JSON = join(__dirname, '..', 'appsscript.json');

// Apps Script global -> the OAuth scope calling it requires. Core services
// with no additional scope of their own (LockService, PropertiesService,
// Utilities) are deliberately left out.
const REQUIRED_SCOPES: Record<string, string> = {
  GmailApp: 'https://www.googleapis.com/auth/gmail.modify',
  CalendarApp: 'https://www.googleapis.com/auth/calendar',
  SpreadsheetApp: 'https://www.googleapis.com/auth/spreadsheets',
  MailApp: 'https://www.googleapis.com/auth/script.send_mail',
  Session: 'https://www.googleapis.com/auth/userinfo.email',
  ScriptApp: 'https://www.googleapis.com/auth/script.scriptapp',
};

function readAllSource(): string {
  return readdirSync(SRC_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(join(SRC_DIR, file), 'utf-8'))
    .join('\n');
}

describe('appsscript.json oauthScopes', () => {
  it('lists a scope for every Apps Script global the adapter source actually calls', () => {
    const source = readAllSource();
    const { oauthScopes } = JSON.parse(readFileSync(APPSSCRIPT_JSON, 'utf-8'));

    const globalsUsed = Object.keys(REQUIRED_SCOPES).filter((global) =>
      new RegExp(`\\b${global}\\.`).test(source),
    );
    // If this finds nothing, the scan itself is broken (e.g. SRC_DIR is wrong).
    expect(globalsUsed.length).toBeGreaterThan(0);

    for (const global of globalsUsed) {
      const scope = REQUIRED_SCOPES[global];
      expect(oauthScopes, `${global} is called in src/ but "${scope}" is missing from appsscript.json`).toContain(
        scope,
      );
    }
  });
});
