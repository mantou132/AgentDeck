import AppIntents
import SwiftUI
import WidgetKit

// Opens an app saved by `crates/agentdeck/src/saved_apps.rs`, which keeps them in the App Group as
// `apps/<id>/agentdeck.json` plus `apps/<id>/__agentdeck/icon.png`.

private let appGroup = "group.com.mantou.agentdeck"

private var appsDir: URL? {
  FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?.appendingPathComponent("apps")
}

private struct Manifest: Decodable {
  let name: String
}

struct SavedAppEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "App"
  static let defaultQuery = SavedAppQuery()

  let id: String
  let name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }

  var icon: UIImage? {
    appsDir.flatMap { UIImage(contentsOfFile: $0.appendingPathComponent("\(id)/__agentdeck/icon.png").path) }
  }

  /// Saved apps, most recently saved first, as AgentDeck lists them.
  static func all() -> [SavedAppEntity] {
    guard let dir = appsDir,
      let urls = try? FileManager.default.contentsOfDirectory(
        at: dir, includingPropertiesForKeys: [.contentModificationDateKey], options: .skipsHiddenFiles)
    else { return [] }
    return urls.compactMap { url -> (Date, SavedAppEntity)? in
      guard let data = try? Data(contentsOf: url.appendingPathComponent("agentdeck.json")),
        let manifest = try? JSONDecoder().decode(Manifest.self, from: data)
      else { return nil }
      let saved = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
      return (saved ?? .distantPast, SavedAppEntity(id: url.lastPathComponent, name: manifest.name))
    }
    .sorted { $0.0 > $1.0 }
    .map(\.1)
  }
}

struct SavedAppQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [SavedAppEntity] {
    SavedAppEntity.all().filter { identifiers.contains($0.id) }
  }

  func suggestedEntities() async throws -> [SavedAppEntity] { SavedAppEntity.all() }

  func defaultResult() async -> SavedAppEntity? { SavedAppEntity.all().first }
}

struct SelectAppIntent: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Choose App"

  @Parameter(title: "App")
  var app: SavedAppEntity?
}

struct SavedAppEntry: TimelineEntry {
  let date = Date()
  /// Nil until an app is saved, or once the chosen app is removed.
  let app: SavedAppEntity?
}

struct SavedAppProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> SavedAppEntry { SavedAppEntry(app: nil) }

  /// Read from disk each time: the configuration keeps the name the app had when it was chosen.
  func snapshot(for configuration: SelectAppIntent, in context: Context) async -> SavedAppEntry {
    let apps = SavedAppEntity.all()
    guard let chosen = configuration.app else { return SavedAppEntry(app: apps.first) }
    return SavedAppEntry(app: apps.first { $0.id == chosen.id })
  }

  // AgentDeck can't reload widgets (WidgetKit is Swift only, the App is Rust), so it picks up apps saved again or
  // removed there on a timer.
  func timeline(for configuration: SelectAppIntent, in context: Context) async -> Timeline<SavedAppEntry> {
    Timeline(
      entries: [await snapshot(for: configuration, in: context)],
      policy: .after(Date().addingTimeInterval(30 * 60)))
  }
}

struct SavedAppWidgetView: View {
  let entry: SavedAppEntry

  var body: some View {
    if let app = entry.app {
      VStack(spacing: 8) {
        Group {
          if let icon = app.icon {
            Image(uiImage: icon).resizable().scaledToFit()
          } else {
            Image(systemName: "app.dashed").resizable().scaledToFit().foregroundStyle(.secondary)
          }
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        Text(app.name).font(.footnote.weight(.semibold)).lineLimit(1)
      }
      .widgetURL(URL(string: "agentdeck://app/\(app.id)"))
    } else {
      Text("Save an app in AgentDeck first").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
    }
  }
}

@main
struct SavedAppWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "SavedApp", intent: SelectAppIntent.self, provider: SavedAppProvider()) { entry in
      SavedAppWidgetView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
    }
    .configurationDisplayName("Saved App")
    .description("Opens an app saved in AgentDeck.")
    .supportedFamilies([.systemSmall])
  }
}
