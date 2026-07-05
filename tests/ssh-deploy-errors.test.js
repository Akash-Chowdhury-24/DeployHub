import { formatRemoteCommandFailure } from '../src/utils/shell-quote.js';

describe('SSH deploy error propagation', () => {
  test('non-zero remote exit codes produce actionable deploy failure messages', () => {
    const message = formatRemoteCommandFailure(
      "mkdir -p '/var/www/demo react project'",
      1,
      "mkdir: cannot create directory '/var/www/demo': Permission denied",
      ''
    );

    expect(message).toContain('Deploy failed: mkdir exited with code 1');
    expect(message).toContain('Permission denied');
  });

  test('unzip failures produce clear error messages', () => {
    const message = formatRemoteCommandFailure(
      "unzip -o '/tmp/deployhub-1783232677708.zip' -d '/var/www/demo react project'",
      2,
      'checkdir: cannot create extraction directory: /var/www/demo\nPermission denied',
      ''
    );

    expect(message).toContain('Deploy failed: unzip exited with code 2');
    expect(message).toContain('Permission denied');
  });
});
