import CoreLocation
import Foundation

/// The Mac's current location for the device_location tool
/// (src/tools/builtins/deviceLocationTool.js), served by the native server
/// (server port + 1) at POST /location. macOS shows its own permission prompt
/// on first use; nothing is stored here.
final class NativeLocation: NSObject, CLLocationManagerDelegate {
  static let shared = NativeLocation()

  enum Failure: String, Error { case denied, restricted, disabled, timeout, unavailable }

  private var manager: CLLocationManager?
  private var waiters: [(Result<CLLocation, Failure>) -> Void] = []

  /// Only the Melo server may ask: the Host must be this machine's native
  /// port (no DNS-rebinding page) and the private header must be present
  /// (a browser page cannot send it without a preflight this server refuses).
  static func allowed(request: String, port: Int) -> Bool {
    let lines = request.components(separatedBy: "\r\n")
    guard let first = lines.first, first.hasPrefix("POST /location ") else { return false }
    var host = "", header = ""
    for line in lines.dropFirst() {
      let parts = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
      guard parts.count == 2 else { continue }
      switch parts[0].lowercased() {
      case "host": host = parts[1].lowercased()
      case "x-melo-native": header = parts[1]
      default: break
      }
    }
    return header == "location" && ["127.0.0.1:\(port)", "localhost:\(port)"].contains(host)
  }

  /// Called from a background thread; blocks for at most `timeout` seconds.
  func currentJSON(timeout: TimeInterval = 15) -> String {
    let done = DispatchSemaphore(value: 0)
    var outcome: Result<CLLocation, Failure> = .failure(.timeout)
    DispatchQueue.main.async {
      self.request { result in outcome = result; done.signal() }
    }
    guard done.wait(timeout: .now() + timeout) == .success else { return Self.json(["ok": false, "error": Failure.timeout.rawValue]) }
    switch outcome {
    case .failure(let failure):
      return Self.json(["ok": false, "error": failure.rawValue])
    case .success(let location):
      var body: [String: Any] = [
        "ok": true,
        "latitude": location.coordinate.latitude,
        "longitude": location.coordinate.longitude,
        "accuracy": location.horizontalAccuracy,
        "timestamp": ISO8601DateFormatter().string(from: location.timestamp),
      ]
      // Place name is a best effort: the coordinates are still useful without it.
      let named = DispatchSemaphore(value: 0)
      DispatchQueue.main.async {
        CLGeocoder().reverseGeocodeLocation(location) { placemarks, _ in
          if let place = placemarks?.first {
            if let city = place.locality { body["city"] = city }
            if let region = place.administrativeArea { body["region"] = region }
            if let country = place.country { body["country"] = country }
            if let zone = place.timeZone?.identifier { body["timeZone"] = zone }
          }
          named.signal()
        }
      }
      _ = named.wait(timeout: .now() + 5)
      return Self.json(body)
    }
  }

  // Main thread only.
  private func request(_ done: @escaping (Result<CLLocation, Failure>) -> Void) {
    guard CLLocationManager.locationServicesEnabled() else { done(.failure(.disabled)); return }
    let manager = self.manager ?? CLLocationManager()
    self.manager = manager
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    switch manager.authorizationStatus {
    case .denied: done(.failure(.denied)); return
    case .restricted: done(.failure(.restricted)); return
    default: break
    }
    waiters.append(done)
    if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() } else { manager.requestLocation() }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard !waiters.isEmpty else { return }
    switch manager.authorizationStatus {
    case .notDetermined: break
    case .denied: finish(.failure(.denied))
    case .restricted: finish(.failure(.restricted))
    default: manager.requestLocation()
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    if let location = locations.last { finish(.success(location)) }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    finish(.failure((error as? CLError)?.code == .denied ? .denied : .unavailable))
  }

  private func finish(_ result: Result<CLLocation, Failure>) {
    let pending = waiters
    waiters = []
    pending.forEach { $0(result) }
  }

  private static func json(_ value: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { return #"{"ok":false,"error":"unavailable"}"# }
    return text
  }
}
