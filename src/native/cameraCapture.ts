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

export const CameraCapture = registerPlugin<CameraCapturePlugin>('CameraCapture');
