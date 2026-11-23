// What macOS's built-in sound classifier hears in sound files (offline, nothing to download):
// the nearest thing to ears in the hijack check. Real speech scores "speech" 0.99.
//
//   swift scripts/ears.swift captures/hijack_comfort.wav
//
// Prints the labels it is surest of, averaged over 1.5 s windows. Labels are not exclusive.
import Foundation
import SoundAnalysis
import AVFoundation

class Obs: NSObject, SNResultsObserving {
  var sums: [String: Double] = [:]
  var n = 0
  func request(_ request: SNRequest, didProduce result: SNResult) {
    guard let r = result as? SNClassificationResult else { return }
    n += 1
    for c in r.classifications { sums[c.identifier, default: 0] += c.confidence }
  }
  func request(_ request: SNRequest, didFailWithError error: Error) { print("error \(error)") }
  func requestDidComplete(_ request: SNRequest) {}
}
for path in CommandLine.arguments.dropFirst() {
  do {
    let a = try SNAudioFileAnalyzer(url: URL(fileURLWithPath: path))
    let req = try SNClassifySoundRequest(classifierIdentifier: .version1)
    req.windowDuration = CMTimeMakeWithSeconds(1.5, preferredTimescale: 48000)
    req.overlapFactor = 0.5
    let o = Obs()
    try a.add(req, withObserver: o)
    a.analyze()
    let top = o.sums.map { ($0.key, $0.value / Double(max(1, o.n))) }.sorted { $0.1 > $1.1 }.prefix(7)
    print("\((path as NSString).lastPathComponent)  [\(o.n) windows]  " + top.map { "\($0.0) \(String(format: "%.2f", $0.1))" }.joined(separator: " · "))
  } catch { print("\(path): \(error)") }
}
