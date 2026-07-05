import {
  shellQuote,
  formatRemoteCommandFailure,
  buildDeployPathWriteTestCommand,
  formatDeployPathWriteFailure,
  toKebabCase,
} from '../src/utils/shell-quote.js';

describe('shellQuote', () => {
  test('wraps paths with spaces in single quotes', () => {
    expect(shellQuote('/var/www/demo react project')).toBe("'/var/www/demo react project'");
  });

  test('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  test('handles null', () => {
    expect(shellQuote(null)).toBe("''");
  });
});

describe('formatRemoteCommandFailure', () => {
  test('includes command name, exit code, and stderr', () => {
    const message = formatRemoteCommandFailure(
      "mkdir -p '/var/www/demo react project'",
      1,
      "mkdir: cannot create directory '/var/www/demo': Permission denied",
      ''
    );
    expect(message).toBe(
      "Deploy failed: mkdir exited with code 1: mkdir: cannot create directory '/var/www/demo': Permission denied"
    );
  });
});

describe('buildDeployPathWriteTestCommand', () => {
  test('quotes paths with spaces', () => {
    const cmd = buildDeployPathWriteTestCommand('/var/www/demo react project');
    expect(cmd).toBe(
      "mkdir -p '/var/www/demo react project' && touch '/var/www/demo react project/.deployhub-write-test' && rm -f '/var/www/demo react project/.deployhub-write-test'"
    );
  });
});

describe('formatDeployPathWriteFailure', () => {
  test('quotes paths in suggested remediation commands', () => {
    const message = formatDeployPathWriteFailure(
      '/var/www/demo react project',
      'ec2-user',
      "Permission denied"
    );
    expect(message).toContain("sudo mkdir -p '/var/www/demo react project'");
    expect(message).toContain("sudo chown ec2-user:ec2-user '/var/www/demo react project'");
  });
});

describe('toKebabCase', () => {
  test('converts spaced names', () => {
    expect(toKebabCase('demo react project')).toBe('demo-react-project');
  });
});
