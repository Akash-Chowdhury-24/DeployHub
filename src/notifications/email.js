import nodemailer from 'nodemailer';
import { createLogger } from '../logger/index.js';

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {{ success: boolean, version: string, message?: string, deployUrl?: string, environment?: string }} result
 */
export async function sendEmailNotification(config, result) {
  const log = createLogger('email');

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.NOTIFY_EMAIL_TO || process.env.NOTIFICATION_EMAIL;

  if (!host || !to) {
    throw new Error('SMTP_HOST and NOTIFY_EMAIL_TO (or NOTIFICATION_EMAIL) must be set');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });

  const status = result.success ? 'SUCCESS' : 'FAILED';
  const environment = result.environment || process.env.DEPLOYHUB_ENV || 'production';
  const deployUrl = result.deployUrl || config.healthCheck?.url || 'N/A';

  const subject = `[DeployHub] ${status}: ${config.project} v${result.version} (${environment})`;
  const body = [
    `Project: ${config.project}`,
    `Version: ${result.version}`,
    `Environment: ${environment}`,
    `Status: ${status}`,
    `Deploy URL: ${deployUrl}`,
    '',
    result.message || (result.success ? 'Deployment completed successfully.' : 'Deployment failed.'),
  ].join('\n');

  await transporter.sendMail({
    from: user || `deployhub@${host}`,
    to,
    subject,
    text: body,
  });

  log.success(`Email notification sent to ${to}`);
}

export default { sendEmailNotification };
