import { S3Client, HeadBucketCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs-extra';
import path from 'path';

/**
 * @param {Record<string, string>} env
 */
export function createAwsProvider(env = process.env) {
  const bucket = env.AWS_BUCKET;
  const region = env.AWS_REGION || 'us-east-1';

  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !bucket) {
    throw new Error(
      'AWS credentials incomplete. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_BUCKET in .env'
    );
  }

  const client = new S3Client({
    region,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  /**
   * @param {string} localPath
   * @param {string} [remoteKey]
   */
  async function upload(localPath, remoteKey) {
    const key =
      remoteKey ||
      path.basename(localPath).replace(/\\/g, '/');

    const fileStream = fs.createReadStream(localPath);
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: fileStream,
      },
    });
    await upload.done();
  }

  /**
   * @param {string} remoteKey
   * @param {string} localPath
   */
  async function download(remoteKey, localPath) {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: remoteKey })
    );
    await fs.ensureDir(path.dirname(localPath));
    const body = response.Body;
    if (!body) throw new Error('Empty response from S3');
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }
    await fs.writeFile(localPath, Buffer.concat(chunks));
  }

  /**
   * @param {string} remoteKey
   */
  async function verify(remoteKey) {
    try {
      await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: remoteKey })
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string} remoteKey
   */
  async function deleteObject(remoteKey) {
    await client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: remoteKey })
    );
  }

  async function testConnection() {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  }

  return { upload, download, verify, delete: deleteObject, testConnection };
}

export default { createAwsProvider };
