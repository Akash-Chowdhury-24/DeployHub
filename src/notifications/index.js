import axios from 'axios';
import { createLogger } from '../logger/index.js';
import { sendSlackNotification } from './slack.js';
import { sendEmailNotification } from './email.js';
import { sendWebhookNotification } from './webhook.js';

/**
 * @param {import('../core/config.js').DeployHubConfig} config
 * @param {{ success: boolean, version: string, message?: string, deployUrl?: string, environment?: string }} result
 */
export async function sendNotifications(config, result) {
  const log = createLogger('notify');
  const tasks = [];

  if (config.notifications.slack) {
    tasks.push(sendSlackNotification(result));
  }
  if (config.notifications.email) {
    tasks.push(sendEmailNotification(config, result));
  }
  if (config.notifications.webhook) {
    tasks.push(sendWebhookNotification(result));
  }

  if (tasks.length === 0) {
    log.info('No notifications configured');
    return;
  }

  await Promise.allSettled(tasks);
  log.success('Notifications sent');
}

export default { sendNotifications };
