import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

loadEnvFile();

const PORT = Number(process.env.AIGCFB_API_PORT ?? 8787);
const ARK_BASE_URL = process.env.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3';
const ARK_API_KEY = process.env.ARK_API_KEY;
const ARK_TEXT_MODEL = process.env.ARK_TEXT_MODEL ?? '';
const ARK_IMAGE_MODEL = process.env.ARK_IMAGE_MODEL ?? 'doubao-seedream-5-0-lite-260128';
const ARK_IMAGE_RESPONSE_FORMAT = process.env.ARK_IMAGE_RESPONSE_FORMAT ?? 'url';
const ARK_IMAGE_OUTPUT_FORMAT = process.env.ARK_IMAGE_OUTPUT_FORMAT ?? 'jpeg';
const ARK_IMAGE_SIZE = process.env.ARK_IMAGE_SIZE ?? '2K';
const ARK_VISION_MODEL = process.env.ARK_VISION_MODEL ?? process.env.ARK_TEXT_MODEL ?? '';
let arkImageApiDisabled = process.env.ARK_IMAGE_API_DISABLED === 'true';
const POSTER_ASPECT_VARIANTS = [
  { aspectRatio: '16:9', label: '16:9 横版', sizeEnv: 'ARK_IMAGE_SIZE_16_9', defaultSize: '2560x1440' },
  { aspectRatio: '3:4', label: '3:4 竖版', sizeEnv: 'ARK_IMAGE_SIZE_3_4', defaultSize: '1728x2304' },
  { aspectRatio: '4:3', label: '4:3 横版', sizeEnv: 'ARK_IMAGE_SIZE_4_3', defaultSize: '2304x1728' },
];
const MAX_POSTER_IMAGE_COUNT = 9;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_TEXT_MODEL = process.env.DEEPSEEK_TEXT_MODEL ?? 'deepseek-v4-pro';
const ARK_PROXY_URL = process.env.ARK_PROXY_URL ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
const ARK_PROXY_ENABLED = configureArkProxy();
const TEXT_MODEL_TIMEOUT_MS = Number(process.env.TEXT_MODEL_TIMEOUT_MS ?? 10000);
const VISION_MODEL_TIMEOUT_MS = Number(process.env.VISION_MODEL_TIMEOUT_MS ?? 20000);
const IMAGE_MODEL_TIMEOUT_MS = Number(process.env.IMAGE_MODEL_TIMEOUT_MS ?? 90000);

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      sendJson(response, 204, {});
      return;
    }

    if (request.method === 'GET' && request.url === '/api/config') {
      sendJson(response, 200, getRuntimeConfig());
      return;
    }

    if (request.method === 'POST' && request.url === '/api/config') {
      const input = await readJson(request);
      if (typeof input.imageApiDisabled === 'boolean') {
        arkImageApiDisabled = input.imageApiDisabled;
      }
      sendJson(response, 200, getRuntimeConfig());
      return;
    }

    if (request.method === 'POST' && request.url === '/api/requirements/summarize') {
      const input = await readJson(request);
      const summary = await summarizeRequirements(input);
      sendJson(response, 200, summary);
      return;
    }

    if (request.method === 'POST' && request.url === '/api/requirements/extract') {
      const input = await readJson(request);
      const extracted = await extractRequirements(input);
      sendJson(response, 200, extracted);
      return;
    }

    if (request.method === 'POST' && request.url === '/api/poster/generate') {
      const input = await readJson(request);
      const poster = await generatePoster(input);
      sendJson(response, 200, poster);
      return;
    }

    if (request.method === 'POST' && request.url === '/api/poster/optimize') {
      const input = await readJson(request);
      const poster = await optimizePoster(input);
      sendJson(response, 200, poster);
      return;
    }

    if (request.method === 'POST' && request.url === '/api/poster/analyze') {
      const input = await readJson(request);
      const analysis = await analyzePosterImage(input);
      sendJson(response, 200, analysis);
      return;
    }

    if (request.method === 'POST' && request.url === '/api/feedback/polish') {
      const input = await readJson(request);
      const feedback = await polishReadingFeedback(input);
      sendJson(response, 200, feedback);
      return;
    }

    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Unexpected server error',
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`AIGCFB API listening on http://127.0.0.1:${PORT}`);
  console.log(`Ark API key: ${ARK_API_KEY ? 'configured' : 'missing'}; image model: ${ARK_IMAGE_MODEL}`);
  console.log(`Ark image API: ${arkImageApiDisabled ? 'disabled' : 'enabled'}`);
  console.log(`Ark vision model: ${ARK_VISION_MODEL || 'missing'}`);
  console.log(
    `DeepSeek API key: ${DEEPSEEK_API_KEY ? 'configured' : 'missing'}; text model: ${DEEPSEEK_TEXT_MODEL}`,
  );
  console.log(`Ark proxy: ${ARK_PROXY_ENABLED ? 'enabled' : 'disabled'}`);
  console.log(
    `External API timeouts: text=${TEXT_MODEL_TIMEOUT_MS}ms, vision=${VISION_MODEL_TIMEOUT_MS}ms, image=${IMAGE_MODEL_TIMEOUT_MS}ms`,
  );
});

function getRuntimeConfig() {
  return {
    imageApiDisabled: arkImageApiDisabled,
    imageApiAvailable: Boolean(ARK_API_KEY),
    imageModel: ARK_IMAGE_MODEL,
    visionModel: ARK_VISION_MODEL,
    visionApiAvailable: Boolean(ARK_API_KEY && ARK_VISION_MODEL),
    textModel: DEEPSEEK_API_KEY ? DEEPSEEK_TEXT_MODEL : ARK_TEXT_MODEL || '',
    textProvider: DEEPSEEK_API_KEY ? 'deepseek' : ARK_TEXT_MODEL ? 'ark' : 'local-fallback',
    arkProxyEnabled: ARK_PROXY_ENABLED,
  };
}

async function summarizeRequirements(input) {
  if (DEEPSEEK_API_KEY && DEEPSEEK_TEXT_MODEL) {
    const modelSummary = await trySummarizeWithDeepSeek(input);

    if (modelSummary) {
      return modelSummary;
    }
  }

  if (ARK_API_KEY && ARK_TEXT_MODEL) {
    const modelSummary = await trySummarizeWithArk(input);

    if (modelSummary) {
      return modelSummary;
    }
  }

  return buildFallbackSummary(input);
}

async function extractRequirements(input) {
  if (DEEPSEEK_API_KEY && DEEPSEEK_TEXT_MODEL) {
    const modelRequirements = await tryExtractWithDeepSeek(input);

    if (modelRequirements) {
      return modelRequirements;
    }
  }

  return normalizePosterRequirements(input, { preferExtracted: true });
}

