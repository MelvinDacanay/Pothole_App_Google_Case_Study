import { GoogleGenAI, Type } from '@google/genai';

export interface GeminiPotholeAnalysisResult {
  available: boolean;
  status: 'completed' | 'unavailable';
  model: string;
  isRoadDefect: boolean;
  severityLabel: 'low' | 'moderate' | 'severe' | 'unclassified';
  confidence: number;
  summary: string;
  duplicateLikelihood?: 'likely_same' | 'uncertain' | 'likely_different' | 'not_compared';
  duplicateReason?: string;
  error?: string;
}

function getConfiguredGeminiKey(): string | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'MY_GEMINI_API_KEY') return null;
  return key;
}

export function getConfiguredGeminiModel(): string {
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
}

export async function analyzePotholeImageWithGemini(params: {
  mediaBuffer: Buffer;
  mimeType: string;
  candidateBuffer?: Buffer | null;
  candidateMimeType?: string | null;
  notes?: string;
}): Promise<GeminiPotholeAnalysisResult> {
  const model = getConfiguredGeminiModel();
  const apiKey = getConfiguredGeminiKey();

  if (!apiKey) {
    return {
      available: false,
      status: 'unavailable',
      model,
      isRoadDefect: true,
      severityLabel: 'unclassified',
      confidence: 0,
      summary: 'Optional image analysis is unavailable; submission continues normally.',
      duplicateLikelihood: 'not_compared',
    };
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [
      {
        inlineData: {
          mimeType: params.mimeType,
          data: params.mediaBuffer.toString('base64'),
        },
      },
    ];

    let promptText =
      'Inspect image 1 as a road-condition photograph submitted in Atlanta, Georgia. ' +
      'Determine whether image 1 shows a real pavement/road defect (pothole, sunken asphalt, cracked crater, or roadway hazard), ' +
      'assign a rough visual severity label (low, moderate, severe, or unclassified) for human review, and write a brief 1-sentence visual summary. ' +
      'Do NOT guess GPS coordinates, addresses, or street names.';

    if (params.candidateBuffer && params.candidateMimeType) {
      parts.push({
        inlineData: {
          mimeType: params.candidateMimeType,
          data: params.candidateBuffer.toString('base64'),
        },
      });
      promptText +=
        ' Image 2 is an existing nearby pothole photograph. Compare image 1 and image 2 visually and report duplicateLikelihood ' +
        '(likely_same, uncertain, or likely_different) plus a concise duplicateReason.';
    } else {
      promptText += ' Set duplicateLikelihood to "not_compared".';
    }

    if (params.notes) {
      promptText += ` Contributor note: ${params.notes.slice(0, 240)}`;
    }

    parts.push({ text: promptText });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini analysis timed out')), 12000)
    );

    const response = await Promise.race([
      ai.models.generateContent({
        model,
        contents: { parts },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              isRoadDefect: { type: Type.BOOLEAN },
              severityLabel: {
                type: Type.STRING,
                description: 'One of: low, moderate, severe, unclassified',
              },
              confidence: { type: Type.NUMBER },
              summary: { type: Type.STRING },
              duplicateLikelihood: {
                type: Type.STRING,
                description: 'One of: likely_same, uncertain, likely_different, not_compared',
              },
              duplicateReason: { type: Type.STRING },
            },
            required: ['isRoadDefect', 'severityLabel', 'confidence', 'summary', 'duplicateLikelihood'],
          },
        },
      }),
      timeoutPromise,
    ]);

    const rawText = (response.text ?? '{}').trim();
    const parsed = JSON.parse(rawText) as {
      isRoadDefect?: boolean;
      severityLabel?: string;
      confidence?: number;
      summary?: string;
      duplicateLikelihood?: string;
      duplicateReason?: string;
    };

    const allowedSeverity = new Set(['low', 'moderate', 'severe', 'unclassified']);
    const severity = allowedSeverity.has(parsed.severityLabel || '')
      ? (parsed.severityLabel as 'low' | 'moderate' | 'severe' | 'unclassified')
      : 'unclassified';

    const allowedDup = new Set(['likely_same', 'uncertain', 'likely_different', 'not_compared']);
    const dupLikelihood = allowedDup.has(parsed.duplicateLikelihood || '')
      ? (parsed.duplicateLikelihood as 'likely_same' | 'uncertain' | 'likely_different' | 'not_compared')
      : 'not_compared';

    return {
      available: true,
      status: 'completed',
      model,
      isRoadDefect: Boolean(parsed.isRoadDefect ?? true),
      severityLabel: severity,
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.5))),
      summary: String(parsed.summary || 'Visual check complete.').slice(0, 300),
      duplicateLikelihood: dupLikelihood,
      duplicateReason: parsed.duplicateReason
        ? String(parsed.duplicateReason).slice(0, 240)
        : undefined,
    };
  } catch (err) {
    return {
      available: false,
      status: 'unavailable',
      model,
      isRoadDefect: true,
      severityLabel: 'unclassified',
      confidence: 0,
      summary: 'Optional image analysis was unavailable; capture continues normally.',
      duplicateLikelihood: 'not_compared',
      error: err instanceof Error ? err.message : 'Gemini call failed',
    };
  }
}
