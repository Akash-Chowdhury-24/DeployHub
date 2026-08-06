import {
  validateEnvironmentName,
  createEnvNamePromptValidate,
} from '../src/core/environments.js';

/**
 * Simulates init's multi-env name collection: each accepted name is added to the
 * in-memory draft before the next prompt, matching promptAndStoreEnvironment +
 * createEnvNamePromptValidate (the same validate wired into inquirer).
 *
 * @param {string[]} attemptedNames — answers the user types (including rejects)
 * @returns {{ stored: string[], rejected: string[] }}
 */
function simulateInitEnvNameLoop(attemptedNames) {
  /** @type {Record<string, true>} */
  const environments = {};
  /** @type {string[]} */
  const stored = [];
  /** @type {string[]} */
  const rejected = [];

  for (const attempt of attemptedNames) {
    const existing = Object.keys(environments);
    // Same callback inquirer uses via createEnvNamePromptValidate(existingEnvNames)
    const outcome = createEnvNamePromptValidate(existing)(attempt);
    if (outcome !== true) {
      rejected.push(attempt);
      continue; // inquirer re-prompts; draft unchanged
    }
    const checked = validateEnvironmentName(attempt, existing);
    if (!checked.ok) {
      rejected.push(attempt);
      continue;
    }
    environments[checked.name] = true;
    stored.push(checked.name);
  }

  return { stored, rejected };
}

describe('init env-name loop (duplicate / empty)', () => {
  test('identical name entered twice in same init session is rejected — draft not overwritten', () => {
    const { stored, rejected } = simulateInitEnvNameLoop([
      'production',
      'production', // duplicate in-session
      'staging',
    ]);

    expect(stored).toEqual(['production', 'staging']);
    expect(rejected).toEqual(['production']);
    expect(stored.filter((n) => n === 'production')).toHaveLength(1);
  });

  test('empty name at env-name prompt is rejected and re-prompted (draft unchanged)', () => {
    const { stored, rejected } = simulateInitEnvNameLoop(['', '   ', 'production']);

    expect(rejected).toEqual(['', '   ']);
    expect(stored).toEqual(['production']);
  });

  test('case-insensitive duplicate in-session is rejected like exact duplicate', () => {
    // Charset rejects uppercase on input; still verify collision if draft has legacy key
    const existing = ['Production'];
    const validate = createEnvNamePromptValidate(existing);
    expect(validate('production')).toMatch(/already exists/i);
    expect(validate('staging')).toBe(true);
  });
});
