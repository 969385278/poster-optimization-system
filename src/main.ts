import './style.css';
import {
  analyzePosterImage,
  extractPosterRequirements,
  generatePosterDraft,
  getRuntimeConfig,
  optimizePosterDraft,
  polishReadingFeedback,
  summarizePosterRequirements,
  updateRuntimeConfig,
  type RuntimeConfig,
} from './api/posterApi';
import { startFrontCamera, stopCamera } from './camera/localCamera';
import { buildOptimizedPage, createEmptyPosterCourseware, createPosterCourseware } from './courseware';
import {
  AOI_IDS,
  CALIBRATION_TARGET_POINTS,
  CALIBRATION_TARGETS,
  type AoiId,
  type AoiStats,
  type CalibrationTarget,
  type CoursePage,
  type FaceFeatureSample,
  type PageDiagnosis,
  type PolishedFeedback,
  type PosterAspectRatio,
  type PosterDraft,
  type PosterGenerationOptions,
  type PosterRequirements,
  type PosterSemanticRegion,
  type PosterSummary,
  type Reaction,
  type ReadingFeedbackDraft,
} from './shared/types';
import { createFaceTracker, type FaceTracker, type FaceTrackingState } from './vision/faceTracker';

type RawGazePoint = {
  x: number;
  y: number;
  faceX: number;
  faceY: number;
  faceSize: number;
};

type CalibrationModel = Record<CalibrationTarget, RawGazePoint>;

type CalibrationState = {
  active: boolean;
  complete: boolean;
  confirmed: boolean;
  usingDefault: boolean;
  targetIndex: number;
  targetStartedAt: number;
  samples: Record<CalibrationTarget, RawGazePoint[]>;
  model?: CalibrationModel;
};

type OptimizationJob = {
  pageId: string;
  activePage: boolean;
  status: 'working' | 'done';
  diagnosis: PageDiagnosis;
  optimizedPage?: CoursePage;
};

type SemanticRegionHit = {
  aoi: AoiId;
  id: string;
  label: string;
  role: string;
  importance?: PosterSemanticRegion['importance'];
};

type SemanticRegionStats = SemanticRegionHit & {
  dwellTimeMs: number;
  visitCount: number;
  reactionMs: Record<Reaction, number>;
};

type PageSession = {
  stats: Record<AoiId, AoiStats>;
  regionStats: Record<string, SemanticRegionStats>;
  lastAoi?: AoiId;
  lastRegionId?: string;
  lastRegionLabel?: string;
  lastSampleAt: number;
  currentReaction: Reaction;
  denied: boolean;
  diagnosis: PageDiagnosis;
};

type PageFeedbackRecord = {
  pageId: string;
  pageIndex: number;
  title: string;
  session: PageSession;
  feedback: ReadingFeedbackDraft;
  polishedFeedback?: PolishedFeedback;
};

type AppView = 'setup' | 'reading' | 'done';

type PosterViewportState = {
  activePageId: string;
  fitWidth: number;
  fitHeight: number;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  panX: number;
  panY: number;
  dragging: boolean;
  pointerId: number | null;
  dragStartX: number;
  dragStartY: number;
  dragOriginX: number;
  dragOriginY: number;
};

const CALIBRATION_TARGET_MS = 1550;
const CALIBRATION_WARMUP_MS = 360;
const OPTIMIZATION_DELAY_MS = 1100;
const defaultCourseware = createEmptyPosterCourseware();
const POSTER_ASPECT_OPTIONS: PosterAspectRatio[] = ['16:9', '3:4', '4:3'];
const DEFAULT_POSTER_GENERATION_OPTIONS: PosterGenerationOptions = {
  aspectRatios: [...POSTER_ASPECT_OPTIONS],
  count: 3,
};
const DEFAULT_TEMPLATE_IMAGE_URL = '/templates/default-poster-red-mansion.jpeg';
const DEFAULT_TEMPLATE_REQUIREMENTS: PosterRequirements = {
  rawBrief:
    '做一张用于阅读推广和活动导读的红楼梦主题海报，重点突出主题标题、人物群像氛围、活动时间地点与报名入口，整体阅读路径要先看到主题，再看到主视觉，最后快速定位报名信息。',
  topic: '红楼梦主题阅读海报',
  posterType: '文学阅读活动 / 导读海报',
  mustHave: '主题：红楼梦\n活动形式：阅读分享 / 导读\n时间地点信息\n报名二维码 / 预约入口\n主办单位信息',
  visual: '用古典人物群像与暖色纸张质感建立文学氛围，标题和信息区保持清晰，不被背景吞掉。',
  visualElements: '人物群像主视觉、题签式标题、暖色书卷背景、活动信息区、二维码入口',
  avoidElements: '装饰过密、标题压在复杂背景上、小字过多、无关商业元素',
  hierarchy: '先看标题，再看人物主视觉，最后看时间地点与报名入口。',
  audience: '面向文学爱好者、阅读社群与课堂导读活动。',
  formats: '16:9 横版主海报，适合投屏展示和网页阅读。',
  style: '古典文学展陈风，暖红与米白底色，克制、清晰、适合阅读。',
  notes: '默认模板直接使用内置海报与预置语义区，不再调用视觉识别 API。',
};

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App shell failed to initialize.');
}

const appRoot = app;

const calibration: CalibrationState = {
  active: false,
  complete: false,
  confirmed: false,
  usingDefault: false,
  targetIndex: 0,
  targetStartedAt: 0,
  samples: createCalibrationSamples(),
};

let view: AppView = 'setup';
let cameraStream: MediaStream | undefined;
let faceTracker: FaceTracker | undefined;
let currentPageIndex = 0;
let lastCompletedPageIndex = 0;
let visiblePageSnapshot: CoursePage | undefined;
let activeCourseware = defaultCourseware;
let currentSession: PageSession = createPageSession();
let currentScreenPoint = { x: 0.5, y: 0.5 };
let cameraStatus = '未开启';
let trackerStatus = '未加载';
let trackingStatus = '等待摄像头';
let setupMessage = '先开启摄像头并完成校准，也可以使用默认校准进入演示。';
let mouseKeyboardMode = false;
let keyboardReaction: Reaction = 'neutral';
let posterSummary: PosterSummary | undefined;
let posterDraft: PosterDraft | undefined;
let posterStatus = '先填写需求，然后生成摘要。';
let posterGenerationOptions: PosterGenerationOptions = { ...DEFAULT_POSTER_GENERATION_OPTIONS };
let runtimeConfig: RuntimeConfig | undefined;
let feedbackPolishStatus = '等待完成阅读后生成反馈总结。';
const posterViewport = createPosterViewportState();
let readerPosterLayoutFrame = 0;
let doneOptimizationStatus = '';
let selectedFeedbackPageId = '';
const optimizedPages = new Map<string, CoursePage>();
const optimizationJobs = new Map<string, OptimizationJob>();
const pageSessions = new Map<string, PageSession>();
const pageFeedbackRecords = new Map<string, PageFeedbackRecord>();

app.innerHTML = `
  <main class="app-shell">
    <section class="setup-view" data-view="setup">
      <div class="hero-panel">
        <div class="hero-copy">
          <p class="eyebrow">poster feedback studio</p>
          <h1>基于眼动与表情反馈的海报自优化</h1>
          <p>把需求整理、海报生成、设备校准和阅读入口压缩到同一张工作台里，方便你直接演示“生成 - 观察 - 修改”的闭环。</p>
        </div>
      </div>

      <section class="setup-dashboard">
        <form class="brief-form" data-brief-form>
          <label class="full-span">
            <div class="field-head">
              <span>原始需求长文本</span>
              <button type="button" class="ghost-button inline-button" data-brief-extract>自动提取重点信息</button>
            </div>
            <textarea class="brief-raw-textarea" data-brief-raw>客户要做一张活动主海报，用于线上宣传和线下张贴。海报需要有明确的主标题、活动类型、时间地点、嘉宾或核心内容、报名入口和主办方信息。画面整体要有清晰的信息层级，第一眼看到主题，第二眼理解活动氛围，第三眼找到时间地点和报名方式。视觉风格可以根据具体活动调整，但不要堆砌无关装饰，不要让背景压过文字，也不要生成乱码或提示词说明。</textarea>
            <small class="field-hint">支持直接粘贴客户发来的一大段自然语言，系统会优先筛出主题、关键信息、视觉方向和注意事项。</small>
          </label>
          <label>
            <span>海报主题</span>
            <input data-brief-topic value="活动主海报" />
          </label>
          <label>
            <span>海报类型</span>
            <input data-brief-type value="主题活动 / 宣传海报" />
          </label>
          <label>
            <span>必须出现的信息</span>
            <textarea data-brief-must-have>时间：待定
地点：待定
主办方：待定
报名入口：扫码预约</textarea>
          </label>
          <label>
            <span>主视觉要求</span>
            <textarea data-brief-visual>围绕活动主题建立一个清晰主视觉，保留足够留白，给标题、时间地点和报名入口留出明确版面。</textarea>
          </label>
          <label class="full-span">
            <span>希望出现的画面元素</span>
            <textarea data-brief-elements>主题主视觉、清晰标题区域、信息分组、留白、报名入口</textarea>
          </label>
          <label class="full-span">
            <span>避免出现的内容</span>
            <textarea data-brief-avoid>不要像商业广告，不要堆太满，不要让人物压过标题，不要生成乱码文字。</textarea>
          </label>
          <label class="full-span">
            <span>信息层级</span>
            <textarea data-brief-hierarchy>第一眼看到主标题，第二眼看到主视觉，第三眼看到时间、地点和报名方式。</textarea>
          </label>
          <label>
            <span>受众与用途</span>
            <textarea data-brief-audience>面向大学生、青年教师和文学爱好者，用于线上宣传和线下张贴。</textarea>
          </label>
          <label>
            <span>尺寸与交付</span>
            <textarea data-brief-formats>竖版主海报，兼顾手机阅读；后续可适配方形和横版。</textarea>
          </label>
          <label>
            <span>风格偏好</span>
            <input data-brief-style value="文学杂志风，克制、留白、纸张质感、低饱和但标题清晰" />
          </label>
          <label>
            <span>补充说明</span>
            <textarea data-brief-notes>第一版只改版式和视觉权重，不改核心文案和人物内容。</textarea>
          </label>
        </form>

        <section class="preview-column">
          <article class="preview-card">
            <div class="preview-card-head">
              <div>
                <span class="step-label">海报版本</span>
                <strong data-course-preview-title>${defaultCourseware.title}</strong>
              </div>
              <div class="preview-head-side">
                <span class="preview-mode-tag">单页海报 demo</span>
                <div class="preview-runtime">
                  <strong data-runtime-mode>读取运行配置中</strong>
                  <button type="button" class="ghost-button mode-toggle" data-api-mode-toggle>切换图片模式</button>
                </div>
              </div>
            </div>
            <div class="workflow-strip">
              <span>需求整理</span>
              <span>海报生成</span>
              <span>阅读采集</span>
              <span>延迟替换</span>
            </div>
            <div class="poster-version-controls">
              <label class="select-label">
                <span>生成数量</span>
                <select data-poster-count>
                  <option value="1">1 张</option>
                  <option value="2">2 张</option>
                  <option value="3" selected>3 张</option>
                  <option value="4">4 张</option>
                  <option value="6">6 张</option>
                </select>
              </label>
              <div class="poster-ratio-picker" aria-label="海报比例">
                <span>海报格式</span>
                <label><input type="checkbox" data-poster-ratio value="16:9" checked />16:9 横版</label>
                <label><input type="checkbox" data-poster-ratio value="3:4" checked />3:4 竖版</label>
                <label><input type="checkbox" data-poster-ratio value="4:3" checked />4:3 横版</label>
              </div>
              <label class="local-poster-upload">
                <span>本地海报阅读</span>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-local-poster-upload />
                <strong>上传本地海报</strong>
                <small>选择图片后直接进入同一套阅读、反馈和优化流程</small>
              </label>
              <button type="button" class="default-template-button" data-default-template>
                <span>默认海报</span>
                <strong>使用默认模板</strong>
                <small>直接载入内置海报和语义区，不再调用视觉识别 API</small>
              </button>
            </div>
            <div class="preview-actions">
              <div class="button-row">
                <button type="button" data-summary-generate>生成需求摘要</button>
                <button type="button" class="secondary-button" data-poster-generate>确认并生成海报</button>
              </div>
              <button type="button" class="start-button" data-reading-start>开始阅读</button>
            </div>
            <div class="course-preview">
              <div class="preview-stage" data-preview-stage></div>
              <p data-course-preview-copy>生成海报后，这里会显示当前版本的阅读入口。用户离开这一页后，后台优化版才允许替换原页面。</p>
            </div>
            <p class="setup-message" data-setup-message></p>
          </article>

          <article class="control-card compact-card device-card">
            <div class="control-header">
              <span class="step-label">设备与进入方式</span>
              <strong data-calibration-title>尚未校准</strong>
            </div>
            <div class="device-layout">
              <video class="camera-preview" data-camera-preview autoplay muted playsinline></video>
              <div class="device-actions">
                <div class="button-row">
                  <button type="button" data-camera-start>开启摄像头</button>
                  <button type="button" class="ghost-button" data-camera-stop>关闭</button>
                </div>
                <div class="button-grid">
                  <button type="button" data-calibration-start>开始眼部校准</button>
                  <button type="button" class="secondary-button" data-calibration-confirm>确认校准</button>
                  <button type="button" class="ghost-button" data-calibration-default>默认校准</button>
                  <button type="button" class="ghost-button" data-calibration-keymouse>键鼠演示</button>
                </div>
                <p class="device-note" data-calibration-message>开启摄像头后，跟随屏幕上的标记完成五点校准。</p>
              </div>
            </div>
            <dl class="status-list compact-status">
              <div><dt>camera</dt><dd data-camera-status>未开启</dd></div>
              <div><dt>tracker</dt><dd data-tracker-status>未加载</dd></div>
              <div><dt>tracking</dt><dd data-tracking-status>等待摄像头</dd></div>
            </dl>
          </article>
        </section>

        <aside class="control-dock">
          <aside class="summary-panel">
            <div>
              <span class="step-label">需求摘要</span>
              <strong data-poster-status></strong>
            </div>
            <dl data-summary-output></dl>
          </aside>

          <article class="control-card compact-card">
            <span class="step-label">演示说明</span>
            <div class="mode-tags">
              <span>摄像头追踪</span>
              <span>默认校准</span>
              <span>键鼠反馈</span>
              <span>模拟推断</span>
            </div>
            <p class="dock-copy">摄像头和键鼠演示现在共用一张卡。键鼠模式下，鼠标代表注意区域，数字键 1/2/3/4 代表平稳、积极、困惑、疲劳。</p>
          </article>
        </aside>
      </section>
    </section>

    <section class="reader-view" data-view="reading" hidden>
      <header class="reader-topbar">
        <div>
          <p class="eyebrow">poster reading</p>
          <h2 data-reader-title></h2>
        </div>
        <div class="reader-actions">
          <button type="button" class="ghost-button" data-page-prev>上一页</button>
          <button type="button" data-page-next>下一页</button>
          <button type="button" class="ghost-button" data-exit-reading>退出</button>
        </div>
      </header>

      <div class="reader-layout">
        <section class="slide-stage">
          <div class="reader-stage-tools" aria-label="海报查看控制">
            <button type="button" class="ghost-button reader-stage-button" data-poster-zoom-out>缩小</button>
            <button type="button" class="ghost-button reader-stage-button" data-poster-zoom-in>放大</button>
            <button type="button" class="ghost-button reader-stage-button" data-poster-reset>适应屏幕</button>
          </div>
          <article class="course-slide" data-course-slide></article>
          <div class="gaze-dot" data-gaze-dot aria-hidden="true"></div>
        </section>

        <aside class="insight-panel" aria-live="polite">
          <span class="step-label">实时推断</span>
          <div class="plain-inference" data-insight-message></div>
          <div class="stats-panel" data-stats-panel></div>
        </aside>
      </div>
    </section>

    <section class="done-view" data-view="done" hidden>
      <article class="done-card">
        <p class="eyebrow">reading complete</p>
        <h2>已经离开海报页，后台优化可以替换原页面</h2>
        <p data-done-summary></p>
        <p class="done-status" data-done-status></p>
        <label class="select-label feedback-target-select">
          <span>选择要重新生成的海报</span>
          <select data-feedback-page-select></select>
        </label>
        <div class="button-row">
          <button type="button" data-optimize-from-feedback>根据反馈生成优化版</button>
          <button type="button" data-back-to-page>返回继续查看</button>
          <button type="button" class="ghost-button" data-reset-demo>重新开始</button>
        </div>
      </article>
    </section>

    <div class="calibration-overlay" data-calibration-overlay hidden>
      <div class="calibration-marker" data-calibration-marker></div>
      <p data-calibration-overlay-text>请注视标记</p>
    </div>
  </main>
`;

