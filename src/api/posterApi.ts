import type {
  PageDiagnosis,
  PolishedFeedback,
  PosterAnalysis,
  PosterAspectRatio,
  PosterDraft,
  PosterGenerationOptions,
  PosterRequirements,
  PosterSemanticRegion,
  PosterSummary,
  ReadingFeedbackDraft,
} from '../shared/types';

const LOCAL_API_ORIGIN = 'http://127.0.0.1:8787';
const DEFAULT_API_REQUEST_TIMEOUT_MS = 4000;
const TEXT_API_REQUEST_TIMEOUT_MS = 20000;
const IMAGE_API_REQUEST_TIMEOUT_MS = 90000;
const VISION_API_REQUEST_TIMEOUT_MS = 30000;

type RequestJsonOptions = {
  timeoutMs?: number;
};

export type RuntimeConfig = {
  imageApiDisabled: boolean;
  imageApiAvailable: boolean;
  imageModel: string;
  visionApiAvailable: boolean;
  visionModel: string;
  textModel: string;
  textProvider: 'deepseek' | 'ark' | 'local-fallback';
  arkProxyEnabled: boolean;
};

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  return requestJson<RuntimeConfig>('/api/config');
}

export async function updateRuntimeConfig(input: { imageApiDisabled: boolean }): Promise<RuntimeConfig> {
  return requestJson<RuntimeConfig>('/api/config', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
}

export async function extractPosterRequirements(requirements: PosterRequirements): Promise<PosterRequirements> {
  if (!requirements.rawBrief.trim()) {
    throw new Error('请先粘贴一段原始需求长文本。');
  }

  return requestJson<PosterRequirements>('/api/requirements/extract', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requirements),
  }, {
    timeoutMs: TEXT_API_REQUEST_TIMEOUT_MS,
  });
}

export async function summarizePosterRequirements(requirements: PosterRequirements): Promise<PosterSummary> {
  return requestJson<PosterSummary>('/api/requirements/summarize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requirements),
  }, {
    timeoutMs: TEXT_API_REQUEST_TIMEOUT_MS,
  });
}

export async function generatePosterDraft(input: {
  requirements: PosterRequirements;
  summary: PosterSummary;
  generationOptions: PosterGenerationOptions;
}): Promise<Omit<PosterDraft, 'layout'>> {
  return requestJson<Omit<PosterDraft, 'layout'>>('/api/poster/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  }, {
    timeoutMs: IMAGE_API_REQUEST_TIMEOUT_MS,
  });
}

export async function optimizePosterDraft(input: {
  poster: PosterDraft;
  diagnosis: PageDiagnosis;
  feedbackSummary?: string;
}): Promise<Omit<PosterDraft, 'layout'>> {
  return requestJson<Omit<PosterDraft, 'layout'>>('/api/poster/optimize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  }, {
    timeoutMs: IMAGE_API_REQUEST_TIMEOUT_MS,
  });
}

export async function polishReadingFeedback(input: {
  feedback: ReadingFeedbackDraft;
  summary?: PosterSummary;
}): Promise<PolishedFeedback> {
  return requestJson<PolishedFeedback>('/api/feedback/polish', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  }, {
    timeoutMs: TEXT_API_REQUEST_TIMEOUT_MS,
  });
}

export async function analyzePosterImage(input: {
  imageUrl: string;
  aspectRatio?: PosterAspectRatio;
  summary?: PosterSummary;
  fallbackRegions?: PosterSemanticRegion[];
}): Promise<PosterAnalysis> {
  return requestJson<PosterAnalysis>('/api/poster/analyze', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  }, {
    timeoutMs: VISION_API_REQUEST_TIMEOUT_MS,
  });
}

async function requestJson<T>(path: string, init?: RequestInit, options: RequestJsonOptions = {}): Promise<T> {
  let lastError: Error | undefined;

  for (const origin of getApiOrigins()) {
    const url = `${origin}${path}`;

    try {
      const response = await fetchWithTimeout(url, init, options.timeoutMs);
      const raw = await response.text();

      if (!response.ok) {
        lastError = new Error(buildHttpErrorMessage(path, response.status, raw));
        continue;
      }

      try {
        return JSON.parse(raw) as T;
      } catch {
        lastError = new Error(`${path} 返回了无法解析的内容。`);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        lastError = new Error(`${path} 请求超时。`);
        continue;
      }

      lastError = error instanceof Error ? error : new Error(`${path} 请求失败。`);
    }
  }

  throw lastError ?? new Error(`${path} 请求失败。`);
}

function getApiOrigins() {
  if (typeof window === 'undefined') {
    return [LOCAL_API_ORIGIN];
  }

  if (window.location.protocol === 'file:') {
    return [LOCAL_API_ORIGIN];
  }

  const origins = [''];

  if (`${window.location.protocol}//${window.location.host}` !== LOCAL_API_ORIGIN) {
    origins.push(LOCAL_API_ORIGIN);
  }

  return origins;
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = DEFAULT_API_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function buildHttpErrorMessage(path: string, status: number, raw: string) {
  const message = extractErrorMessage(raw);
  return message ? `${path} 请求失败（${status}）：${message}` : `${path} 请求失败（${status}）。`;
}

function extractErrorMessage(raw: string) {
  const text = raw.trim();

  if (!text) {
    return '';
  }

  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };

    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }

    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Ignore parse errors and fall back to plain text.
  }

  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
