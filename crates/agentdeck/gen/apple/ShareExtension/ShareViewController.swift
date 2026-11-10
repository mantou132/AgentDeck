import UIKit
import UniformTypeIdentifiers

private let appGroup = "group.com.mantou.agentdeck"
/// Larger shares are reported to the app instead of being copied.
private let maxBytes = 20 * 1024 * 1024

/// Copies shared text and files into the App Group in the layout `share_take` (`crates/agentdeck/src/share.rs`)
/// reads, the same as Android's `MainActivity`, then brings the app to the front where the frontend takes them.
class ShareViewController: UIViewController {
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    Task {
      if await receive() { openApp() }
      extensionContext?.completeRequest(returningItems: nil)
    }
  }

  private func receive() async -> Bool {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
      return false
    }
    let dir = container.appendingPathComponent("shared")
    try? FileManager.default.removeItem(at: dir)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var entries: [[String: Any]] = []
    for item in extensionContext?.inputItems as? [NSExtensionItem] ?? [] {
      for provider in item.attachments ?? [] {
        let file = dir.appendingPathComponent(String(entries.count))
        if let entry = await receive(provider, to: file) { entries.append(entry) }
      }
    }
    guard !entries.isEmpty, let manifest = try? JSONSerialization.data(withJSONObject: entries) else { return false }
    // Written last: its presence marks the share as complete.
    return (try? manifest.write(to: dir.appendingPathComponent("manifest.json"))) != nil
  }

  private func receive(_ provider: NSItemProvider, to file: URL) async -> [String: Any]? {
    // Web pages and plain text arrive as values, everything else as files.
    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
      !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
    {
      guard let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL else { return nil }
      return writeText(url.absoluteString, name: provider.suggestedName, to: file)
    }
    if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
      let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String
    {
      return writeText(text, name: provider.suggestedName, to: file)
    }
    let type =
      provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .data) == true } ?? UTType.data.identifier
    let name = provider.suggestedName
    return await withCheckedContinuation { continuation in
      _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
        continuation.resume(returning: url.map { copyFile($0, type: type, name: name, to: file) })
      }
    }
  }

  private func writeText(_ text: String, name: String?, to file: URL) -> [String: Any]? {
    guard (try? text.write(to: file, atomically: true, encoding: .utf8)) != nil else { return nil }
    return ["name": textName(name), "mimeType": "text/plain", "path": file.lastPathComponent]
  }

  private func textName(_ subject: String?) -> String {
    let name = (subject ?? "").components(separatedBy: CharacterSet(charactersIn: "\\/:*?\"<>|\n"))
      .joined(separator: " ").trimmingCharacters(in: .whitespaces).prefix(60)
    return "\(name.isEmpty ? "shared" : name).txt"
  }

  /// Extensions cannot open their app directly, so the URL goes through the host process's `UIApplication`,
  /// called dynamically since `open` is unavailable to extension code.
  private func openApp() {
    guard let url = NSURL(string: "agentdeck://share") else { return }
    let selector = NSSelectorFromString("openURL:options:completionHandler:")
    var responder: UIResponder? = self
    while let current = responder {
      if current is UIApplication, current.responds(to: selector) {
        typealias Open = @convention(c) (NSObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
        unsafeBitCast(current.method(for: selector), to: Open.self)(current, selector, url, NSDictionary(), nil)
        return
      }
      responder = current.next
    }
  }
}

/// `source` is only readable inside the load callback, so it is copied right away.
private func copyFile(_ source: URL, type: String, name: String?, to file: URL) -> [String: Any] {
  var entry: [String: Any] = [
    "name": source.lastPathComponent.isEmpty ? name ?? "shared" : source.lastPathComponent,
    "mimeType": UTType(type)?.preferredMIMEType ?? "",
  ]
  let size = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
  if size > maxBytes {
    entry["tooLarge"] = true
  } else if (try? FileManager.default.copyItem(at: source, to: file)) != nil {
    entry["path"] = file.lastPathComponent
  }
  // Listed without a path, so the frontend reports it as unreadable.
  return entry
}
