import { Bytes, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';

export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_RAW_FILE_BYTES = 10 * 1024 * 1024; // 10 MB raw upload ceiling
export const TARGET_COMPRESSED_BYTES = 300 * 1024; // ~300 KB target for Spark-tier mediaObjects
export const MAX_STORAGE_BYTES = 380_000; // <= 380 KB client guard (under 400,000 byte rule cap)
export const MAX_IMAGE_DIMENSION = 960;

export interface CompressedImageResult {
  blob: Blob;
  contentType: 'image/jpeg' | 'image/webp' | 'image/png';
  width: number;
  height: number;
  originalBytes: number;
  compressedBytes: number;
}

export function validateRawImageFile(file: File): string | null {
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type as (typeof ALLOWED_IMAGE_MIME_TYPES)[number])) {
    return 'Unsupported format. Please select a JPEG, PNG, or WebP photograph.';
  }
  if (file.size <= 0) {
    return 'The selected file is empty.';
  }
  if (file.size > MAX_RAW_FILE_BYTES) {
    return 'File exceeds the 10 MB upload limit. Please select a smaller photograph.';
  }
  return null;
}

async function encodeScaledCanvas(
  bitmap: ImageBitmap,
  maxDimension: number,
  outputMime: 'image/jpeg' | 'image/webp'
): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to initialize image compression canvas.');
  }

  ctx.drawImage(bitmap, 0, 0, width, height);

  let quality = 0.82;
  let blob: Blob | null = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), outputMime, quality)
    );
    if (!blob) break;
    if (blob.size <= TARGET_COMPRESSED_BYTES || quality <= 0.42) break;
    quality -= 0.1;
  }

  if (!blob) {
    throw new Error('Image compression failed. Please try another photo.');
  }

  return { blob, width, height };
}

export async function compressImageForUpload(file: File): Promise<CompressedImageResult> {
  const validationError = validateRawImageFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const bitmap = await createImageBitmap(file);
  const outputMime: 'image/jpeg' | 'image/webp' =
    file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';

  try {
    let encoded = await encodeScaledCanvas(bitmap, MAX_IMAGE_DIMENSION, outputMime);
    if (encoded.blob.size > MAX_STORAGE_BYTES) {
      encoded = await encodeScaledCanvas(bitmap, 720, outputMime);
    }
    if (encoded.blob.size > MAX_STORAGE_BYTES) {
      encoded = await encodeScaledCanvas(bitmap, 560, 'image/jpeg');
    }

    if (encoded.blob.size > MAX_STORAGE_BYTES) {
      throw new Error('Compressed image still exceeds the 380 KB Spark-tier media limit.');
    }

    const finalContentType: 'image/jpeg' | 'image/webp' =
      encoded.blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg';

    return {
      blob: encoded.blob,
      contentType: finalContentType,
      width: encoded.width,
      height: encoded.height,
      originalBytes: file.size,
      compressedBytes: encoded.blob.size,
    };
  } finally {
    bitmap.close();
  }
}

export interface StorageUploadOptions {
  uid: string;
  fileId: string;
  compressed: CompressedImageResult;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export interface StorageUploadResult {
  storagePath: string;
  downloadUrl: string;
  contentType: string;
  sizeBytes: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNonRetryableFirestoreError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return (
    code === 'permission-denied' ||
    code === 'unauthenticated' ||
    code === 'invalid-argument' ||
    code === 'failed-precondition'
  );
}

export async function uploadImageWithRetry({
  uid,
  fileId,
  compressed,
  onProgress,
  signal,
}: StorageUploadOptions): Promise<StorageUploadResult> {
  const mediaId = fileId;
  const mediaDocPath = `mediaObjects/${mediaId}`;
  const downloadUrl = `/api/media/${mediaId}`;
  const maxAttempts = 3;

  if (signal?.aborted) {
    throw new Error('Upload canceled.');
  }

  onProgress?.(20);
  const arrayBuffer = await compressed.blob.arrayBuffer();
  const payloadBytes = Bytes.fromUint8Array(new Uint8Array(arrayBuffer));

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error('Upload canceled.');
    }

    try {
      onProgress?.(60);
      await setDoc(doc(db, 'mediaObjects', mediaId), {
        mediaId,
        ownerId: uid,
        contentType: compressed.contentType,
        sizeBytes: compressed.compressedBytes,
        width: compressed.width,
        height: compressed.height,
        data: payloadBytes,
        createdAt: serverTimestamp(),
      });

      if (signal?.aborted) {
        throw new Error('Upload canceled.');
      }

      onProgress?.(100);
      return {
        storagePath: mediaDocPath,
        downloadUrl,
        contentType: compressed.contentType,
        sizeBytes: compressed.compressedBytes,
      };
    } catch (err) {
      if (signal?.aborted) {
        throw new Error('Upload canceled.');
      }
      lastError = err;
      if (isNonRetryableFirestoreError(err)) {
        handleFirestoreError(err, OperationType.CREATE, mediaDocPath);
      }
      if (attempt < maxAttempts) {
        const backoffMs = 400 * 2 ** (attempt - 1);
        await sleep(backoffMs);
      }
    }
  }

  handleFirestoreError(lastError, OperationType.CREATE, mediaDocPath);
}
