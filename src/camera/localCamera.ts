export type CameraResult =
  | {
      ok: true;
      stream: MediaStream;
    }
  | {
      ok: false;
      reason: string;
    };

export async function startFrontCamera(video: HTMLVideoElement): Promise<CameraResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      reason: '当前浏览器不支持摄像头调用。',
    };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 960 },
        height: { ideal: 540 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    return {
      ok: true,
      stream,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : '摄像头启动失败。',
    };
  }
}

export function stopCamera(stream: MediaStream | undefined) {
  stream?.getTracks().forEach((track) => {
    track.stop();
  });
}
