import { getDateVersion } from '../src/utils/version.js';

describe('version', () => {
  test('getDateVersion returns valid format', () => {
    const v = getDateVersion();
    expect(v).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d{4}$/);
  });
});
