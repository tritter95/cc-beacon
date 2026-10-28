// CCBeaconNotifier.app: posts CC Beacon's macOS notifications through UNUserNotificationCenter
// and opens a notification's URL when it is clicked.
//
//   ccbeacon-notifier post --id ID --thread T --title T [--subtitle S] [--body B]
//                          [--sound default|none|NAME] [--open URL] [--replace-thread]
//   ccbeacon-notifier withdraw (--id ID | --thread T)
//   ccbeacon-notifier status
//   ccbeacon-notifier request-permission
//   (no arguments) = launched by macOS after a notification click; handles the click and exits.
//
// Every verb prints one JSON line on stdout. Exit codes: 0 ok, 2 usage, 3 not authorized,
// 4 notification center error, 5 timed out.
//
// `post` never asks for permission: the first-run prompt blocks until the user answers, so only
// `request-permission` (run from onboarding) may show it.
import AppKit
import UserNotifications

let helperVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
let startedAt = Date()

func elapsedMs() -> Int {
    Int(Date().timeIntervalSince(startedAt) * 1000)
}

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
       let s = String(data: data, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}

/// Appends to ~/.cc-beacon/helper.log, keeping the newest half once the file passes maxBytes.
/// Only ids, threads, timings and click URLs are logged, never notification text.
enum HelperLog {
    static let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cc-beacon")
    static let file = dir.appendingPathComponent("helper.log")
    static let maxBytes = 256 * 1024

    static func write(_ message: String) {
        let fm = FileManager.default
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        if let size = (try? fm.attributesOfItem(atPath: file.path))?[.size] as? Int, size > maxBytes,
           let data = try? Data(contentsOf: file) {
            let tail = data.suffix(maxBytes / 2)
            let kept = tail.firstIndex(of: 0x0A).map { Data(tail[($0 + 1)...]) } ?? Data()
            try? kept.write(to: file)
        }
        let line = Data("\(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8)
        if let h = try? FileHandle(forWritingTo: file) {
            h.seekToEndOfFile()
            h.write(line)
            try? h.close()
        } else {
            fm.createFile(atPath: file.path, contents: line, attributes: [.posixPermissions: 0o600])
        }
    }
}

let booleanFlags: Set<String> = ["replace-thread"]

func parseFlags(_ args: [String]) -> [String: String] {
    var out: [String: String] = [:]
    var i = 0
    while i < args.count {
        let a = args[i]
        guard a.hasPrefix("--") else {
            i += 1
            continue
        }
        let name = String(a.dropFirst(2))
        if booleanFlags.contains(name) {
            out[name] = "true"
            i += 1
        } else if i + 1 < args.count {
            out[name] = args[i + 1]
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

func isAllowed(_ s: UNAuthorizationStatus) -> Bool {
    s == .authorized || s == .provisional
}

func styleName(_ s: UNAlertStyle) -> String {
    switch s {
    case .none: return "none"
    case .banner: return "banner"
    case .alert: return "alert"
    @unknown default: return "unknown"
    }
}

func usage(_ verb: String, _ message: String) -> Never {
    emit(["ok": false, "verb": verb, "error": message])
    exit(2)
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
            // Launched by a notification click: didReceive arrives shortly. Exit if it never does.
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { exit(0) }
            return
        }
        if verb != "request-permission" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                emit(["ok": false, "verb": verb, "error": "timed out"])
                exit(5)
            }
        }
        let flags = parseFlags(Array(args.dropFirst()))
        switch verb {
        case "post": post(flags)
        case "withdraw": withdraw(flags)
        case "status": status()
        case "request-permission": requestPermission()
        default: usage(verb, "unknown verb")
        }
    }

    func post(_ flags: [String: String]) {
        guard let id = flags["id"], !id.isEmpty else { usage("post", "--id is required") }
        guard let title = flags["title"] else { usage("post", "--title is required") }
        center.getNotificationSettings { settings in
            guard isAllowed(settings.authorizationStatus) else {
                emit(["ok": false, "verb": "post", "error": authName(settings.authorizationStatus)])
                exit(3)
            }
            let content = UNMutableNotificationContent()
            content.title = title
            if let s = flags["subtitle"], !s.isEmpty { content.subtitle = s }
            if let b = flags["body"], !b.isEmpty { content.body = b }
            if let t = flags["thread"], !t.isEmpty { content.threadIdentifier = t }
            if let u = flags["open"], !u.isEmpty { content.userInfo = ["url": u] }
            switch flags["sound"] ?? "default" {
            case "none": break
            case "default": content.sound = .default
            case let name: content.sound = UNNotificationSound(named: UNNotificationSoundName(name))
            }
            let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
            let add = {
                self.center.add(request) { err in
                    if let err = err {
                        HelperLog.write("post-failed id=\(id) error=\(err.localizedDescription)")
                        emit(["ok": false, "verb": "post", "error": err.localizedDescription])
                        exit(4)
                    }
                    let ms = elapsedMs()
                    HelperLog.write("post id=\(id) thread=\(content.threadIdentifier) ms=\(ms)")
                    emit(["ok": true, "verb": "post", "id": id, "ms": ms])
                    exit(0)
                }
            }
            guard flags["replace-thread"] != nil, let thread = flags["thread"], !thread.isEmpty else {
                add()
                return
            }
            // Remove the thread's delivered notifications first, including an earlier copy of this id,
            // so the session shows one notification and the new one is presented afresh.
            self.center.getDeliveredNotifications { delivered in
                let ids = delivered.filter { $0.request.content.threadIdentifier == thread }.map { $0.request.identifier }
                if !ids.isEmpty {
                    self.center.removeDeliveredNotifications(withIdentifiers: ids)
                }
                add()
            }
        }
    }

    func withdraw(_ flags: [String: String]) {
        let matches: (UNNotification) -> Bool
        if let id = flags["id"], !id.isEmpty {
            matches = { $0.request.identifier == id }
        } else if let thread = flags["thread"], !thread.isEmpty {
            matches = { $0.request.content.threadIdentifier == thread }
        } else {
            usage("withdraw", "--id or --thread is required")
        }
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter(matches).map { $0.request.identifier }
            if !ids.isEmpty {
                self.center.removeDeliveredNotifications(withIdentifiers: ids)
                self.center.removePendingNotificationRequests(withIdentifiers: ids)
            }
            // A second query on the same connection is processed after the removal, so the
            // reported count reflects it and the removal isn't lost when the process exits.
            self.center.getDeliveredNotifications { after in
                emit(["ok": true, "verb": "withdraw", "removed": ids.count, "remaining": after.filter(matches).count])
                exit(0)
            }
        }
    }

    func status() {
        center.getNotificationSettings { s in
            emit(["ok": true, "verb": "status", "authorization": authName(s.authorizationStatus),
                  "alertStyle": styleName(s.alertStyle),
                  "bundleId": Bundle.main.bundleIdentifier ?? "",
                  "version": helperVersion])
            exit(0)
        }
    }

    func requestPermission() {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            self.center.getNotificationSettings { s in
                var out: [String: Any] = ["ok": true, "verb": "request-permission", "granted": granted,
                                          "authorization": authName(s.authorizationStatus)]
                if let error = error { out["detail"] = error.localizedDescription }
                emit(out)
                exit(0)
            }
        }
    }

    // Show banners even if this background (LSUIElement) app happens to be frontmost.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let url = response.notification.request.content.userInfo["url"] as? String ?? ""
        HelperLog.write("click id=\(response.notification.request.identifier) action=\(response.actionIdentifier) url=\(url)")
        if let u = URL(string: url), !url.isEmpty {
            NSWorkspace.shared.open(u)
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