const setupView = requireElement<HTMLElement>('[data-view="setup"]');
const readerView = requireElement<HTMLElement>('[data-view="reading"]');
const doneView = requireElement<HTMLElement>('[data-view="done"]');
const briefRawInput = requireElement<HTMLTextAreaElement>('[data-brief-raw]');
const briefExtractButton = requireElement<HTMLButtonElement>('[data-brief-extract]');
const briefTopicInput = requireElement<HTMLInputElement>('[data-brief-topic]');
const briefTypeInput = requireElement<HTMLInputElement>('[data-brief-type]');
const briefMustHaveInput = requireElement<HTMLTextAreaElement>('[data-brief-must-have]');
const briefVisualInput = requireElement<HTMLTextAreaElement>('[data-brief-visual]');
const briefElementsInput = requireElement<HTMLTextAreaElement>('[data-brief-elements]');
const briefAvoidInput = requireElement<HTMLTextAreaElement>('[data-brief-avoid]');
const briefHierarchyInput = requireElement<HTMLTextAreaElement>('[data-brief-hierarchy]');
const briefAudienceInput = requireElement<HTMLTextAreaElement>('[data-brief-audience]');
const briefFormatsInput = requireElement<HTMLTextAreaElement>('[data-brief-formats]');
const briefStyleInput = requireElement<HTMLInputElement>('[data-brief-style]');
const briefNotesInput = requireElement<HTMLTextAreaElement>('[data-brief-notes]');
const posterStatusOutput = requireElement<HTMLElement>('[data-poster-status]');
const summaryOutput = requireElement<HTMLElement>('[data-summary-output]');
const summaryGenerateButton = requireElement<HTMLButtonElement>('[data-summary-generate]');
const posterGenerateButton = requireElement<HTMLButtonElement>('[data-poster-generate]');
const posterCountSelect = requireElement<HTMLSelectElement>('[data-poster-count]');
const posterRatioInputs = Array.from(appRoot.querySelectorAll<HTMLInputElement>('[data-poster-ratio]'));
const localPosterUploadInput = requireElement<HTMLInputElement>('[data-local-poster-upload]');
const defaultTemplateButton = appRoot.querySelector<HTMLButtonElement>('[data-default-template]');
const coursePreviewTitle = requireElement<HTMLElement>('[data-course-preview-title]');
const coursePreviewCopy = requireElement<HTMLElement>('[data-course-preview-copy]');
const previewStage = requireElement<HTMLElement>('[data-preview-stage]');
const cameraPreview = requireElement<HTMLVideoElement>('[data-camera-preview]');
const cameraStartButton = requireElement<HTMLButtonElement>('[data-camera-start]');
const cameraStopButton = requireElement<HTMLButtonElement>('[data-camera-stop]');
const cameraStatusOutput = requireElement<HTMLElement>('[data-camera-status]');
const trackerStatusOutput = requireElement<HTMLElement>('[data-tracker-status]');
const trackingStatusOutput = requireElement<HTMLElement>('[data-tracking-status]');
const calibrationStartButton = requireElement<HTMLButtonElement>('[data-calibration-start]');
const calibrationConfirmButton = requireElement<HTMLButtonElement>('[data-calibration-confirm]');
const calibrationDefaultButton = requireElement<HTMLButtonElement>('[data-calibration-default]');
const calibrationKeyMouseButton = requireElement<HTMLButtonElement>('[data-calibration-keymouse]');
const calibrationTitle = requireElement<HTMLElement>('[data-calibration-title]');
const calibrationMessage = requireElement<HTMLElement>('[data-calibration-message]');
const readingStartButton = requireElement<HTMLButtonElement>('[data-reading-start]');
const setupMessageOutput = requireElement<HTMLElement>('[data-setup-message]');
const readerTitle = requireElement<HTMLElement>('[data-reader-title]');
const courseSlide = requireElement<HTMLElement>('[data-course-slide]');
const pagePrevButton = requireElement<HTMLButtonElement>('[data-page-prev]');
const pageNextButton = requireElement<HTMLButtonElement>('[data-page-next]');
const exitReadingButton = requireElement<HTMLButtonElement>('[data-exit-reading]');
const gazeDot = requireElement<HTMLElement>('[data-gaze-dot]');
const posterZoomOutButton = requireElement<HTMLButtonElement>('[data-poster-zoom-out]');
const posterZoomInButton = requireElement<HTMLButtonElement>('[data-poster-zoom-in]');
const posterResetButton = requireElement<HTMLButtonElement>('[data-poster-reset]');
const insightMessageOutput = requireElement<HTMLElement>('[data-insight-message]');
const statsPanel = requireElement<HTMLElement>('[data-stats-panel]');
const doneSummary = requireElement<HTMLElement>('[data-done-summary]');
const doneStatusOutput = requireElement<HTMLElement>('[data-done-status]');
const feedbackPageSelect = requireElement<HTMLSelectElement>('[data-feedback-page-select]');
const optimizeFromFeedbackButton = requireElement<HTMLButtonElement>('[data-optimize-from-feedback]');
const backToPageButton = requireElement<HTMLButtonElement>('[data-back-to-page]');
const resetDemoButton = requireElement<HTMLButtonElement>('[data-reset-demo]');
const calibrationOverlay = requireElement<HTMLElement>('[data-calibration-overlay]');
const calibrationMarker = requireElement<HTMLElement>('[data-calibration-marker]');
const calibrationOverlayText = requireElement<HTMLElement>('[data-calibration-overlay-text]');
const runtimeModeOutput = requireElement<HTMLElement>('[data-runtime-mode]');
const apiModeToggleButton = requireElement<HTMLButtonElement>('[data-api-mode-toggle]');

cameraStartButton.addEventListener('click', () => {
  void startCamera();
});
briefExtractButton.addEventListener('click', () => {
  void extractBriefFields();
});
summaryGenerateButton.addEventListener('click', () => {
  void summarizePosterBrief();
});
posterGenerateButton.addEventListener('click', () => {
  void generatePosterFromBrief();
});
apiModeToggleButton.addEventListener('click', () => {
  void toggleImageApiMode();
});
posterCountSelect.addEventListener('change', handleGenerationOptionChange);
posterRatioInputs.forEach((input) => {
  input.addEventListener('change', handleGenerationOptionChange);
});
localPosterUploadInput.addEventListener('change', () => {
  void loadLocalPosterUpload();
});
defaultTemplateButton?.addEventListener('click', loadDefaultPosterTemplate);
cameraStopButton.addEventListener('click', stopCameraAndTracker);
calibrationStartButton.addEventListener('click', startCalibration);
calibrationConfirmButton.addEventListener('click', confirmCalibration);
calibrationDefaultButton.addEventListener('click', useDefaultCalibration);
calibrationKeyMouseButton.addEventListener('click', useKeyboardMouseMode);
readingStartButton.addEventListener('click', startReading);
pagePrevButton.addEventListener('click', goToPreviousPage);
pageNextButton.addEventListener('click', leaveCurrentPage);
exitReadingButton.addEventListener('click', exitToSetup);
optimizeFromFeedbackButton.addEventListener('click', () => {
  void optimizeFromFeedback();
});
feedbackPageSelect.addEventListener('change', () => {
  selectedFeedbackPageId = feedbackPageSelect.value;
  render();
});
backToPageButton.addEventListener('click', returnToPage);
resetDemoButton.addEventListener('click', resetDemo);

document.addEventListener('keydown', handleKeyboardReaction);
readerView.addEventListener('mousemove', handleMouseAttention);
courseSlide.addEventListener('pointerdown', handlePosterPointerDown);
courseSlide.addEventListener('pointermove', handlePosterPointerMove);
courseSlide.addEventListener('pointerup', handlePosterPointerUp);
courseSlide.addEventListener('pointercancel', handlePosterPointerUp);
courseSlide.addEventListener('lostpointercapture', () => {
  stopPosterDrag();
});
posterZoomOutButton.addEventListener('click', () => {
  zoomReaderPoster(-0.18);
});
posterZoomInButton.addEventListener('click', () => {
  zoomReaderPoster(0.18);
});
posterResetButton.addEventListener('click', resetReaderPosterView);
window.addEventListener('resize', () => {
  if (view === 'reading') {
    scheduleReaderPosterLayout(false);
  }
});

[
  briefRawInput,
  briefTopicInput,
  briefTypeInput,
  briefMustHaveInput,
  briefVisualInput,
  briefElementsInput,
  briefAvoidInput,
  briefHierarchyInput,
  briefAudienceInput,
  briefFormatsInput,
  briefStyleInput,
  briefNotesInput,
].forEach((field) => {
  field.addEventListener('input', handleBriefInputChange);
});

[
  briefMustHaveInput,
  briefVisualInput,
  briefElementsInput,
  briefAvoidInput,
  briefHierarchyInput,
  briefAudienceInput,
  briefFormatsInput,
  briefNotesInput,
].forEach((field) => {
  field.dataset.autoResize = 'true';
  field.addEventListener('input', () => resizeTextarea(field));
});

setInterval(() => {
  if (view === 'reading') {
    if (mouseKeyboardMode) {
      recordAoiHit(currentScreenPoint, keyboardReaction, performance.now(), 760);
    }

    refreshDiagnosis();
    renderInsights();
  }
}, 700);

resizeBriefTextareas();
render();
void loadRuntimeConfig();

async function extractBriefFields() {
  const requirements = readPosterRequirements();

  if (!requirements.rawBrief) {
    posterStatus = '请先粘贴一段原始需求长文本。';
    renderPosterBrief();
    return;
  }

  posterStatus = '正在提取重点信息...';
  renderPosterBrief();

  try {
    const extracted = await extractPosterRequirements(requirements);
    applyPosterRequirements(extracted);
    invalidatePosterOutputs('重点信息已提取，请生成需求摘要。', '已从长文本中回填重点信息。');
  } catch (error) {
    posterStatus = error instanceof Error ? error.message : '重点信息提取失败。';
  }

  render();
}

async function summarizePosterBrief() {
  posterStatus = '正在整理需求...';
  renderPosterBrief();

  try {
    posterSummary = await summarizePosterRequirements(readPosterRequirements());
    posterStatus = '需求摘要已生成，可以确认并生成海报。';
  } catch (error) {
    posterStatus = error instanceof Error ? error.message : '需求摘要生成失败。';
  }

  renderPosterBrief();
}

async function generatePosterFromBrief() {
  const requirements = readPosterRequirements();
  posterGenerationOptions = readPosterGenerationOptions();

  if (!posterSummary) {
    posterStatus = '请先生成需求摘要。';
    renderPosterBrief();
    return;
  }

  posterStatus = '正在生成海报主视觉...';
  renderPosterBrief();

  try {
    const draft = await generatePosterDraft({
      requirements,
      summary: posterSummary,
      generationOptions: posterGenerationOptions,
    });
    posterDraft = {
      ...draft,
      layout: createDefaultPosterLayout(),
    };
    activeCourseware = createPosterCourseware(posterDraft);
    optimizedPages.clear();
    optimizationJobs.clear();
    clearReadingFeedbackState();
    currentPageIndex = 0;
    const generatedImages = posterDraft.images ?? [];
    const generatedCount = generatedImages.length || 1;
    const generatedLabels = generatedImages.map((image) => image.label).join('、') || (posterDraft.aspectRatio ?? '默认比例');
    posterStatus =
      posterDraft.source === 'remote-api'
        ? `已生成 ${generatedCount} 张海报：${generatedLabels}。`
        : `已生成 ${generatedCount} 张海报，其中部分使用本地 fallback。图片 API 未成功：${posterDraft.imageError ?? '请检查 ARK_API_KEY、模型权限和图片参数。'}`;
    setupMessage = '海报已准备好。确认校准后即可开始阅读并采集反馈。';
  } catch (error) {
    posterStatus = error instanceof Error ? error.message : '海报生成失败。';
  }

  render();
}

