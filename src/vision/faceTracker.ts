import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import type { FaceFeatureSample } from '../shared/types';

export type FaceTrackingState = {
  faceVisible: boolean;
  headStable: boolean;
  blink: boolean;
  blinkScore: number;
  message: string;
  sample?: FaceFeatureSample;
};

export type FaceTracker = {
  stop: () => void;
};

type FaceMotionSample = {
  centerX: number;
  centerY: number;
  size: number;
};

type EyeFeature = {
  irisX: number;
  irisY: number;
  openness: number;
};

const WASM_PATH = '/mediapipe/wasm';
const MODEL_PATH = '/mediapipe/models/face_landmarker.task';
const DETECTION_INTERVAL_MS = 90;
const BLINK_ON_THRESHOLD = 0.52;
const BLINK_OFF_THRESHOLD = 0.28;
const STABLE_MOTION_THRESHOLD = 0.045;
const MOTION_WINDOW_SIZE = 8;

let faceLandmarkerPromise: Promise<FaceLandmarker> | undefined;

export async function createFaceTracker(
  video: HTMLVideoElement,
  onState: (state: FaceTrackingState) => void,
  onError: (message: string) => void,
): Promise<FaceTracker> {
  const faceLandmarker = await getFaceLandmarker();
  const motionWindow: FaceMotionSample[] = [];
  let stopped = false;
  let lastDetectAt = 0;
  let blinkArmed = true;
  let animationFrame = 0;

  const tick = () => {
    if (stopped) {
      return;
    }

    animationFrame = window.requestAnimationFrame(tick);

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }

    const now = performance.now();

    if (now - lastDetectAt < DETECTION_INTERVAL_MS) {
      return;
    }

    lastDetectAt = now;

    try {
      const result = faceLandmarker.detectForVideo(video, now);
      const faceState = toFaceTrackingState(result, motionWindow, blinkArmed, now);

      if (faceState.blink) {
        blinkArmed = false;
      } else if (faceState.blinkScore < BLINK_OFF_THRESHOLD) {
        blinkArmed = true;
      }

      onState(faceState);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Face tracking failed.');
    }
  };

  tick();

  return {
    stop: () => {
      stopped = true;
      window.cancelAnimationFrame(animationFrame);
    },
  };
}

async function getFaceLandmarker() {
  faceLandmarkerPromise ??= createFaceLandmarker();
  return faceLandmarkerPromise;
}

async function createFaceLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);

  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: MODEL_PATH,
    },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
}

function toFaceTrackingState(
  result: FaceLandmarkerResult,
  motionWindow: FaceMotionSample[],
  blinkArmed: boolean,
  now: number,
): FaceTrackingState {
  const landmarks = result.faceLandmarks[0];

  if (!landmarks) {
    motionWindow.length = 0;
    return {
      faceVisible: false,
      headStable: false,
      blink: false,
      blinkScore: 0,
      message: '未检测到人脸',
    };
  }

  const face = getFaceMotionSample(landmarks);
  const leftEye = getEyeFeature(landmarks, {
    iris: [468, 469, 470, 471, 472],
    corners: [33, 133],
    lids: [159, 145],
  });
  const rightEye = getEyeFeature(landmarks, {
    iris: [473, 474, 475, 476, 477],
    corners: [362, 263],
    lids: [386, 374],
  });

  motionWindow.push(face);

  if (motionWindow.length > MOTION_WINDOW_SIZE) {
    motionWindow.shift();
  }

  const blendshapes = getBlendshapeScores(result);
  const blinkScore = (blendshapes.eyeBlinkLeft + blendshapes.eyeBlinkRight) / 2;
  const eyeOpenness = (leftEye.openness + rightEye.openness) / 2;
  const headStable = motionWindow.length < MOTION_WINDOW_SIZE || getMotionScore(motionWindow) < STABLE_MOTION_THRESHOLD;
  const blink = blinkArmed && blinkScore >= BLINK_ON_THRESHOLD;
  const sampleQuality = getSampleQuality({ blinkScore, eyeOpenness, headStable });

  return {
    faceVisible: true,
    headStable,
    blink,
    blinkScore,
    message: headStable ? '人脸稳定' : '头部移动中',
    sample: {
      timestamp: now,
      faceCenterX: face.centerX,
      faceCenterY: face.centerY,
      faceSize: face.size,
      irisX: (leftEye.irisX + rightEye.irisX) / 2,
      irisY: (leftEye.irisY + rightEye.irisY) / 2,
      leftIrisX: leftEye.irisX,
      leftIrisY: leftEye.irisY,
      rightIrisX: rightEye.irisX,
      rightIrisY: rightEye.irisY,
      eyeOpenness,
      eyeLookLeft: (blendshapes.eyeLookOutLeft + blendshapes.eyeLookInRight) / 2,
      eyeLookRight: (blendshapes.eyeLookInLeft + blendshapes.eyeLookOutRight) / 2,
      eyeLookUp: (blendshapes.eyeLookUpLeft + blendshapes.eyeLookUpRight) / 2,
      eyeLookDown: (blendshapes.eyeLookDownLeft + blendshapes.eyeLookDownRight) / 2,
      blinkScore,
      smile: (blendshapes.mouthSmileLeft + blendshapes.mouthSmileRight) / 2,
      browDown: (blendshapes.browDownLeft + blendshapes.browDownRight) / 2,
      eyeSquint: (blendshapes.eyeSquintLeft + blendshapes.eyeSquintRight) / 2,
      mouthFrown: (blendshapes.mouthFrownLeft + blendshapes.mouthFrownRight) / 2,
      jawOpen: blendshapes.jawOpen,
      sampleQuality,
      faceVisible: true,
      headStable,
    },
  };
}

