import exifr from 'exifr';

export interface ExtractedExifGps {
  lat: number;
  lng: number;
}

export async function extractExifGpsFromFile(file: File): Promise<ExtractedExifGps | null> {
  try {
    const gps = await exifr.gps(file);
    if (
      gps &&
      typeof gps.latitude === 'number' &&
      typeof gps.longitude === 'number' &&
      Number.isFinite(gps.latitude) &&
      Number.isFinite(gps.longitude) &&
      Math.abs(gps.latitude) <= 90 &&
      Math.abs(gps.longitude) <= 180 &&
      !(gps.latitude === 0 && gps.longitude === 0)
    ) {
      return {
        lat: Number(gps.latitude.toFixed(6)),
        lng: Number(gps.longitude.toFixed(6)),
      };
    }
    return null;
  } catch {
    return null;
  }
}
