#import <Capacitor/Capacitor.h>

CAP_PLUGIN(CameraCapturePlugin, "CameraCapture",
  CAP_PLUGIN_METHOD(capturePhoto, CAPPluginReturnPromise);
)
