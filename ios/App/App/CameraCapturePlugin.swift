import AVFoundation
import Capacitor
import Foundation

// capturePhoto() is scaffolding (task 1.2): a single unconfigured capture.
// lockCaptureSettings()/unlockCaptureSettings() are the part that actually
// matters (task 1.3) — stop motion needs exposure/focus/white balance held
// fixed across the whole session, or every frame re-exposes on its own and
// the sequence flickers.
@objc(CameraCapturePlugin)
public class CameraCapturePlugin: CAPPlugin {
    private let sessionQueue = DispatchQueue(label: "com.tommyelgucci.clumsyloop.cameracapture.session")
    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private var videoDevice: AVCaptureDevice?
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

    // Freezes exposure/focus/white balance at whatever the device's auto
    // modes have converged to, so every capturePhoto() afterward reuses
    // those same values instead of re-metering the scene on its own.
    @objc func lockCaptureSettings(_ call: CAPPluginCall) {
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
                guard let device = self.videoDevice else {
                    call.reject("No camera device configured")
                    return
                }
                self.waitForAutoAdjustmentsToSettle(device: device) {
                    do {
                        try device.lockForConfiguration()
                        defer { device.unlockForConfiguration() }
                        if device.isExposureModeSupported(.locked) {
                            device.exposureMode = .locked
                        }
                        if device.isFocusModeSupported(.locked) {
                            device.focusMode = .locked
                        }
                        if device.isWhiteBalanceModeSupported(.locked) {
                            device.whiteBalanceMode = .locked
                        }
                        call.resolve()
                    } catch {
                        call.reject(error.localizedDescription)
                    }
                }
            }
        }
    }

    // Reverts to continuous auto modes — call before starting a new
    // session against a different scene/light.
    @objc func unlockCaptureSettings(_ call: CAPPluginCall) {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            guard let device = self.videoDevice else {
                call.resolve()
                return
            }
            do {
                try device.lockForConfiguration()
                defer { device.unlockForConfiguration() }
                if device.isExposureModeSupported(.continuousAutoExposure) {
                    device.exposureMode = .continuousAutoExposure
                }
                if device.isFocusModeSupported(.continuousAutoFocus) {
                    device.focusMode = .continuousAutoFocus
                }
                if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                    device.whiteBalanceMode = .continuousAutoWhiteBalance
                }
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
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
        videoDevice = device
        isConfigured = true
    }

    // Auto exposure/focus need a moment to converge after the session
    // starts (or after the scene changes) before locking makes sense —
    // locking mid-adjustment freezes a transient, not the settled value.
    // Falls back to a timeout so a device stuck "adjusting" can't hang
    // the lock call forever.
    private func waitForAutoAdjustmentsToSettle(
        device: AVCaptureDevice,
        timeout: TimeInterval = 1.5,
        completion: @escaping () -> Void
    ) {
        guard device.isAdjustingExposure || device.isAdjustingFocus else {
            completion()
            return
        }

        var didComplete = false
        var exposureObservation: NSKeyValueObservation?
        var focusObservation: NSKeyValueObservation?

        let finish = {
            guard !didComplete else { return }
            didComplete = true
            exposureObservation?.invalidate()
            focusObservation?.invalidate()
            completion()
        }

        let checkSettled = {
            if !device.isAdjustingExposure && !device.isAdjustingFocus {
                finish()
            }
        }

        exposureObservation = device.observe(\.isAdjustingExposure) { [weak self] _, _ in
            self?.sessionQueue.async(execute: checkSettled)
        }
        focusObservation = device.observe(\.isAdjustingFocus) { [weak self] _, _ in
            self?.sessionQueue.async(execute: checkSettled)
        }

        sessionQueue.asyncAfter(deadline: .now() + timeout, execute: finish)
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
