import type { CoursePage, Courseware, PageDiagnosis, PosterDraft, PosterLayout } from './shared/types';

export function createEmptyPosterCourseware(): Courseware {
  return {
    id: 'poster-placeholder',
    title: '等待生成海报',
    pages: [],
  };
}

export function buildOptimizedPage(page: CoursePage, diagnosis: PageDiagnosis, optimizedPoster?: PosterDraft): CoursePage {
  const poster = page.poster;

  if (!poster) {
    return page;
  }

  const nextPoster = optimizedPoster ?? poster;

  return {
    ...page,
    subtitle:
      diagnosis.focusAoi === 'image'
        ? '优化版：主视觉已降低干扰，并为标题和关键信息留出更稳定的阅读路径。'
        : page.subtitle,
    variant: 'optimized',
    poster: {
      ...poster,
      ...nextPoster,
      layout: adjustPosterLayout(poster.layout, diagnosis),
      versionType: 'optimized',
      basedOnImageId: nextPoster.basedOnImageId ?? poster.id,
      optimizationReason: nextPoster.optimizationReason ?? diagnosis.headline,
      optimizationChanges: nextPoster.optimizationChanges ?? diagnosis.changes,
    },
  };
}

export function createPosterCourseware(draft: PosterDraft): Courseware {
  const images = draft.images?.length ? draft.images : undefined;

  return {
    id: `poster-${draft.id}`,
    title: draft.summary.goal || '海报反馈优化 Demo',
    pages: images
      ? images.map((image) =>
          createPosterPage({
            ...draft,
            id: image.id,
            imageUrl: image.imageUrl,
            imagePrompt: image.imagePrompt,
            imageError: image.imageError,
            source: image.source,
            aspectRatio: image.aspectRatio,
            semanticRegions: image.semanticRegions ?? draft.semanticRegions,
          }),
        )
      : [createPosterPage(draft)],
  };
}

function createPosterPage(draft: PosterDraft): CoursePage {
  const mustHave = draft.summary.mustHave.length ? draft.summary.mustHave : ['时间待定', '地点待定', '扫码预约'];

  return {
    id: `poster-page-${draft.id}`,
    title: `${draft.summary.goal || '文学活动海报'}${draft.aspectRatio ? ` ${draft.aspectRatio}` : ''}`,
    subtitle: draft.summary.visualDirection || '通过主视觉、标题和信息层级组织阅读注意力。',
    definition: [draft.summary.visualDirection || '文学杂志风主视觉。'],
    aiImageTitle: '主视觉',
    aiImagePrompt: draft.imagePrompt,
    aiImageCaption: draft.summary.style,
    aiImageMood: 'concept',
    diagramNotes: mustHave.slice(0, 4),
    mechanism: mustHave.slice(0, 3),
    example: ['立即预约', '扫码报名'],
    summary: draft.summary.layoutPriorities,
    variant: 'original',
    kind: 'poster',
    poster: draft,
  };
}

function adjustPosterLayout(layout: PosterLayout, diagnosis: PageDiagnosis): PosterLayout {
  const next = { ...layout };

  if (diagnosis.focusAoi === 'title' || diagnosis.issue === 'ignored') {
    next.titleScale = clamp(next.titleScale + 0.16, 0.82, 1.42);
    next.titleContrast = clamp(next.titleContrast + 0.18, 0.7, 1.3);
  }

  if (diagnosis.focusAoi === 'image') {
    if (diagnosis.issue === 'ignored') {
      next.imageScale = clamp(next.imageScale + 0.08, 0.72, 1.18);
      next.imageDim = clamp(next.imageDim - 0.12, 0.55, 1);
    } else {
      next.imageScale = clamp(next.imageScale - 0.08, 0.72, 1.18);
      next.imageDim = clamp(next.imageDim + 0.14, 0.55, 1);
    }
  }

  if (diagnosis.focusAoi === 'diagram' || diagnosis.focusAoi === 'mechanism') {
    next.infoScale = clamp(next.infoScale + 0.14, 0.8, 1.36);
  }

  if (diagnosis.focusAoi === 'example') {
    next.ctaEmphasis = clamp(next.ctaEmphasis + 0.2, 0.75, 1.5);
  }

  if (diagnosis.issue === 'fatigued') {
    next.infoScale = clamp(next.infoScale - 0.08, 0.8, 1.36);
    next.imageDim = clamp(next.imageDim + 0.08, 0.55, 1);
  }

  return next;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
