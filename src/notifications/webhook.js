import axios from 'axios';

/**
 * @param {{ success: boolean, version: string, message?: string }} result
 */
export async function sendWebhookNotification(result) {
  const url = process.env.WEBHOOK_URL;
  if (!url) {
    throw new Error('WEBHOOK_URL not set');
  }

  await axios.post(url, {
    event: 'deployhub.deployment',
    success: result.success,
    version: result.version,
    message: result.message,
    timestamp: new Date().toISOString(),
  });
}

export default { sendWebhookNotification };
