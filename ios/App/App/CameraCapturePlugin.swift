import AVFoundation
import Capacitor
import Foundation

// Scaffolding only: a single unconfigured capture, no exposure/focus lock
// yet. That's task 1.3 — this just proves AVFoundation can be driven from
// a Capacitor plugin end to end.
@objc(CameraCapturePlugin)
public class CameraCapturePlugin: CAPPlugin {
    private let sessionQueue = DispatchQueue(label: "com.tommyelgucci.clumsyloop.cameracapture.session")
    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private var isConfigured = false
    private var pendingCall: CAPPluginCall?

    @objc func capturePhoto(_ call: CAPPluginCall) {
        call.keepAlive = true
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self else { return }
            guard granted else {
                call.reject("Camera access denied")
                return
            }
            self.sessionQueue.async {
                do {
                    try self.configureSessionIfNeeded()
                } catch {
                    call.reject(error.localizedDescription)
                    return
                }
                self.pendingCall = call
                let settings = AVCapturePhotoSettings()
                self.photoOutput.capturePhoto(with: settings, delegate: self)
            }
        }
    }

    // Must run on sessionQueue: AVCaptureSession configuration isn't
    // thread-safe against concurrent start/stop calls.
    private func configureSessionIfNeeded() throws {
        guard !isConfigured else {
            if !session.isRunning {
                session.startRunning()
            }
            return
        }

        session.beginConfiguration()
        session.sessionPreset = .photo

        guard
            let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
            let input = try? AVCaptureDeviceInput(device: device),
            session.canAddInput(input)
        else {
            session.commitConfiguration()
            throw NSError(
                domain: "CameraCapturePlugin",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No back camera input available"]
            )
        }
        session.addInput(input)

        guard session.canAddOutput(photoOutput) else {
            session.commitConfiguration()
            throw NSError(
                domain: "CameraCapturePlugin",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Cannot add photo output to session"]
            )
        }
        session.addOutput(photoOutput)

        session.commitConfiguration()
        session.startRunning()
        isConfigured = true
    }
}

extension CameraCapturePlugin: AVCapturePhotoCaptureDelegate {
    public func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        guard let call = pendingCall else { return }
        pendingCall = nil

        if let error {
            call.reject(error.localizedDescription)
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            call.reject("No image data produced")
            return
        }
        call.resolve(["base64": data.base64EncodedString()])
    }
}