function loadDefaultPosterTemplate() {
  applyPosterRequirements(DEFAULT_TEMPLATE_REQUIREMENTS);
  posterCountSelect.value = '1';
  posterRatioInputs.forEach((input) => {
    input.checked = input.value === '16:9';
  });
  posterGenerationOptions = readPosterGenerationOptions();

  const summary = createDefaultTemplateSummary();
  const id = `default-template-${Date.now()}`;
  const semanticRegions = createDefaultTemplateSemanticRegions(summary);
  const draft: PosterDraft = {
    id,
    createdAt: new Date().toISOString(),
    summary,
    imagePrompt: summary.imagePrompt,
    imageUrl: DEFAULT_TEMPLATE_IMAGE_URL,
    aspectRatio: '16:9',
    semanticRegions,
    images: [
      {
        id: `${id}-16-9`,
        label: '默认模板 16:9',
        aspectRatio: '16:9',
        imagePrompt: summary.imagePrompt,
        imageUrl: DEFAULT_TEMPLATE_IMAGE_URL,
        semanticRegions,
        source: 'local-fallback',
      },
    ],
    source: 'local-fallback',
    versionType: 'original',
    layout: createDefaultPosterLayout(),
  };

  applyPosterDraftState(draft, '已载入默认模板：红楼梦主题阅读海报。', '默认模板已准备好。确认校准后即可直接开始阅读。');
  render();
}

async function loadLocalPosterUpload() {
  const file = localPosterUploadInput.files?.[0];

  if (!file) {
    return;
  }

  if (!file.type.startsWith('image/')) {
    posterStatus = '请选择 PNG、JPG、WebP 或 SVG 图片。';
    renderPosterBrief();
    return;
  }

  posterStatus = '正在读取本地海报...';
  renderPosterBrief();

  try {
    const imageUrl = await readFileAsDataUrl(file);
    const size = await readImageSize(imageUrl);
    const aspectRatio = inferPosterAspectRatio(size.width, size.height);
    const requirements = readPosterRequirements();
    const summary = posterSummary ?? buildLocalPosterSummary(requirements, file.name);
    let semanticRegions = createSemanticRegionsForAspectRatio(aspectRatio, summary);
    const id = `local-${Date.now()}`;

    posterStatus = '正在用视觉 API 识别本地海报内容...';
    renderPosterBrief();

    try {
      const analysis = await analyzePosterImage({
        imageUrl,
        aspectRatio,
        summary,
        fallbackRegions: semanticRegions,
      });
      semanticRegions = analysis.semanticRegions.length ? analysis.semanticRegions : semanticRegions;
    } catch (error) {
      posterStatus = `视觉识别未成功，已使用模板语义区：${error instanceof Error ? error.message : '未知错误'}`;
      renderPosterBrief();
    }

    posterSummary = summary;
    posterDraft = {
      id,
      createdAt: new Date().toISOString(),
      summary,
      imagePrompt: `本地上传海报：${file.name}`,
      imageUrl,
      aspectRatio,
      semanticRegions,
      images: [
        {
          id: `${id}-${aspectRatio.replace(':', '-')}`,
          label: `本地上传 ${aspectRatio}`,
          aspectRatio,
          imagePrompt: `本地上传海报：${file.name}`,
          imageUrl,
          semanticRegions,
          source: 'local-fallback',
        },
      ],
      source: 'local-fallback',
      versionType: 'original',
      layout: createDefaultPosterLayout(),
    };
    activeCourseware = createPosterCourseware(posterDraft);
    optimizedPages.clear();
    optimizationJobs.clear();
    clearReadingFeedbackState();
    currentPageIndex = 0;
    currentSession = createPageSession();
    visiblePageSnapshot = undefined;
    posterStatus = `已载入本地海报：${file.name}，识别为 ${aspectRatio}。`;
    setupMessage = '本地海报已准备好。确认校准后即可开始阅读并采集反馈。';
  } catch (error) {
    posterStatus = error instanceof Error ? error.message : '本地海报读取失败。';
  } finally {
    localPosterUploadInput.value = '';
  }

  render();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取结果无效。'));
    };
    reader.onerror = () => reject(new Error('图片读取失败。'));
    reader.readAsDataURL(file);
  });
}

function readImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
    image.onerror = () => reject(new Error('无法识别本地海报尺寸。'));
    image.src = src;
  });
}

function inferPosterAspectRatio(width: number, height: number): PosterAspectRatio {
  const ratio = width / Math.max(height, 1);
  const candidates: Array<{ value: PosterAspectRatio; ratio: number }> = [
    { value: '16:9', ratio: 16 / 9 },
    { value: '4:3', ratio: 4 / 3 },
    { value: '3:4', ratio: 3 / 4 },
  ];

  return candidates.sort((a, b) => Math.abs(a.ratio - ratio) - Math.abs(b.ratio - ratio))[0].value;
}

function buildLocalPosterSummary(requirements: PosterRequirements, fileName: string): PosterSummary {
  const mustHave = splitPreviewMustHave(requirements.mustHave);
  const visualElements = splitPreviewMustHave(requirements.visualElements);
  const avoidElements = splitPreviewMustHave(requirements.avoidElements);

  return {
    goal: requirements.topic || fileName.replace(/\.[^.]+$/, '') || '本地上传海报',
    visualDirection: requirements.visual || '基于本地上传海报进行阅读反馈分析。',
    style: requirements.style || '本地海报',
    mustHave: mustHave.length ? mustHave : ['本地上传海报'],
    visualElements,
    avoidElements,
    audience: requirements.audience || '用于本地海报阅读反馈演示。',
    formatNotes: splitPreviewMustHave(requirements.formats),
    layoutPriorities: splitPreviewMustHave(requirements.hierarchy).length
      ? splitPreviewMustHave(requirements.hierarchy)
      : ['观察标题、主视觉、时间地点和报名入口是否被注意到'],
    imagePrompt: `本地上传海报：${fileName}`,
  };
}

function readPosterRequirements(): PosterRequirements {
  return {
    rawBrief: briefRawInput.value.trim(),
    topic: briefTopicInput.value.trim(),
    posterType: briefTypeInput.value.trim(),
    mustHave: briefMustHaveInput.value.trim(),
    visual: briefVisualInput.value.trim(),
    visualElements: briefElementsInput.value.trim(),
    avoidElements: briefAvoidInput.value.trim(),
    hierarchy: briefHierarchyInput.value.trim(),
    audience: briefAudienceInput.value.trim(),
    formats: briefFormatsInput.value.trim(),
    style: briefStyleInput.value.trim(),
    notes: briefNotesInput.value.trim(),
  };
}

function readPosterGenerationOptions(): PosterGenerationOptions {
  const checkedRatios = posterRatioInputs
    .filter((input) => input.checked)
    .map((input) => input.value)
    .filter((value): value is PosterAspectRatio => POSTER_ASPECT_OPTIONS.includes(value as PosterAspectRatio));
  const aspectRatios = checkedRatios.length ? checkedRatios : [...DEFAULT_POSTER_GENERATION_OPTIONS.aspectRatios];
  const count = clamp(Number.parseInt(posterCountSelect.value, 10), 1, 9);

  return {
    aspectRatios,
    count: Number.isFinite(count) ? count : DEFAULT_POSTER_GENERATION_OPTIONS.count,
  };
}

function handleGenerationOptionChange() {
  const checkedCount = posterRatioInputs.filter((input) => input.checked).length;

  if (!checkedCount) {
    posterRatioInputs[0].checked = true;
  }

  posterGenerationOptions = readPosterGenerationOptions();

  if (posterDraft) {
    invalidatePosterOutputs('海报版本配置已更新，请重新生成海报。', undefined, true);
    render();
    return;
  }

  renderPosterBrief();
}

function applyPosterRequirements(requirements: PosterRequirements) {
  briefRawInput.value = requirements.rawBrief;
  briefTopicInput.value = requirements.topic;
  briefTypeInput.value = requirements.posterType;
  briefMustHaveInput.value = requirements.mustHave;
  briefVisualInput.value = requirements.visual;
  briefElementsInput.value = requirements.visualElements;
  briefAvoidInput.value = requirements.avoidElements;
  briefHierarchyInput.value = requirements.hierarchy;
  briefAudienceInput.value = requirements.audience;
  briefFormatsInput.value = requirements.formats;
  briefStyleInput.value = requirements.style;
  briefNotesInput.value = requirements.notes;
  resizeBriefTextareas();
}

function handleBriefInputChange() {
  resizeBriefTextareas();

  if (posterSummary || posterDraft) {
    invalidatePosterOutputs('需求已更新，请重新生成摘要。', '已检测到需求变更，之前的摘要和海报草稿已失效。');
    render();
    return;
  }

  renderPosterBrief();
}

function resizeBriefTextareas() {
  document.querySelectorAll<HTMLTextAreaElement>('[data-auto-resize="true"]').forEach(resizeTextarea);
}

function resizeTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function invalidatePosterOutputs(statusMessage: string, nextSetupMessage?: string, preserveSummary = false) {
  if (!preserveSummary) {
    posterSummary = undefined;
  }

  posterDraft = undefined;
  activeCourseware = createEmptyPosterCourseware();
  optimizedPages.clear();
  optimizationJobs.clear();
  clearReadingFeedbackState();
  currentPageIndex = 0;
  currentSession = createPageSession();
  visiblePageSnapshot = undefined;
  posterStatus = statusMessage;

  if (nextSetupMessage) {
    setupMessage = nextSetupMessage;
  }
}

function createDefaultPosterLayout() {
  return {
    titleScale: 1,
    titleContrast: 1,
    imageScale: 1,
    imageX: 0,
    imageY: 0,
    imageDim: 0.74,
    infoScale: 1,
    ctaEmphasis: 1,
  };
}

function createPosterViewportState(): PosterViewportState {
  return {
    activePageId: '',
    fitWidth: 0,
    fitHeight: 0,
    zoom: 1,
    minZoom: 1,
    maxZoom: 3.2,
    panX: 0,
    panY: 0,
    dragging: false,
    pointerId: null,
    dragStartX: 0,
    dragStartY: 0,
    dragOriginX: 0,
    dragOriginY: 0,
  };
}

function createDefaultTemplateSummary(): PosterSummary {
  return {
    goal: DEFAULT_TEMPLATE_REQUIREMENTS.topic,
    visualDirection: DEFAULT_TEMPLATE_REQUIREMENTS.visual,
    style: DEFAULT_TEMPLATE_REQUIREMENTS.style,
    mustHave: splitPreviewMustHave(DEFAULT_TEMPLATE_REQUIREMENTS.mustHave),
    visualElements: splitPreviewMustHave(DEFAULT_TEMPLATE_REQUIREMENTS.visualElements),
    avoidElements: splitPreviewMustHave(DEFAULT_TEMPLATE_REQUIREMENTS.avoidElements),
    audience: DEFAULT_TEMPLATE_REQUIREMENTS.audience,
    formatNotes: splitPreviewMustHave(DEFAULT_TEMPLATE_REQUIREMENTS.formats),
    layoutPriorities: splitPreviewMustHave(DEFAULT_TEMPLATE_REQUIREMENTS.hierarchy),
    imagePrompt: '默认模板：红楼梦主题阅读海报',
  };
}

function createDefaultTemplateSemanticRegions(summary: PosterSummary): PosterSemanticRegion[] {
  const textByRole = {
    title: summary.goal,
    subtitle: '阅读导读 / 活动引导',
    visual: summary.visualElements.join('、') || summary.style,
    speaker: '活动主题与人物导读',
    timeVenue: findSummaryItems(summary.mustHave, ['时间', '地点', '活动']),
    qr: findSummaryItems(summary.mustHave, ['二维码', '报名', '预约']),
    organizer: findSummaryItems(summary.mustHave, ['主办', '承办']) || '主办单位信息',
  };

  return [
    createSemanticRegion('title', '主题标题', 'title', 'title', 0.07, 0.08, 0.34, 0.18),
    createSemanticRegion('subtitle', '导读说明', 'subtitle', 'definition', 0.07, 0.28, 0.3, 0.1),
    createSemanticRegion('visual', '人物群像主视觉', 'visual', 'image', 0.4, 0.07, 0.5, 0.72),
    createSemanticRegion('speaker', '主题信息', 'speaker', 'diagram', 0.07, 0.45, 0.28, 0.14),
    createSemanticRegion('time-venue', '时间地点', 'time_venue', 'mechanism', 0.07, 0.63, 0.3, 0.14),
    createSemanticRegion('qr', '报名入口', 'qr', 'example', 0.74, 0.74, 0.14, 0.16),
    createSemanticRegion('organizer', '主办信息', 'organizer', 'summary', 0.07, 0.84, 0.48, 0.08),
  ].map((region) => ({
    ...region,
    text:
      region.role === 'title'
        ? textByRole.title
        : region.role === 'subtitle'
          ? textByRole.subtitle
          : region.role === 'visual'
            ? textByRole.visual
            : region.role === 'speaker'
              ? textByRole.speaker
              : region.role === 'time_venue'
                ? textByRole.timeVenue
                : region.role === 'qr'
                  ? textByRole.qr
                  : region.role === 'organizer'
                    ? textByRole.organizer
                    : undefined,
  }));
}

function applyPosterDraftState(draft: PosterDraft, nextPosterStatus: string, nextSetupMessage: string) {
  posterSummary = draft.summary;
  posterDraft = draft;
  activeCourseware = createPosterCourseware(draft);
  optimizedPages.clear();
  optimizationJobs.clear();
  clearReadingFeedbackState();
  currentPageIndex = 0;
  currentSession = createPageSession();
  visiblePageSnapshot = undefined;
  posterStatus = nextPosterStatus;
  setupMessage = nextSetupMessage;
  stopPosterDrag();
  resetPosterViewport();
}

async function startCamera() {
  cameraStatus = '请求权限中';
  trackerStatus = '未加载';
  trackingStatus = '正在启动';
  setupMessage = '正在请求摄像头权限。';
  render();

  faceTracker?.stop();
  stopCamera(cameraStream);
  cameraPreview.srcObject = null;

  const result = await startFrontCamera(cameraPreview);

  if (!result.ok) {
    cameraStatus = '不可用';
    trackerStatus = '错误';
    trackingStatus = '摄像头失败';
    setupMessage = `摄像头启动失败：${result.reason}。可以使用默认校准和模拟反馈继续演示。`;
    render();
    return;
  }

  cameraStream = result.stream;
  cameraStatus = '已开启';
  trackerStatus = '加载中';
  trackingStatus = '等待人脸';
  setupMessage = '摄像头已开启，正在加载人脸追踪模型。';
  render();

  try {
    faceTracker = await createFaceTracker(cameraPreview, handleTrackingState, (message) => {
      trackerStatus = '错误';
      trackingStatus = message;
      setupMessage = `追踪器错误：${message}`;
      render();
    });
    trackerStatus = '已激活';
    trackingStatus = calibration.confirmed ? '可阅读' : '可校准';
    setupMessage = '摄像头和追踪器已就绪，请开始眼部校准。';
  } catch (error) {
    trackerStatus = '错误';
    trackingStatus = '模型加载失败';
    setupMessage = error instanceof Error ? error.message : '人脸追踪模型加载失败。';
  }

  render();
}

