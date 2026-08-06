import {
  validateEnvironmentName,
  createEnvNamePromptValidate,
  ENV_NAME_MAX_LENGTH,
} from '../src/core/environments.js';

describe('validateEnvironmentName (shared by env add + init)', () => {
  test('rejects reserved name "all" (collides with --env all)', () => {
    const result = validateEnvironmentName('all');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        '"all" is a reserved name and cannot be used as an environment name.'
      );
    }
  });

  test('rejects reserved name case-insensitively (All / ALL)', () => {
    expect(validateEnvironmentName('All').ok).toBe(false);
    expect(validateEnvironmentName('ALL').ok).toBe(false);
  });

  test('allows "default" — normal key used by init/migration, not a CLI sentinel', () => {
    const result = validateEnvironmentName('default');
    expect(result).toEqual({ ok: true, name: 'default' });
  });

  test('rejects spaces and unsafe characters', () => {
    expect(validateEnvironmentName('my prod').ok).toBe(false);
    expect(validateEnvironmentName('my_prod').ok).toBe(false);
    expect(validateEnvironmentName('Prod!').ok).toBe(false);
    expect(validateEnvironmentName('1staging').ok).toBe(false);
  });

  test('rejects uppercase (must be lowercase kebab-case)', () => {
    const result = validateEnvironmentName('Production');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/lowercase/i);
    }
  });

  test('accepts lowercase kebab-case names', () => {
    expect(validateEnvironmentName('production')).toEqual({
      ok: true,
      name: 'production',
    });
    expect(validateEnvironmentName('my-app')).toEqual({ ok: true, name: 'my-app' });
    expect(validateEnvironmentName('staging2')).toEqual({
      ok: true,
      name: 'staging2',
    });
  });

  test('rejects case-insensitive collision with existing env', () => {
    // Legacy configs may still have mixed-case keys; new names must not collide.
    const result = validateEnvironmentName('production', ['Production']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/already exists/i);
      expect(result.error).toMatch(/case-insensitive/i);
    }
  });

  test('rejects exact duplicate against existing config names', () => {
    const result = validateEnvironmentName('staging', ['production', 'staging']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/already exists/i);
    }
  });

  test('rejects empty / whitespace-only names', () => {
    expect(validateEnvironmentName('').ok).toBe(false);
    expect(validateEnvironmentName('   ').ok).toBe(false);
  });

  test('rejects names longer than DNS label limit (63)', () => {
    const tooLong = `a${'b'.repeat(ENV_NAME_MAX_LENGTH)}`;
    expect(tooLong.length).toBeGreaterThan(ENV_NAME_MAX_LENGTH);
    const result = validateEnvironmentName(tooLong);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/at most 63/);
    }
  });

  test('accepts name at exactly 63 characters', () => {
    const exact = `a${'b'.repeat(ENV_NAME_MAX_LENGTH - 1)}`;
    expect(exact.length).toBe(63);
    expect(validateEnvironmentName(exact).ok).toBe(true);
  });

  test('createEnvNamePromptValidate returns inquirer-compatible true|string', () => {
    const validate = createEnvNamePromptValidate(['production']);
    expect(validate('staging')).toBe(true);
    expect(validate('')).toMatch(/empty/i);
    expect(validate('production')).toMatch(/already exists/i);
    expect(validate('all')).toMatch(/reserved/i);
  });
});
