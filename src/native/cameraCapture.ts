import { registerPlugin } from '@capacitor/core';

export interface CameraCapturePlugin {
  /** Takes one photo through AVFoundation with whatever settings are currently active. */
  capturePhoto(): Promise<{ base64: string }>;
  /**
   * Waits for auto exposure/focus to converge, then locks exposure, focus,
   * and white balance so every subsequent capturePhoto() reuses those same
   * values instead of re-metering the scene per frame.
   */
  lockCaptureSettings(): Promise<void>;
  /** Reverts exposure/focus/white balance to continuous auto modes. */
  unlockCaptureSettings(): Promise<void>;
}

/**
 * Browser stand-in so the capture UI can be exercised in `npm run dev` and
 * headless tests without a device: grabs a still from `getUserMedia`. It is
 * NOT a substitute for the native plugin — a browser can't reliably lock
 * exposure/focus/white balance, so lock/unlock are no-ops here and the
 * flicker criterion of task 1.3 still has to be checked on hardware.
 */
class CameraCaptureWeb implements CameraCapturePlugin {
  private video: HTMLVideoElement | null = null;

  private async ensureVideo(): Promise<HTMLVideoElement> {
    if (this.video) return this.video;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    this.video = video;
    return video;
  }

  async capturePhoto(): Promise<{ base64: string }> {
    const video = await this.ensureVideo();
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    return { base64: canvas.toDataURL('image/jpeg', 0.92).split(',')[1] };
  }

  async lockCaptureSettings(): Promise<void> {}
  async unlockCaptureSettings(): Promise<void> {}
}

export const CameraCapture = registerPlugin<CameraCapturePlugin>('CameraCapture', {
  web: () => new CameraCaptureWeb(),
});