function stopCameraAndTracker() {
  faceTracker?.stop();
  faceTracker = undefined;
  stopCamera(cameraStream);
  cameraStream = undefined;
  cameraPreview.srcObject = null;
  cameraStatus = '未开启';
  trackerStatus = '未加载';
  trackingStatus = '等待摄像头';
  setupMessage = '摄像头已关闭。仍可使用默认校准和模拟反馈演示页面逻辑。';
  render();
}

function startCalibration() {
  if (!faceTracker) {
    setupMessage = '请先开启摄像头；如果暂时无法使用摄像头，可以点“使用默认校准”。';
    render();
    return;
  }

  calibration.active = true;
  calibration.complete = false;
  calibration.confirmed = false;
  calibration.usingDefault = false;
  mouseKeyboardMode = false;
  calibration.targetIndex = 0;
  calibration.targetStartedAt = performance.now();
  calibration.samples = createCalibrationSamples();
  setupMessage = '请跟随屏幕标记完成眼部校准。';
  render();
}

function confirmCalibration() {
  if (!calibration.complete && !calibration.usingDefault) {
    setupMessage = '校准尚未完成，暂时不能确认。';
    render();
    return;
  }

  calibration.confirmed = true;
  setupMessage = calibration.usingDefault ? '已使用默认校准，可以开始阅读。' : '校准已确认，可以开始阅读。';
  render();
}

function useDefaultCalibration() {
  mouseKeyboardMode = false;
  calibration.active = false;
  calibration.complete = true;
  calibration.confirmed = true;
  calibration.usingDefault = true;
  calibration.model = undefined;
  setupMessage = '已使用默认校准：系统会用粗略视线/中心点兜底，适合演示和模拟反馈。';
  render();
}

function useKeyboardMouseMode() {
  mouseKeyboardMode = true;
  keyboardReaction = 'neutral';
  calibration.active = false;
  calibration.complete = true;
  calibration.confirmed = true;
  calibration.usingDefault = true;
  calibration.model = undefined;
  setupMessage = '已开启键鼠演示模式：阅读页中移动鼠标代表注意力区域，按 1/2/3/4 切换表情反馈。';
  render();
}

function startReading() {
  if (!posterDraft || activeCourseware.pages.length === 0) {
    setupMessage = '请先生成海报，再进入阅读反馈。';
    render();
    return;
  }

  if (!calibration.confirmed) {
    setupMessage = '请先确认校准，或使用默认校准。';
    render();
    return;
  }

  currentPageIndex = 0;
  clearReadingFeedbackState();
  enterPage(currentPageIndex);
  view = 'reading';
  render();
}

function goToPreviousPage() {
  if (currentPageIndex <= 0) {
    return;
  }

  currentPageIndex -= 1;
  enterPage(currentPageIndex);
  view = 'reading';
  render();
}

function leaveCurrentPage() {
  const page = getCurrentBasePage();

  if (!page) {
    return;
  }

  refreshDiagnosis();
  saveCurrentPageFeedback(page, currentPageIndex);
  lastCompletedPageIndex = currentPageIndex;
  const completedDiagnosis = currentSession.diagnosis;
  const wasDenied = currentSession.denied;

  currentPageIndex += 1;
  view = currentPageIndex >= activeCourseware.pages.length ? 'done' : 'reading';

  if (view === 'reading') {
    enterPage(currentPageIndex);
    if (!wasDenied) {
      queueOptimization(page, completedDiagnosis, false);
    }
  } else {
    selectedFeedbackPageId = page.id;
    feedbackPolishStatus = '正在按海报整理反馈总结...';
    doneOptimizationStatus = '';
    void polishDoneFeedback();
  }

  render();
}

function exitToSetup() {
  view = 'setup';
  setupMessage = '已退出阅读页。已完成的优化会在下次进入对应页面时显示。';
  render();
}

function returnToPage() {
  currentPageIndex = clamp(lastCompletedPageIndex, 0, Math.max(0, activeCourseware.pages.length - 1));
  enterPage(currentPageIndex);
  view = 'reading';
  render();
}

function resetDemo() {
  invalidatePosterOutputs(
    posterSummary ? '需求摘要已生成，可以确认并生成海报。' : '先填写需求，然后生成摘要。',
    undefined,
    Boolean(posterSummary),
  );
  keyboardReaction = 'neutral';
  view = 'setup';
  setupMessage = '演示已重置。请重新生成海报并开始阅读。';
  render();
}

function enterPage(pageIndex: number) {
  const page = activeCourseware.pages[pageIndex];

  if (!page) {
    return;
  }

  visiblePageSnapshot = optimizedPages.get(page.id) ?? page;
  currentSession = pageSessions.get(page.id) ?? createPageSession();
}

function queueOptimization(page: CoursePage, diagnosis: PageDiagnosis, activePage: boolean) {
  optimizationJobs.set(page.id, {
    pageId: page.id,
    activePage,
    status: 'working',
    diagnosis,
  });
  renderInsights();

  window.setTimeout(() => {
    void finishOptimizationJob(page, diagnosis, activePage);
  }, OPTIMIZATION_DELAY_MS);
}