function getBlendshapeScores(result: FaceLandmarkerResult) {
  const categories = result.faceBlendshapes[0]?.categories ?? [];
  const score = (name: string) => categories.find((category) => category.categoryName === name)?.score ?? 0;

  return {
    eyeBlinkLeft: score('eyeBlinkLeft'),
    eyeBlinkRight: score('eyeBlinkRight'),
    eyeLookOutLeft: score('eyeLookOutLeft'),
    eyeLookInRight: score('eyeLookInRight'),
    eyeLookInLeft: score('eyeLookInLeft'),
    eyeLookOutRight: score('eyeLookOutRight'),
    eyeLookUpLeft: score('eyeLookUpLeft'),
    eyeLookUpRight: score('eyeLookUpRight'),
    eyeLookDownLeft: score('eyeLookDownLeft'),
    eyeLookDownRight: score('eyeLookDownRight'),
    mouthSmileLeft: score('mouthSmileLeft'),
    mouthSmileRight: score('mouthSmileRight'),
    browDownLeft: score('browDownLeft'),
    browDownRight: score('browDownRight'),
    eyeSquintLeft: score('eyeSquintLeft'),
    eyeSquintRight: score('eyeSquintRight'),
    mouthFrownLeft: score('mouthFrownLeft'),
    mouthFrownRight: score('mouthFrownRight'),
    jawOpen: score('jawOpen'),
  };
}

function getEyeFeature(
  landmarks: NormalizedLandmark[],
  indices: {
    iris: number[];
    corners: [number, number];
    lids: [number, number];
  },
): EyeFeature {
  const irisPoints = indices.iris.map((index) => landmarks[index]).filter(isLandmark);
  const cornerA = landmarks[indices.corners[0]];
  const cornerB = landmarks[indices.corners[1]];
  const lidTop = landmarks[indices.lids[0]];
  const lidBottom = landmarks[indices.lids[1]];

  if (!irisPoints.length || !isLandmark(cornerA) || !isLandmark(cornerB)) {
    return {
      irisX: 0.5,
      irisY: 0.5,
      openness: 0,
    };
  }

  const irisCenter = averageLandmarks(irisPoints);
  const minX = Math.min(cornerA.x, cornerB.x);
  const maxX = Math.max(cornerA.x, cornerB.x);
  const minY = Math.min(cornerA.y, cornerB.y, isLandmark(lidTop) ? lidTop.y : cornerA.y);
  const maxY = Math.max(cornerA.y, cornerB.y, isLandmark(lidBottom) ? lidBottom.y : cornerB.y);
  const eyeWidth = Math.max(maxX - minX, 0.001);
  const eyeHeight = Math.max(maxY - minY, 0.001);
  const openness =
    isLandmark(lidTop) && isLandmark(lidBottom)
      ? Math.hypot(lidTop.x - lidBottom.x, lidTop.y - lidBottom.y) / eyeWidth
      : 0;

  return {
    irisX: clamp((irisCenter.x - minX) / eyeWidth, 0, 1),
    irisY: clamp((irisCenter.y - minY) / eyeHeight, 0, 1),
    openness: clamp(openness, 0, 1),
  };
}

function averageLandmarks(landmarks: NormalizedLandmark[]) {
  const total = landmarks.reduce(
    (sum, landmark) => ({
      x: sum.x + landmark.x,
      y: sum.y + landmark.y,
    }),
    {
      x: 0,
      y: 0,
    },
  );

  return {
    x: total.x / landmarks.length,
    y: total.y / landmarks.length,
  };
}

function getFaceMotionSample(landmarks: NormalizedLandmark[]): FaceMotionSample {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const landmark of landmarks) {
    minX = Math.min(minX, landmark.x);
    minY = Math.min(minY, landmark.y);
    maxX = Math.max(maxX, landmark.x);
    maxY = Math.max(maxY, landmark.y);
  }

  const width = maxX - minX;
  const height = maxY - minY;

  return {
    centerX: minX + width / 2,
    centerY: minY + height / 2,
    size: Math.max(width, height),
  };
}

function getMotionScore(samples: FaceMotionSample[]) {
  const first = samples[0];
  const last = samples[samples.length - 1];

  if (!first || !last) {
    return 0;
  }

  return Math.hypot(last.centerX - first.centerX, last.centerY - first.centerY) + Math.abs(last.size - first.size);
}

function getSampleQuality(input: { blinkScore: number; eyeOpenness: number; headStable: boolean }) {
  const blinkQuality = clamp(1 - input.blinkScore / BLINK_ON_THRESHOLD, 0, 1);
  const opennessQuality = clamp((input.eyeOpenness - 0.08) / 0.16, 0, 1);
  const headQuality = input.headStable ? 1 : 0.42;

  return clamp(blinkQuality * 0.34 + opennessQuality * 0.36 + headQuality * 0.3, 0, 1);
}

function isLandmark(landmark: NormalizedLandmark | undefined): landmark is NormalizedLandmark {
  return Boolean(landmark && Number.isFinite(landmark.x) && Number.isFinite(landmark.y));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