async function polishReadingFeedback(input) {
  const local = buildLocalPolishedFeedback(input.feedback);

  if (DEEPSEEK_API_KEY && DEEPSEEK_TEXT_MODEL) {
    try {
      const parsed = await requestDeepSeekJson([
        {
          role: 'system',
          content:
            '你是海报眼动与表情反馈分析助手。只输出 JSON，不输出 Markdown。字段必须为 headline, summary, optimizationBrief, items。items 是数组，每项包含 aoi, label, behavior, inference, suggestion, dwellTimeMs, visitCount, reaction。请基于用户真实行为数据润色，不要编造不存在的观看行为。summary 用中文自然语言总结；optimizationBrief 写给生图模型，说明哪些区域保留、哪些区域优化。',
        },
        {
          role: 'user',
          content: JSON.stringify({
            posterSummary: input.summary ?? {},
            feedback: input.feedback ?? {},
          }),
        },
      ]);

      return normalizePolishedFeedback(parsed, local, 'deepseek');
    } catch (error) {
      console.warn(`DeepSeek feedback polishing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  if (ARK_API_KEY && ARK_TEXT_MODEL) {
    try {
      const parsed = await requestArkFeedbackJson(input);
      return normalizePolishedFeedback(parsed, local, 'ark');
    } catch (error) {
      console.warn(`Ark feedback polishing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  return local;
}

async function generatePoster(input) {
  const summary = input.summary ?? buildFallbackSummary(input.requirements ?? {});
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const images = [];
  const variants = resolvePosterAspectVariants(input.generationOptions);

  for (const variant of variants) {
    const semanticRegions = buildPosterSemanticRegions(summary, variant);
    const prompt = buildImagePrompt(summary, variant, semanticRegions);
    const imageResult = ARK_API_KEY && !arkImageApiDisabled
      ? await tryGenerateImageWithArk(prompt, variant)
      : { imageUrl: undefined, error: arkImageApiDisabled ? 'Image API is disabled.' : 'ARK_API_KEY is not configured.' };
    const source = imageResult.imageUrl ? 'remote-api' : 'local-fallback';
    const imageUrl = imageResult.imageUrl ?? buildFallbackPosterDataUrl(summary, variant);
    const analyzedRegions = imageResult.imageUrl
      ? await tryAnalyzePosterRegions({ imageUrl, aspectRatio: variant.aspectRatio, summary, fallbackRegions: semanticRegions })
      : semanticRegions;

    images.push({
      id: `${id}-${variant.aspectRatio.replace(':', '-')}-${variant.generationIndex}`,
      label: variant.label,
      aspectRatio: variant.aspectRatio,
      imagePrompt: prompt,
      imageUrl,
      semanticRegions: analyzedRegions,
      source,
      imageError: imageResult.imageUrl ? undefined : imageResult.error,
    });
  }

  const primary = images[0];

  return {
    id,
    createdAt,
    summary,
    imagePrompt: primary.imagePrompt,
    imageUrl: primary.imageUrl,
    aspectRatio: primary.aspectRatio,
    semanticRegions: primary.semanticRegions,
    images,
    source: images.every((image) => image.source === 'remote-api') ? 'remote-api' : 'local-fallback',
    imageError: images
      .filter((image) => image.imageError)
      .map((image) => `${image.label}: ${image.imageError}`)
      .join('；') || undefined,
  };
}

function resolvePosterAspectVariants(options = {}) {
  const requestedRatios = Array.isArray(options.aspectRatios) ? options.aspectRatios : [];
  const selectedVariants = requestedRatios
    .map((aspectRatio) => POSTER_ASPECT_VARIANTS.find((variant) => variant.aspectRatio === aspectRatio))
    .filter(Boolean);
  const baseVariants = selectedVariants.length ? selectedVariants : POSTER_ASPECT_VARIANTS;
  const requestedCount = Number(options.count);
  const count = Number.isFinite(requestedCount)
    ? Math.min(MAX_POSTER_IMAGE_COUNT, Math.max(1, Math.trunc(requestedCount)))
    : baseVariants.length;

  return Array.from({ length: count }, (_, index) => {
    const variant = baseVariants[index % baseVariants.length];
    const cycle = Math.floor(index / baseVariants.length) + 1;
    const shouldShowCycle = count > baseVariants.length;

    return {
      ...variant,
      label: shouldShowCycle ? `${variant.label} #${cycle}` : variant.label,
      generationIndex: index + 1,
    };
  });
}

async function optimizePoster(input) {
  const originalPoster = input.poster ?? {};
  const diagnosis = input.diagnosis ?? {};
  const summary = originalPoster.summary ?? input.summary ?? buildOptimizationFallbackSummary(originalPoster);
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const variant = posterVariantForAspectRatio(originalPoster.aspectRatio);
  const semanticRegions = buildPosterSemanticRegions(summary, variant);
  const feedbackSummary = asText(input.feedbackSummary) || asText(diagnosis.feedbackSummary);
  const prompt = buildOptimizationImagePrompt(summary, originalPoster, diagnosis, variant, semanticRegions, feedbackSummary);
  const imageResult = ARK_API_KEY && !arkImageApiDisabled
    ? await tryGenerateImageWithArk(prompt, variant, originalPoster.imageUrl)
    : { imageUrl: undefined, error: arkImageApiDisabled ? 'Image API is disabled.' : 'ARK_API_KEY is not configured.' };
  const source = imageResult.imageUrl ? 'remote-api' : 'local-fallback';
  const imageUrl = imageResult.imageUrl ?? originalPoster.imageUrl ?? buildFallbackPosterDataUrl(summary, variant);
  const analyzedRegions = imageResult.imageUrl
    ? await tryAnalyzePosterRegions({ imageUrl, aspectRatio: variant.aspectRatio, summary, fallbackRegions: semanticRegions })
    : semanticRegions;
  const label = `优化版 ${variant.label}`;

  return {
    id,
    createdAt,
    summary,
    imagePrompt: prompt,
    imageUrl,
    aspectRatio: variant.aspectRatio,
    semanticRegions: analyzedRegions,
    images: [
      {
        id: `${id}-${variant.aspectRatio.replace(':', '-')}-optimized`,
        label,
        aspectRatio: variant.aspectRatio,
        imagePrompt: prompt,
        imageUrl,
        semanticRegions: analyzedRegions,
        source,
        imageError: imageResult.imageUrl ? undefined : `${imageResult.error}；已保留原海报图像，未使用默认兜底海报。`,
      },
    ],
    source,
    imageError: imageResult.imageUrl ? undefined : `${imageResult.error}；已保留原海报图像，未使用默认兜底海报。`,
    versionType: 'optimized',
    basedOnImageId: originalPoster.id,
    optimizationReason: asText(diagnosis.headline) || '根据注意力与表情反馈优化',
    optimizationChanges: Array.isArray(diagnosis.changes) ? diagnosis.changes.map(String) : [],
  };
}

function posterVariantForAspectRatio(aspectRatio) {
  return POSTER_ASPECT_VARIANTS.find((variant) => variant.aspectRatio === aspectRatio) ?? POSTER_ASPECT_VARIANTS[0];
}

function buildOptimizationFallbackSummary(originalPoster = {}) {
  return {
    goal: asText(originalPoster.title) || '原海报优化版',
    visualDirection: '基于原海报图像与用户反馈进行局部优化，保留原活动事实和整体风格。',
    style: '沿用原海报风格',
    mustHave: [],
    visualElements: [],
    avoidElements: ['不要改成其他活动', '不要虚构新的嘉宾、时间、地点或主题'],
    audience: '原海报目标受众',
    formatNotes: [],
    layoutPriorities: ['保留原海报主题', '只优化反馈指出的弱关注区域'],
    imagePrompt: 'optimize the original poster based on feedback, preserve original event facts',
  };
}

async function trySummarizeWithArk(input) {
  try {
    const response = await fetchWithTimeout(`${ARK_BASE_URL}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ARK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ARK_TEXT_MODEL,
        input: [
          {
            role: 'system',
            content:
              '你是海报需求分析助手。只输出 JSON，不输出 Markdown。字段：goal, visualDirection, style, mustHave, visualElements, avoidElements, audience, formatNotes, layoutPriorities, imagePrompt。',
          },
          {
            role: 'user',
            content: JSON.stringify(input),
          },
        ],
      }),
    }, TEXT_MODEL_TIMEOUT_MS);

    if (!response.ok) {
      return undefined;
    }

    const data = await response.json();
    const text = extractResponseText(data);
    const parsed = JSON.parse(text);
    return normalizeSummary(parsed, input);
  } catch {
    return undefined;
  }
}

async function trySummarizeWithDeepSeek(input) {
  try {
    const response = await requestDeepSeekJson([
      {
        role: 'system',
        content:
          '你是海报需求分析助手。只输出 JSON，不输出 Markdown。字段：goal, visualDirection, style, mustHave, visualElements, avoidElements, audience, formatNotes, layoutPriorities, imagePrompt。mustHave、visualElements、avoidElements、formatNotes、layoutPriorities 必须是字符串数组。',
      },
      {
        role: 'user',
        content: JSON.stringify(input),
      },
    ]);

    return normalizeSummary(response, input);
  } catch (error) {
    console.warn(`DeepSeek summarization failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return undefined;
  }
}

async function tryExtractWithDeepSeek(input) {
  try {
    const fallback = normalizePosterRequirements(input, { preferExtracted: true });
    const parsed = await requestDeepSeekJson([
      {
        role: 'system',
        content:
          '你是海报需求抽取助手。只输出 JSON，不输出 Markdown。字段必须为 rawBrief, topic, posterType, mustHave, visual, visualElements, avoidElements, hierarchy, audience, formats, style, notes。所有字段都是字符串；多条信息用换行分隔。重点抽取用户希望画面中出现的元素、必须出现的信息、禁止出现的元素、信息层级、受众、尺寸和交付要求。',
      },
      {
        role: 'user',
        content: JSON.stringify(input),
      },
    ]);

    return {
      rawBrief: asText(parsed.rawBrief) || fallback.rawBrief,
      topic: asText(parsed.topic) || fallback.topic,
      posterType: asText(parsed.posterType) || fallback.posterType,
      mustHave: asText(parsed.mustHave) || fallback.mustHave,
      visual: asText(parsed.visual) || fallback.visual,
      visualElements: asText(parsed.visualElements) || fallback.visualElements,
      avoidElements: asText(parsed.avoidElements) || fallback.avoidElements,
      hierarchy: asText(parsed.hierarchy) || fallback.hierarchy,
      audience: asText(parsed.audience) || fallback.audience,
      formats: asText(parsed.formats) || fallback.formats,
      style: asText(parsed.style) || fallback.style,
      notes: asText(parsed.notes) || fallback.notes,
    };
  } catch (error) {
    console.warn(`DeepSeek extraction failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return undefined;
  }
}

async function requestArkFeedbackJson(input) {
  const response = await fetchWithTimeout(`${ARK_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ARK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ARK_TEXT_MODEL,
      input: [
        {
          role: 'system',
          content:
            '你是海报眼动与表情反馈分析助手。只输出 JSON，不输出 Markdown。字段必须为 headline, summary, optimizationBrief, items。items 是数组，每项包含 aoi, label, behavior, inference, suggestion, dwellTimeMs, visitCount, reaction。请基于用户真实行为数据润色，不要编造不存在的观看行为。',
        },
        {
          role: 'user',
          content: JSON.stringify({
            posterSummary: input.summary ?? {},
            feedback: input.feedback ?? {},
          }),
        },
      ],
    }),
  }, TEXT_MODEL_TIMEOUT_MS);

  if (!response.ok) {
    const error = await readApiError(response);
    throw new Error(error.message);
  }

  const data = await response.json();
  return parseJsonObject(extractResponseText(data));
}

function buildLocalPolishedFeedback(feedback) {
  const items = Array.isArray(feedback?.items) ? feedback.items.map(normalizeFeedbackItem).filter(Boolean) : [];
  const focusedText = asText(feedback?.focusedText) || '暂无稳定关注区域';
  const ignoredText = asText(feedback?.ignoredText) || '暂无明显遗漏区域';
  const goodItems = items.filter((item) => item.dwellTimeMs >= 500 && item.reaction !== 'confused' && item.reaction !== 'fatigued');
  const weakItems = items.filter((item) => item.dwellTimeMs < 500 || item.reaction === 'confused' || item.reaction === 'fatigued');

  return {
    source: 'local-fallback',
    headline: '阅读反馈总结',
    summary: `用户主要关注到：${focusedText}。用户没看到或关注不足：${ignoredText}。`,
    optimizationBrief: [
      goodItems.length ? `保留这些有效区域的表达：${goodItems.map((item) => item.label).join('、')}` : '',
      weakItems.length ? `重点优化这些区域：${weakItems.map((item) => `${item.label}（${item.suggestion}）`).join('；')}` : '',
    ]
      .filter(Boolean)
      .join('。') || '保持整体层级，微调弱关注区域的字号、颜色、位置和留白。',
    items,
  };
}

function normalizePolishedFeedback(parsed, fallback, source) {
  const items = Array.isArray(parsed?.items)
    ? parsed.items.map(normalizeFeedbackItem).filter(Boolean)
    : fallback.items;

  return {
    source,
    headline: asText(parsed?.headline) || fallback.headline,
    summary: asText(parsed?.summary) || fallback.summary,
    optimizationBrief: asText(parsed?.optimizationBrief) || fallback.optimizationBrief,
    items: items.length ? items : fallback.items,
  };
}

function normalizeFeedbackItem(item) {
  const aoi = asText(item?.aoi);
  const allowedAoi = ['title', 'definition', 'image', 'diagram', 'mechanism', 'example', 'summary'];
  const reaction = asText(item?.reaction);
  const allowedReaction = ['neutral', 'positive', 'confused', 'fatigued'];

  if (!allowedAoi.includes(aoi)) {
    return undefined;
  }

  return {
    aoi,
    label: asText(item.label) || aoi,
    behavior: asText(item.behavior) || '暂无行为描述',
    inference: asText(item.inference) || '暂无推论',
    suggestion: asText(item.suggestion) || '暂无建议',
    dwellTimeMs: Number.isFinite(Number(item.dwellTimeMs)) ? Number(item.dwellTimeMs) : 0,
    visitCount: Number.isFinite(Number(item.visitCount)) ? Number(item.visitCount) : 0,
    reaction: allowedReaction.includes(reaction) ? reaction : 'neutral',
  };
}

async function requestDeepSeekJson(messages) {
  const response = await fetchWithTimeout(`${DEEPSEEK_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEEPSEEK_TEXT_MODEL,
      messages,
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      stream: false,
    }),
  }, TEXT_MODEL_TIMEOUT_MS);

  if (!response.ok) {
    const error = await readApiError(response);
    throw new Error(error.message);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;

  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('DeepSeek returned no message content.');
  }

  return parseJsonObject(text);
}

async function tryGenerateImageWithArk(prompt, variant, referenceImageUrl = '') {
  try {
    const firstAttempt = await requestArkImage(prompt, variant, referenceImageUrl);

    if (firstAttempt.imageUrl) {
      return firstAttempt;
    }

    if (referenceImageUrl && shouldRetryWithoutReferenceImage(firstAttempt.error)) {
      console.warn('Ark image generation did not accept reference image, retrying with text prompt only.');
      const textOnlyAttempt = await requestArkImage(prompt, variant);

      if (textOnlyAttempt.imageUrl) {
        return textOnlyAttempt;
      }
    }

    if (shouldRetryWithSafePrompt(firstAttempt.errorCode)) {
      const safePrompt = buildPolicySafeImagePrompt(variant, prompt);
      console.warn('Ark image generation hit policy filter, retrying with a conservative prompt that preserves original facts.');
      const secondAttempt = await requestArkImage(safePrompt, variant);

      if (secondAttempt.imageUrl) {
        return secondAttempt;
      }

      return {
        imageUrl: undefined,
        error: `${firstAttempt.error}；已尝试改用保守优化提示词重试，但仍未成功：${secondAttempt.error}`,
      };
    }

    return firstAttempt;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected image generation error.';
    console.warn(`Ark image generation failed: ${message}`);
    return { imageUrl: undefined, error: message };
  }
}

async function requestArkImage(prompt, variant, referenceImageUrl = '') {
  const response = await fetchWithTimeout(`${ARK_BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ARK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildArkImageGenerationRequest(prompt, variant, referenceImageUrl)),
  }, IMAGE_MODEL_TIMEOUT_MS);

  if (!response.ok) {
    const error = await readApiError(response);
    console.warn(`Ark image generation failed: ${error.message}`);
    return { imageUrl: undefined, error: error.message, errorCode: error.code };
  }

  const data = await response.json();
  const image = data.data?.[0];

  if (typeof image?.url === 'string' && image.url) {
    return { imageUrl: image.url };
  }

  if (typeof image?.b64_json === 'string' && image.b64_json) {
    return { imageUrl: `data:image/png;base64,${image.b64_json}` };
  }

  return { imageUrl: undefined, error: 'Ark returned no image URL or base64 image data.' };
}

async function analyzePosterImage(input) {
  const imageUrl = asText(input.imageUrl);
  const aspectRatio = asText(input.aspectRatio) || '3:4';
  const summary = input.summary ?? {};
  const fallbackRegions = Array.isArray(input.fallbackRegions)
    ? input.fallbackRegions
    : buildPosterSemanticRegions(summary, posterVariantForAspectRatio(aspectRatio));

  if (!imageUrl) {
    throw new Error('imageUrl is required.');
  }

  if (!ARK_API_KEY || !ARK_VISION_MODEL) {
    return {
      source: 'template-fallback',
      semanticRegions: fallbackRegions,
      layoutSummary: 'Vision API is not configured.',
      missingInfo: [],
      error: 'ARK_API_KEY or ARK_VISION_MODEL is not configured.',
    };
  }

  return analyzePosterWithArkVision({ imageUrl, aspectRatio, summary, fallbackRegions });
}

async function tryAnalyzePosterRegions(input) {
  try {
    const analysis = await analyzePosterImage(input);
    return analysis.semanticRegions?.length ? analysis.semanticRegions : input.fallbackRegions;
  } catch (error) {
    console.warn(`Ark vision poster analysis failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return input.fallbackRegions;
  }
}

async function analyzePosterWithArkVision({ imageUrl, aspectRatio, summary, fallbackRegions }) {
  const response = await fetchWithTimeout(`${ARK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ARK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ARK_VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: buildPosterVisionPrompt(summary, aspectRatio),
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
              },
            },
          ],
        },
      ],
      temperature: 0.1,
    }),
  }, VISION_MODEL_TIMEOUT_MS);

  if (!response.ok) {
    const error = await readApiError(response);
    throw new Error(error.message);
  }

  const data = await response.json();
  const parsed = parseJsonObject(extractResponseText(data));
  const semanticRegions = normalizeVisionRegions(parsed.regions, fallbackRegions);

  return {
    source: 'ark-vision',
    semanticRegions,
    layoutSummary: asText(parsed.layoutSummary),
    missingInfo: Array.isArray(parsed.missingInfo) ? parsed.missingInfo.map(String).slice(0, 8) : [],
  };
}

