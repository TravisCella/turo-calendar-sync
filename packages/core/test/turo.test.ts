import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTuroEmail } from '../src/parsers/turo';
import { FIXTURES_DIR, loadFixtureEmail, loadFixtureExpected } from './helpers/loadFixture';

const fixtureNames = readdirSync(FIXTURES_DIR)
  .filter((file) => file.endsWith('.txt'))
  .map((file) => file.replace(/\.txt$/, ''))
  .sort();

describe('parseTuroEmail', () => {
  for (const name of fixtureNames) {
    it(`parses ${name} to match its expected fixture`, () => {
      const email = loadFixtureEmail(name);
      const expected = loadFixtureExpected(name);

      expect(parseTuroEmail(email)).toEqual(expected);
    });
  }
});
