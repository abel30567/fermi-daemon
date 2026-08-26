// Local, on-device transcription via macOS Speech framework (no network).
// Usage: swift transcribe.swift <audio-file> [locale]
import Foundation
import Speech

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: transcribe.swift <audio> [locale]"); exit(2) }
let url = URL(fileURLWithPath: args[1])
let localeId = args.count >= 3 ? args[2] : "en-US"

let sema = DispatchSemaphore(value: 0)
SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else { print("ERROR: speech recognition not authorized (\(status.rawValue))"); exit(3) }
  guard let rec = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else { print("ERROR: no recognizer for \(localeId)"); exit(4) }
  guard rec.isAvailable else { print("ERROR: recognizer unavailable"); exit(5) }
  let req = SFSpeechURLRecognitionRequest(url: url)
  req.requiresOnDeviceRecognition = true   // hard-local: fails rather than using the network
  if !rec.supportsOnDeviceRecognition { print("WARN: on-device model not present for \(localeId); would need network"); }
  rec.recognitionTask(with: req) { result, err in
    if let err = err { print("ERROR: \(err.localizedDescription)"); exit(6) }
    if let r = result, r.isFinal {
      print(r.bestTranscription.formattedString)
      sema.signal()
    }
  }
}
_ = sema.wait(timeout: .now() + 600)
exit(0)