function buildPosterVisionPrompt(summary, aspectRatio) {
  const expectedText = [
    summary.goal ? `title: ${summary.goal}` : '',
    Array.isArray(summary.mustHave) && summary.mustHave.length ? `important copy: ${summary.mustHave.join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    'Analyze this poster image and return strict JSON only. Do not return Markdown.',
    `Poster aspect ratio hint: ${aspectRatio}.`,
    expectedText ? `Known expected event text:\n${expectedText}` : '',
    'Detect semantic regions that a viewer may look at. Use normalized coordinates from 0 to 1 relative to the visible poster image.',
    'Return at most 10 regions. Prefer real content regions over decorative areas.',
    'Allowed role values: title, subtitle, visual, speaker, time_venue, qr, organizer, decoration.',
    'Allowed importance values: high, medium, low.',
    'Use this exact JSON shape:',
    '{"regions":[{"id":"title","name":"main title area","role":"title","text":"recognized text or visual description","importance":"high","box":{"x":0.1,"y":0.1,"width":0.5,"height":0.12}}],"missingInfo":[],"layoutSummary":"short poster layout diagnosis"}',
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeVisionRegions(regions, fallbackRegions) {
  if (!Array.isArray(regions)) {
    return fallbackRegions;
  }

  const normalized = regions
    .map((region, index) => normalizeVisionRegion(region, index))
    .filter(Boolean)
    .slice(0, 10);

  return normalized.length ? normalized : fallbackRegions;
}

function normalizeVisionRegion(region, index) {
  const role = normalizeRegionRole(region?.role);
  const box = normalizeVisionBox(region?.box);

  if (!role || !box) {
    return undefined;
  }

  return {
    id: asText(region.id) || `${role}-${index + 1}`,
    name: asText(region.name) || defaultRegionName(role),
    role,
    aoiId: aoiIdForRegionRole(role),
    text: asText(region.text),
    importance: normalizeImportance(region.importance),
    box,
  };
}

function normalizeVisionBox(box) {
  if (!box || typeof box !== 'object') {
    return undefined;
  }

  const x = clampRatio(Number(box.x));
  const y = clampRatio(Number(box.y));
  const width = clampRatio(Number(box.width));
  const height = clampRatio(Number(box.height));

  if (![x, y, width, height].every(Number.isFinite) || width < 0.03 || height < 0.03) {
    return undefined;
  }

  return {
    x: roundRatio(Math.min(x, 0.98)),
    y: roundRatio(Math.min(y, 0.98)),
    width: roundRatio(Math.min(width, 1 - Math.min(x, 0.98))),
    height: roundRatio(Math.min(height, 1 - Math.min(y, 0.98))),
  };
}

function clampRatio(value) {
  if (!Number.isFinite(value)) {
    return NaN;
  }

  return Math.min(1, Math.max(0, value));
}

function normalizeRegionRole(role) {
  const value = asText(role);
  const allowed = ['title', 'subtitle', 'visual', 'speaker', 'time_venue', 'qr', 'organizer', 'decoration'];
  return allowed.includes(value) ? value : undefined;
}

function normalizeImportance(value) {
  return ['high', 'medium', 'low'].includes(value) ? value : 'medium';
}

function aoiIdForRegionRole(role) {
  return {
    title: 'title',
    subtitle: 'definition',
    visual: 'image',
    speaker: 'diagram',
    time_venue: 'mechanism',
    qr: 'example',
    organizer: 'summary',
    decoration: 'image',
  }[role] ?? 'image';
}

function defaultRegionName(role) {
  return {
    title: 'Title area',
    subtitle: 'Subtitle area',
    visual: 'Main visual area',
    speaker: 'Speaker information',
    time_venue: 'Time and venue',
    qr: 'QR or registration area',
    organizer: 'Organizer information',
    decoration: 'Decorative area',
  }[role] ?? 'Poster region';
}

function buildArkImageGenerationRequest(prompt, variant, referenceImageUrl = '') {
  const request = {
    model: ARK_IMAGE_MODEL,
    prompt,
    size: imageSizeForVariant(variant),
    response_format: ARK_IMAGE_RESPONSE_FORMAT,
  };

  if (referenceImageUrl && /^https?:\/\//i.test(referenceImageUrl)) {
    request.image = referenceImageUrl;
  }

  if (ARK_IMAGE_MODEL.startsWith('doubao-seedream-5-0')) {
    request.output_format = ARK_IMAGE_OUTPUT_FORMAT;
  }

  return request;
}

function imageSizeForVariant(variant) {
  if (!variant) {
    return ARK_IMAGE_SIZE;
  }

  return process.env[variant.sizeEnv] ?? variant.defaultSize ?? ARK_IMAGE_SIZE;
}

function configureArkProxy() {
  if (!ARK_PROXY_URL || isLocalUrl(ARK_BASE_URL)) {
    return false;
  }

  setGlobalDispatcher(new ProxyAgent(ARK_PROXY_URL));
  return true;
}

function isLocalUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

async function readApiError(response) {
  const text = await response.text();

  if (!text) {
    return {
      message: `HTTP ${response.status} ${response.statusText}`,
      code: undefined,
    };
  }

  try {
    const data = JSON.parse(text);
    const error = data.error ?? data;
    const parts = [
      `HTTP ${response.status}`,
      sanitizeApiErrorText(error.message),
      error.type ? `type=${error.type}` : '',
      error.param ? `param=${error.param}` : '',
      error.code ? `code=${error.code}` : '',
    ].filter(Boolean);

    return {
      message: parts.join(' | '),
      code: error.code,
    };
  } catch {
    return {
      message: `HTTP ${response.status}: ${sanitizeApiErrorText(text.slice(0, 500))}`,
      code: undefined,
    };
  }
}

function shouldRetryWithSafePrompt(errorCode) {
  return errorCode === 'InputTextSensitiveContentDetected.PolicyViolation';
}

function shouldRetryWithoutReferenceImage(message) {
  return /image|reference|invalid|unsupported|unknown|parameter|param/i.test(String(message ?? ''));
}

function buildPolicySafeImagePrompt(variant, originalPrompt = '') {
  return [
    'create a conservative revised event poster based on the same original poster brief',
    variant ? `aspect ratio ${variant.aspectRatio}, ${variant.label}` : '',
    originalPrompt ? `preserve the same visible event text and facts from this brief: ${originalPrompt}` : '',
    'do not change the event topic, title, date, venue, guests, organizer, or QR reservation meaning',
    'only improve visual hierarchy, readability, contrast, spacing, and weak-attention regions',
    'readable Chinese poster typography',
    'avoid portraits of recognizable real people and avoid copyrighted character likeness',
    'do not invent a new activity, do not use default sample content, do not mention Yu Hua unless the original brief explicitly says Yu Hua',
    'not a recognizable real person',
  ].filter(Boolean).join(', ');
}

function sanitizeApiErrorText(value) {
  return String(value ?? '')
    .replace(/sk-[A-Za-z0-9_*.-]+/g, 'sk-***')
    .replace(/\b[A-Za-z0-9]{24,}\b/g, (token) => (looksLikeSecretToken(token) ? '***' : token));
}

function looksLikeSecretToken(token) {
  return /[A-Z]/.test(token) && /\d/.test(token);
}

function buildFallbackSummary(input) {
  const requirements = normalizePosterRequirements(input);
  const mustHave = splitLines(requirements.mustHave).length
    ? splitLines(requirements.mustHave)
    : ['时间待定', '地点待定', '报名方式待定'];
  const visualElements = splitLines(requirements.visualElements);
  const avoidElements = splitLines(requirements.avoidElements);
  const formatNotes = splitLines(requirements.formats);
  const layoutPriorities = splitLines(requirements.hierarchy).length
    ? splitLines(requirements.hierarchy)
    : ['主标题优先可见', '时间地点清晰', '报名入口不能被忽略', '人像不压过主题'];

  return {
    goal: requirements.topic || '未命名活动海报',
    visualDirection: requirements.visual || '围绕原始需求设置清晰主视觉，并为标题、时间地点和行动入口保留明确排版空间。',
    style: requirements.style || '信息清晰的活动海报风格',
    mustHave,
    visualElements,
    avoidElements,
    audience: requirements.audience || '面向目标读者，用于线上传播和线下张贴。',
    formatNotes,
    layoutPriorities,
    imagePrompt: buildDetailedImagePrompt(requirements, visualElements, avoidElements),
  };
}

function normalizeSummary(parsed, input) {
  const fallback = buildFallbackSummary(input);

  return {
    goal: asText(parsed.goal) || fallback.goal,
    visualDirection: asText(parsed.visualDirection) || fallback.visualDirection,
    style: asText(parsed.style) || fallback.style,
    mustHave: Array.isArray(parsed.mustHave) ? parsed.mustHave.map(String).slice(0, 12) : fallback.mustHave,
    visualElements: Array.isArray(parsed.visualElements)
      ? parsed.visualElements.map(String).slice(0, 10)
      : fallback.visualElements,
    avoidElements: Array.isArray(parsed.avoidElements)
      ? parsed.avoidElements.map(String).slice(0, 10)
      : fallback.avoidElements,
    audience: asText(parsed.audience) || fallback.audience,
    formatNotes: Array.isArray(parsed.formatNotes) ? parsed.formatNotes.map(String).slice(0, 8) : fallback.formatNotes,
    layoutPriorities: Array.isArray(parsed.layoutPriorities)
      ? parsed.layoutPriorities.map(String).slice(0, 10)
      : fallback.layoutPriorities,
    imagePrompt: asText(parsed.imagePrompt) || fallback.imagePrompt,
  };
}

function buildImagePrompt(summary, variant, semanticRegions = []) {
  const layoutGuide = buildNaturalLayoutGuide(variant, semanticRegions);
  const visibleTextGuide = buildVisiblePosterTextGuide(summary);
  const designGuide = buildInternalDesignGuide(summary);

  return [
    'Create a single finished event poster image.',
    visibleTextGuide,
    designGuide,
    layoutGuide,
    'generate one complete finished poster, not a background or a UI mockup',
    'all typography, title, subtitle, event details, organizer text and QR placeholder must be part of the image',
    'use clean readable Chinese poster typography and a professional information hierarchy',
    'make the poster look ready for publishing, with no extra web overlay needed',
    'do not print prompt instructions, field names, design notes, semantic region names, feedback labels, coordinate-like strings, debug text, or layout annotations in the poster',
    'include a clear QR-code-like reservation block if the brief mentions scanning or QR code',
    'editorial poster composition',
  ]
    .filter(Boolean)
    .join(', ');
}

function buildOptimizationImagePrompt(summary, originalPoster, diagnosis, variant, semanticRegions = [], feedbackSummary = '') {
  const feedbackDetails = Array.isArray(diagnosis.details) ? diagnosis.details.join(' | ') : '';
  const changes = Array.isArray(diagnosis.changes) ? diagnosis.changes.join(' | ') : '';
  const focusRegion = diagnosis.focusAoi ? `focus region: ${diagnosis.focusAoi}` : '';
  const issue = diagnosis.issue ? `observed issue: ${diagnosis.issue}` : '';
  const layoutGuide = buildNaturalLayoutGuide(variant, semanticRegions);
  const visibleTextGuide = buildVisiblePosterTextGuide(summary);
  const designGuide = buildInternalDesignGuide(summary);

  return [
    'generate a revised optimized version of the previous poster as one complete finished poster image',
    'keep the same event facts, title, names, date, venue, organizer, QR reservation block and core theme; do not invent new facts',
    visibleTextGuide,
    designGuide,
    asText(diagnosis.headline) ? `internal feedback diagnosis, do not print as poster text: ${diagnosis.headline}` : '',
    feedbackSummary ? `internal polished audience feedback and optimization brief, do not print as poster text: ${feedbackSummary}` : '',
    feedbackDetails ? `internal feedback evidence, do not print as poster text: ${feedbackDetails}` : '',
    changes ? `internal required optimization changes, do not print as poster text: ${changes}` : '',
    focusRegion ? `internal ${focusRegion}, do not print as poster text` : '',
    issue ? `internal ${issue}, do not print as poster text` : '',
    layoutGuide,
    'make the changed region easier to notice, read, and understand',
    'reduce visual competition from low-priority decorations',
    'all typography and text must be inside the generated poster image, no external web overlay',
    'do not print prompt instructions, field names, design notes, semantic region names, feedback labels, coordinate-like strings, debug text, or layout annotations in the poster',
    'professional readable Chinese poster typography, improved information hierarchy',
  ]
    .filter(Boolean)
    .join(', ');
}

function buildVisiblePosterTextGuide(summary) {
  const copy = [
    summary.goal,
    ...(Array.isArray(summary.mustHave) ? summary.mustHave.slice(0, 12) : []),
  ]
    .map((item) => asText(item))
    .filter(Boolean);

  return [
    `Typeset only these real poster words: ${copy.length ? copy.join(' / ') : 'concise event title and essential event facts'}.`,
    'Do not add any other readable words, captions, labels, metadata, coordinates, prompt text, or interface text.',
  ].join(' ');
}

function buildInternalDesignGuide(summary) {
  return [
    summary.visualDirection ? `Use this visual direction without writing it as text: ${summary.visualDirection}.` : '',
    summary.style ? `Mood and style: ${summary.style}.` : '',
    summary.visualElements?.length ? `Depict these as visual motifs only, not as written labels: ${summary.visualElements.join(', ')}.` : '',
    summary.avoidElements?.length ? `Avoid these motifs and styles: ${summary.avoidElements.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function buildNaturalLayoutGuide(variant, semanticRegions = []) {
  const roles = new Set(semanticRegions.map((region) => region.role));
  const common = [
    'use an invisible professional layout grid; do not draw grid lines or labels',
    roles.has('title') ? 'make the main title the first visual anchor' : '',
    roles.has('subtitle') ? 'place the subtitle close to the title with lower visual weight' : '',
    roles.has('visual') ? 'give the main visual a clear focal area without covering key text' : '',
    roles.has('speaker') ? 'keep speaker or guest information in a readable secondary information group' : '',
    roles.has('time_venue') ? 'make date, time and venue easy to scan as a compact information group' : '',
    roles.has('qr') ? 'keep the QR reservation block clear, high contrast, and separated from complex texture' : '',
    roles.has('organizer') ? 'put organizer information quietly near the bottom' : '',
  ];

  if (variant?.aspectRatio === '16:9') {
    return [
      'horizontal poster layout',
      'arrange title and key copy on the left, main visual on the right or center-right, action/QR information near the lower-right',
      ...common,
    ]
      .filter(Boolean)
      .join(', ');
  }

  if (variant?.aspectRatio === '4:3') {
    return [
      'classic horizontal poster layout',
      'balance the main visual on one side with title and event information on the other side',
      'place time, venue and QR information along the lower area',
      ...common,
    ]
      .filter(Boolean)
      .join(', ');
  }

  return [
    'vertical poster layout',
    'place title near the top, main visual in the middle, speaker/theme information below it, and time/venue/QR information near the bottom',
    ...common,
  ]
    .filter(Boolean)
    .join(', ');
}

function buildPosterSemanticRegions(summary, variant) {
  const mustHaveText = Array.isArray(summary.mustHave) ? summary.mustHave.join(' | ') : '';
  const titleText = summary.goal || '活动主标题';
  const subtitleText = summary.visualDirection || '活动主题说明';
  const speakerText = pickItems(summary.mustHave, ['嘉宾', '主讲', '分享', '主持', '专家', '作家', '教授']) || '嘉宾 / 主题信息';
  const timeVenueText = pickItems(summary.mustHave, ['时间', '日期', '地点', '会场', '报告厅']) || mustHaveText || '时间地点';
  const qrText = pickItems(summary.mustHave, ['扫码', '二维码', '报名', '预约', '入场']) || '扫码预约入场';
  const organizerText = pickItems(summary.mustHave, ['主办', '承办', '协办']) || '主办 / 承办';
  const aspectRatio = variant?.aspectRatio;

  if (aspectRatio === '16:9') {
    return normalizeRegions([
      region('title', '主标题区', 'title', 'title', titleText, 'high', 0.07, 0.08, 0.48, 0.2),
      region('subtitle', '副标题与引导语', 'subtitle', 'definition', subtitleText, 'medium', 0.07, 0.28, 0.42, 0.14),
      region('visual', '主视觉图像', 'visual', 'image', summary.visualElements?.join('、') || '主视觉', 'high', 0.52, 0.08, 0.4, 0.54),
      region('speaker', '嘉宾与主题信息', 'speaker', 'diagram', speakerText, 'medium', 0.07, 0.45, 0.4, 0.2),
      region('time-venue', '时间地点', 'time_venue', 'mechanism', timeVenueText, 'high', 0.07, 0.7, 0.46, 0.14),
      region('qr', '报名二维码', 'qr', 'example', qrText, 'high', 0.73, 0.68, 0.18, 0.24),
      region('organizer', '主承办信息', 'organizer', 'summary', organizerText, 'low', 0.54, 0.84, 0.36, 0.08),
    ]);
  }

  if (aspectRatio === '4:3') {
    return normalizeRegions([
      region('visual', '主视觉图像', 'visual', 'image', summary.visualElements?.join('、') || '主视觉', 'high', 0.06, 0.12, 0.42, 0.58),
      region('title', '主标题区', 'title', 'title', titleText, 'high', 0.5, 0.1, 0.42, 0.2),
      region('subtitle', '副标题与引导语', 'subtitle', 'definition', subtitleText, 'medium', 0.52, 0.31, 0.36, 0.14),
      region('speaker', '嘉宾与主题信息', 'speaker', 'diagram', speakerText, 'medium', 0.52, 0.48, 0.34, 0.16),
      region('time-venue', '时间地点', 'time_venue', 'mechanism', timeVenueText, 'high', 0.08, 0.76, 0.52, 0.13),
      region('qr', '报名二维码', 'qr', 'example', qrText, 'high', 0.7, 0.7, 0.2, 0.22),
      region('organizer', '主承办信息', 'organizer', 'summary', organizerText, 'low', 0.52, 0.88, 0.36, 0.07),
    ]);
  }

  return normalizeRegions([
    region('title', '主标题区', 'title', 'title', titleText, 'high', 0.1, 0.07, 0.8, 0.14),
    region('subtitle', '副标题与引导语', 'subtitle', 'definition', subtitleText, 'medium', 0.15, 0.22, 0.7, 0.1),
    region('visual', '主视觉图像', 'visual', 'image', summary.visualElements?.join('、') || '主视觉', 'high', 0.12, 0.33, 0.76, 0.33),
    region('speaker', '嘉宾与主题信息', 'speaker', 'diagram', speakerText, 'medium', 0.12, 0.66, 0.52, 0.12),
    region('time-venue', '时间地点', 'time_venue', 'mechanism', timeVenueText, 'high', 0.12, 0.8, 0.48, 0.1),
    region('qr', '报名二维码', 'qr', 'example', qrText, 'high', 0.68, 0.76, 0.22, 0.15),
    region('organizer', '主承办信息', 'organizer', 'summary', organizerText, 'low', 0.15, 0.92, 0.7, 0.05),
  ]);
}

function region(id, name, role, aoiId, text, importance, x, y, width, height) {
  return {
    id,
    name,
    role,
    aoiId,
    text,
    importance,
    box: { x, y, width, height },
  };
}

function normalizeRegions(regions) {
  return regions.map((item) => ({
    ...item,
    box: {
      x: roundRatio(item.box.x),
      y: roundRatio(item.box.y),
      width: roundRatio(item.box.width),
      height: roundRatio(item.box.height),
    },
  }));
}

function roundRatio(value) {
  return Math.round(value * 1000) / 1000;
}

function pickItems(items, keywords) {
  if (!Array.isArray(items)) {
    return '';
  }

  return items.filter((item) => keywords.some((keyword) => String(item).includes(keyword))).slice(0, 3).join(' | ');
}

function buildDetailedImagePrompt(requirements, visualElements, avoidElements) {
  const parts = [
    'complete event poster with all text designed inside the image',
    requirements.topic ? `main title text: ${requirements.topic}` : '',
    requirements.posterType ? `subtitle or event type text: ${requirements.posterType}` : '',
    splitLines(requirements.mustHave).length
      ? `required poster copy: ${splitLines(requirements.mustHave).join(' | ')}`
      : '',
    requirements.visual || '',
    requirements.style ? `style: ${requirements.style}` : '',
    visualElements.length ? `must visually suggest: ${visualElements.join(', ')}` : '',
    requirements.hierarchy ? `visual hierarchy: ${requirements.hierarchy}` : '',
    requirements.audience ? `audience: ${requirements.audience}` : '',
    requirements.formats ? `format constraints: ${requirements.formats}` : '',
    avoidElements.length ? `do not show: ${avoidElements.join(', ')}` : '',
    requirements.notes ? `extra constraints: ${requirements.notes}` : '',
  ];

  return parts.filter(Boolean).join(', ');
}

function buildFallbackPosterDataUrl(summary, variant) {
  const title = escapeXml(summary.goal ?? '文学座谈会');
  const style = escapeXml(summary.style ?? '文学杂志风');
  const size = fallbackSvgSize(variant);
  const margin = Math.round(size.width * 0.08);
  const titleY = Math.round(size.height * 0.78);
  const styleY = Math.round(size.height * 0.84);
  const portraitX = Math.round(size.width * 0.64);
  const portraitY = Math.round(size.height * 0.34);
  const portraitR = Math.round(Math.min(size.width, size.height) * 0.16);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">
      <defs>
        <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#f6f0e8"/>
          <stop offset="0.56" stop-color="#d8ddd4"/>
          <stop offset="1" stop-color="#263b3a"/>
        </linearGradient>
        <linearGradient id="portrait" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#202f2d"/>
          <stop offset="1" stop-color="#9c7b5b"/>
        </linearGradient>
      </defs>
      <rect width="${size.width}" height="${size.height}" fill="url(#paper)"/>
      <rect x="${margin}" y="${margin}" width="${size.width - margin * 2}" height="${size.height - margin * 2}" fill="none" stroke="#263b3a" stroke-width="4" opacity="0.22"/>
      <circle cx="${portraitX}" cy="${portraitY}" r="${portraitR}" fill="url(#portrait)" opacity="0.92"/>
      <rect x="${margin}" y="${Math.round(size.height * 0.6)}" width="${Math.round(size.width * 0.68)}" height="18" fill="#263b3a" opacity="0.42"/>
      <rect x="${margin}" y="${Math.round(size.height * 0.64)}" width="${Math.round(size.width * 0.48)}" height="12" fill="#263b3a" opacity="0.28"/>
      <text x="${margin}" y="${titleY}" fill="#263b3a" font-family="Georgia, serif" font-size="${Math.round(Math.min(size.width, size.height) * 0.06)}" font-weight="700">${title}</text>
      <text x="${margin}" y="${styleY}" fill="#263b3a" font-family="Georgia, serif" font-size="${Math.round(Math.min(size.width, size.height) * 0.03)}">${style}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function fallbackSvgSize(variant) {
  if (variant?.aspectRatio === '16:9') {
    return { width: 1600, height: 900 };
  }

  if (variant?.aspectRatio === '4:3') {
    return { width: 1200, height: 900 };
  }

  return { width: 900, height: 1200 };
}

function normalizePosterRequirements(input, options = {}) {
  const current = {
    rawBrief: asText(input.rawBrief),
    topic: asText(input.topic),
    posterType: asText(input.posterType),
    mustHave: asText(input.mustHave),
    visual: asText(input.visual),
    visualElements: asText(input.visualElements),
    avoidElements: asText(input.avoidElements),
    hierarchy: asText(input.hierarchy),
    audience: asText(input.audience),
    formats: asText(input.formats),
    style: asText(input.style),
    notes: asText(input.notes),
  };
  const extracted = extractRequirementsFromText(current.rawBrief);
  const preferExtracted = options.preferExtracted === true;

  const pick = (manualValue, extractedValue, fallback = '') =>
    preferExtracted
      ? asText(extractedValue) || asText(manualValue) || fallback
      : asText(manualValue) || asText(extractedValue) || fallback;

  const mustHaveValue = joinImportantItems(
    preferExtracted && extracted.mustHave.length
      ? extracted.mustHave
      : splitLines(current.mustHave).length
        ? splitLines(current.mustHave)
        : extracted.mustHave,
  );
  const posterType =
    pick(current.posterType, extracted.posterType) ||
    inferPosterType(current.rawBrief || current.topic || current.mustHave);

  return {
    rawBrief: current.rawBrief,
    topic: pick(current.topic, extracted.topic, '未命名活动海报'),
    posterType: posterType || '活动海报',
    mustHave: mustHaveValue || '时间待定\n地点待定\n报名方式待定',
    visual:
      pick(current.visual, extracted.visual) ||
      defaultVisualDirection(current.rawBrief || current.topic || posterType),
    visualElements: joinImportantItems(
      preferExtracted && extracted.visualElements.length
        ? extracted.visualElements
        : splitLines(current.visualElements).length
          ? splitLines(current.visualElements)
          : extracted.visualElements,
    ),
    avoidElements: joinImportantItems(
      preferExtracted && extracted.avoidElements.length
        ? extracted.avoidElements
        : splitLines(current.avoidElements).length
          ? splitLines(current.avoidElements)
          : extracted.avoidElements,
    ),
    hierarchy:
      pick(current.hierarchy, extracted.hierarchy) ||
      '第一眼看到主标题，第二眼看到主视觉，第三眼看到时间、地点和报名方式。',
    audience: pick(current.audience, extracted.audience) || '面向活动目标读者，用于线上宣传和线下张贴。',
    formats: pick(current.formats, extracted.formats) || '竖版主海报，保留后续适配方形和横版的空间。',
    style:
      pick(current.style, extracted.style) ||
      defaultStyleDirection(current.rawBrief || current.topic || posterType),
    notes:
      pick(current.notes, extracted.notes) || '第一版优先保证信息层级清晰，不改活动核心事实。',
  };
}

function extractRequirementsFromText(rawBrief) {
  const text = asText(rawBrief);

  if (!text) {
    return {
      topic: '',
      posterType: '',
      mustHave: [],
      visual: '',
      visualElements: [],
      avoidElements: [],
      hierarchy: '',
      audience: '',
      formats: '',
      style: '',
      notes: '',
    };
  }

  const lines = splitRawLines(text);
  const sentences = splitSentences(text);
  const clauses = splitClauses(text);
  const topic =
    findLabeledValue(lines, ['海报主题', '活动主题', '座谈主题', '讲座主题', '主题', '标题', '活动名称']) ||
    inferTopicFromText(text, sentences);
  const posterType =
    findLabeledValue(lines, ['海报类型', '活动类型', '活动形式', '类型']) || inferPosterType(text);
  const visual =
    collectPreferenceLines([...lines, ...clauses], ['主视觉', '视觉', '画面', '人物', '肖像', '照片', '插画', '背景', '构图']).join('；') ||
    inferVisualFromText(text);
  const style =
    collectPreferenceLines([...lines, ...clauses], ['风格', '调性', '配色', '色调', '氛围', '质感', '版式', '杂志封面']).join('；') ||
    inferStyleFromText(text);
  const notes = collectNoteLines([...lines, ...clauses], sentences).join('\n');
  const mustHave = collectImportantItems([...lines, ...clauses], sentences, topic);
  const visualElements = collectVisualElements([...lines, ...clauses, ...sentences]);
  const avoidElements = collectAvoidElements([...lines, ...clauses, ...sentences]);
  const hierarchy = collectHierarchy(lines, sentences);
  const audience = collectAudience(lines, sentences);
  const formats = collectFormatNotes(lines, sentences);

  return {
    topic,
    posterType,
    mustHave,
    visual,
    visualElements,
    avoidElements,
    hierarchy,
    audience,
    formats,
    style,
    notes,
  };
}

function splitRawLines(value) {
  return String(value)
    .split(/\r?\n+/)
    .flatMap(segmentTextLine)
    .filter(Boolean);
}

function splitSentences(value) {
  return String(value)
    .split(/[。！？!?；;\n]+/)
    .map(cleanTextLine)
    .filter(Boolean);
}

function splitClauses(value) {
  return String(value)
    .split(/[，,、。！？!?；;\n]/)
    .map(cleanTextLine)
    .filter(Boolean);
}

function segmentTextLine(value) {
  const cleaned = cleanTextLine(value);

  if (!cleaned) {
    return [];
  }

  if (cleaned.length > 40 && /[，,。；;]/.test(cleaned)) {
    return cleaned
      .split(/[。！？!?；;，,、]/)
      .map(cleanTextLine)
      .filter(Boolean);
  }

  return [cleaned];
}

function cleanTextLine(value) {
  return String(value ?? '')
    .replace(/^[\s\-*•·●]+/, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function findLabeledValue(lines, labels) {
  for (const line of lines) {
    for (const label of labels) {
      const escaped = escapeRegExp(label);
      const match = line.match(new RegExp(`(?:^|[，,；;。\\s])${escaped}\\s*[：:是为]\\s*(.+)$`, 'i'));

      if (match?.[1]) {
        return cleanExtractedValue(match[1]);
      }
    }
  }

  return '';
}

function inferTopicFromText(text, sentences) {
  const namedTitle = text.match(/(?:活动暂定名称为|活动名称为|名称为|主标题(?:需要|是|为)?)[“"「]?([^”"」。\n]{4,60})[”"」]?/);

  if (namedTitle?.[1]) {
    return cleanExtractedValue(namedTitle[1]).replace(/作为主标题.*/, '');
  }

  const quoted = text.match(/[“"]([^”"]{3,28})[”"]/);

  if (quoted?.[1]) {
    return cleanExtractedValue(quoted[1]);
  }

  const first = sentences[0] ?? '';
  const directMatch = first.match(
    /(?:做|设计|生成|需要|想要|希望做|客户要做|客户希望做|帮我做)?(?:一张|一个|一份)?(.{3,32}?)(?:海报|主视觉|活动页|宣传图)/,
  );

  if (directMatch?.[1]) {
    return cleanExtractedValue(directMatch[1]);
  }

  return cleanExtractedValue(first).slice(0, 26);
}

function inferPosterType(text) {
  const value = String(text ?? '');

  if (/(座谈|对谈|论坛|圆桌)/.test(value)) {
    return '座谈会海报';
  }

  if (/(讲座|分享会|公开课|沙龙)/.test(value)) {
    return '讲座活动海报';
  }

  if (/(展览|展讯|开幕)/.test(value)) {
    return '展览海报';
  }

  if (/(发布会|新品|上新)/.test(value)) {
    return '发布活动海报';
  }

  if (/(招募|报名|征集)/.test(value)) {
    return '招募海报';
  }

  return '';
}

function collectPreferenceLines(lines, keywords) {
  const matches = [];

  for (const line of lines) {
    if (keywords.some((keyword) => line.includes(keyword))) {
      const cleaned = cleanExtractedValue(stripCommonPrefixes(line));

      if (cleaned) {
        matches.push(cleaned);
      }
    }
  }

  return uniqueStrings(matches).slice(0, 3);
}

function collectNoteLines(lines, sentences) {
  const noteKeywords = ['不要', '避免', '注意', '保留', '必须', '务必', '优先', '不要太', '不改', '不能'];
  const collected = [];

  for (const line of [...lines, ...sentences]) {
    if (noteKeywords.some((keyword) => line.includes(keyword))) {
      const cleaned = cleanExtractedValue(stripCommonPrefixes(line));

      if (cleaned) {
        collected.push(cleaned);
      }
    }
  }

  return uniqueStrings(collected).slice(0, 3);
}

function collectImportantItems(lines, sentences, topic) {
  const items = [];
  const priorityPattern =
    /(时间|日期|地点|地址|会场|嘉宾|主讲|主持|专家|作家|荣誉|头衔|主办|承办|协办|报名|预约|扫码|二维码|电话|微信|邮箱|直播|票价|费用|人数|限额|茅盾文学奖)/;
  const supportPattern = /(主题|文案|口号|宣传语)/;
  const excludePattern = /^(必须让观众|其次|不要|避免|但不要|地点和报名方式|时间和地点|时间地点)/;

  const addItem = (value) => {
    const cleaned = normalizeImportantItem(value);

    if (cleaned) {
      items.push(cleaned);
    }
  };

  for (const line of lines) {
    if (excludePattern.test(line)) {
      continue;
    }

    if (priorityPattern.test(line) || looksLikeTimeLine(line) || looksLikeLocationLine(line)) {
      addItem(stripCommonPrefixes(line));
    }
  }

  if (items.length < 5) {
    for (const line of lines) {
      if (excludePattern.test(line)) {
        continue;
      }

      if (supportPattern.test(line)) {
        addItem(stripCommonPrefixes(line));
      }
    }
  }

  if (!items.length) {
    for (const sentence of sentences) {
      if (
        !excludePattern.test(sentence) &&
        (priorityPattern.test(sentence) || looksLikeTimeLine(sentence) || looksLikeLocationLine(sentence))
      ) {
        addItem(sentence);
      }
    }
  }

  if (topic && !items.some((item) => item.includes(topic))) {
    items.unshift(`主题：${topic}`);
  }

  return uniqueStrings(items).slice(0, 8);
}

function collectVisualElements(lines) {
  const elementWords = [
    '大观园',
    '园林',
    '窗格',
    '屏风',
    '花枝',
    '水面倒影',
    '倒影',
    '诗笺',
    '书页',
    '批注',
    '旧纸张',
    '帘幕',
    '人影',
    '背影',
    '剪影',
    '衣袖',
    '落花',
    '花瓣',
    '诗稿',
    '建筑',
    '海棠',
    '芭蕉',
    '竹影',
    '团扇',
    '绢帕',
    '古典园林',
    '翻开的书',
    '繁花',
    '残叶',
    '印章红',
    '书签',
  ];
  const sourceLines = lines.filter((line) =>
    /(可以|希望|画面|视觉|表现|意象|元素|例如|参考|使用|加入|主视觉|构图)/.test(line),
  );
  const matched = [];

  for (const word of elementWords) {
    if (sourceLines.some((line) => line.includes(word))) {
      matched.push(word);
    }
  }

  return uniqueStrings(matched).slice(0, 12);
}

function collectAvoidElements(lines) {
  const avoidLines = lines.filter((line) => /(不要|不希望|不能|避免|不建议|不需要|禁止|暂时不|不会)/.test(line));
  const cleaned = avoidLines
    .map((line) =>
      cleanExtractedValue(
        stripCommonPrefixes(
          line
            .replace(/^也?不希望/u, '不要')
            .replace(/^不希望/u, '不要')
            .replace(/^不建议/u, '不要')
            .replace(/^不需要/u, '不要')
            .replace(/^不能/u, '不要')
            .replace(/^避免/u, '避免'),
        ),
      ),
    )
    .filter((line) => line.length >= 4);

  return uniqueStrings(cleaned).slice(0, 10);
}

function collectHierarchy(lines, sentences) {
  const source = [...lines, ...sentences].find((line) => /(第一眼|第二眼|第三眼|信息优先级|最醒目|清晰层级|主次|不要.*抢过)/.test(line));

  if (source) {
    return cleanExtractedValue(source);
  }

  return '';
}

function collectAudience(lines, sentences) {
  const source = [...lines, ...sentences].find((line) => /(受众|面向|大学生|青年教师|文学爱好者|社会读者|全校师生|线上宣传|线下张贴|朋友圈|小红书|公众号)/.test(line));

  if (source) {
    return cleanExtractedValue(source);
  }

  return '';
}

function collectFormatNotes(lines, sentences) {
  const formatLines = [...lines, ...sentences].filter((line) =>
    /(尺寸|比例|竖版|横版|方形|3:4|1:1|16:9|A3|A2|CMYK|300dpi|出血|PDF|JPG|PNG|源文件|二维码)/i.test(line),
  );

  return uniqueStrings(formatLines.map(cleanExtractedValue)).slice(0, 8).join('\n');
}

function looksLikeTimeLine(value) {
  return /(\d{4}年|\d{1,2}月\d{1,2}日|\d{1,2}:\d{2}|周[一二三四五六日天]|AM|PM)/i.test(value);
}

function looksLikeLocationLine(value) {
  return /(上海|北京|广州|深圳|杭州|南京|成都|西安|地点|地址|会场|书店|礼堂|报告厅|中心|学院|馆|剧场|线上|直播)/.test(
    value,
  );
}

function stripCommonPrefixes(value) {
  return String(value ?? '').replace(/^(客户要做|客户希望做|需要做|想做|希望做|做一张|做一个|生成一张|海报里要有|海报中要有)\s*/, '');
}

function cleanExtractedValue(value) {
  return String(value ?? '')
    .replace(/^[：:、,，.\s]+/, '')
    .replace(/[。；;，,\s]+$/g, '')
    .trim();
}

function normalizeImportantItem(value) {
  return cleanExtractedValue(
    String(value ?? '')
      .replace(/^(?:活动)?时间(?:是|为)?[：:]?\s*/u, '时间：')
      .replace(/^(?:地点|地址)(?:在|是|为)?[：:]?\s*/u, '地点：')
      .replace(/^主办(?:方)?(?:是|为)?[：:]?\s*/u, '主办方：')
      .replace(/^报名方式(?:是|为)?[：:]?\s*/u, '报名方式：')
      .replace(/^主题想突出[：:]?\s*/u, '主题：')
      .replace(/^主题(?:是|为)?[：:]?\s*/u, '主题：')
      .replace(/^还希望补上一句\s*/u, '文案：')
      .replace(/^如果版面允许(?:，|,)?可以提到\s*/u, '补充荣誉：')
      .replace(/^可以提到\s*/u, '补充荣誉：'),
  );
}

function joinImportantItems(items) {
  const lines = uniqueStrings(items).filter(Boolean);
  return lines.join('\n');
}

function defaultVisualDirection(text) {
  if (/(文学|作家|阅读|座谈|讲座)/.test(text)) {
    return '人物主视觉靠近画面一侧，整体克制留白，给主题、时间地点和报名信息留出清晰排版空间。';
  }

  if (/(展览|艺术|开幕)/.test(text)) {
    return '主视觉先突出作品气质，再给标题与展讯信息留出稳定的排版区域。';
  }

  return '围绕主题设置一个明确主视觉焦点，同时为标题、时间地点和行动入口留出清晰版面。';
}

function defaultStyleDirection(text) {
  if (/(文学|作家|阅读)/.test(text)) {
    return '文学杂志风，克制、留白、低饱和，信息层级清楚。';
  }

  if (/(论坛|讲座|分享会|发布会)/.test(text)) {
    return '专业活动海报风格，重点突出主题与关键信息，避免信息拥挤。';
  }

  return '信息优先、层级清楚、适合演示的活动海报风格。';
}

function inferVisualFromText(text) {
  if (/侧脸|肖像|人物/.test(text)) {
    return '画面需要突出人物主视觉，并给标题与时间地点留出清晰排版区域。';
  }

  return '';
}

function inferStyleFromText(text) {
  if (/杂志|文学/.test(text)) {
    return '文学杂志风，克制留白。';
  }

  if (/简约|高级|克制|留白/.test(text)) {
    return '简约克制，留白明确，重点信息先被看到。';
  }

  return '';
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => asText(value)).filter(Boolean)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractResponseText(data) {
  const chatContent = data.choices?.[0]?.message?.content;

  if (typeof chatContent === 'string') {
    return chatContent;
  }

  if (Array.isArray(chatContent)) {
    return chatContent
      .map((part) => part.text)
      .filter(Boolean)
      .join('\n');
  }

  if (typeof data.output_text === 'string') {
    return data.output_text;
  }

  const parts = data.output
    ?.flatMap((item) => item.content ?? [])
    .map((part) => part.text)
    .filter(Boolean);

  return parts?.join('\n') ?? '';
}

function parseJsonObject(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }

    throw new Error('Model response is not valid JSON.');
  }
}

function splitLines(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(/\r?\n|，|,|；|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function loadEnvFile() {
  if (!existsSync('.env')) {
    return;
  }

  const lines = readFileSync('.env', 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const index = trimmed.indexOf('=');

    if (index === -1) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Upstream request timed out after ${timeoutMs}ms: ${url}`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Content-Type': 'application/json; charset=utf-8',
  });

  if (statusCode === 204) {
    response.end();
    return;
  }

  response.end(JSON.stringify(payload));
}
