// Script Properties: CALENDAR_ID (required), DRY_RUN (default "true"),
// SPREADSHEET_ID (set automatically once the ledger spreadsheet is created).

export interface AdapterConfig {
  calendarId: string;
  dryRun: boolean;
}

export function readConfig(): AdapterConfig {
  const props = PropertiesService.getScriptProperties();

  const calendarId = props.getProperty('CALENDAR_ID');
  if (!calendarId) {
    throw new Error(
      'Script property CALENDAR_ID is not set. Set it to the target calendar\'s id before running sync.',
    );
  }

  // Only the literal string "false" turns dry-run off; anything else (including unset) is dry-run.
  const dryRun = props.getProperty('DRY_RUN') !== 'false';

  return { calendarId, dryRun };
}

export function getSpreadsheetId(): string | null {
  return PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
}

export function saveSpreadsheetId(id: string): void {
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', id);
}

export function getLastDigestAt(): string | null {
  return PropertiesService.getScriptProperties().getProperty('LAST_DIGEST_AT');
}

export function saveLastDigestAt(iso: string): void {
  PropertiesService.getScriptProperties().setProperty('LAST_DIGEST_AT', iso);
}
