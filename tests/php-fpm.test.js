import {
  preferredPhpFpmUnitName,
  parsePhpFpmUnitList,
  pickPhpFpmUnitName,
  parsePhpMajorMinor,
  formatPhpFpmMissingError,
  formatPhpFpmVersionMismatchError,
  resolvePreferredPhpFpmUnit,
  buildPhpFpmUnitListCommand,
} from '../src/utils/php-fpm.js';

describe('php-fpm unit helpers', () => {
  test('preferredPhpFpmUnitName follows Debian/Ubuntu naming', () => {
    expect(preferredPhpFpmUnitName('8.4')).toBe('php8.4-fpm');
    expect(preferredPhpFpmUnitName('8.3')).toBe('php8.3-fpm');
  });

  test('resolvePreferredPhpFpmUnit uses config phpVersion / default 8.4', () => {
    expect(resolvePreferredPhpFpmUnit({})).toBe('php8.4-fpm');
    expect(resolvePreferredPhpFpmUnit({ phpVersion: '8.3' })).toBe('php8.3-fpm');
    expect(
      resolvePreferredPhpFpmUnit({
        phpVersion: '8.3',
        backend: { phpVersion: '8.4' },
      })
    ).toBe('php8.4-fpm');
  });

  test('parsePhpFpmUnitList extracts versioned and generic units', () => {
    expect(
      parsePhpFpmUnitList('php8.4-fpm.service\tenabled\nphp-fpm.service\tenabled\n')
    ).toEqual(expect.arrayContaining(['php8.4-fpm', 'php-fpm']));
    expect(parsePhpFpmUnitList('')).toEqual([]);
  });

  test('pickPhpFpmUnitName prefers exact, then generic, else other-version', () => {
    expect(pickPhpFpmUnitName(['php8.4-fpm', 'php-fpm'], '8.4')).toEqual({
      unit: 'php8.4-fpm',
      match: 'exact',
    });
    expect(pickPhpFpmUnitName(['php-fpm'], '8.4')).toEqual({
      unit: 'php-fpm',
      match: 'generic',
    });
    expect(pickPhpFpmUnitName(['php8.2-fpm'], '8.4')).toEqual({
      unit: 'php8.2-fpm',
      match: 'other-version',
    });
    expect(pickPhpFpmUnitName([], '8.4')).toBeNull();
  });

  test('parsePhpMajorMinor reads php -v output', () => {
    expect(parsePhpMajorMinor('PHP 8.4.1 (cli) (built: ...)')).toBe('8.4');
    expect(parsePhpMajorMinor('PHP 8.2.33 (cli)')).toBe('8.2');
    expect(parsePhpMajorMinor('nope')).toBeNull();
  });

  test('buildPhpFpmUnitListCommand uses passwordless sudo so unprivileged SSH users can query systemd', () => {
    const cmd = buildPhpFpmUnitListCommand();
    expect(cmd).toMatch(/sudo -n systemctl list-unit-files/);
    expect(cmd).toMatch(/php-fpm\.service/);
  });

  test('error formatters mention expected unit and found units', () => {
    expect(formatPhpFpmMissingError('8.4')).toMatch(/php8\.4-fpm/);
    expect(formatPhpFpmMissingError('8.4', ['php8.2-fpm'])).toMatch(/php8\.2-fpm/);
    expect(formatPhpFpmVersionMismatchError('8.4', 'php8.2-fpm')).toMatch(
      /expects PHP 8\.4/
    );
  });
});
