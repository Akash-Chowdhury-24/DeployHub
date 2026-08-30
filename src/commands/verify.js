import chalk from 'chalk';
import { loadEnv } from '../core/config.js';
import { loadConfigOrExit } from '../core/load-config-or-exit.js';
import { resolveEnvTargets } from '../core/environments.js';
import {
  anyEnvHasResolvableHealthCheckUrl,
  runHealthChecksForEnvs,
  formatHealthCheckAllSummary,
} from '../utils/health-check.js';
import {
  runDockerPortPublishChecksForEnvs,
  verifyStageShouldRun,
} from '../utils/docker-port-publish.js';

/**
 * Standalone verify — same per-env URL resolution and summary as the deploy pipeline stage.
 *
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {string|undefined} envFlag — omitted = defaultEnvironment; `"all"` = every enabled
 * @param {{ httpGet?: (url: string, timeoutMs: number) => Promise<{ status: number }> }} [options]
 * @returns {Promise<{ ok: boolean, targets: string[], results: object[], failures: object[], summary: string, message: string }>}
 */
export async function runVerify(config, envFlag, options = {}) {
  const { targets, skippedDisabled } = resolveEnvTargets(config, envFlag);

  if (targets.length === 0) {
    return {
      ok: false,
      targets,
      results: [],
      failures: [],
      summary: '',
      message: 'No enabled environments to verify.',
      skippedDisabled,
    };
  }

  if (!verifyStageShouldRun(config, targets, anyEnvHasResolvableHealthCheckUrl)) {
    const label =
      targets.length === 1
        ? `environment "${targets[0]}"`
        : 'the selected environment(s)';
    return {
      ok: false,
      targets,
      results: [],
      failures: [],
      summary: '',
      message: `No health check URL configured for ${label}. Set healthCheck.url or environments.<name>.config.healthCheckUrl.`,
      skippedDisabled,
    };
  }

  const portOutcome = await runDockerPortPublishChecksForEnvs(config, targets, {
    requireRunning: true,
    ...options,
  });

  const { results, failures } = await runHealthChecksForEnvs(config, targets, options);
  const allFailures = [
    ...portOutcome.failures.map((f) => ({ envName: f.envName, url: '', error: f.error })),
    ...failures,
  ];
  const portResults = portOutcome.results.map((r) => ({
    envName: r.envName,
    url: '',
    status: 0,
    elapsed: 0,
    message: r.message,
  }));
  const mergedResults = [...portResults, ...results];
  const multi = targets.length > 1 || allFailures.length > 0;
  const summary = multi ? formatHealthCheckAllSummary(results, failures) : '';

  let message = '';
  if (allFailures.length === 0 && results.length === 1 && portOutcome.results.length === 0 && !multi) {
    const r = results[0];
    message = `Health check passed (${r.envName}): HTTP ${r.status} (${r.elapsed}ms)`;
  } else if (allFailures.length === 0 && results.length === 0 && portOutcome.results.length === 1) {
    message = portOutcome.results[0].message;
  } else if (allFailures.length === 0 && results.length === 0 && portOutcome.results.length === 0) {
    message = `No health check URL configured for the selected environment(s).`;
  }

  return {
    ok: allFailures.length === 0 && (results.length > 0 || portOutcome.results.length > 0),
    targets,
    results: mergedResults,
    failures: allFailures,
    summary,
    message:
      message ||
      (allFailures.length > 0
        ? allFailures[0].error
        : `All ${results.length} environment(s) passed health checks.`),
    skippedDisabled,
  };
}

/**
 * @param {import('commander').Command} program
 */
export function registerVerifyCommand(program) {
  program
    .command('verify')
    .description('Run health check on configured endpoint (default environment, or --env)')
    .option(
      '--env <name>',
      'Environment to verify (name, or "all" for every enabled environment)'
    )
    .action(async (opts) => {
      loadEnv();
      const config = await loadConfigOrExit();

      let outcome;
      try {
        outcome = await runVerify(config, opts.env);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      for (const name of outcome.skippedDisabled || []) {
        console.log(chalk.gray(`Skipping disabled environment "${name}"`));
      }

      if (outcome.summary) {
        console.log('');
        console.log(outcome.summary);
      } else if (outcome.ok && outcome.message) {
        console.log(chalk.green(`✓ ${outcome.message}`));
      }

      if (!outcome.ok) {
        if (!outcome.summary && outcome.message) {
          console.error(chalk.red(`✗ ${outcome.message}`));
        }
        process.exit(1);
      }
    });
}

export default { registerVerifyCommand, runVerify };
