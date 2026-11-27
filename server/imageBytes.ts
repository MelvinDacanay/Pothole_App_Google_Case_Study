import { MAX_DIMENSION, MAX_IMAGE_BYTES, hashBytes } from './verificationPolicy.ts';

// Bounded container parsing; not a full pixel decoder. Strip metadata from the copy sent to AI.
function dimensions(w: number, h: number) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_DIMENSION || h > MAX_DIMENSION) throw new Error('Unsupported image dimensions');
}
function jpeg(b: Buffer): Buffer {
  if (b.length < 8 || b[0] !== 255 || b[1] !== 216) throw new Error('Invalid JPEG');
  const parts = [b.subarray(0,2)]; let p=2, frame=false, scan=false, ended=false;
  while (p < b.length) {
    const start=p;
    if (b[p++] !== 255) throw new Error('Invalid JPEG marker');
    while (b[p] === 255) p++;
    const m=b[p++];
    if (m===217) { parts.push(b.subarray(start,p)); ended=true; break; }
    if (m===0 || m===216 || m===1 || (m>=208 && m<=215) || p+2>b.length) throw new Error('Invalid JPEG segment');
    const n=b.readUInt16BE(p); if(n<2 || p+n>b.length) throw new Error('Truncated JPEG');
    const end=p+n;
    if ([192,193,194].includes(m)) { if(n<8 || frame) throw new Error('Invalid JPEG frame'); dimensions(b.readUInt16BE(p+5),b.readUInt16BE(p+3)); frame=true; }
    else if (m>=192 && m<=207 && ![196,204].includes(m)) throw new Error('Unsupported JPEG encoding');
    if (!(m>=224 && m<=239) && m!==254) parts.push(b.subarray(start,end));
    p=end;
    if(m===218) {
      if(!frame) throw new Error('Missing JPEG frame'); scan=true; const s=p;
      while(p<b.length) { if(b[p]!==255) {p++;continue;} let q=p+1; while(b[q]===255) q++; if(q>=b.length) throw new Error('Truncated JPEG scan'); if(b[q]===0 || (b[q]>=208 && b[q]<=215)) {p=q+1;continue;} break; }
      parts.push(b.subarray(s,p));
    }
  }
  if(!frame || !scan || !ended || p!==b.length) throw new Error('Incomplete JPEG');
  return Buffer.concat(parts);
}
function png(b: Buffer): Buffer {
  const sig=Buffer.from([137,80,78,71,13,10,26,10]); if(!b.subarray(0,8).equals(sig)) throw new Error('Invalid PNG');
  const parts:Buffer[]=[sig]; let p=8, header=false, data=false, end=false;
  while(p+12<=b.length) {
    const n=b.readUInt32BE(p), t=b.toString('ascii',p+4,p+8), e=p+12+n;
    if(e>b.length || !/^[A-Za-z]{4}$/.test(t)) throw new Error('Invalid PNG chunk');
    if(!header && t!=='IHDR') throw new Error('Missing PNG header');
    if(t==='IHDR') {if(header||n!==13) throw new Error('Invalid PNG header'); dimensions(b.readUInt32BE(p+8),b.readUInt32BE(p+12));header=true;}
    if(t==='acTL'||t==='fcTL'||t==='fdAT') throw new Error('Animated images unsupported');
    if(t==='IDAT') data=true;
    if(t==='IEND') {if(n!==0) throw new Error('Invalid PNG end');end=true;}
    if(['IHDR','PLTE','IDAT','IEND','tRNS'].includes(t)) parts.push(b.subarray(p,e));
    else if(t[0]===t[0].toUpperCase()) throw new Error('Unsupported PNG chunk');
    p=e; if(end) break;
  }
  if(!header||!data||!end||p!==b.length) throw new Error('Incomplete PNG'); return Buffer.concat(parts);
}
function webp(b:Buffer):Buffer {
  if(b.length<20 || b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WEBP'||b.readUInt32LE(4)+8!==b.length) throw new Error('Invalid WebP');
  let p=12, frames=0; const parts:Buffer[]=[];
  while(p+8<=b.length) {
    const t=b.toString('ascii',p,p+4), n=b.readUInt32LE(p+4), d=p+8, e=d+n+(n%2); if(e>b.length) throw new Error('Truncated WebP');
    const part=Buffer.from(b.subarray(p,e));
    if(t==='VP8X') {if(n!==10 || (b[d]&2)) throw new Error('Animated or invalid WebP');dimensions(b.readUIntLE(d+4,3)+1,b.readUIntLE(d+7,3)+1);part[8]&=~(0x20|0x08|0x04);parts.push(part);}
    else if(t==='VP8 ') {if(n<10 || b[d+3]!==157 || b[d+4]!==1 || b[d+5]!==42) throw new Error('Invalid WebP frame');dimensions(b.readUInt16LE(d+6)&0x3fff,b.readUInt16LE(d+8)&0x3fff);frames++;parts.push(part);}
    else if(t==='VP8L') {if(n<5 || b[d]!==47) throw new Error('Invalid lossless WebP');const bits=b.readUInt32LE(d+1);dimensions((bits&0x3fff)+1,((bits>>>14)&0x3fff)+1);frames++;parts.push(part);}
    else if(t==='ALPH') parts.push(part);
    else if(t==='ANIM'||t==='ANMF') throw new Error('Animated images unsupported');
    p=e;
  }
  if(frames!==1||p!==b.length) throw new Error('Incomplete WebP');
  const h=Buffer.from(b.subarray(0,12)); h.writeUInt32LE(4+parts.reduce((s,x)=>s+x.length,0),4);return Buffer.concat([h,...parts]);
}
export function prepareImage(bytes: Buffer, mime: string) {
  if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>MAX_IMAGE_BYTES) throw new Error('Invalid image size');
  const cleaned = mime==='image/jpeg'?jpeg(bytes):mime==='image/png'?png(bytes):mime==='image/webp'?webp(bytes):null;
  if(!cleaned) throw new Error('Unsupported image format');
  return { bytes:cleaned, mime, imageHash:hashBytes(bytes), contentHash:hashBytes(cleaned) };
}

export function extractBytesBuffer(rawBytes: unknown): Buffer | null {
  if (Buffer.isBuffer(rawBytes)) return rawBytes;
  if (rawBytes instanceof Uint8Array) return Buffer.from(rawBytes);
  if (
    rawBytes &&
    typeof rawBytes === 'object' &&
    'toUint8Array' in rawBytes &&
    typeof (rawBytes as { toUint8Array: () => Uint8Array }).toUint8Array === 'function'
  ) {
    return Buffer.from((rawBytes as { toUint8Array: () => Uint8Array }).toUint8Array());
  }
  return null;
}
