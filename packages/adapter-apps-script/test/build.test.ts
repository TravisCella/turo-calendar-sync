import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST_CODE_JS = join(__dirname, '..', 'dist', 'Code.js');
const ENTRY_POINTS = ['runSync', 'runBackfill', 'installTrigger', 'preflight', 'resetCalendarEvents'];

describe('esbuild bundle', () => {
  it('declares every Apps Script entry point as a top-level function, not just a runtime property', async () => {
    await import('../../../esbuild.config.mjs');

    const bundle = readFileSync(DIST_CODE_JS, 'utf-8');

    for (const name of ENTRY_POINTS) {
      expect(bundle).toMatch(new RegExp(`^function ${name}\\(\\) \\{`, 'm'));
    }

    // The old runtime-only wiring must be gone — Apps Script's editor and
    // triggers can't see a property assigned on globalThis at call time.
    expect(bundle).not.toMatch(/globalThis\.(runSync|runBackfill|installTrigger|preflight)\s*=/);
  });
});