async function finishOptimizationJob(page: CoursePage, diagnosis: PageDiagnosis, activePage: boolean) {
  const job = optimizationJobs.get(page.id);

  if (!job || job.status !== 'working') {
    return;
  }

  let optimizedPage = buildOptimizedPage(page, diagnosis);
  if (page.poster) {
    try {
      const optimizedDraft = await optimizePosterDraft({
        poster: page.poster,
        diagnosis,
      });
      optimizedPage = buildOptimizedPage(page, diagnosis, {
        ...optimizedDraft,
        layout: createDefaultPosterLayout(),
      });
    } catch (error) {
      console.warn(`Poster optimization API failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  optimizedPages.set(page.id, optimizedPage);
  optimizationJobs.set(page.id, {
    ...job,
    status: 'done',
    optimizedPage,
  });

  if (activePage && view === 'reading' && getCurrentBasePage()?.id === page.id) {
    visiblePageSnapshot = optimizedPage;
    render();
    return;
  }

  render();
}

function handleTrackingState(state: FaceTrackingState) {
  trackingStatus = state.message;

  if (!state.sample) {
    renderStatusOnly();
    return;
  }

  const sample = state.sample;

  if (calibration.active) {
    collectCalibrationSample(sample);
    render();
    return;
  }

  if (view !== 'reading') {
    renderStatusOnly();
    return;
  }

  if (mouseKeyboardMode) {
    renderStatusOnly();
    return;
  }

  currentScreenPoint = estimateScreenPoint(sample);
  updateAoiStats(sample, currentScreenPoint);
  renderInsights();
}

function handleMouseAttention(event: MouseEvent) {
  if (!mouseKeyboardMode || view !== 'reading' || posterViewport.dragging) {
    return;
  }

  currentScreenPoint = {
    x: clamp(event.clientX / window.innerWidth, 0, 1),
    y: clamp(event.clientY / window.innerHeight, 0, 1),
  };
  recordAoiHit(currentScreenPoint, keyboardReaction, event.timeStamp || performance.now());
  renderInsights();
}

function handleKeyboardReaction(event: KeyboardEvent) {
  if (!mouseKeyboardMode || view !== 'reading') {
    return;
  }

  const reactionByKey: Record<string, Reaction> = {
    '1': 'neutral',
    '2': 'positive',
    '3': 'confused',
    '4': 'fatigued',
  };
  const nextReaction = reactionByKey[event.key];

  if (!nextReaction) {
    return;
  }

  keyboardReaction = nextReaction;
  currentSession.currentReaction = nextReaction;
  recordAoiHit(currentScreenPoint, nextReaction, performance.now());
  renderInsights();
}

function collectCalibrationSample(sample: FaceFeatureSample) {
  const target = CALIBRATION_TARGETS[calibration.targetIndex];

  if (!target) {
    finishCalibration();
    return;
  }

  const now = performance.now();
  const elapsed = now - calibration.targetStartedAt;

  if (elapsed > CALIBRATION_WARMUP_MS) {
    calibration.samples[target].push(toRawGazePoint(sample));
  }

  if (elapsed < CALIBRATION_TARGET_MS) {
    return;
  }

  calibration.targetIndex += 1;
  calibration.targetStartedAt = now;

  if (calibration.targetIndex >= CALIBRATION_TARGETS.length) {
    finishCalibration();
  }
}

function finishCalibration() {
  calibration.active = false;
  calibration.complete = true;
  calibration.model = buildCalibrationModel(calibration.samples);
  setupMessage = '校准完成，请点击“确认校准”。';
}

function buildCalibrationModel(samples: Record<CalibrationTarget, RawGazePoint[]>): CalibrationModel {
  return CALIBRATION_TARGETS.reduce((model, target) => {
    model[target] = averageRawPoints(samples[target]);
    return model;
  }, {} as CalibrationModel);
}

function averageRawPoints(samples: RawGazePoint[]): RawGazePoint {
  if (!samples.length) {
    return {
      x: 0.5,
      y: 0.5,
      faceX: 0.5,
      faceY: 0.5,
      faceSize: 0.5,
    };
  }

  const total = samples.reduce(
    (sum, sample) => ({
      x: sum.x + sample.x,
      y: sum.y + sample.y,
      faceX: sum.faceX + sample.faceX,
      faceY: sum.faceY + sample.faceY,
      faceSize: sum.faceSize + sample.faceSize,
    }),
    {
      x: 0,
      y: 0,
      faceX: 0,
      faceY: 0,
      faceSize: 0,
    },
  );

  return {
    x: total.x / samples.length,
    y: total.y / samples.length,
    faceX: total.faceX / samples.length,
    faceY: total.faceY / samples.length,
    faceSize: total.faceSize / samples.length,
  };
}

function estimateScreenPoint(sample: FaceFeatureSample) {
  const model = calibration.model;

  if (!model) {
    return {
      x: clamp(0.5 + (sample.eyeLookRight - sample.eyeLookLeft) * 1.45, 0, 1),
      y: clamp(0.5 + (sample.eyeLookDown - sample.eyeLookUp) * 1.45, 0, 1),
    };
  }

  const raw = toRawGazePoint(sample);
  const center = model.center;
  const normalizedX = normalizeAxis(raw.x, center.x, model.left.x, model.right.x);
  const normalizedY = normalizeAxis(raw.y, center.y, model.top.y, model.bottom.y);
  const headX = raw.faceX - center.faceX;
  const headY = raw.faceY - center.faceY;

  return {
    x: clamp(0.5 + normalizedX * 0.34 + headX * 0.16, 0, 1),
    y: clamp(0.5 + normalizedY * 0.34 + headY * 0.12, 0, 1),
  };
}

function updateAoiStats(sample: FaceFeatureSample, point: { x: number; y: number }) {
  recordAoiHit(point, inferReaction(sample), sample.timestamp);
}

function recordAoiHit(point: { x: number; y: number }, reaction: Reaction, timestamp: number, maxDeltaMs = 320) {
  const hit = getSemanticHitAtScreenPoint(point);
  const deltaMs = currentSession.lastSampleAt ? clamp(timestamp - currentSession.lastSampleAt, 0, maxDeltaMs) : 0;
  currentSession.lastSampleAt = timestamp;
  currentSession.currentReaction = reaction;

  if (!hit) {
    currentSession.lastAoi = undefined;
    currentSession.lastRegionId = undefined;
    currentSession.lastRegionLabel = undefined;
    return;
  }

  const aoi = hit.aoi;
  const stats = currentSession.stats[aoi];
  stats.dwellTimeMs += deltaMs;
  stats.reactionMs[reaction] += deltaMs;

  if (currentSession.lastAoi !== aoi) {
    stats.visitCount += 1;

    if (stats.visitCount > 1) {
      stats.revisitCount += 1;
    }
  }

  stats.ignored = false;
  currentSession.lastAoi = aoi;

  const regionStats = ensureRegionStats(hit);
  regionStats.dwellTimeMs += deltaMs;
  regionStats.reactionMs[reaction] += deltaMs;

  if (currentSession.lastRegionId !== hit.id) {
    regionStats.visitCount += 1;
  }

  currentSession.lastRegionId = hit.id;
  currentSession.lastRegionLabel = hit.label;
}

function refreshDiagnosis() {
  for (const id of AOI_IDS) {
    currentSession.stats[id].ignored = currentSession.stats[id].dwellTimeMs < 500;
  }

  currentSession.diagnosis = diagnoseSemanticRegions() ?? diagnosePage(currentSession.stats);
}

function diagnoseSemanticRegions(): PageDiagnosis | undefined {
  const pageId = getCurrentBasePage()?.id ?? 'unknown';
  const regions = getCurrentPosterSemanticRegions();
  const totalDwellMs = Object.values(currentSession.stats).reduce((sum, stat) => sum + stat.dwellTimeMs, 0);

  if (!regions.length || totalDwellMs < 1500) {
    return undefined;
  }

  const regionSnapshots = regions.map((region) => ({
    region,
    stats: currentSession.regionStats[region.id],
  }));
  const confused = regionSnapshots.find(({ stats }) => stats && (stats.reactionMs.confused > 1200 || stats.visitCount >= 3));

  if (confused) {
    return {
      pageId,
      headline: `${confused.region.name}可能造成困惑`,
      details: [
        `用户在“${confused.region.name}”停留或回看较多，并出现困惑反馈。建议围绕这个具体信息区降低文字密度、强化层级或改成更直接的视觉表达。`,
      ],
      changes: buildSemanticChangeDirections(confused.region, 'confused'),
      focusAoi: confused.region.aoiId,
      issue: 'confused',
    };
  }

  const fatigued = regionSnapshots.find(({ stats }) => stats && stats.reactionMs.fatigued > 1000);

  if (fatigued) {
    return {
      pageId,
      headline: `${fatigued.region.name}阅读负担偏高`,
      details: [`用户在“${fatigued.region.name}”出现疲劳反馈，说明该区域可能信息过密、字号偏小或视觉停顿太长。`],
      changes: buildSemanticChangeDirections(fatigued.region, 'fatigued'),
      focusAoi: fatigued.region.aoiId,
      issue: 'fatigued',
    };
  }

  const importantIgnored = regionSnapshots.find(({ region, stats }) => {
    const importantRole = ['qr', 'time_venue', 'title', 'speaker'].includes(region.role);
    return totalDwellMs > 3200 && (region.importance === 'high' || importantRole) && (!stats || stats.dwellTimeMs < 450);
  });

  if (importantIgnored) {
    return {
      pageId,
      headline: `${importantIgnored.region.name}可能被忽略`,
      details: [
        `系统几乎没有观察到用户注视“${importantIgnored.region.name}”。如果这是关键传播信息，需要提高它的视觉权重，或移动到更符合阅读路径的位置。`,
      ],
      changes: buildSemanticChangeDirections(importantIgnored.region, 'ignored'),
      focusAoi: importantIgnored.region.aoiId,
      issue: 'ignored',
    };
  }

  const positive = regionSnapshots.find(({ stats }) => stats && stats.reactionMs.positive > 1600);

  if (positive) {
    return {
      pageId,
      headline: `${positive.region.name}吸引了注意`,
      details: [`用户对“${positive.region.name}”反馈积极。优化时可以保留该区域的风格，并把它的表达方式迁移到其他关键但弱关注的区域。`],
      changes: buildSemanticChangeDirections(positive.region, 'interested'),
      focusAoi: positive.region.aoiId,
      issue: 'interested',
    };
  }

  return undefined;
}

function getCurrentPosterSemanticRegions(): PosterSemanticRegion[] {
  const page = visiblePageSnapshot ?? getCurrentBasePage();
  return page?.poster ? getPosterSemanticRegions(page.poster.semanticRegions) : [];
}

function diagnosePage(stats: Record<AoiId, AoiStats>): PageDiagnosis {
  const imageConfused =
    stats.image.reactionMs.confused > 1200 || (stats.image.dwellTimeMs > 2000 && stats.image.reactionMs.positive < 500);

  if (imageConfused) {
    return {
      pageId: getCurrentBasePage()?.id ?? 'unknown',
      headline: 'AI 图片可能没有帮助理解',
      details: ['检测到你在 AI 图片区域停留较久，但积极反馈不足。这通常意味着图片存在感够强，却没有把概念解释清楚。'],
      changes: buildChangeDirections('image', 'confused'),
      focusAoi: 'image',
      issue: 'confused',
    };
  }

  const confused = AOI_IDS.find((id) => stats[id].reactionMs.confused > 1200 || stats[id].revisitCount >= 2);

  if (confused) {
    return {
      pageId: getCurrentBasePage()?.id ?? 'unknown',
      headline: `${aoiLabel(confused)}可能造成困惑`,
      details: [`该区域停留或回看较多，且出现困惑迹象，建议拆短句、分步骤解释，并补充一个具体例子。`],
      changes: buildChangeDirections(confused, 'confused'),
      focusAoi: confused,
      issue: 'confused',
    };
  }

  const fatigued = AOI_IDS.find((id) => stats[id].reactionMs.fatigued > 1000);

  if (fatigued) {
    return {
      pageId: getCurrentBasePage()?.id ?? 'unknown',
      headline: `${aoiLabel(fatigued)}阅读负担偏高`,
      details: [`检测到疲劳相关反馈，建议减少文字密度，把结论改成醒目的短卡片。`],
      changes: buildChangeDirections(fatigued, 'fatigued'),
      focusAoi: fatigued,
      issue: 'fatigued',
    };
  }

  if (stats.image.reactionMs.positive > 1200) {
    return {
      pageId: getCurrentBasePage()?.id ?? 'unknown',
      headline: 'AI 图片吸引了注意',
      details: ['图片本身对阅读有吸引力，可以把这种视觉风格延伸到标题强调和关键知识点的提示上。'],
      changes: buildChangeDirections('image', 'interested'),
      focusAoi: 'image',
      issue: 'interested',
    };
  }

  const positive = AOI_IDS.find((id) => id !== 'image' && stats[id].reactionMs.positive > 1600);

  if (positive) {
    return {
      pageId: getCurrentBasePage()?.id ?? 'unknown',
      headline: `${aoiLabel(positive)}吸引了注意`,
      details: [`该区域反馈较积极，可以保留结构，并把类似表达扩展到其他难点区域。`],
      changes: buildChangeDirections(positive, 'interested'),
      focusAoi: positive,
      issue: 'interested',
    };
  }

  const ignored = AOI_IDS.find((id) => stats[id].ignored && id !== 'title');

  if (ignored) {
    return {
      pageId: getCurrentBasePage()?.id ?? 'unknown',
      headline: `${aoiLabel(ignored)}可能被忽略`,
      details: [`系统几乎没有观察到你注视“${aoiLabel(ignored)}”，建议提高它的视觉权重或移动到更靠近正文的位置。`],
      changes: buildChangeDirections(ignored, 'ignored'),
      focusAoi: ignored,
      issue: 'ignored',
    };
  }

  return {
    pageId: getCurrentBasePage()?.id ?? 'unknown',
    headline: '暂未发现明显问题',
    details: ['当前阅读反馈较平稳。若需要演示优化闭环，可以使用侧边栏的模拟反馈按钮。'],
    changes: ['保留当前版式', '仅做轻微文字润色', '不主动替换正在阅读的页面'],
    issue: 'clear',
  };
}

function buildSemanticChangeDirections(
  region: PosterSemanticRegion,
  issue: NonNullable<PageDiagnosis['issue']>,
): string[] {
  const name = region.name;

  if (issue === 'ignored') {
    if (region.role === 'qr') {
      return [
        `放大“${name}”，增加浅色留白底板，避免压在复杂纹理上`,
        '提高二维码和“扫码预约入场”文字的对比度',
        '把报名入口移动到右下角或底部信息流末端，贴近用户自然扫读路径',
      ];
    }

    if (region.role === 'time_venue') {
      return [
        `强化“${name}”的字号、字重和对比度`,
        '把日期、时间、地点拆成两到三行短信息，减少连续长句',
        '用细分隔线或小图标建立时间地点信息组',
      ];
    }

    if (region.role === 'title') {
      return [
        `增大“${name}”主标题字号，让它成为第一视觉锚点`,
        '降低周围装饰元素饱和度，避免抢走标题注意',
        '给标题增加更稳定的留白和高对比背景层',
      ];
    }

    if (region.role === 'speaker') {
      return [
        `提高“${name}”的层级，但避免压过主标题`,
        '将嘉宾姓名和身份拆成清晰两级：姓名更醒目，身份更克制',
        '减少长介绍，只保留最能建立可信度的关键词',
      ];
    }

    return [
      `提高“${name}”的视觉权重`,
      '移动到更靠近主阅读路径的位置',
      '增加边框、底色或间距，让用户扫读时更容易捕捉',
    ];
  }

  if (issue === 'confused') {
    return [
      `重排“${name}”，减少拥挤和交叉信息`,
      '把长句拆成短标签或两级信息结构',
      '提高关键词可读性，减少装饰字体和低对比颜色',
    ];
  }

  if (issue === 'fatigued') {
    return [
      `压缩“${name}”的信息量`,
      '增加行距和留白，避免文字贴得太密',
      '保留必要事实，删去低优先级解释性文字',
    ];
  }

  if (issue === 'interested') {
    return [
      `保留“${name}”的视觉风格和位置`,
      '把该区域的对比、留白或色彩提示迁移到弱关注区域',
      '避免在优化版中过度削弱这个已经有效的注意力入口',
    ];
  }

  return ['保留当前结构', '只做轻微视觉润色'];
}

function buildChangeDirections(aoi: AoiId, issue: NonNullable<PageDiagnosis['issue']>): string[] {
  const commonVisualChanges = ['增大相关区域的视觉权重', '调整强调色，让关键内容更容易被扫到'];

  if (issue === 'ignored') {
    if (aoi === 'image') {
      return [
        '放大 AI 图片卡片，让它在正文中更先进入视线',
        '提高图片和背景的对比度，增加边框或投影',
        '给图片补一行更短的解释，让用户知道为什么要看它',
        '把图片位置移到定义或机制附近，减少跳读成本',
      ];
    }

    return [
      ...commonVisualChanges,
      `放大“${aoiLabel(aoi)}”模块或移动到阅读路径更靠前的位置`,
      '增加箭头、边框或高亮底色作为视觉引导',
    ];
  }

  if (issue === 'confused') {
    if (aoi === 'image') {
      return [
        '替换成更贴近知识点的 AI 图片，减少装饰性元素',
        '给图片加一句更直接的图注，说明它在解释什么',
        '收紧颜色数量，保留单一视觉焦点',
        '把图片里的关键信息同步到旁边文字，避免只好看不好懂',
      ];
    }

    return [
      `把“${aoiLabel(aoi)}”的长句拆成 2-4 个短步骤`,
      '降低文字密度，增加行距和留白',
      '补充一个具体例子或生活化类比',
      '用更醒目的颜色标出关键词',
    ];
  }

  if (issue === 'fatigued') {
    return [
      `压缩“${aoiLabel(aoi)}”的文本长度`,
      '把结论改成短卡片或项目符号',
      '提高标题字号，减少连续阅读压力',
    ];
  }

  if (issue === 'interested') {
    if (aoi === 'image') {
      return [
        '保留这张 AI 图片的视觉风格',
        '把同样的色彩提示迁移到标题和关键词高亮',
        '允许优化版放大图片并保留图注，强化第一眼吸引力',
      ];
    }

    return [
      `保留“${aoiLabel(aoi)}”的表达方式`,
      '把相同的示例化表达迁移到难点区域',
      '适度增强标题颜色和关键字高亮',
    ];
  }

  return ['保留当前版式', '仅做轻微文字润色'];
}

function inferReaction(sample: FaceFeatureSample): Reaction {
  if (sample.blinkScore > 0.48 || sample.eyeOpenness < 0.08) {
    return 'fatigued';
  }

  if (sample.browDown + sample.eyeSquint > 0.42 || sample.mouthFrown > 0.18 || sample.jawOpen > 0.44) {
    return 'confused';
  }

  if (sample.smile > 0.2) {
    return 'positive';
  }

  return 'neutral';
}

function ensureRegionStats(hit: SemanticRegionHit): SemanticRegionStats {
  currentSession.regionStats[hit.id] ??= {
    ...hit,
    dwellTimeMs: 0,
    visitCount: 0,
    reactionMs: {
      neutral: 0,
      positive: 0,
      confused: 0,
      fatigued: 0,
    },
  };

  return currentSession.regionStats[hit.id];
}

function getSemanticHitAtScreenPoint(point: { x: number; y: number }): SemanticRegionHit | undefined {
  const x = window.innerWidth * point.x;
  const y = window.innerHeight * point.y;
  const matches = Array.from(document.querySelectorAll<HTMLElement>('[data-aoi]'))
    .map((element) => {
      const rect = element.getBoundingClientRect();

      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        return undefined;
      }

      const aoi = element.dataset.aoi as AoiId;
      const label = element.dataset.regionLabel || aoiLabel(aoi);
      const role = element.dataset.regionRole || aoi;

      return {
        hit: {
          aoi,
          id: element.dataset.regionId || `${aoi}-${label}`,
          label,
          role,
          importance: element.dataset.regionImportance as PosterSemanticRegion['importance'] | undefined,
        },
        area: rect.width * rect.height,
        isBroadVisual: role === 'visual' && rect.width * rect.height > window.innerWidth * window.innerHeight * 0.35,
      };
    })
    .filter(Boolean) as Array<{ hit: SemanticRegionHit; area: number; isBroadVisual: boolean }>;

  return matches
    .sort((a, b) => {
      if (a.isBroadVisual !== b.isBroadVisual) {
        return a.isBroadVisual ? 1 : -1;
      }

      if ((a.hit.role === 'visual') !== (b.hit.role === 'visual')) {
        return a.hit.role === 'visual' ? 1 : -1;
      }

      return a.area - b.area;
    })[0]?.hit;
}

function render() {
  setupView.hidden = view !== 'setup';
  readerView.hidden = view !== 'reading';
  doneView.hidden = view !== 'done';

  if (view !== 'reading') {
    stopPosterDrag();
  }
  renderPosterBrief();
  renderStatusOnly();
  renderCalibration();

  if (view === 'reading') {
    renderReader();
    renderInsights();
  }

  if (view === 'done') {
    renderFeedbackPageSelect();
    doneSummary.innerHTML = renderReadingCompleteSummary();
    doneStatusOutput.textContent = [feedbackPolishStatus, doneOptimizationStatus].filter(Boolean).join(' ');
    optimizeFromFeedbackButton.disabled = doneOptimizationStatus.includes('正在');
  }
}

function renderReadingCompleteSummary() {
  const records = getFeedbackRecords();

  if (!records.length) {
    return renderFeedbackDraft(buildReadingFeedbackDraft());
  }

  return `
    <div class="poster-feedback-list">
      ${records.map(renderPageFeedbackRecord).join('')}
    </div>
  `;
}

function renderFeedbackPageSelect() {
  const records = getFeedbackRecords();

  if (!records.length) {
    feedbackPageSelect.innerHTML = '';
    feedbackPageSelect.disabled = true;
    return;
  }

  if (!records.some((record) => record.pageId === selectedFeedbackPageId)) {
    selectedFeedbackPageId = records[records.length - 1]?.pageId ?? '';
  }

  feedbackPageSelect.disabled = false;
  feedbackPageSelect.value = selectedFeedbackPageId;
  feedbackPageSelect.innerHTML = records
    .map(
      (record) =>
        `<option value="${escapeHtml(record.pageId)}"${record.pageId === selectedFeedbackPageId ? ' selected' : ''}>海报 ${
          record.pageIndex + 1
        }：${escapeHtml(record.title)}</option>`,
    )
    .join('');
}

function getFeedbackRecords() {
  return activeCourseware.pages
    .map((page, pageIndex) => pageFeedbackRecords.get(page.id) ?? createPageFeedbackRecord(page, pageIndex, pageSessions.get(page.id)))
    .filter((record): record is PageFeedbackRecord => Boolean(record));
}

function renderPageFeedbackRecord(record: PageFeedbackRecord) {
  const selectedClass = record.pageId === selectedFeedbackPageId ? ' poster-feedback-card--selected' : '';
  const feedbackHtml = record.polishedFeedback
    ? renderPolishedFeedback(record.polishedFeedback)
    : renderFeedbackDraft(record.feedback);

  return `
    <section class="poster-feedback-card${selectedClass}">
      <header>
        <span>海报 ${record.pageIndex + 1} 反馈：</span>
        <strong>${escapeHtml(record.title)}</strong>
      </header>
      ${feedbackHtml}
    </section>
  `;
}

function renderPolishedFeedback(feedback: PolishedFeedback) {
  return `
    <div class="reading-summary">
      <p><strong>${escapeHtml(feedback.headline)}</strong></p>
      <p>${escapeHtml(feedback.summary)}</p>
      <p><strong>分区反馈总结：</strong></p>
      <ul>${feedback.items.map(renderFeedbackItem).join('')}</ul>
      <p><strong>给生图模型的优化指令：</strong>${escapeHtml(feedback.optimizationBrief)}</p>
    </div>
  `;
}

function renderFeedbackDraft(feedback: ReadingFeedbackDraft) {
  return `
    <div class="reading-summary">
      <p><strong>用户关注到：</strong>${escapeHtml(feedback.focusedText)}</p>
      <p><strong>用户没看到：</strong>${escapeHtml(feedback.ignoredText)}</p>
      <p><strong>分区反馈总结：</strong></p>
      <ul>${feedback.items.map(renderFeedbackItem).join('')}</ul>
    </div>
  `;
}

function buildReadingFeedbackDraft(session = currentSession): ReadingFeedbackDraft {
  const focused = AOI_IDS.filter((id) => session.stats[id].dwellTimeMs >= 500);
  const ignored = AOI_IDS.filter((id) => session.stats[id].dwellTimeMs < 500);
  const focusedText = focused.length ? focused.map(aoiLabel).join('、') : '暂无稳定关注区域';
  const ignoredText = ignored.length ? ignored.map(aoiLabel).join('、') : '暂无明显遗漏区域';

  return {
    focusedText,
    ignoredText,
    items: AOI_IDS.map((id) => buildAoiFeedbackItem(id, session)),
  };
}

function buildAoiFeedbackItem(id: AoiId, session = currentSession) {
  const stat = session.stats[id];
  const seconds = Math.round(stat.dwellTimeMs / 100) / 10;
  const dominantReaction = dominantAoiReaction(stat);
  const behavior = stat.dwellTimeMs >= 500
    ? `停留约 ${seconds}s，访问 ${stat.visitCount} 次，主要表情为${inferenceReactionLabel(dominantReaction)}`
    : '几乎没有形成有效停留';
  const inference = buildAoiInference(id, stat, dominantReaction);
  const suggestion = buildAoiPromptAdvice(id, stat, dominantReaction);

  return {
    aoi: id,
    label: aoiLabel(id),
    behavior,
    inference,
    suggestion,
    dwellTimeMs: stat.dwellTimeMs,
    visitCount: stat.visitCount,
    reaction: dominantReaction,
  };
}

function renderFeedbackItem(item: {
  label: string;
  behavior: string;
  inference: string;
  suggestion: string;
}) {
  return `<li><strong>${escapeHtml(item.label)}</strong>：行为：${escapeHtml(item.behavior)}；推论：${escapeHtml(item.inference)}；建议：${escapeHtml(item.suggestion)}</li>`;
}

function saveCurrentPageFeedback(page: CoursePage, pageIndex: number) {
  pageSessions.set(page.id, currentSession);
  const record = createPageFeedbackRecord(page, pageIndex, currentSession);

  if (record) {
    pageFeedbackRecords.set(page.id, {
      ...record,
      polishedFeedback: pageFeedbackRecords.get(page.id)?.polishedFeedback,
    });
  }
}

function createPageFeedbackRecord(
  page: CoursePage,
  pageIndex: number,
  session: PageSession | undefined,
): PageFeedbackRecord | undefined {
  if (!session) {
    return undefined;
  }

  return {
    pageId: page.id,
    pageIndex,
    title: page.title || `海报 ${pageIndex + 1}`,
    session,
    feedback: buildReadingFeedbackDraft(session),
    polishedFeedback: pageFeedbackRecords.get(page.id)?.polishedFeedback,
  };
}

function clearReadingFeedbackState() {
  pageSessions.clear();
  pageFeedbackRecords.clear();
  selectedFeedbackPageId = '';
  feedbackPolishStatus = '等待完成阅读后生成反馈总结。';
  doneOptimizationStatus = '';
}

async function polishDoneFeedback() {
  const records = getFeedbackRecords();

  if (!records.length) {
    feedbackPolishStatus = '暂无可整理的海报反馈。';
    render();
    return;
  }

  for (const record of records) {
    const feedback = record.feedback;

    try {
      const polished = await polishReadingFeedback({
        feedback,
        summary: activeCourseware.pages[record.pageIndex]?.poster?.summary ?? posterSummary,
      });
      pageFeedbackRecords.set(record.pageId, {
        ...record,
        polishedFeedback: polished,
      });
    } catch (error) {
      const fallbackFeedback: PolishedFeedback = {
        source: 'local-fallback',
        headline: '阅读反馈总结',
        summary: `用户主要关注到：${feedback.focusedText}。用户没看到或关注不足：${feedback.ignoredText}。`,
        optimizationBrief: feedback.items.map((item) => `${item.label}：${item.suggestion}`).join('；'),
        items: feedback.items,
      };
      pageFeedbackRecords.set(record.pageId, {
        ...record,
        polishedFeedback: fallbackFeedback,
      });
      console.warn(`Feedback polishing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  const polishedRecords = getFeedbackRecords().filter((record) => record.polishedFeedback);
  const provider = polishedRecords.find((record) => record.polishedFeedback?.source !== 'local-fallback')?.polishedFeedback
    ?.source;
  feedbackPolishStatus = provider
    ? `已按海报分别整理反馈，部分总结由 ${provider === 'deepseek' ? 'DeepSeek' : 'Ark'} 润色。`
    : '已按海报分别生成本地反馈总结。';
  render();
}

async function optimizeFromFeedback() {
  const targetPageId = selectedFeedbackPageId || activeCourseware.pages[lastCompletedPageIndex]?.id;
  const pageIndex = activeCourseware.pages.findIndex((item) => item.id === targetPageId);
  const page = pageIndex >= 0 ? activeCourseware.pages[pageIndex] : undefined;
  const record = page ? pageFeedbackRecords.get(page.id) : undefined;

  if (!page?.poster) {
    doneOptimizationStatus = '当前页面没有可优化的海报。';
    render();
    return;
  }

  const draftFeedback = record?.feedback ?? buildReadingFeedbackDraft(record?.session);
  const feedback = record?.polishedFeedback ?? {
    source: 'local-fallback' as const,
    headline: `第 ${pageIndex + 1} 页阅读反馈`,
    summary: renderPlainTextFeedbackSummary(draftFeedback),
    optimizationBrief: draftFeedback.items.map((item) => `${item.label}：${item.suggestion}`).join('；'),
    items: draftFeedback.items,
  };
  const diagnosis = buildFeedbackDiagnosis(page.id, feedback);

  doneOptimizationStatus = `正在为第 ${pageIndex + 1} 页生成优化版...`;
  render();

  try {
    const optimizedDraft = await optimizePosterDraft({
      poster: page.poster,
      diagnosis,
      feedbackSummary: feedback.optimizationBrief,
    });
    const optimizedPage = buildOptimizedPage(page, diagnosis, {
      ...optimizedDraft,
      layout: createDefaultPosterLayout(),
    });
    optimizedPages.set(page.id, optimizedPage);
    doneOptimizationStatus =
      optimizedDraft.source === 'remote-api'
        ? `第 ${pageIndex + 1} 页优化版已生成，返回阅读页即可查看。`
        : `第 ${pageIndex + 1} 页优化版已用本地 fallback 生成，API 提示：${optimizedDraft.imageError ?? '未知错误'}`;
  } catch (error) {
    doneOptimizationStatus = `第 ${pageIndex + 1} 页优化失败：${error instanceof Error ? error.message : '未知错误'}`;
  }

  render();
}

function buildFeedbackDiagnosis(pageId: string, feedback: PolishedFeedback): PageDiagnosis {
  const weakItem = feedback.items.find((item) => item.dwellTimeMs < 500 || item.reaction === 'confused' || item.reaction === 'fatigued');

  return {
    pageId,
    headline: feedback.headline,
    details: [feedback.summary, feedback.optimizationBrief],
    changes: feedback.items.map((item) => `${item.label}：${item.suggestion}`),
    focusAoi: weakItem?.aoi,
    issue: weakItem
      ? weakItem.reaction === 'confused'
        ? 'confused'
        : weakItem.reaction === 'fatigued'
          ? 'fatigued'
          : 'ignored'
      : 'interested',
    feedbackSummary: feedback.optimizationBrief,
  };
}

function renderPlainTextFeedbackSummary(feedback: ReadingFeedbackDraft) {
  return `用户关注到：${feedback.focusedText}。用户没看到或关注不足：${feedback.ignoredText}。${feedback.items
    .map((item) => `${item.label}：行为 ${item.behavior}；推论 ${item.inference}；建议 ${item.suggestion}`)
    .join('。')}`;
}

function dominantAoiReaction(stat: AoiStats): Reaction {
  return (Object.entries(stat.reactionMs).sort(([, a], [, b]) => b - a)[0]?.[0] as Reaction | undefined) ?? 'neutral';
}

function buildAoiInference(id: AoiId, stat: AoiStats, reaction: Reaction) {
  if (stat.dwellTimeMs < 500) {
    return `${aoiLabel(id)}没有被用户明显注意到，可能层级、位置或对比度不足`;
  }

  if (reaction === 'positive') {
    return `${aoiLabel(id)}成功吸引注意，并带来积极反馈`;
  }

  if (reaction === 'confused') {
    return `${aoiLabel(id)}被看到了，但信息可能过密或表达不够直接`;
  }

  if (reaction === 'fatigued') {
    return `${aoiLabel(id)}被看到了，但阅读负担偏高`;
  }

  return `${aoiLabel(id)}被用户看到，反馈稳定，可以保留基本层级`;
}

function buildAoiPromptAdvice(id: AoiId, stat: AoiStats, reaction: Reaction) {
  if (stat.dwellTimeMs < 500) {
    return promptSuggestionForAoi(id);
  }

  if (reaction === 'positive') {
    return `保留${aoiLabel(id)}的视觉层级和表达方式，并把这种有效处理迁移到弱关注区域`;
  }

  if (reaction === 'confused') {
    return `在提示词中要求${aoiLabel(id)}减少文字密度、拆分层级、提高关键词可读性`;
  }

  if (reaction === 'fatigued') {
    return `在提示词中要求${aoiLabel(id)}压缩信息、增加留白、降低连续阅读压力`;
  }

  return `保持${aoiLabel(id)}清晰可读，微调字体、颜色和留白即可`;
}

function renderStatusOnly() {
  cameraStatusOutput.textContent = cameraStatus;
  trackerStatusOutput.textContent = trackerStatus;
  trackingStatusOutput.textContent = trackingStatus;
  setupMessageOutput.textContent = setupMessage;
  cameraStopButton.disabled = !cameraStream;
  renderRuntimeConfig();
}

async function loadRuntimeConfig() {
  try {
    runtimeConfig = await getRuntimeConfig();
  } catch {
    runtimeConfig = undefined;
  }

  renderRuntimeConfig();
}

async function toggleImageApiMode() {
  if (!runtimeConfig) {
    await loadRuntimeConfig();
  }

  const nextDisabled = !(runtimeConfig?.imageApiDisabled ?? false);
  apiModeToggleButton.disabled = true;
  runtimeModeOutput.textContent = '正在切换图片模式...';

  try {
    runtimeConfig = await updateRuntimeConfig({ imageApiDisabled: nextDisabled });
    const modeText = runtimeConfig.imageApiDisabled ? '本地演示模式已启用，不会消耗生图额度。' : '真实图片 API 已启用，生成与优化会消耗额度。';
    setupMessage = modeText;
  } catch (error) {
    setupMessage = error instanceof Error ? error.message : '图片模式切换失败。';
  }

  apiModeToggleButton.disabled = false;
  render();
}

function renderRuntimeConfig() {
  if (!runtimeConfig) {
    runtimeModeOutput.textContent = '运行配置未读取';
    apiModeToggleButton.textContent = '重新读取';
    return;
  }

  const imageMode = runtimeConfig.imageApiDisabled
    ? '本地演示 fallback'
    : runtimeConfig.imageApiAvailable
      ? '真实图片 API'
      : '本地 fallback';
  const visionMode = runtimeConfig.visionApiAvailable ? '视觉识别可用' : '视觉识别未配置';
  runtimeModeOutput.textContent = `${imageMode} · 文本 ${runtimeConfig.textProvider} · ${visionMode}`;
  apiModeToggleButton.textContent = runtimeConfig.imageApiDisabled ? '启用真实生图' : '切到本地演示';
}

function renderPosterBrief() {
  const requirements = readPosterRequirements();
  posterStatusOutput.textContent = posterStatus;
  posterGenerateButton.disabled = !posterSummary || posterStatus.includes('正在');
  summaryGenerateButton.disabled = posterStatus.includes('正在');
  briefExtractButton.disabled = posterStatus.includes('正在');
  coursePreviewTitle.textContent = posterDraft ? activeCourseware.title : '等待生成海报';
  coursePreviewCopy.textContent =
    posterDraft
      ? `${posterDraft.summary.style} · ${posterDraft.images?.length ?? 1} 张比例版本 · ${posterDraft.source === 'remote-api' ? '图片 API' : '本地 fallback'}`
      : '这里只有海报阅读模式。生成海报后，用户会在单页中完成阅读、反馈和优化替换演示。';
  previewStage.innerHTML = renderSetupPreview(requirements);

  if (!posterSummary) {
    summaryOutput.innerHTML = `
      <div><dt>目标</dt><dd>等待摘要</dd></div>
      <div><dt>主视觉</dt><dd>等待摘要</dd></div>
      <div><dt>约束</dt><dd>等待摘要</dd></div>
    `;
    return;
  }

  summaryOutput.innerHTML = `
    <div><dt>目标</dt><dd>${escapeHtml(posterSummary.goal)}</dd></div>
    <div><dt>风格</dt><dd>${escapeHtml(posterSummary.style)}</dd></div>
    <div><dt>主视觉</dt><dd>${escapeHtml(posterSummary.visualDirection)}</dd></div>
    <div><dt>画面元素</dt><dd>${posterSummary.visualElements.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</dd></div>
    <div><dt>避免出现</dt><dd>${posterSummary.avoidElements.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</dd></div>
    <div><dt>必须出现</dt><dd>${posterSummary.mustHave.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</dd></div>
    <div><dt>受众用途</dt><dd>${escapeHtml(posterSummary.audience)}</dd></div>
    <div><dt>尺寸交付</dt><dd>${posterSummary.formatNotes.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</dd></div>
    <div><dt>布局重点</dt><dd>${posterSummary.layoutPriorities.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</dd></div>
  `;
}

function renderSetupPreview(requirements: PosterRequirements) {
  const chips = (posterSummary?.mustHave ?? splitPreviewMustHave(requirements.mustHave)).slice(0, 3);
  const title = escapeHtml(posterDraft?.summary.goal ?? requirements.topic ?? '等待生成海报');
  const subtitle = escapeHtml(posterDraft?.summary.style ?? requirements.style ?? '文学杂志风');

  if (posterDraft) {
    const images = posterDraft.images?.length
      ? posterDraft.images
      : [
          {
            id: posterDraft.id,
            label: posterDraft.aspectRatio ?? '默认',
            aspectRatio: posterDraft.aspectRatio ?? '16:9',
            imageUrl: posterDraft.imageUrl,
            imagePrompt: posterDraft.imagePrompt,
            source: posterDraft.source,
          },
        ];
    const generatedCount = images.length;
    const optimizedHistory = Array.from(optimizedPages.values());

    return `
      <article class="preview-sheet preview-sheet--live">
        <div class="preview-variants">
          ${images
            .map(
              (image) => `
                <figure class="preview-variant" data-ratio="${image.aspectRatio}">
                  <img src="${image.imageUrl}" alt="${escapeHtml(image.imagePrompt)}" />
                  <figcaption>${escapeHtml(image.label)} · ${image.source === 'remote-api' ? 'API' : 'fallback'}</figcaption>
                </figure>
              `,
            )
            .join('')}
        </div>
        <div class="preview-sheet__gradient"></div>
        <div class="preview-sheet__content">
          <span class="preview-sheet__flag">${posterDraft.source === 'remote-api' ? `已生成 ${generatedCount} 张` : `含 fallback · ${generatedCount} 张`}</span>
          <strong>${title}</strong>
          <p>${escapeHtml(posterDraft.summary.visualDirection)}</p>
          <div class="preview-sheet__chips">
            ${chips.map((item) => `<i>${escapeHtml(item)}</i>`).join('')}
          </div>
        </div>
        ${renderPosterVersionHistory(optimizedHistory)}
      </article>
    `;
  }

  return `
    <article class="preview-sheet preview-sheet--placeholder">
      <div class="preview-sheet__paper"></div>
      <div class="preview-sheet__content">
        <span class="preview-sheet__flag">待生成</span>
        <strong>${title}</strong>
        <p>${subtitle}</p>
        <div class="preview-sheet__lines">
          <i></i>
          <i></i>
          <i></i>
        </div>
        <div class="preview-sheet__chips">
          ${chips.map((item) => `<i>${escapeHtml(item)}</i>`).join('')}
        </div>
      </div>
    </article>
  `;
}

function renderPosterVersionHistory(pages: CoursePage[]) {
  if (!pages.length) {
    return `
      <div class="version-history version-history--empty">
        <span>版本历史</span>
        <p>阅读反馈触发优化后，优化版会存放在这里，原图不会被覆盖。</p>
      </div>
    `;
  }

  return `
    <div class="version-history">
      <span>版本历史</span>
      <div class="version-history__list">
        ${pages
          .map((page) => {
            const poster = page.poster;
            const changes = poster?.optimizationChanges?.length
              ? poster.optimizationChanges
              : page.summary;

            return `
              <article class="version-card">
                <img src="${escapeHtml(poster?.imageUrl ?? '')}" alt="${escapeHtml(page.title)}" />
                <div>
                  <strong>${escapeHtml(page.title)}</strong>
                  <small>${poster?.source === 'remote-api' ? 'AI 优化版' : '本地优化版'} · ${escapeHtml(poster?.aspectRatio ?? '默认比例')}</small>
                  <p>${escapeHtml(poster?.optimizationReason ?? '根据阅读反馈生成优化版')}</p>
                  <ul>
                    ${changes.slice(0, 3).map((change) => `<li>${escapeHtml(change)}</li>`).join('')}
                  </ul>
                </div>
              </article>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function splitPreviewMustHave(value: string) {
  return String(value ?? '')
    .split(/\r?\n|,|，|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderCalibration() {
  calibrationOverlay.hidden = !calibration.active;

  if (calibration.active) {
    const target = CALIBRATION_TARGETS[calibration.targetIndex] ?? 'center';
    const point = CALIBRATION_TARGET_POINTS[target];
    calibrationMarker.style.left = `${point.x * 100}%`;
    calibrationMarker.style.top = `${point.y * 100}%`;
    calibrationOverlayText.textContent = `请注视 ${targetLabel(target)} 标记`;
  }

  if (calibration.confirmed) {
    calibrationTitle.textContent = mouseKeyboardMode
      ? '键鼠演示模式已启用'
      : calibration.usingDefault
        ? '默认校准已启用'
        : '眼部校准已确认';
    calibrationMessage.textContent = mouseKeyboardMode
      ? '阅读页中移动鼠标代表注意力区域；按 1 平稳、2 兴趣、3 困惑、4 疲劳。'
      : calibration.usingDefault
        ? '这是演示兜底模式：可以进入阅读，也可以用模拟反馈展示优化闭环。'
      : '正式校准已完成，阅读时会根据视线估计当前关注区域。';
  } else if (calibration.complete) {
    calibrationTitle.textContent = '校准完成';
    calibrationMessage.textContent = '请点击“确认校准”，然后开始阅读。';
  } else if (calibration.active) {
    calibrationTitle.textContent = '正在校准';
    calibrationMessage.textContent = '请自然注视当前标记，系统会自动切换到下一个点。';
  } else {
    calibrationTitle.textContent = '尚未校准';
    calibrationMessage.textContent = '开启摄像头后，跟随屏幕上的标记完成五点校准。';
  }

  calibrationConfirmButton.disabled = !calibration.complete;
  readingStartButton.disabled = !calibration.confirmed || !posterDraft;
}

function renderReader() {
  const page = visiblePageSnapshot ?? getCurrentBasePage();

  if (!page) {
    return;
  }

  const pageChanged = posterViewport.activePageId !== page.id;

  if (pageChanged) {
    resetPosterViewport(page.id);
  }

  readerTitle.textContent = `${activeCourseware.title} · 第 ${currentPageIndex + 1} 页 / ${activeCourseware.pages.length}`;
  pagePrevButton.disabled = currentPageIndex <= 0;
  pageNextButton.textContent = currentPageIndex >= activeCourseware.pages.length - 1 ? '完成阅读' : '下一页';
  courseSlide.dataset.variant = page.variant ?? 'original';
  courseSlide.dataset.mode = 'poster';
  courseSlide.innerHTML = renderPosterPage(page);
  updateReaderPosterControls();

  if (page.poster) {
    scheduleReaderPosterLayout(pageChanged);
  }
}

function renderPosterPage(page: CoursePage) {
  const poster = page.poster;

  if (!poster) {
    return '';
  }

  const layout = poster.layout;

  return `
    <div class="poster-stage-fit" data-poster-stage data-can-pan="false" data-dragging="false">
      <article
        class="poster-canvas"
        data-poster-canvas
        data-dragging="false"
        style="
          --title-scale: ${layout.titleScale};
          --title-contrast: ${layout.titleContrast};
          --image-scale: ${layout.imageScale};
          --image-x: ${layout.imageX}%;
          --image-y: ${layout.imageY}%;
          --image-dim: ${layout.imageDim};
          --info-scale: ${layout.infoScale};
          --cta-emphasis: ${layout.ctaEmphasis};
        "
      >
        <section class="poster-visual">
          <img data-poster-image src="${poster.imageUrl}" alt="${escapeHtml(page.aiImagePrompt)}" draggable="false" />
          ${renderPosterSemanticRegions(poster.semanticRegions)}
        </section>
      </article>
    </div>
  `;
}

function readPosterAspectRatioValue(aspectRatio: PosterAspectRatio | undefined) {
  if (aspectRatio === '3:4') {
    return 3 / 4;
  }

  if (aspectRatio === '4:3') {
    return 4 / 3;
  }

  return 16 / 9;
}

function resetPosterViewport(pageId = '') {
  posterViewport.activePageId = pageId;
  posterViewport.fitWidth = 0;
  posterViewport.fitHeight = 0;
  posterViewport.zoom = 1;
  posterViewport.panX = 0;
  posterViewport.panY = 0;
  stopPosterDrag();
}

function scheduleReaderPosterLayout(resetView = false) {
  syncReaderPosterCanvasSize(resetView);

  if (readerPosterLayoutFrame) {
    window.cancelAnimationFrame(readerPosterLayoutFrame);
  }

  readerPosterLayoutFrame = window.requestAnimationFrame(() => {
    readerPosterLayoutFrame = 0;
    syncReaderPosterCanvasSize(false);
  });
}

function syncReaderPosterCanvasSize(resetView = false) {
  const page = visiblePageSnapshot ?? getCurrentBasePage();
  const stage = courseSlide.querySelector<HTMLElement>('[data-poster-stage]');
  const canvas = courseSlide.querySelector<HTMLElement>('[data-poster-canvas]');
  const posterImage = courseSlide.querySelector<HTMLImageElement>('[data-poster-image]');

  if (!page?.poster || !stage || !canvas) {
    updateReaderPosterControls();
    return;
  }

  const rect = stage.getBoundingClientRect();

  if (rect.width < 8 || rect.height < 8) {
    return;
  }

  const aspectRatioValue = readPosterAspectRatioValue(page.poster.aspectRatio);
  let fitWidth = rect.width;
  let fitHeight = fitWidth / aspectRatioValue;

  if (fitHeight > rect.height) {
    fitHeight = rect.height;
    fitWidth = fitHeight * aspectRatioValue;
  }

  posterViewport.activePageId = page.id;
  posterViewport.fitWidth = fitWidth;
  posterViewport.fitHeight = fitHeight;

  if (resetView) {
    posterViewport.zoom = posterViewport.minZoom;
    posterViewport.panX = 0;
    posterViewport.panY = 0;
  }

  applyPosterViewportTransform();

  if (posterImage && !posterImage.complete) {
    posterImage.addEventListener(
      'load',
      () => {
        syncReaderPosterCanvasSize(false);
      },
      { once: true },
    );
  }
}

function getPosterPanBounds() {
  return {
    x: Math.max(0, (posterViewport.fitWidth * posterViewport.zoom - posterViewport.fitWidth) / 2),
    y: Math.max(0, (posterViewport.fitHeight * posterViewport.zoom - posterViewport.fitHeight) / 2),
  };
}

function canPanCurrentPoster() {
  const bounds = getPosterPanBounds();
  return posterViewport.zoom > posterViewport.minZoom + 0.01 && (bounds.x > 0 || bounds.y > 0);
}

function applyPosterViewportTransform() {
  const stage = courseSlide.querySelector<HTMLElement>('[data-poster-stage]');
  const canvas = courseSlide.querySelector<HTMLElement>('[data-poster-canvas]');

  if (!stage || !canvas) {
    updateReaderPosterControls();
    return;
  }

  const bounds = getPosterPanBounds();
  posterViewport.panX = clamp(posterViewport.panX, -bounds.x, bounds.x);
  posterViewport.panY = clamp(posterViewport.panY, -bounds.y, bounds.y);

  canvas.style.width = `${posterViewport.fitWidth}px`;
  canvas.style.height = `${posterViewport.fitHeight}px`;
  canvas.style.transform = `translate(${posterViewport.panX}px, ${posterViewport.panY}px) scale(${posterViewport.zoom})`;
  stage.dataset.canPan = canPanCurrentPoster() ? 'true' : 'false';
  stage.dataset.dragging = posterViewport.dragging ? 'true' : 'false';
  canvas.dataset.dragging = posterViewport.dragging ? 'true' : 'false';
  updateReaderPosterControls();
}

function updateReaderPosterControls() {
  const hasPoster = Boolean(courseSlide.querySelector('[data-poster-canvas]'));
  const canZoomOut = posterViewport.zoom > posterViewport.minZoom + 0.01;
  const canZoomIn = posterViewport.zoom < posterViewport.maxZoom - 0.01;

  posterZoomOutButton.disabled = !hasPoster || !canZoomOut;
  posterZoomInButton.disabled = !hasPoster || !canZoomIn;
  posterResetButton.disabled =
    !hasPoster ||
    (Math.abs(posterViewport.zoom - posterViewport.minZoom) < 0.01 &&
      Math.abs(posterViewport.panX) < 0.5 &&
      Math.abs(posterViewport.panY) < 0.5);
}

function zoomReaderPoster(delta: number) {
  if (!courseSlide.querySelector('[data-poster-canvas]')) {
    return;
  }

  const nextZoom = clamp(Number((posterViewport.zoom + delta).toFixed(2)), posterViewport.minZoom, posterViewport.maxZoom);

  if (Math.abs(nextZoom - posterViewport.zoom) < 0.001) {
    return;
  }

  const ratio = nextZoom / Math.max(posterViewport.zoom, 0.001);
  posterViewport.zoom = nextZoom;
  posterViewport.panX *= ratio;
  posterViewport.panY *= ratio;
  applyPosterViewportTransform();
}

function resetReaderPosterView() {
  if (!courseSlide.querySelector('[data-poster-canvas]')) {
    return;
  }

  posterViewport.zoom = posterViewport.minZoom;
  posterViewport.panX = 0;
  posterViewport.panY = 0;
  stopPosterDrag();
  applyPosterViewportTransform();
}

function handlePosterPointerDown(event: PointerEvent) {
  if (view !== 'reading' || event.button !== 0 || !canPanCurrentPoster()) {
    return;
  }

  const target = event.target;

  if (!(target instanceof Element) || !target.closest('[data-poster-canvas]')) {
    return;
  }

  posterViewport.dragging = true;
  posterViewport.pointerId = event.pointerId;
  posterViewport.dragStartX = event.clientX;
  posterViewport.dragStartY = event.clientY;
  posterViewport.dragOriginX = posterViewport.panX;
  posterViewport.dragOriginY = posterViewport.panY;

  try {
    courseSlide.setPointerCapture(event.pointerId);
  } catch (error) {
    console.warn('Pointer capture failed', error);
  }

  applyPosterViewportTransform();
  event.preventDefault();
}

function handlePosterPointerMove(event: PointerEvent) {
  if (!posterViewport.dragging || posterViewport.pointerId !== event.pointerId) {
    return;
  }

  posterViewport.panX = posterViewport.dragOriginX + (event.clientX - posterViewport.dragStartX);
  posterViewport.panY = posterViewport.dragOriginY + (event.clientY - posterViewport.dragStartY);
  applyPosterViewportTransform();
}

function handlePosterPointerUp(event: PointerEvent) {
  stopPosterDrag(event.pointerId);
}

function stopPosterDrag(pointerId?: number) {
  if (!posterViewport.dragging && posterViewport.pointerId == null) {
    return;
  }

  if (pointerId != null && posterViewport.pointerId != null && pointerId !== posterViewport.pointerId) {
    return;
  }

  const activePointerId = posterViewport.pointerId;
  posterViewport.dragging = false;
  posterViewport.pointerId = null;

  if (activePointerId != null) {
    try {
      if (courseSlide.hasPointerCapture(activePointerId)) {
        courseSlide.releasePointerCapture(activePointerId);
      }
    } catch (error) {
      console.warn('Pointer release failed', error);
    }
  }

  applyPosterViewportTransform();
}

function renderPosterSemanticRegions(regions: PosterSemanticRegion[] | undefined) {
  return getPosterSemanticRegions(regions)
    .map((region) => {
      const box = region.box;

      return `
        <section
          class="poster-aoi-zone poster-aoi-zone--semantic"
          data-aoi="${region.aoiId}"
          data-region-id="${escapeHtml(region.id)}"
          data-region-role="${region.role}"
          data-region-label="${escapeHtml(region.name)}"
          data-region-importance="${region.importance}"
          title="${escapeHtml(region.name)}"
          style="
            left: ${box.x * 100}%;
            top: ${box.y * 100}%;
            width: ${box.width * 100}%;
            height: ${box.height * 100}%;
          "
          aria-hidden="true"
        >
          <span>${escapeHtml(region.name)}</span>
        </section>
      `;
    })
    .join('');
}

function getPosterSemanticRegions(regions: PosterSemanticRegion[] | undefined): PosterSemanticRegion[] {
  if (regions?.length) {
    return regions;
  }

  return [
    createSemanticRegion('title', '主标题区', 'title', 'title', 0.08, 0.08, 0.52, 0.26),
    createSemanticRegion('subtitle', '副标题与引导语', 'subtitle', 'definition', 0.08, 0.34, 0.52, 0.18),
    createSemanticRegion('visual', '主视觉图像', 'visual', 'image', 0.08, 0.52, 0.46, 0.28),
    createSemanticRegion('speaker', '嘉宾与主题信息', 'speaker', 'diagram', 0.6, 0.12, 0.32, 0.34),
    createSemanticRegion('time-venue', '时间地点', 'time_venue', 'mechanism', 0.08, 0.8, 0.54, 0.12),
    createSemanticRegion('qr', '报名二维码', 'qr', 'example', 0.66, 0.68, 0.26, 0.22),
    createSemanticRegion('organizer', '主承办信息', 'organizer', 'summary', 0.64, 0.9, 0.28, 0.06),
  ];
}

function createSemanticRegionsForAspectRatio(
  aspectRatio: PosterAspectRatio,
  summary: PosterSummary,
): PosterSemanticRegion[] {
  const textByRole = {
    title: summary.goal,
    subtitle: summary.visualDirection,
    visual: summary.visualElements.join('、') || summary.style,
    speaker: findSummaryItems(summary.mustHave, ['嘉宾', '主讲', '分享', '主持', '专家', '作家', '教授']),
    timeVenue: findSummaryItems(summary.mustHave, ['时间', '日期', '地点', '会场', '报告厅']),
    qr: findSummaryItems(summary.mustHave, ['扫码', '二维码', '报名', '预约', '入场']),
    organizer: findSummaryItems(summary.mustHave, ['主办', '承办', '协办']),
  };

  const withText = (region: PosterSemanticRegion): PosterSemanticRegion => ({
    ...region,
    text:
      region.role === 'title'
        ? textByRole.title
        : region.role === 'subtitle'
          ? textByRole.subtitle
          : region.role === 'visual'
            ? textByRole.visual
            : region.role === 'speaker'
              ? textByRole.speaker
              : region.role === 'time_venue'
                ? textByRole.timeVenue
                : region.role === 'qr'
                  ? textByRole.qr
                  : region.role === 'organizer'
                    ? textByRole.organizer
                    : undefined,
  });

  if (aspectRatio === '16:9') {
    return [
      createSemanticRegion('title', '主标题区', 'title', 'title', 0.07, 0.08, 0.48, 0.2),
      createSemanticRegion('subtitle', '副标题与引导语', 'subtitle', 'definition', 0.07, 0.28, 0.42, 0.14),
      createSemanticRegion('visual', '主视觉图像', 'visual', 'image', 0.52, 0.08, 0.4, 0.54),
      createSemanticRegion('speaker', '嘉宾与主题信息', 'speaker', 'diagram', 0.07, 0.45, 0.4, 0.2),
      createSemanticRegion('time-venue', '时间地点', 'time_venue', 'mechanism', 0.07, 0.7, 0.46, 0.14),
      createSemanticRegion('qr', '报名二维码', 'qr', 'example', 0.73, 0.68, 0.18, 0.24),
      createSemanticRegion('organizer', '主承办信息', 'organizer', 'summary', 0.54, 0.84, 0.36, 0.08),
    ].map(withText);
  }

  if (aspectRatio === '4:3') {
    return [
      createSemanticRegion('visual', '主视觉图像', 'visual', 'image', 0.06, 0.12, 0.42, 0.58),
      createSemanticRegion('title', '主标题区', 'title', 'title', 0.5, 0.1, 0.42, 0.2),
      createSemanticRegion('subtitle', '副标题与引导语', 'subtitle', 'definition', 0.52, 0.31, 0.36, 0.14),
      createSemanticRegion('speaker', '嘉宾与主题信息', 'speaker', 'diagram', 0.52, 0.48, 0.34, 0.16),
      createSemanticRegion('time-venue', '时间地点', 'time_venue', 'mechanism', 0.08, 0.76, 0.52, 0.13),
      createSemanticRegion('qr', '报名二维码', 'qr', 'example', 0.7, 0.7, 0.2, 0.22),
      createSemanticRegion('organizer', '主承办信息', 'organizer', 'summary', 0.52, 0.88, 0.36, 0.07),
    ].map(withText);
  }

  return [
    createSemanticRegion('title', '主标题区', 'title', 'title', 0.1, 0.07, 0.8, 0.14),
    createSemanticRegion('subtitle', '副标题与引导语', 'subtitle', 'definition', 0.15, 0.22, 0.7, 0.1),
    createSemanticRegion('visual', '主视觉图像', 'visual', 'image', 0.12, 0.33, 0.76, 0.33),
    createSemanticRegion('speaker', '嘉宾与主题信息', 'speaker', 'diagram', 0.12, 0.66, 0.52, 0.12),
    createSemanticRegion('time-venue', '时间地点', 'time_venue', 'mechanism', 0.12, 0.8, 0.48, 0.1),
    createSemanticRegion('qr', '报名二维码', 'qr', 'example', 0.68, 0.76, 0.22, 0.15),
    createSemanticRegion('organizer', '主承办信息', 'organizer', 'summary', 0.15, 0.92, 0.7, 0.05),
  ].map(withText);
}

function findSummaryItems(items: string[], keywords: string[]) {
  return items.filter((item) => keywords.some((keyword) => item.includes(keyword))).slice(0, 3).join(' | ');
}

function createSemanticRegion(
  id: string,
  name: string,
  role: PosterSemanticRegion['role'],
  aoiId: AoiId,
  x: number,
  y: number,
  width: number,
  height: number,
): PosterSemanticRegion {
  return {
    id,
    name,
    role,
    aoiId,
    importance: role === 'decoration' || role === 'organizer' ? 'low' : 'high',
    box: { x, y, width, height },
  };
}

function renderInsights() {
  gazeDot.style.left = `${currentScreenPoint.x * 100}%`;
  gazeDot.style.top = `${currentScreenPoint.y * 100}%`;
  insightMessageOutput.innerHTML = renderPlainInference();
  statsPanel.innerHTML = renderAoiStats();
}

function renderPlainInference() {
  const focusedAoi = currentSession.lastAoi;
  const focusedLabel = focusedAoi ? (currentSession.lastRegionLabel ?? aoiLabel(focusedAoi)) : '暂无';
  const reaction = currentSession.currentReaction;
  const ignoredItems = getIgnoredAoiItems();

  return `
    <p><strong>关注区域：</strong>${escapeHtml(focusedLabel)}</p>
    <p><strong>表情：</strong>${escapeHtml(inferenceReactionLabel(reaction))}</p>
    <p><strong>推断：</strong>${escapeHtml(buildInferenceSentence(focusedLabel, reaction, Boolean(focusedAoi)))}</p>
    <div class="plain-inference__missing">
      <strong>用户未关注区域：</strong>
      ${
        ignoredItems.length
          ? `<ul>${ignoredItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
          : '<p>暂无明显遗漏</p>'
      }
    </div>
  `;
}

function buildInferenceSentence(focusedLabel: string, reaction: Reaction, hasFocus: boolean) {
  if (!hasFocus) {
    return '等待用户在海报区域停留，暂未形成稳定推断';
  }

  if (reaction === 'positive') {
    return `用户关注到${focusedLabel}，并展现出兴趣`;
  }

  if (reaction === 'confused') {
    return `用户关注到${focusedLabel}，但可能存在理解成本`;
  }

  if (reaction === 'fatigued') {
    return `用户关注到${focusedLabel}，但出现疲劳反馈`;
  }

  return `用户关注到${focusedLabel}，反馈较平稳`;
}

function getIgnoredAoiItems() {
  return AOI_IDS.filter((id) => currentSession.stats[id].ignored && id !== currentSession.lastAoi).map(
    (id) => `${aoiLabel(id)}（${promptSuggestionForAoi(id)}）`,
  );
}

function promptSuggestionForAoi(id: AoiId) {
  const suggestions: Record<AoiId, string> = {
    title: '可通过增大字号、提高对比度或减少周围装饰',
    definition: '可通过缩短文案、提高层级或靠近主标题',
    image: '可通过放大主视觉、减少干扰元素或提高画面焦点',
    diagram: '可通过改变字体、分组或增加留白',
    mechanism: '可通过改变字体或颜色',
    example: '可通过增强二维码/按钮区域对比度',
    summary: '可通过压缩说明文字或降低装饰干扰',
  };

  return suggestions[id];
}

function inferenceReactionLabel(reaction: Reaction) {
  return reaction === 'positive' ? '喜悦' : reactionLabel(reaction);
}

function renderAoiStats() {
  return `
    <section class="aoi-stat-group">
      <span class="step-label">AOI 汇总</span>
      ${AOI_IDS.map((id) => {
        const stat = currentSession.stats[id];
        const seconds = Math.round(stat.dwellTimeMs / 100) / 10;
        const width = clamp(stat.dwellTimeMs / 70, 4, 100);

        return `
          <div class="stat-row">
            <div><strong>${aoiLabel(id)}</strong><span>${seconds}s · 访问 ${stat.visitCount} 次</span></div>
            <i style="width: ${width}%"></i>
          </div>
        `;
      }).join('')}
    </section>
  `;
}

function getCurrentBasePage() {
  return activeCourseware.pages[currentPageIndex];
}

function createPageSession(): PageSession {
  return {
    stats: createStats(),
    regionStats: {},
    lastSampleAt: 0,
    currentReaction: 'neutral',
    denied: false,
    diagnosis: {
      pageId: getCurrentBasePage()?.id ?? 'unknown',
      headline: '等待阅读反馈',
      details: ['系统正在等待视线和表情反馈。'],
      changes: ['等待推断稳定后生成修改方向'],
      issue: 'clear',
    },
  };
}

function createStats(): Record<AoiId, AoiStats> {
  return AOI_IDS.reduce((stats, id) => {
    stats[id] = {
      id,
      dwellTimeMs: 0,
      visitCount: 0,
      revisitCount: 0,
      ignored: true,
      reactionMs: {
        neutral: 0,
        positive: 0,
        confused: 0,
        fatigued: 0,
      },
    };
    return stats;
  }, {} as Record<AoiId, AoiStats>);
}

function createCalibrationSamples(): Record<CalibrationTarget, RawGazePoint[]> {
  return CALIBRATION_TARGETS.reduce((samples, target) => {
    samples[target] = [];
    return samples;
  }, {} as Record<CalibrationTarget, RawGazePoint[]>);
}

function toRawGazePoint(sample: FaceFeatureSample): RawGazePoint {
  return {
    x: sample.irisX * 0.6 + ((sample.leftIrisX + sample.rightIrisX) / 2) * 0.4,
    y: sample.irisY * 0.6 + ((sample.leftIrisY + sample.rightIrisY) / 2) * 0.4,
    faceX: sample.faceCenterX,
    faceY: sample.faceCenterY,
    faceSize: sample.faceSize,
  };
}

function normalizeAxis(value: number, center: number, negativeEdge: number, positiveEdge: number) {
  const minDenominator = 0.04;

  if (value >= center) {
    return clamp((value - center) / Math.max(Math.abs(positiveEdge - center), minDenominator), -1, 1);
  }

  return clamp((value - center) / Math.max(Math.abs(center - negativeEdge), minDenominator), -1, 1);
}

function aoiLabel(id: AoiId) {
  const labels: Record<AoiId, string> = {
    title: '主标题',
    definition: '副标题',
    diagram: '关键信息',
    image: '主视觉',
    mechanism: '时间地点',
    example: '行动入口',
    summary: '说明',
  };

  return labels[id];
}

function targetLabel(target: CalibrationTarget) {
  const labels: Record<CalibrationTarget, string> = {
    center: '中心',
    left: '左侧',
    right: '右侧',
    top: '上方',
    bottom: '下方',
  };

  return labels[target];
}

function reactionLabel(reaction: Reaction) {
  const labels: Record<Reaction, string> = {
    neutral: '平稳',
    positive: '积极',
    confused: '困惑',
    fatigued: '疲劳',
  };

  return labels[reaction];
}

function requireElement<T extends Element>(selector: string): T {
  const element = appRoot.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
