import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { env } from '../config/env.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StoredFile {
  storagePath: string;
  storageBackend: 'local' | 's3';
  sha256Hash: string;
  fileSize: number;
}

// ─── Allowed MIME Types ──────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'image/jpeg',
  'image/png',
]);

const MAX_FILE_SIZE_VIDEO = 50 * 1024 * 1024; // 50MB
const MAX_FILE_SIZE_IMAGE = 10 * 1024 * 1024; // 10MB

export function validateUpload(mimeType: string, fileSize: number): string | null {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return `Invalid file type: ${mimeType}. Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`;
  }

  const isVideo = mimeType.startsWith('video/');
  const maxSize = isVideo ? MAX_FILE_SIZE_VIDEO : MAX_FILE_SIZE_IMAGE;

  if (fileSize > maxSize) {
    const maxMB = maxSize / (1024 * 1024);
    return `File too large (${(fileSize / (1024 * 1024)).toFixed(1)}MB). Maximum: ${maxMB}MB for ${isVideo ? 'video' : 'image'} files.`;
  }

  return null;
}

// ─── File Extension Mapping ──────────────────────────────────────────────────

function getExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'image/jpeg': 'jpg',
    'image/png': 'png',
  };
  return map[mimeType] ?? 'bin';
}

// ─── Generate Safe Filename ──────────────────────────────────────────────────

function generateFilename(documentType: string, mimeType: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const ext = getExtension(mimeType);
  return `${documentType}_${timestamp}_${random}.${ext}`;
}

// ─── Storage Backend: Local ──────────────────────────────────────────────────

async function storeLocal(
  userId: string,
  documentType: string,
  mimeType: string,
  buffer: Buffer,
): Promise<StoredFile> {
  const filename = generateFilename(documentType, mimeType);
  const relativePath = `kyc/${userId}/${filename}`;
  const absolutePath = join(env.STORAGE_LOCAL_PATH, relativePath);

  // Ensure directory exists
  await mkdir(dirname(absolutePath), { recursive: true });

  // Compute hash before writing
  const sha256Hash = createHash('sha256').update(buffer).digest('hex');

  // Write file
  await writeFile(absolutePath, buffer);

  return {
    storagePath: relativePath,
    storageBackend: 'local',
    sha256Hash,
    fileSize: buffer.length,
  };
}

// ─── Storage Backend: S3 (Production) ────────────────────────────────────────

async function storeS3(
  userId: string,
  documentType: string,
  mimeType: string,
  buffer: Buffer,
): Promise<StoredFile> {
  // Dynamic import to avoid loading AWS SDK in development
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

  const filename = generateFilename(documentType, mimeType);
  const key = `kyc/${userId}/${filename}`;

  const sha256Hash = createHash('sha256').update(buffer).digest('hex');

  const client = new S3Client({ region: env.AWS_REGION });
  await client.send(new PutObjectCommand({
    Bucket: env.AWS_S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    ServerSideEncryption: 'AES256',
    Metadata: {
      'x-sha256': sha256Hash,
      'x-user-id': userId,
      'x-document-type': documentType,
    },
  }));

  return {
    storagePath: key,
    storageBackend: 's3',
    sha256Hash,
    fileSize: buffer.length,
  };
}

// ─── Unified Store Function ──────────────────────────────────────────────────

export async function storeFile(
  userId: string,
  documentType: string,
  mimeType: string,
  buffer: Buffer,
): Promise<StoredFile> {
  if (env.STORAGE_BACKEND === 's3') {
    return storeS3(userId, documentType, mimeType, buffer);
  }
  return storeLocal(userId, documentType, mimeType, buffer);
}

// ─── Delete (for cleanup on failed records) ──────────────────────────────────

export async function deleteFile(storagePath: string, backend: 'local' | 's3'): Promise<void> {
  if (backend === 'local') {
    const absolutePath = join(env.STORAGE_LOCAL_PATH, storagePath);
    await unlink(absolutePath).catch(() => {});
  } else {
    const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: env.AWS_REGION });
    await client.send(new DeleteObjectCommand({
      Bucket: env.AWS_S3_BUCKET,
      Key: storagePath,
    }));
  }
}
