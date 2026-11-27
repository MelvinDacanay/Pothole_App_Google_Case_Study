import sharp from 'sharp';
import { prepareImage } from './imageBytes.ts';
import { hashBytes, MAX_DIMENSION, MAX_IMAGE_BYTES } from './verificationPolicy.ts';

export const SANITIZER_VERSION = 'pixel-jpeg-v1';
export const PHOTO_PRIVACY_VERSION = '2026-11-27-v2';
export const THUMBNAIL_DIMENSION = 320;
export const THUMBNAIL_MAX_BYTES = 40_000;
const formats: Record<string,string> = {'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'};
// Sharp/libvips is bounded independently of client-declared dimensions. Keep one decoder at a time
// to bound native memory on small hosting instances; reject overload instead of an unbounded queue.
sharp.cache(false); sharp.concurrency(1);
let queued=0;
let tail=Promise.resolve();
export async function sanitizePhoto(bytes: Buffer, mime: string, maxDimension = MAX_DIMENSION) {
  if(queued>=4) throw new Error('Image processing busy. Retry shortly.');
  if (!formats[mime] || !Number.isInteger(maxDimension) || maxDimension < 320 || maxDimension > MAX_DIMENSION) throw new Error('Unsupported photo format or dimensions.');
  queued++;
  const previous=tail; let release!:()=>void; tail=new Promise<void>(resolve=>{release=resolve;});
  await previous;
  try {
    // Validate container, reject animation/trailing data, strip EXIF/XMP/comments *before* decoding.
    const cleaned = prepareImage(bytes, mime).bytes;
    const decoder = sharp(cleaned, {limitInputPixels: MAX_DIMENSION * MAX_DIMENSION, failOn:'warning', animated:false});
    const meta = await decoder.metadata();
    if (meta.format !== formats[mime] || !meta.width || !meta.height || meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION || (meta.pages || 1) !== 1) throw new Error('Invalid image dimensions or format.');
    // Decode the pixels; never copy the original container/metadata. Use sRGB, no embedded profiles or comments.
    const raw = await decoder.flatten({background:'#ffffff'}).toColourspace('srgb').resize({width:maxDimension,height:maxDimension,fit:'inside',withoutEnlargement:true}).raw().toBuffer({resolveWithObject:true});
    const make = () => sharp(raw.data,{raw:{width:raw.info.width,height:raw.info.height,channels:raw.info.channels}});
    let evidence:Buffer|undefined;
    for (const quality of [88,82,76,70,64,58]) {
      const jpeg=await make().jpeg({quality,chromaSubsampling:'4:4:4'}).toBuffer();
      if(jpeg.length <= MAX_IMAGE_BYTES) {evidence=prepareImage(jpeg,'image/jpeg').bytes;break;}
    }
    if(!evidence) throw new Error('Photo is too detailed to fit safely. Crop closer to the pothole.');
    let thumbnail:Buffer|undefined;
    for(const quality of [75,60,45]) {
      const jpeg=await make().resize({width:THUMBNAIL_DIMENSION,height:THUMBNAIL_DIMENSION,fit:'inside',withoutEnlargement:true}).jpeg({quality}).toBuffer();
      if(jpeg.length<=THUMBNAIL_MAX_BYTES){thumbnail=prepareImage(jpeg,'image/jpeg').bytes;break;}
    }
    if(!thumbnail) throw new Error('Unable to prepare photo preview.');
    return {bytes:evidence,thumbnail,mime:'image/jpeg' as const,width:raw.info.width,height:raw.info.height,imageHash:hashBytes(evidence),contentHash:hashBytes(evidence),thumbnailHash:hashBytes(thumbnail)};
  } finally {queued--;release();}
}

// The only inline payload allowed at the external provider boundary. It cannot carry EXIF,
// original names, coordinates, user IDs or notes. Pixel-level identification is still possible.
export async function geminiInlinePhoto(bytes:Buffer,mime:string) {
  const clean=await sanitizePhoto(bytes,mime);
  return {mimeType:clean.mime,data:clean.bytes.toString('base64')};
}

export function decodeUpload(value:unknown):Buffer {
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw new Error('Invalid photo upload.');
  const bytes=Buffer.from(value,'base64');
  if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==value)throw new Error('Invalid photo upload.');
  return bytes;
}
