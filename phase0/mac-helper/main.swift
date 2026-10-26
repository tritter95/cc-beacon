// Phase 0 prototype of CCBeaconNotifier.app: posts macOS notifications via UNUserNotificationCenter
// and opens a URL when one is clicked.
//
//   ccbeacon-notifier post --id ID --title T [--subtitle S] [--body B] [--thread T] [--sound default|none] [--open URL]
//   ccbeacon-notifier withdraw --id ID
//   ccbeacon-notifier status
//   (no arguments) = launched by macOS after a notification click; handles the click and exits.
import AppKit
import UserNotifications

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
       let s = String(data: data, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

func parseFlags(_ args: [String]) -> [String: String] {
    var out: [String: String] = [:]
    var i = 0
    while i < args.count {
        let a = args[i]
        if a.hasPrefix("--"), i + 1 < args.count {
            out[String(a.dropFirst(2))] = args[i + 1]
            i += 2
        } else {
            i += 1
        }
    }
    return out
}

func authName(_ s: UNAuthorizationStatus) -> String {
    switch s {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .ephemeral: return "ephemeral"
    @unknown default: return "unknown"
    }
}

func styleName(_ s: UNAlertStyle) -> String {
    switch s {
    case .none: return "none"
    case .banner: return "banner"
    case .alert: return "alert"
    @unknown default: return "unknown"
    }
}

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let args: [String]
    let center = UNUserNotificationCenter.current()

    init(args: [String]) {
        self.args = args
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        center.delegate = self
        guard let verb = args.first else {
            // Launched by a notification click: wait briefly for didReceive, then exit.
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { exit(0) }
            return
        }
        let flags = parseFlags(Array(args.dropFirst()))
        switch verb {
        case "post": post(flags)
        case "withdraw":
            center.removeDeliveredNotifications(withIdentifiers: [flags["id"] ?? ""])
            emit(["ok": true, "verb": "withdraw"])
            exit(0)
        case "status":
            center.getNotificationSettings { s in
                emit(["ok": true, "verb": "status", "authorization": authName(s.authorizationStatus),
                      "alertStyle": styleName(s.alertStyle),
                      "bundleId": Bundle.main.bundleIdentifier ?? "nil",
                      "bundlePath": Bundle.main.bundlePath])
                exit(0)
            }
        default:
            emit(["ok": false, "error": "unknown verb \(verb)"])
            exit(2)
        }
    }

    func post(_ flags: [String: String]) {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            guard granted else {
                emit(["ok": false, "verb": "post", "error": "not authorized", "detail": error?.localizedDescription ?? ""])
                exit(3)
            }
            let content = UNMutableNotificationContent()
            content.title = flags["title"] ?? "CC Beacon"
            if let s = flags["subtitle"] { content.subtitle = s }
            if let b = flags["body"] { content.body = b }
            if let t = flags["thread"] { content.threadIdentifier = t }
            if let u = flags["open"] { content.userInfo = ["url": u] }
            switch flags["sound"] ?? "default" {
            case "none": break
            case "default": content.sound = .default
            case let name: content.sound = UNNotificationSound(named: UNNotificationSoundName(name))
            }
            let id = flags["id"] ?? UUID().uuidString
            let req = UNNotificationRequest(identifier: id, content: content, trigger: nil)
            self.center.add(req) { err in
                if let err = err {
                    emit(["ok": false, "verb": "post", "error": err.localizedDescription])
                    exit(4)
                }
                emit(["ok": true, "verb": "post", "id": id])
                exit(0)
            }
        }
    }

    // Show banners even if this (background, LSUIElement) app happens to be frontmost.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cc-beacon-phase0-clicks.log")
        let line = "\(ISO8601DateFormatter().string(from: Date())) clicked id=\(response.notification.request.identifier) action=\(response.actionIdentifier) url=\(info["url"] as? String ?? "")\n"
        if let h = try? FileHandle(forWritingTo: log) {
            h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close()
        } else {
            try? line.write(to: log, atomically: true, encoding: .utf8)
        }
        if let s = info["url"] as? String, let url = URL(string: s) {
            NSWorkspace.shared.open(url)
        }
        completionHandler()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate(args: Array(CommandLine.arguments.dropFirst()))
app.delegate = delegate
app.run()
