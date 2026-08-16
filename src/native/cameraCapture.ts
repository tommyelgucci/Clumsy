import { registerPlugin } from '@capacitor/core';

export interface CameraCapturePlugin {
  /**
   * Scaffolding only: takes one photo through AVFoundation with no manual
   * exposure/focus/white-balance lock across frames yet — that's task 1.3.
   */
  capturePhoto(): Promise<{ base64: string }>;
}

export const CameraCapture = registerPlugin<CameraCapturePlugin>('CameraCapture');
