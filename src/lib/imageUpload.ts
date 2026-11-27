import { auth } from './firebase';
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
    return 'Unsupported format. Please select a JPEG, PNG, or WebP photograph. For HEIC, export as JPEG first.';
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
      throw new Error('Photo is too large after compression. Crop closer or retake it.');
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
  privacyConfirmed: boolean;
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

export async function uploadImageWithRetry({uid,fileId,compressed,onProgress,signal,privacyConfirmed}:StorageUploadOptions):Promise<StorageUploadResult> {
  const user=auth?.currentUser;if(!user||user.uid!==uid)throw new Error('Sign in again to upload.');
  const bytes=new Uint8Array(await compressed.blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const payload=JSON.stringify({mediaId:fileId,contentType:compressed.contentType,data:btoa(binary),privacyConfirmed});
  for(let attempt=0;attempt<3;attempt++){
    if(signal?.aborted)throw new Error('Upload canceled.');
    onProgress?.(20);
    const token=await user.getIdToken();
    let response:Response;
    try{response=await fetch('/api/media/upload',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:payload,signal});}catch(e){if(attempt===2||signal?.aborted)throw e;await sleep(400*2**attempt);continue;}
    const result=await response.json();if(response.ok){onProgress?.(100);return result as StorageUploadResult;}
    if(response.status<500||attempt===2)throw new Error(result.error||'Photo upload failed.');await sleep(400*2**attempt);
  }throw new Error('Photo upload failed.');
}
export async function cropPhoto(photo:CompressedImageResult,inset:number):Promise<CompressedImageResult>{
  const bitmap=await createImageBitmap(photo.blob);try{const x=Math.round(bitmap.width*inset),y=Math.round(bitmap.height*inset),w=bitmap.width-2*x,h=bitmap.height-2*y;const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Crop unavailable.');ctx.drawImage(bitmap,x,y,w,h,0,0,w,h);const blob=await new Promise<Blob|null>(r=>canvas.toBlob(r,'image/jpeg',.85));if(!blob||blob.size>MAX_STORAGE_BYTES)throw new Error('Crop failed.');return {...photo,blob,width:w,height:h,contentType:'image/jpeg',compressedBytes:blob.size};}finally{bitmap.close();}
}
