import { S3Client, HeadObjectCommand, NoSuchKey, NotFound } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '@/config';
import { logger } from '@/lib/logger';

const client = new S3Client({
  endpoint: config.storage.endpoint,
  region: config.storage.region,
  credentials: {
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
  },
  forcePathStyle: config.storage.forcePathStyle,
});

const EXTENSION_BY_MIME: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export function canonicalExtension(mimeType: string): string | null {
  return EXTENSION_BY_MIME[mimeType] ?? null;
}

export function buildMediaKey(args: {
  eventId: string;
  submissionId: string;
  mediaId: string;
  ext: string;
}): string {
  return `events/${args.eventId}/submissions/${args.submissionId}/media/${args.mediaId}.${args.ext}`;
}

export async function createPresignedUpload(args: {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<{ url: string; method: 'PUT'; headers: Record<string, string> }> {
  const command = new PutObjectCommand({
    Bucket: config.storage.bucket,
    Key: args.key,
    ContentType: args.contentType,
  });
  const url = await getSignedUrl(client, command, {
    expiresIn: args.expiresInSeconds ?? 900,
  });
  return { url, method: 'PUT', headers: { 'Content-Type': args.contentType } };
}

export async function headObject(key: string): Promise<{
  exists: boolean;
  contentType?: string;
  contentLength?: number;
}> {
  try {
    const res = await client.send(
      new HeadObjectCommand({ Bucket: config.storage.bucket, Key: key }),
    );
    return {
      exists: true,
      contentType: res.ContentType,
      contentLength: res.ContentLength,
    };
  } catch (err) {
    if (err instanceof NoSuchKey || err instanceof NotFound) {
      return { exists: false };
    }
    if (
      typeof err === 'object' &&
      err !== null &&
      '$metadata' in err &&
      ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
    ) {
      return { exists: false };
    }
    logger.error({ err, key }, 'headObject failed');
    throw err;
  }
}

export { client as s3Client };
