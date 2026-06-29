import axios from 'axios';

/**
 * @param {{ success: boolean, version: string, message?: string }} result
 */
export async function sendSlackNotification(result) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('SLACK_WEBHOOK_URL not set');
  }

  const status = result.success ? '✅' : '❌';
  await axios.post(webhookUrl, {
    text: `${status} DeployHub: v${result.version} — ${result.message || (result.success ? 'Deployment succeeded' : 'Deployment failed')}`,
  });
}

export default { sendSlackNotification };
