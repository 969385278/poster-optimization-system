export type CalibrationTarget = 'center' | 'left' | 'right' | 'top' | 'bottom';

export const CALIBRATION_TARGETS: CalibrationTarget[] = ['center', 'left', 'right', 'top', 'bottom'];

export const CALIBRATION_TARGET_POINTS: Record<CalibrationTarget, { x: number; y: number }> = {
  center: { x: 0.5, y: 0.5 },
  left: { x: 0.16, y: 0.5 },
  right: { x: 0.84, y: 0.5 },
  top: { x: 0.5, y: 0.16 },
  bottom: { x: 0.5, y: 0.84 },
};

export type AoiId = 'title' | 'definition' | 'image' | 'diagram' | 'mechanism' | 'example' | 'summary';

export const AOI_IDS: AoiId[] = ['title', 'definition', 'image', 'diagram', 'mechanism', 'example', 'summary'];

export type Reaction = 'neutral' | 'positive' | 'confused' | 'fatigued';

export type FaceFeatureSample = {
  timestamp: number;
  faceCenterX: number;
  faceCenterY: number;
  faceSize: number;
  irisX: number;
  irisY: number;
  leftIrisX: number;
  leftIrisY: number;
  rightIrisX: number;
  rightIrisY: number;
  eyeOpenness: number;
  eyeLookLeft: number;
  eyeLookRight: number;
  eyeLookUp: number;
  eyeLookDown: number;
  blinkScore: number;
  smile: number;
  browDown: number;
  eyeSquint: number;
  mouthFrown: number;
  jawOpen: number;
  sampleQuality: number;
  faceVisible: boolean;
  headStable: boolean;
};

export type AoiStats = {
  id: AoiId;
  dwellTimeMs: number;
  visitCount: number;
  revisitCount: number;
  ignored: boolean;
  reactionMs: Record<Reaction, number>;
};

export type CoursePage = {
  id: string;
  title: string;
  subtitle: string;
  definition: string[];
  aiImageTitle: string;
  aiImagePrompt: string;
  aiImageCaption: string;
  aiImageMood?: 'concept' | 'warm' | 'focus';
  diagramNotes: string[];
  mechanism: string[];
  example: string[];
  summary: string[];
  variant?: 'original' | 'optimized';
  kind?: 'poster';
  poster?: PosterDraft;
};

export type Courseware = {
  id: string;
  title: string;
  pages: CoursePage[];
};

export type PageDiagnosis = {
  pageId: string;
  headline: string;
  details: string[];
  changes: string[];
  focusAoi?: AoiId;
  issue?: 'ignored' | 'confused' | 'fatigued' | 'interested' | 'clear';
  feedbackSummary?: string;
};

export type ReadingFeedbackItem = {
  aoi: AoiId;
  label: string;
  behavior: string;
  inference: string;
  suggestion: string;
  dwellTimeMs: number;
  visitCount: number;
  reaction: Reaction;
};

export type ReadingFeedbackDraft = {
  focusedText: string;
  ignoredText: string;
  items: ReadingFeedbackItem[];
};

export type PolishedFeedback = {
  source: 'deepseek' | 'ark' | 'local-fallback';
  headline: string;
  summary: string;
  optimizationBrief: string;
  items: ReadingFeedbackItem[];
};

export type PosterRequirements = {
  rawBrief: string;
  topic: string;
  posterType: string;
  mustHave: string;
  visual: string;
  visualElements: string;
  avoidElements: string;
  hierarchy: string;
  audience: string;
  formats: string;
  style: string;
  notes: string;
};

export type PosterSummary = {
  goal: string;
  visualDirection: string;
  style: string;
  mustHave: string[];
  visualElements: string[];
  avoidElements: string[];
  audience: string;
  formatNotes: string[];
  layoutPriorities: string[];
  imagePrompt: string;
};

export type PosterDraft = {
  id: string;
  createdAt: string;
  summary: PosterSummary;
  imagePrompt: string;
  imageUrl: string;
  aspectRatio?: PosterAspectRatio;
  semanticRegions?: PosterSemanticRegion[];
  images?: PosterImageVariant[];
  source: 'remote-api' | 'local-fallback';
  imageError?: string;
  versionType?: 'original' | 'optimized';
  basedOnImageId?: string;
  optimizationReason?: string;
  optimizationChanges?: string[];
  layout: PosterLayout;
};

export type PosterAspectRatio = '16:9' | '3:4' | '4:3';

export type PosterGenerationOptions = {
  aspectRatios: PosterAspectRatio[];
  count: number;
};

export type PosterImageVariant = {
  id: string;
  label: string;
  aspectRatio: PosterAspectRatio;
  imagePrompt: string;
  imageUrl: string;
  semanticRegions?: PosterSemanticRegion[];
  source: 'remote-api' | 'local-fallback';
  imageError?: string;
};

export type PosterAnalysis = {
  source: 'ark-vision' | 'template-fallback';
  semanticRegions: PosterSemanticRegion[];
  layoutSummary?: string;
  missingInfo?: string[];
  error?: string;
};

export type PosterSemanticRegionRole =
  | 'title'
  | 'subtitle'
  | 'visual'
  | 'speaker'
  | 'time_venue'
  | 'qr'
  | 'organizer'
  | 'decoration';

export type PosterSemanticRegion = {
  id: string;
  name: string;
  role: PosterSemanticRegionRole;
  aoiId: AoiId;
  text?: string;
  importance: 'high' | 'medium' | 'low';
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type PosterLayout = {
  titleScale: number;
  titleContrast: number;
  imageScale: number;
  imageX: number;
  imageY: number;
  imageDim: number;
  infoScale: number;
  ctaEmphasis: number;
};
