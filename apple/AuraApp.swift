import SwiftUI
import Photos
import WebKit
import CryptoKit
import Network
#if os(iOS)
import BackgroundTasks
#else
import ServiceManagement
#endif

struct TransferError: LocalizedError {
    let message: String
    var statusCode: Int? = nil
    var code: String? = nil
    var deleted = false
    var deletionScope: String? = nil
    var hash: String? = nil
    var sourceKey: String? = nil
    var errorDescription: String? { message }

    func deletion(for expectedHash: String, source expectedSource: String? = nil) -> DeletionNotice? {
        guard statusCode == 410, code == "original_deleted", deleted, hash == expectedHash,
              let scope = DeletionScope(rawValue: deletionScope ?? "") else { return nil }
        if scope == .source {
            guard let sourceKey, !sourceKey.isEmpty, sourceKey == expectedSource else { return nil }
        }
        return DeletionNotice(scope: scope, hash: expectedHash, sourceKey: scope == .source ? sourceKey : nil)
    }
}

enum DeletionScope: String { case hash, source }

struct DeletionNotice {
    let scope: DeletionScope
    let hash: String
    var sourceKey: String?
}

enum ImportStage: String, Codable {
    case export = "iCloud / 系统原件"
    case upload = "上传原件"
    case processing = "服务器处理"
    case verification = "核对原件"
    case album = "导入相册"
    case settings = "客户端设置"
}

struct ImportIssue: Codable, Identifiable {
    var id: String
    var resourceKey: String
    var assetID: String?
    var name: String
    var stage: ImportStage
    var message: String
    var occurredAt: String
}

struct Receipt: Codable {
    var key: String
    var hash: String
    var localAssetID: String?
    var serverAssetID: String?
    var status: String?
    var trashed: Bool?
    var present: Bool?
    var verifiedAt: String?
    var invalidated: Bool?
    var deleted: Bool?
    var deletedScope: String?
    var sourceKey: String?

    var sourceAsset: String? {
        // Legacy receipts carry the PhotoKit asset ID inside the composite key.
        localAssetID ?? key.split(separator: "|", maxSplits: 4).dropFirst().first.map(String.init)
    }
}

struct ClientState: Codable {
    var origin: String
    var matched: Int
    var completed: Int
    var processing: Int
    var uploaded: Int
    var duplicates: Int
    var errors: [ImportIssue]
    var lastScan: String
    var lastVerified: String
    var verificationStatus: String
    var albumSignatures: [String: String]
    var blockedAlbums: [String]
    var excluded: Int?
    var deletedSources: [String]?
}

struct AssetSummary {
    var keys: [String]
    var complete: Bool
    var processing: Bool
    var excluded: Bool
}

@MainActor
final class AuraModel: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    @Published var server = UserDefaults.standard.string(forKey: "server") ?? "" {
        didSet {
            if oldValue != server { connected = false; originalPresenceAvailable = false; albumImportAvailable = false }
        }
    }
    @Published var start = UserDefaults.standard.object(forKey: "start") as? Date ?? Calendar.current.date(byAdding: .month, value: -1, to: Date())!
    @Published var end = UserDefaults.standard.object(forKey: "end") as? Date ?? Date()
    @Published var openEnd = UserDefaults.standard.object(forKey: "openEnd") as? Bool ?? true
    @Published var connected = false
    @Published var showLogin = false
    @Published var running = false
    @Published var busy = false
    @Published var progress: Double = 0
    @Published var current = ""
    @Published var status = "连接照片库"
    @Published var matched = 0
    @Published var completedAssets = 0
    @Published var processingAssets = 0
    @Published var excludedAssets = 0
    @Published var uploaded = 0
    @Published var duplicates = 0
    @Published var errors: [ImportIssue] = []
    @Published var limited = false
    @Published var verifying = false
    @Published var verificationProgress: Double = 0
    @Published var verificationStatus = "尚未核对服务器原件"
    @Published var lastVerified = ""
    @Published var lastScan = ""
    @Published var originalPresenceAvailable = false
    @Published var albumImportAvailable = false
    @Published var wifiOnly = UserDefaults.standard.object(forKey: "wifiOnly") as? Bool ?? true {
        didSet { UserDefaults.standard.set(wifiOnly, forKey: "wifiOnly"); policyChanged() }
    }
    @Published var chargingOnly = UserDefaults.standard.bool(forKey: "chargingOnly") {
        didSet { UserDefaults.standard.set(chargingOnly, forKey: "chargingOnly"); policyChanged() }
    }
    @Published var importAlbums = UserDefaults.standard.bool(forKey: "importAlbums") {
        didSet {
            UserDefaults.standard.set(importAlbums, forKey: "importAlbums")
            albumsDirty = true
            rescan()
        }
    }
    #if os(macOS)
    @Published var launchAtLogin = SMAppService.mainApp.status == .enabled
    @Published var loginItemStatus = SMAppService.mainApp.status == .requiresApproval ? "请在系统设置中批准 Aura 登录项" : ""
    #endif
    let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    private var timer: Timer?
    private var scanTask: Task<Void, Never>?
    private var verificationTask: Task<Void, Never>?
    private var startupTask: Task<Void, Never>?
    private var receipts: [String: Receipt] = [:]
    private var receiptKeysByAsset: [String: Set<String>] = [:]
    private var receiptKeysByHash: [String: Set<String>] = [:]
    private var receiptsDirty = false
    private var fetchedAssets: PHFetchResult<PHAsset>?
    private var activeAssetIDs = Set<String>()
    private var summaries: [String: AssetSummary] = [:]
    private var pendingAssetIDs = Set<String>()
    private var needsFullScan = true
    private var scanRequested = false
    private var albumsDirty = true
    private var albumSignatures: [String: String] = [:]
    private var blockedAlbums = Set<String>()
    private var deletedSources = Set<String>()
    private var processingCursor = 0
    private var lastStateWrite = Date.distantPast
    private var activeExport: ResourceExport?
    private var networkKnown = false
    private var networkAvailable = false
    private var nonCellularNetwork = false
    private let networkMonitor = NWPathMonitor()
    #if os(iOS)
    private var charging = false
    #endif
    private let sourceID: String
    private let cache: URL
    private var receiptURL: URL { cache.appendingPathComponent("receipts.jsonl") }
    private var stateURL: URL { cache.appendingPathComponent("client-state.json") }
    private var clock: String { ISO8601DateFormatter().string(from: Date()) }
    var remainingAssets: Int { max(0, matched - completedAssets - excludedAssets) }
    var summaryIsCurrent: Bool { fetchedAssets != nil }
    var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.3.0" }
    var uploadPauseReason: String? {
        if !networkKnown { return "正在检查网络" }
        if !networkAvailable { return "等待网络连接" }
        if wifiOnly && !nonCellularNetwork { return "等待 Wi-Fi 或有线网络" }
        #if os(iOS)
        if chargingOnly && !charging { return "等待设备充电" }
        #endif
        return nil
    }
    var origin: URL? {
        guard var u = URLComponents(string: server.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = u.host, !host.isEmpty, u.scheme == "https" || (u.scheme == "http" && ["localhost", "127.0.0.1"].contains(host)) else { return nil }
        u.path = ""; u.query = nil; u.fragment = nil; u.user = nil; u.password = nil
        return u.url
    }
    override init() {
        let defaults = UserDefaults.standard
        sourceID = defaults.string(forKey: "sourceID") ?? UUID().uuidString
        defaults.set(sourceID, forKey: "sourceID")
        cache = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Aura", isDirectory: true)
        try? FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        super.init()
        BackgroundTransfer.shared.reconnect()
        if let text = try? String(contentsOf: receiptURL, encoding: .utf8) {
            for line in text.split(separator: "\n") {
                if let data = line.data(using: .utf8), let row = try? JSONDecoder().decode(Receipt.self, from: data) {
                    if row.invalidated == true { receipts.removeValue(forKey: row.key) }
                    else { receipts[row.key] = row }
                }
            }
        }
        for row in receipts.values {
            if let id = row.sourceAsset { receiptKeysByAsset[id, default: []].insert(row.key) }
            receiptKeysByHash[row.hash, default: []].insert(row.key)
        }
        loadState()
        networkMonitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            let local = !path.usesInterfaceType(.cellular) && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet) || path.usesInterfaceType(.loopback))
            Task { @MainActor in
                guard let self else { return }
                self.networkKnown = true; self.networkAvailable = available; self.nonCellularNetwork = local
                self.policyChanged()
            }
        }
        networkMonitor.start(queue: DispatchQueue(label: "app.aura.photos.network"))
        PHPhotoLibrary.shared().register(self)
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in Task { @MainActor in self?.rescan() } }
        #if os(iOS)
        UIDevice.current.isBatteryMonitoringEnabled = true
        NotificationCenter.default.addObserver(self, selector: #selector(batteryChanged), name: UIDevice.batteryStateDidChangeNotification, object: nil)
        batteryChanged()
        BGTaskScheduler.shared.register(forTaskWithIdentifier: "app.aura.photos.refresh", using: nil) { [weak self] task in
            Task { @MainActor in
                guard let self, let task = task as? BGProcessingTask else { task.setTaskCompleted(success: false); return }
                await self.runBackground(task)
            }
        }
        #endif
        startupTask = Task { await cleanAbandonedOriginals() }
        Task { await restoreAuthorization(resume: Self.isForeground) }
    }
    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor [weak self] in self?.libraryChanged(changeInstance) }
    }
    private func libraryChanged(_ change: PHChange) {
        if let fetchedAssets, let detail = change.changeDetails(for: fetchedAssets) {
            self.fetchedAssets = detail.fetchResultAfterChanges
            if detail.hasIncrementalChanges {
                for asset in detail.insertedObjects + detail.changedObjects { pendingAssetIDs.insert(asset.localIdentifier) }
                for asset in detail.removedObjects { pendingAssetIDs.remove(asset.localIdentifier); activeAssetIDs.remove(asset.localIdentifier) }
                activeAssetIDs = Set((0..<detail.fetchResultAfterChanges.count).map { detail.fetchResultAfterChanges.object(at: $0).localIdentifier })
                recountSummaries()
            } else { needsFullScan = true }
        } else { needsFullScan = true }
        albumsDirty = true
        rescan()
    }
    static var isForeground: Bool {
        #if os(iOS)
        return UIApplication.shared.applicationState == .active
        #else
        return true
        #endif
    }
    func restoreAuthorization(resume: Bool = true) async {
        await startupTask?.value
        guard origin != nil else { return }
        await copyCookies()
        do {
            let info = try await json("info")
            let capabilities = info["capabilities"] as? [String: Any] ?? [:]
            originalPresenceAvailable = capabilities["originalPresence"] as? Bool == true
            albumImportAvailable = capabilities["albumImport"] as? Bool == true
            connected = true; status = "已连接 Aura"
            let access = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            limited = access == .limited
            if resume && UserDefaults.standard.bool(forKey: "continuous") && (access == .authorized || access == .limited) && !running {
                running = true; rescan()
            }
        } catch { connected = false; status = error.localizedDescription }
    }
    func copyCookies() async {
        let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
        for cookie in cookies where cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == origin?.host {
            HTTPCookieStorage.shared.setCookie(cookie)
        }
    }
    func connect() {
        guard let origin else { status = "请输入 HTTPS 服务器地址"; return }
        running = false; connected = false
        UserDefaults.standard.set(origin.absoluteString, forKey: "server")
        summaries = [:]; fetchedAssets = nil; needsFullScan = true
        loadState()
        webView.load(URLRequest(url: origin.appendingPathComponent("portal/login")))
        showLogin = true
    }
    func loginFinished() async {
        await restoreAuthorization()
        if connected { showLogin = false }
    }
    func startUpload() {
        guard connected else { connect(); return }
        guard openEnd || start <= end else { status = "开始日期不能晚于结束日期"; return }
        UserDefaults.standard.set(start, forKey: "start")
        UserDefaults.standard.set(end, forKey: "end")
        UserDefaults.standard.set(openEnd, forKey: "openEnd")
        guard scanTask == nil && !verifying else { return }
        scanTask = Task { [weak self] in
            guard let self else { return }
            defer { self.finishScanTask() }
            let access = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            guard access == .authorized || access == .limited else { self.status = "请在系统设置中允许 Aura 访问照片"; return }
            self.limited = access == .limited
            self.running = true
            self.needsFullScan = true
            UserDefaults.standard.set(true, forKey: "continuous")
            #if os(iOS)
            self.scheduleBackground()
            #endif
            await self.scan()
        }
    }
    func pauseUpload() {
        running = false
        UserDefaults.standard.set(false, forKey: "continuous")
        activeExport?.cancel()
        status = busy ? "当前分片完成后暂停" : "已暂停"
        #if os(iOS)
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: "app.aura.photos.refresh")
        #endif
    }
    func rescan() {
        guard running && !verifying else { return }
        guard scanTask == nil else { scanRequested = true; return }
        scanTask = Task { [weak self] in
            guard let self else { return }
            defer { self.finishScanTask() }
            await self.scan()
        }
    }
    private func finishScanTask() {
        scanTask = nil
        if scanRequested && running && Self.isForeground {
            scanRequested = false
            rescan()
        }
    }
    private func policyChanged() {
        if let reason = uploadPauseReason {
            activeExport?.cancel()
            if running { status = reason }
        } else if running { rescan() }
        #if os(iOS)
        scheduleBackground()
        #endif
    }
    #if os(iOS)
    @objc private func batteryChanged() {
        let state = UIDevice.current.batteryState
        charging = state == .charging || state == .full
        policyChanged()
    }
    private func runBackground(_ background: BGProcessingTask) async {
        let operation = Task { @MainActor in
            await startupTask?.value
            guard !Task.isCancelled else { return false }
            await restoreAuthorization(resume: false)
            guard !Task.isCancelled && connected && UserDefaults.standard.bool(forKey: "continuous") else { return false }
            let access = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            guard access == .authorized || access == .limited else { return false }
            limited = access == .limited
            running = true
            if scanTask == nil { rescan() }
            guard let ownedTask = scanTask else { return false }
            // Await and expire the same scan, including one already active at wake-up.
            return await withTaskCancellationHandler(operation: {
                await ownedTask.value
                return !Task.isCancelled && !ownedTask.isCancelled && connected && uploadPauseReason == nil && pendingAssetIDs.isEmpty
            }, onCancel: { ownedTask.cancel() })
        }
        background.expirationHandler = { operation.cancel() }
        let success = await operation.value
        background.expirationHandler = nil
        scheduleBackground()
        background.setTaskCompleted(success: success)
    }
    func scheduleBackground() {
        guard UserDefaults.standard.bool(forKey: "continuous") else { return }
        let request = BGProcessingTaskRequest(identifier: "app.aura.photos.refresh")
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = chargingOnly
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
    #endif
    func scan() async {
        await startupTask?.value
        guard running && !busy && !verifying && connected && !Task.isCancelled else { return }
        guard uploadPauseReason == nil else { status = uploadPauseReason!; return }
        busy = true
        #if os(macOS)
        let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "Uploading original photo resources")
        defer { ProcessInfo.processInfo.endActivity(activity) }
        #endif
        defer {
            busy = false; current = ""; progress = 0
            status = running ? (uploadPauseReason ?? (errors.isEmpty ? "持续监测中" : "有待处理项目")) : "已暂停"
            try? compactReceipts()
            saveState(force: true)
        }
        let options = fetchOptions()
        let assets: PHFetchResult<PHAsset>
        if needsFullScan || fetchedAssets == nil {
            let all = PHAsset.fetchAssets(with: options)
            fetchedAssets = all
            activeAssetIDs = Set((0..<all.count).map { all.object(at: $0).localIdentifier })
            pendingAssetIDs.formUnion(activeAssetIDs)
            needsFullScan = false
            summaries = [:]
            recountSummaries()
            assets = all
        } else {
            assets = PHAsset.fetchAssets(withLocalIdentifiers: Array(pendingAssetIDs), options: options)
        }
        for index in 0..<assets.count {
            if index.isMultiple(of: 64) { await Task.yield() }
            guard running && !Task.isCancelled && uploadPauseReason == nil else { break }
            let asset = assets.object(at: index)
            pendingAssetIDs.remove(asset.localIdentifier)
            let resources = PHAssetResource.assetResources(for: asset)
            let keys = resources.map { receiptKey(asset: asset, resource: $0) }
            let source = nativeSourceKey(asset.localIdentifier)
            if sourceDeleted(source) {
                updateSummary(assetID: asset.localIdentifier, keys: keys)
                continue
            }
            for resource in resources {
                guard running && !Task.isCancelled && uploadPauseReason == nil else { pendingAssetIDs.insert(asset.localIdentifier); break }
                let key = receiptKey(asset: asset, resource: resource)
                if receipts[key] != nil { continue }
                var stage = ImportStage.export
                var currentHash: String?
                do {
                    current = resource.originalFilename
                    status = "读取原件 · \(index + 1) / \(assets.count)"
                    progress = 0
                    let file = cache.appendingPathComponent(UUID().uuidString + "-" + resource.originalFilename)
                    defer { try? FileManager.default.removeItem(at: file) }
                    try await export(resource, to: file)
                    guard running && !Task.isCancelled && uploadPauseReason == nil else { pendingAssetIDs.insert(asset.localIdentifier); break }
                    status = "校验原件"
                    let checksumTask = Task.detached { try Self.checksum(file) }
                    let checksum = try await withTaskCancellationHandler(operation: { try await checksumTask.value }, onCancel: { checksumTask.cancel() })
                    currentHash = checksum
                    guard running && !Task.isCancelled && uploadPauseReason == nil else { pendingAssetIDs.insert(asset.localIdentifier); break }
                    let size = (try file.resourceValues(forKeys: [.fileSizeKey])).fileSize!
                    var hints: [String: Any] = ["hash": checksum, "name": resource.originalFilename, "size": size,
                        "sourceKey": source, "resourceType": Self.resourceName(resource.type), "favorite": asset.isFavorite]
                    if let date = asset.creationDate { hints["capturedAt"] = ISO8601DateFormatter().string(from: date) }
                    if let date = asset.modificationDate { hints["modifiedAt"] = ISO8601DateFormatter().string(from: date) }
                    if let location = asset.location { hints["latitude"] = location.coordinate.latitude; hints["longitude"] = location.coordinate.longitude }
                    stage = .upload
                    switch try await transfer(file: file, hints: hints) {
                    case let .accepted(duplicate, result):
                        let row = Receipt(key: key, hash: checksum, localAssetID: asset.localIdentifier,
                            serverAssetID: result["assetId"] as? String, status: result["status"] as? String ?? "queued",
                            trashed: false, present: true, sourceKey: source)
                        try remember(row)
                        if duplicate { duplicates += 1 } else { uploaded += 1 }
                        removeIssues(resourceKey: key)
                        removeIssues(resourceKey: "missing:" + checksum)
                        if row.status == "error" {
                            recordIssue(key: key, assetID: asset.localIdentifier, name: resource.originalFilename, stage: .processing,
                                error: TransferError(message: result["error"] as? String ?? "原件已保存，但服务器处理失败，请在照片库中重试处理"))
                        }
                    case let .trash(result):
                        try remember(Receipt(key: key, hash: checksum, localAssetID: asset.localIdentifier,
                            serverAssetID: result["assetId"] as? String, status: result["status"] as? String,
                            trashed: true, present: result["present"] as? Bool == true, sourceKey: source))
                        removeIssues(resourceKey: key)
                        removeIssues(resourceKey: "missing:" + checksum)
                    case let .deleted(notice):
                        try recordDeletion(notice, key: key, assetID: asset.localIdentifier, source: source)
                    }
                } catch {
                    if let hash = currentHash, let notice = (error as? TransferError)?.deletion(for: hash, source: source) {
                        do { try recordDeletion(notice, key: key, assetID: asset.localIdentifier, source: source) }
                        catch {
                            pendingAssetIDs.insert(asset.localIdentifier)
                            recordIssue(key: key, assetID: asset.localIdentifier, name: resource.originalFilename, stage: .settings, error: error)
                        }
                        if sourceDeleted(source) { break }
                        continue
                    }
                    pendingAssetIDs.insert(asset.localIdentifier)
                    if Task.isCancelled || !running || uploadPauseReason != nil { break }
                    recordIssue(key: key, assetID: asset.localIdentifier, name: resource.originalFilename, stage: stage, error: error)
                }
                if sourceDeleted(source) { break }
            }
            updateSummary(assetID: asset.localIdentifier, keys: keys)
            saveState()
            if !connected { break }
        }
        guard running && !Task.isCancelled && uploadPauseReason == nil && connected else { return }
        await refreshProcessing()
        if importAlbums && albumsDirty { await syncAlbums(options: options) }
        lastScan = clock
    }
    private func fetchOptions() -> PHFetchOptions {
        let options = PHFetchOptions()
        let begin = Calendar.current.startOfDay(for: start)
        if openEnd { options.predicate = NSPredicate(format: "creationDate >= %@", begin as NSDate) }
        else {
            let finish = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: end))!
            options.predicate = NSPredicate(format: "creationDate >= %@ AND creationDate < %@", begin as NSDate, finish as NSDate)
        }
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        return options
    }
    private func receiptKey(asset: PHAsset, resource: PHAssetResource) -> String {
        "\(origin!.absoluteString)|\(asset.localIdentifier)|\(asset.modificationDate?.timeIntervalSince1970 ?? 0)|\(resource.type.rawValue)|\(resource.originalFilename)"
    }
    private func nativeSourceKey(_ assetID: String) -> String { "photokit:\(sourceID):\(assetID)" }
    private func sourceDeleted(_ source: String) -> Bool { deletedSources.contains((origin?.absoluteString ?? "") + "|" + source) }
    private func knownDeletedHash(_ hash: String) -> Bool {
        let prefix = (origin?.absoluteString ?? "") + "|"
        return receiptKeysByHash[hash, default: []].contains { key in
            key.hasPrefix(prefix) && receipts[key]?.deleted == true && receipts[key]?.deletedScope != "source"
        }
    }
    private func knownTrashHash(_ hash: String) -> Bool {
        let prefix = (origin?.absoluteString ?? "") + "|"
        return receiptKeysByHash[hash, default: []].contains { $0.hasPrefix(prefix) && receipts[$0]?.trashed == true }
    }
    private func recountSummaries() {
        matched = activeAssetIDs.count
        completedAssets = summaries.filter { activeAssetIDs.contains($0.key) && $0.value.complete }.count
        processingAssets = summaries.filter { activeAssetIDs.contains($0.key) && $0.value.processing }.count
        excludedAssets = summaries.filter { activeAssetIDs.contains($0.key) && $0.value.excluded }.count
    }
    private func updateSummary(assetID: String, keys: [String]) {
        let eligible = keys.filter { receipts[$0]?.deleted != true && receipts[$0]?.trashed != true }
        let rows = eligible.compactMap { receipts[$0] }
        let excluded = sourceDeleted(nativeSourceKey(assetID)) || (!keys.isEmpty && eligible.isEmpty)
        let value = AssetSummary(keys: keys,
            complete: !excluded && !eligible.isEmpty && rows.count == eligible.count && rows.allSatisfy { $0.present != false },
            processing: !excluded && rows.contains { $0.status == "queued" || $0.status == "processing" || $0.serverAssetID?.isEmpty != false },
            excluded: excluded)
        if activeAssetIDs.contains(assetID) {
            if summaries[assetID]?.complete == true { completedAssets -= 1 }
            if summaries[assetID]?.processing == true { processingAssets -= 1 }
            if summaries[assetID]?.excluded == true { excludedAssets -= 1 }
            if value.complete { completedAssets += 1 }
            if value.processing { processingAssets += 1 }
            if value.excluded { excludedAssets += 1 }
        }
        summaries[assetID] = value
    }
    private func export(_ resource: PHAssetResource, to file: URL) async throws {
        guard uploadPauseReason == nil else { throw CancellationError() }
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        options.progressHandler = { [weak self] value in Task { @MainActor in self?.progress = value * 0.1 } }
        let writer = try ResourceExport(file: file)
        activeExport = writer
        defer { activeExport = nil }
        try await withTaskCancellationHandler(operation: {
            try await writer.write(resource: resource, options: options)
        }, onCancel: { writer.cancel() })
    }
    private enum TransferOutcome {
        case accepted(Bool, [String: Any])
        case trash([String: Any])
        case deleted(DeletionNotice)
    }
    private func transfer(file: URL, hints: [String: Any]) async throws -> TransferOutcome {
        guard running && !Task.isCancelled && uploadPauseReason == nil else { throw CancellationError() }
        let hash = hints["hash"] as! String, size = hints["size"] as! Int
        if knownDeletedHash(hash) { return .deleted(DeletionNotice(scope: .hash, hash: hash)) }
        if knownTrashHash(hash) {
            let row = try await presence(hash)
            let result = try applyServerState(hash: hash, row: row, checked: false, repairMissing: true)
            if result == .deleted { return .deleted(DeletionNotice(scope: .hash, hash: hash)) }
            if result == .trash { return .trash(row) }
        }
        let prepared = try await json("uploads", body: hints)
        if prepared["trashed"] as? Bool == true { return .trash(prepared) }
        if prepared["complete"] as? Bool == true { return .accepted(true, prepared) }
        var offset = prepared["offset"] as? Int ?? 0
        let chunkSize = prepared["chunkSize"] as? Int ?? 8 * 1024 * 1024
        let input = try FileHandle(forReadingFrom: file)
        defer { try? input.close() }
        status = "上传原件"
        var failures = 0
        while offset < size {
            guard running && !Task.isCancelled else { throw CancellationError() }
            guard uploadPauseReason == nil else { throw CancellationError() }
            try input.seek(toOffset: UInt64(offset))
            let bytes = try input.read(upToCount: min(chunkSize, size - offset)) ?? Data()
            guard !bytes.isEmpty else { throw TransferError(message: "无法读取原件") }
            let chunk = cache.appendingPathComponent("chunk-" + UUID().uuidString)
            try bytes.write(to: chunk, options: .atomic)
            defer { try? FileManager.default.removeItem(at: chunk) }
            var request = URLRequest(url: origin!.appendingPathComponent("aura/api/uploads/" + hash))
            request.httpMethod = "PUT"
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            request.setValue(String(offset), forHTTPHeaderField: "Upload-Offset")
            request.timeoutInterval = 180
            do {
                let (data, response) = try await BackgroundTransfer.shared.upload(request, file: chunk, wifiOnly: wifiOnly)
                let row = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
                if response.statusCode == 409, let received = row["offset"] as? Int { offset = received; continue }
                guard (200..<300).contains(response.statusCode), let received = row["offset"] as? Int else { throw Self.responseError(row, status: response.statusCode) }
                offset = received; failures = 0
                progress = 0.1 + 0.9 * Double(offset) / Double(size)
            } catch {
                if (error as? TransferError)?.deletion(for: hash, source: hints["sourceKey"] as? String) != nil { throw error }
                if Task.isCancelled || !running || uploadPauseReason != nil { throw error }
                failures += 1
                if failures > 3 { throw error }
                try await Task.sleep(nanoseconds: UInt64(1 << failures) * 1_000_000_000)
                let current = try await json("uploads/" + hash)
                offset = current["offset"] as? Int ?? offset
            }
        }
        let result = try await json("uploads/" + hash + "/complete", body: [:])
        return result["trashed"] as? Bool == true ? .trash(result) : .accepted(false, result)
    }
    func json(_ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let origin else { throw TransferError(message: "服务器地址无效") }
        var request = URLRequest(url: origin.appendingPathComponent("aura/api/" + path))
        request.timeoutInterval = 60
        request.allowsCellularAccess = !wifiOnly
        if let body { request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        let row = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode), !row.isEmpty else {
            if (response as? HTTPURLResponse)?.statusCode == 401 { connected = false; running = false }
            throw Self.responseError(row, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return row
    }
    nonisolated private static func responseError(_ row: [String: Any], status: Int) -> TransferError {
        TransferError(message: row["error"] as? String ?? "服务器响应无效 (\(status))，请检查网络或重新完成门户授权",
            statusCode: status, code: row["code"] as? String, deleted: row["deleted"] as? Bool == true,
            deletionScope: row["scope"] as? String, hash: row["hash"] as? String, sourceKey: row["sourceKey"] as? String)
    }
    nonisolated static func checksum(_ file: URL) throws -> String {
        let input = try FileHandle(forReadingFrom: file); defer { try? input.close() }
        var hash = SHA256()
        while let data = try input.read(upToCount: 4 * 1024 * 1024), !data.isEmpty {
            try Task.checkCancellation()
            hash.update(data: data)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func remember(_ receipt: Receipt) throws {
        try appendReceipt(receipt)
        receipts[receipt.key] = receipt
        if let id = receipt.sourceAsset { receiptKeysByAsset[id, default: []].insert(receipt.key) }
        receiptKeysByHash[receipt.hash, default: []].insert(receipt.key)
        receiptsDirty = true
    }
    private func appendReceipt(_ receipt: Receipt) throws {
        var line = try JSONEncoder().encode(receipt); line.append(10)
        if !FileManager.default.fileExists(atPath: receiptURL.path) { FileManager.default.createFile(atPath: receiptURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let file = try FileHandle(forWritingTo: receiptURL); defer { try? file.close() }
        try file.seekToEnd(); try file.write(contentsOf: line); try file.synchronize()
    }
    private func invalidate(_ receipt: Receipt) throws {
        var removed = receipt
        removed.invalidated = true
        try appendReceipt(removed)
        receipts.removeValue(forKey: receipt.key)
        receiptKeysByHash[receipt.hash]?.remove(receipt.key)
        if let id = receipt.sourceAsset {
            receiptKeysByAsset[id]?.remove(receipt.key)
            pendingAssetIDs.insert(id)
        }
        receiptsDirty = true
    }
    private func compactReceipts() throws {
        guard receiptsDirty else { return }
        var data = Data()
        let encoder = JSONEncoder()
        for key in receipts.keys.sorted() {
            data.append(try encoder.encode(receipts[key]!)); data.append(10)
        }
        try data.write(to: receiptURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receiptURL.path)
        let file = try FileHandle(forWritingTo: receiptURL); defer { try? file.close() }
        try file.synchronize()
        receiptsDirty = false
    }
    private func recordDeletion(_ notice: DeletionNotice, key: String, assetID: String, source: String) throws {
        let row = Receipt(key: key, hash: notice.hash, localAssetID: assetID, status: "deleted", present: false,
            deleted: true, deletedScope: notice.scope.rawValue, sourceKey: source)
        try remember(row)
        if notice.scope == .source {
            deletedSources.insert((origin?.absoluteString ?? "") + "|" + source)
            pendingAssetIDs.remove(assetID)
            errors.removeAll { $0.assetID == assetID }
        } else { try markHashDeleted(notice.hash) }
        saveState(force: true)
    }
    private func markHashDeleted(_ hash: String) throws {
        let prefix = (origin?.absoluteString ?? "") + "|"
        let keys = Array(receiptKeysByHash[hash, default: []].filter { $0.hasPrefix(prefix) })
        for key in keys {
            guard var row = receipts[key] else { continue }
            // Keep source exclusions recoverable even after the last retained hash is deleted.
            if row.deleted == true && row.deletedScope == "source" {
                removeIssues(resourceKey: key)
                continue
            }
            if row.deleted != true || row.deletedScope != "hash" || row.present != false {
                row.deleted = true; row.deletedScope = "hash"; row.present = false; row.status = "deleted"
                try remember(row)
            }
            removeIssues(resourceKey: key)
        }
        for prefix in ["missing:", "audit:", "status:"] { removeIssues(resourceKey: prefix + hash) }
        for id in Set(keys.compactMap({ receipts[$0]?.sourceAsset })) {
            if let summary = summaries[id] { updateSummary(assetID: id, keys: summary.keys) }
        }
    }
    private func loadState() {
        defer {
            // Source-scoped decisions also live in the flushed journal, not only the summary.
            for row in receipts.values where row.deleted == true && row.deletedScope == "source" {
                if let source = row.sourceKey, let origin = row.key.split(separator: "|", maxSplits: 1).first {
                    deletedSources.insert(String(origin) + "|" + source)
                }
            }
        }
        guard let data = try? Data(contentsOf: stateURL), let saved = try? JSONDecoder().decode(ClientState.self, from: data), saved.origin == origin?.absoluteString else {
            matched = 0; completedAssets = 0; processingAssets = 0; uploaded = 0; duplicates = 0
            excludedAssets = 0; deletedSources = []
            errors = []; lastScan = ""; lastVerified = ""; verificationStatus = "尚未核对服务器原件"
            albumSignatures = [:]; blockedAlbums = []
            return
        }
        matched = saved.matched; completedAssets = saved.completed; processingAssets = saved.processing
        excludedAssets = saved.excluded ?? 0; deletedSources = Set(saved.deletedSources ?? [])
        uploaded = saved.uploaded; duplicates = saved.duplicates; errors = saved.errors
        lastScan = saved.lastScan; lastVerified = saved.lastVerified
        verificationStatus = saved.verificationStatus.hasPrefix("正在核对") ? "上次核对未完成，已保留上传记录" : saved.verificationStatus
        albumSignatures = saved.albumSignatures; blockedAlbums = Set(saved.blockedAlbums)
    }
    private func saveState(force: Bool = false) {
        guard let origin else { return }
        guard force || Date().timeIntervalSince(lastStateWrite) >= 1 else { return }
        let saved = ClientState(origin: origin.absoluteString, matched: matched, completed: completedAssets, processing: processingAssets,
            uploaded: uploaded, duplicates: duplicates, errors: errors, lastScan: lastScan, lastVerified: lastVerified,
            verificationStatus: verificationStatus, albumSignatures: albumSignatures, blockedAlbums: Array(blockedAlbums).sorted(),
            excluded: excludedAssets, deletedSources: Array(deletedSources).sorted())
        do {
            try JSONEncoder().encode(saved).write(to: stateURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
            lastStateWrite = Date()
        } catch { status = "无法保存客户端进度：\(error.localizedDescription)" }
    }
    private func recordIssue(key: String, assetID: String? = nil, name: String, stage: ImportStage, error: Error) {
        let id = key + "|" + stage.rawValue
        let row = ImportIssue(id: id, resourceKey: key, assetID: assetID, name: name, stage: stage, message: error.localizedDescription, occurredAt: clock)
        if let index = errors.firstIndex(where: { $0.id == id }) { errors[index] = row }
        else { errors.append(row) }
        saveState(force: true)
    }
    private func removeIssues(resourceKey: String, stage: ImportStage? = nil) {
        errors.removeAll { $0.resourceKey == resourceKey && (stage == nil || $0.stage == stage) }
    }
    private func cleanAbandonedOriginals() async {
        let referenced = await BackgroundTransfer.shared.activeFiles()
        guard let files = try? FileManager.default.contentsOfDirectory(at: cache, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]) else { return }
        for file in files {
            let name = file.lastPathComponent
            guard name.count > 37, UUID(uuidString: String(name.prefix(36))) != nil, name.dropFirst(36).first == "-",
                  !referenced.contains(file.path), (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            try? FileManager.default.removeItem(at: file)
        }
    }
    func verifyServer() {
        if verifying { verificationTask?.cancel(); return }
        guard connected && !busy && scanTask == nil else { return }
        guard originalPresenceAvailable else { verificationStatus = "服务器需更新到支持原件存在检查的版本"; saveState(force: true); return }
        verifying = true
        verificationTask = Task { [weak self] in
            guard let self else { return }
            await self.verifyReceipts()
            self.verifying = false; self.verificationTask = nil
            if self.running { self.rescan() }
        }
    }
    private func verifyReceipts() async {
        guard let origin else { return }
        await rebuildSummarySnapshot()
        let prefix = origin.absoluteString + "|"
        let hashes = Set(receipts.values.filter { $0.key.hasPrefix(prefix) && $0.deletedScope != "source" }.map(\.hash)).sorted()
        var present = 0, missing = 0, retainedTrash = 0, permanentlyDeleted = 0, checked = 0, unresolved = 0
        verificationProgress = 0
        verificationStatus = "正在核对服务器原件 · 0 / \(hashes.count)"
        saveState(force: true)
        defer {
            if Task.isCancelled { verificationStatus = "核对已停止：已确认 \(present) 个原件，剩余记录已保留" }
            else {
                verificationStatus = "已确认 \(present) 个原件，缺失 \(missing) 个，最近删除 \(retainedTrash) 个，永久删除 \(permanentlyDeleted) 个，未确认 \(unresolved + hashes.count - checked) 个"
                if checked == hashes.count && unresolved == 0 { lastVerified = clock }
            }
            if missing > 0 && !running { verificationStatus += "；开始持续上传后补传可访问的缺失原件" }
            let sources = deletedSources.filter { $0.hasPrefix(prefix) }.count
            if sources > 0 { verificationStatus += "；已排除 \(sources) 个永久删除的来源" }
            try? compactReceipts()
            albumsDirty = true; albumSignatures = [:]
            saveState(force: true)
        }
        for hash in hashes {
            guard !Task.isCancelled && connected else { break }
            do {
                let row = try await presence(hash)
                let result = try applyServerState(hash: hash, row: row, checked: true, repairMissing: true)
                if result == .present { present += 1 }
                else if result == .missing { missing += 1 }
                else if result == .deleted { permanentlyDeleted += 1 }
                else { retainedTrash += 1 }
                removeIssues(resourceKey: "audit:" + hash, stage: .verification)
                checked += 1
            } catch {
                if Task.isCancelled { break }
                unresolved += 1; checked += 1
                recordIssue(key: "audit:" + hash, name: String(hash.prefix(12)), stage: .verification, error: error)
                if !(error is TransferError) || !connected { break }
            }
            verificationProgress = hashes.isEmpty ? 1 : Double(checked) / Double(hashes.count)
            verificationStatus = "正在核对服务器原件 · \(checked) / \(hashes.count)"
        }
    }
    private enum PresenceResult { case present, missing, trash, deleted }
    private func rebuildSummarySnapshot() async {
        guard fetchedAssets == nil else { return }
        let access = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard access == .authorized || access == .limited else { return }
        limited = access == .limited
        let assets = PHAsset.fetchAssets(with: fetchOptions())
        fetchedAssets = assets
        activeAssetIDs = Set((0..<assets.count).map { assets.object(at: $0).localIdentifier })
        summaries = [:]; recountSummaries()
        for index in 0..<assets.count {
            if index.isMultiple(of: 64) { await Task.yield() }
            guard !Task.isCancelled else { return }
            let asset = assets.object(at: index)
            let keys = PHAssetResource.assetResources(for: asset).map { receiptKey(asset: asset, resource: $0) }
            updateSummary(assetID: asset.localIdentifier, keys: keys)
        }
    }
    private func presence(_ hash: String) async throws -> [String: Any] {
        do { return try await json("uploads/" + hash) }
        catch let error as TransferError where error.statusCode == 404 { return ["complete": false, "missing": true] }
        catch let error as TransferError {
            if let notice = error.deletion(for: hash), notice.scope == .hash {
                return ["_confirmedDeletion": notice, "complete": false, "present": false, "missing": false]
            }
            throw error
        }
    }
    private func applyServerState(hash: String, row: [String: Any], checked: Bool, repairMissing: Bool) throws -> PresenceResult {
        let prefix = (origin?.absoluteString ?? "") + "|"
        let keys = Array(receiptKeysByHash[hash, default: []].filter { $0.hasPrefix(prefix) })
        // JSON responses cannot manufacture this locally validated, typed deletion notice.
        if let notice = row["_confirmedDeletion"] as? DeletionNotice, notice.scope == .hash, notice.hash == hash {
            try markHashDeleted(hash)
            return .deleted
        }
        let confirmed = row["complete"] as? Bool == true && row["present"] as? Bool == true
        let missing = row["missing"] as? Bool == true || row["complete"] as? Bool == false
        guard confirmed || missing else { throw TransferError(message: "服务器未确认原件存在状态，已保留上传记录") }
        if knownDeletedHash(hash) {
            try markHashDeleted(hash)
            return .deleted
        }
        let knownTrash = keys.contains { receipts[$0]?.trashed == true }
        var trash = row["trashed"] as? Bool == true
        for key in keys {
            guard var receipt = receipts[key] else { continue }
            if receipt.deleted == true && receipt.deletedScope == "source" { continue }
            // An omitted state cannot let a legacy alias undo another receipt's deletion.
            let isTrash = row["trashed"] as? Bool ?? knownTrash
            trash = trash || isTrash
            if missing && !isTrash && repairMissing {
                try invalidate(receipt)
                recordIssue(key: "missing:" + hash, assetID: receipt.sourceAsset, name: String(hash.prefix(12)), stage: .verification,
                    error: TransferError(message: "服务器原件缺失，等待从系统照片补传；不会改动系统照片"))
                continue
            }
            if let value = row["assetId"] as? String { receipt.serverAssetID = value }
            if let value = row["status"] as? String { receipt.status = value }
            receipt.trashed = isTrash; receipt.present = confirmed
            if checked && confirmed { receipt.verifiedAt = clock }
            receipts[key] = receipt; receiptsDirty = true
            if confirmed { removeIssues(resourceKey: key, stage: .verification) }
            if missing && isTrash {
                removeIssues(resourceKey: key)
            } else if receipt.status == "error" {
                recordIssue(key: key, assetID: receipt.sourceAsset, name: String(hash.prefix(12)), stage: .processing,
                    error: TransferError(message: row["error"] as? String ?? "原件已保存，但服务器处理失败，请在照片库中重试处理"))
            } else if receipt.status == "ready" { removeIssues(resourceKey: key, stage: .processing) }
        }
        let affected = Set(keys.compactMap { receipts[$0]?.sourceAsset ?? $0.split(separator: "|", maxSplits: 4).dropFirst().first.map(String.init) })
        for id in affected { if let summary = summaries[id] { updateSummary(assetID: id, keys: summary.keys) } }
        if confirmed { removeIssues(resourceKey: "missing:" + hash); return trash ? .trash : .present }
        if trash { removeIssues(resourceKey: "missing:" + hash) }
        return trash ? .trash : .missing
    }
    private func refreshProcessing() async {
        let prefix = (origin?.absoluteString ?? "") + "|"
        let hashes = Set(receipts.values.filter {
            $0.key.hasPrefix(prefix) && $0.deleted != true && $0.trashed != true && activeAssetIDs.contains($0.sourceAsset ?? "") &&
            ($0.status == "queued" || $0.status == "processing" || $0.serverAssetID?.isEmpty != false)
        }.map(\.hash)).sorted()
        guard !hashes.isEmpty else { return }
        let begin = processingCursor % hashes.count
        let count = min(32, hashes.count)
        for index in 0..<count {
            guard running && connected && !Task.isCancelled && uploadPauseReason == nil else { return }
            let hash = hashes[(begin + index) % hashes.count]
            do {
                let row = try await presence(hash)
                if originalPresenceAvailable { _ = try applyServerState(hash: hash, row: row, checked: false, repairMissing: true) }
                else {
                    for key in receiptKeysByHash[hash, default: []].filter({ $0.hasPrefix(prefix) }) {
                        receipts[key]?.status = row["status"] as? String
                        receipts[key]?.serverAssetID = row["assetId"] as? String
                    }
                    receiptsDirty = true
                }
                removeIssues(resourceKey: "status:" + hash, stage: .processing)
            } catch {
                if Task.isCancelled { return }
                recordIssue(key: "status:" + hash, name: String(hash.prefix(12)), stage: .processing, error: error)
                if !(error is TransferError) || !connected { return }
            }
        }
        processingCursor = (begin + count) % hashes.count
    }
    func refreshAlbums() {
        guard importAlbums && !busy && !verifying else { return }
        albumSignatures = [:]; albumsDirty = true
        rescan()
    }
    private func syncAlbums(options: PHFetchOptions) async {
        guard albumImportAvailable && originalPresenceAvailable else {
            recordIssue(key: "album-capability", name: "Apple 相册", stage: .album, error: TransferError(message: "服务器需更新到支持 Apple 相册导入的版本"))
            return
        }
        removeIssues(resourceKey: "album-capability")
        let collections = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil)
        var states: [String: [String: Any]] = [:]
        var unfinished = false
        for index in 0..<collections.count {
            guard running && connected && !Task.isCancelled && uploadPauseReason == nil else { return }
            let album = collections.object(at: index)
            let source = "photokit-album:\(sourceID):\(album.localIdentifier)"
            guard !blockedAlbums.contains(source) else { continue }
            let name = album.localizedTitle ?? "未命名相册"
            let members = PHAsset.fetchAssets(in: album, options: options)
            var hashes = Set<String>()
            for position in 0..<members.count {
                let id = members.object(at: position).localIdentifier
                if sourceDeleted(nativeSourceKey(id)) { continue }
                guard let summary = summaries[id], summary.complete || summary.excluded else { unfinished = true; continue }
                for key in summary.keys {
                    if let receipt = receipts[key], receipt.deleted != true { hashes.insert(receipt.hash) }
                }
            }
            guard !hashes.isEmpty else { continue }
            let signature = SHA256.hash(data: Data((name + "\n" + hashes.sorted().joined(separator: "\n")).utf8)).map { String(format: "%02x", $0) }.joined()
            guard albumSignatures[source] != signature else { continue }
            do {
                status = "导入相册 · \(name)"
                var ids = Set<String>()
                var unresolved = false
                for hash in hashes.sorted() {
                    guard running && connected && !Task.isCancelled && uploadPauseReason == nil else { return }
                    let row: [String: Any]
                    if let known = states[hash] { row = known }
                    else { row = try await presence(hash); states[hash] = row }
                    let result = try applyServerState(hash: hash, row: row, checked: false, repairMissing: true)
                    if result == .trash || result == .deleted { continue }
                    if result != .present { unresolved = true; continue }
                    if row["trashed"] as? Bool == true { continue }
                    guard let id = row["assetId"] as? String, !id.isEmpty else { unresolved = true; continue }
                    ids.insert(id)
                }
                if unresolved { unfinished = true }
                let sorted = ids.sorted()
                for offset in stride(from: 0, to: sorted.count, by: 1000) {
                    _ = try await json("albums/import", body: ["sourceKey": source, "name": name, "assets": Array(sorted[offset..<min(offset + 1000, sorted.count)])])
                }
                if !unresolved { albumSignatures[source] = signature }
                removeIssues(resourceKey: source, stage: .album)
            } catch {
                if Task.isCancelled { return }
                recordIssue(key: source, name: name, stage: .album, error: error)
                if let error = error as? TransferError, error.code == "imported_album_deleted" { blockedAlbums.insert(source) }
                else { unfinished = true }
                if !(error is TransferError) || !connected { return }
            }
        }
        albumsDirty = unfinished
        saveState()
    }
    #if os(macOS)
    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            launchAtLogin = SMAppService.mainApp.status == .enabled
            loginItemStatus = SMAppService.mainApp.status == .requiresApproval ? "请在系统设置中批准 Aura 登录项" : ""
            removeIssues(resourceKey: "login-item")
        } catch {
            launchAtLogin = SMAppService.mainApp.status == .enabled
            recordIssue(key: "login-item", name: "登录时启动", stage: .settings, error: error)
        }
        saveState()
    }
    #endif
    nonisolated static func resourceName(_ type: PHAssetResourceType) -> String {
        switch type {
        case .photo: return "originalPhoto"
        case .video: return "originalVideo"
        case .pairedVideo: return "originalPairedVideo"
        case .fullSizePhoto: return "fullSizePhoto"
        case .fullSizeVideo: return "fullSizeVideo"
        case .fullSizePairedVideo: return "fullSizePairedVideo"
        case .adjustmentData: return "adjustmentData"
        case .alternatePhoto: return "alternatePhoto"
        default: return "resource-\(type.rawValue)"
        }
    }
}

final class ResourceExport: @unchecked Sendable {
    private let lock = NSLock()
    private let file: FileHandle
    private var requestID: PHAssetResourceDataRequestID?
    private var continuation: CheckedContinuation<Void, Error>?
    private var result: Result<Void, Error>?

    init(file url: URL) throws {
        guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw TransferError(message: "无法创建原件缓存，请检查可用空间")
        }
        file = try FileHandle(forWritingTo: url)
    }
    func write(resource: PHAssetResource, options: PHAssetResourceRequestOptions) async throws {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let result { lock.unlock(); continuation.resume(with: result); return }
            self.continuation = continuation
            lock.unlock()
            let identifier = PHAssetResourceManager.default().requestData(for: resource, options: options, dataReceivedHandler: { [self] data in
                receive(data)
            }, completionHandler: { [self] error in finish(error) })
            lock.lock(); requestID = identifier; let completed = result != nil; lock.unlock()
            if completed { PHAssetResourceManager.default().cancelDataRequest(identifier) }
        }
    }
    private func receive(_ data: Data) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        do { try file.write(contentsOf: data); lock.unlock() }
        catch { lock.unlock(); finish(error); cancel() }
    }
    private func finish(_ error: Error?) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        var failure = error
        if failure == nil { do { try file.synchronize() } catch { failure = error } }
        try? file.close()
        let value: Result<Void, Error> = failure.map { .failure($0) } ?? .success(())
        result = value
        let pending = continuation; continuation = nil
        lock.unlock()
        pending?.resume(with: value)
    }
    func cancel() {
        lock.lock(); let identifier = requestID; lock.unlock()
        finish(CancellationError())
        if let identifier { PHAssetResourceManager.default().cancelDataRequest(identifier) }
    }
}

final class TransferCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionTask?
    private var cancelled = false
    func bind(_ task: URLSessionTask) {
        lock.lock(); self.task = task; let stop = cancelled; lock.unlock()
        if stop { task.cancel() }
    }
    func cancel() {
        lock.lock(); cancelled = true; let task = task; lock.unlock()
        task?.cancel()
    }
}

final class BackgroundTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = BackgroundTransfer()
    private let lock = NSLock()
    private var pending: [String: CheckedContinuation<(Data, HTTPURLResponse), Error>] = [:]
    private var buffers: [String: Data] = [:]
    private var sessions: [String: URLSession] = [:]
    private var completions: [String: () -> Void] = [:]
    private func session(wifiOnly: Bool) -> URLSession {
        // A background session's policy is fixed; reconnect both identifiers after relaunch.
        let identifier = "app.aura.photos.upload" + (wifiOnly ? ".wifi" : "")
        lock.lock(); defer { lock.unlock() }
        if let existing = sessions[identifier] { return existing }
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.isDiscretionary = false
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpMaximumConnectionsPerHost = 2
        config.timeoutIntervalForResource = 24 * 60 * 60
        config.allowsCellularAccess = !wifiOnly
        #if os(iOS)
        config.sessionSendsLaunchEvents = true
        #endif
        let created = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        sessions[identifier] = created
        return created
    }
    func reconnect() { _ = session(wifiOnly: false); _ = session(wifiOnly: true) }
    func setCompletion(_ completion: @escaping () -> Void, identifier: String) {
        lock.lock(); completions[identifier] = completion; lock.unlock()
    }
    func activeFiles() async -> Set<String> {
        var paths = Set<String>()
        for wifiOnly in [false, true] {
            let session = session(wifiOnly: wifiOnly)
            let tasks: [URLSessionTask] = await withCheckedContinuation { continuation in
                session.getAllTasks { continuation.resume(returning: $0) }
            }
            paths.formUnion(tasks.compactMap(\.taskDescription))
        }
        return paths
    }
    private func key(_ session: URLSession, _ task: URLSessionTask) -> String {
        (session.configuration.identifier ?? "") + "|" + String(task.taskIdentifier)
    }
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock(); let completion = completions.removeValue(forKey: session.configuration.identifier ?? ""); lock.unlock()
        DispatchQueue.main.async { completion?() }
    }
    func upload(_ request: URLRequest, file: URL, wifiOnly: Bool) async throws -> (Data, HTTPURLResponse) {
        let cancellation = TransferCancellation()
        return try await withTaskCancellationHandler(operation: {
          try await withCheckedThrowingContinuation { continuation in
            var request = request
            request.allowsCellularAccess = !wifiOnly
            if let cookies = HTTPCookieStorage.shared.cookies(for: request.url!) {
                for (key, value) in HTTPCookie.requestHeaderFields(with: cookies) { request.setValue(value, forHTTPHeaderField: key) }
            }
            let session = session(wifiOnly: wifiOnly)
            let task = session.uploadTask(with: request, fromFile: file)
            task.taskDescription = file.path
            let id = key(session, task)
            lock.lock(); pending[id] = continuation; buffers[id] = Data(); lock.unlock()
            cancellation.bind(task)
            task.resume()
          }
        }, onCancel: { cancellation.cancel() })
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); defer { lock.unlock() }
        let id = key(session, dataTask)
        if (buffers[id]?.count ?? 0) < 1_048_576 { buffers[id, default: Data()].append(data) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let id = key(session, task)
        lock.lock(); let continuation = pending.removeValue(forKey: id); let data = buffers.removeValue(forKey: id) ?? Data(); lock.unlock()
        if let error { continuation?.resume(throwing: error) }
        else if let response = task.response as? HTTPURLResponse { continuation?.resume(returning: (data, response)) }
        else { continuation?.resume(throwing: TransferError(message: "上传响应无效")) }
        if continuation == nil, let path = task.taskDescription, URL(fileURLWithPath: path).lastPathComponent.hasPrefix("chunk-") { try? FileManager.default.removeItem(atPath: path) }
    }
}

#if os(iOS)
final class AuraAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        BackgroundTransfer.shared.setCompletion(completionHandler, identifier: identifier)
        BackgroundTransfer.shared.reconnect()
    }
}
#endif

struct AuraContent: View {
    @ObservedObject var model: AuraModel
    let olive = Color(red: 0.33, green: 0.40, blue: 0.27)
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack(spacing: 12) {
                    Image(systemName: "camera.aperture").font(.system(size: 32, weight: .light)).foregroundStyle(olive)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Aura").font(.system(size: 32, weight: .medium, design: .rounded))
                        Text("客户端 \(model.version)").font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.connected { Label("已连接", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(olive) }
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("服务器").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        TextField("https://服务器地址", text: $model.server).textFieldStyle(.roundedBorder).disabled(model.running || model.busy || model.verifying)
                        Button(model.connected ? "重新授权" : "连接") { model.connect() }.disabled(model.busy || model.verifying)
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 16) {
                    Text("拍摄日期").font(.headline)
                    DatePicker("开始", selection: $model.start, displayedComponents: .date).disabled(model.running)
                    Toggle("持续上传此日期之后的照片", isOn: $model.openEnd).disabled(model.running)
                    if !model.openEnd { DatePicker("结束", selection: $model.end, in: model.start..., displayedComponents: .date).disabled(model.running) }
                    if model.limited { Text("当前仅能读取系统允许的部分照片。若要自动发现所有新增照片，请在系统设置中允许完整访问。").font(.caption).foregroundStyle(.secondary) }
                }
                VStack(alignment: .leading, spacing: 12) {
                    Text("上传策略").font(.headline)
                    Toggle("仅使用 Wi-Fi 或有线网络", isOn: $model.wifiOnly).disabled(model.busy || model.verifying)
                    #if os(iOS)
                    Toggle("仅在充电时上传", isOn: $model.chargingOnly).disabled(model.busy || model.verifying)
                    #endif
                    Toggle("导入 Apple 自建相册", isOn: $model.importAlbums).disabled(model.busy || model.verifying)
                    if model.importAlbums {
                        Text("仅添加已备份项目；保留 Aura 中修改的名称，不跟随 Apple 删除照片或相册。").font(.caption).foregroundStyle(.secondary)
                        Button("更新相册关系") { model.refreshAlbums() }.disabled(!model.running || model.busy || model.verifying)
                    }
                    #if os(macOS)
                    Toggle("登录时启动 Aura", isOn: Binding(get: { model.launchAtLogin }, set: { model.setLaunchAtLogin($0) }))
                    if !model.loginItemStatus.isEmpty {
                        Text(model.loginItemStatus).font(.caption).foregroundStyle(.secondary)
                        Button("打开登录项设置") { SMAppService.openSystemSettingsLoginItems() }
                    }
                    #endif
                }
                HStack(spacing: 30) {
                    counter(model.matched, "范围内项目")
                    counter(model.completedAssets, "已备份项目")
                    counter(model.remainingAssets, "待备份项目")
                }.padding(.vertical, 5)
                if !model.summaryIsCurrent { Text("项目数量为上次扫描结果，开始上传或核对后刷新。").font(.caption2).foregroundStyle(.secondary) }
                Text("累计新传 \(model.uploaded) 个原件 · 已存在 \(model.duplicates) 个原件 · \(model.processingAssets) 个项目等待服务器处理").font(.caption).foregroundStyle(.secondary)
                if model.excludedAssets > 0 {
                    Text("已排除 \(model.excludedAssets) 个已删除项目，不计入待备份；最近删除可在 Aura 恢复，永久删除不会重新上传。").font(.caption).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 10) {
                    HStack { if model.busy { ProgressView().controlSize(.small) }; Text(model.status).font(.subheadline); Spacer() }
                    if !model.current.isEmpty { Text(model.current).font(.caption).foregroundStyle(.secondary).lineLimit(1); ProgressView(value: model.progress).tint(olive) }
                    HStack {
                        Button { model.running ? model.pauseUpload() : model.startUpload() } label: {
                            Label(model.running ? "暂停" : "开始持续上传", systemImage: model.running ? "pause.fill" : "arrow.up.circle.fill").frame(maxWidth: .infinity).padding(.vertical, 7)
                        }.buttonStyle(.borderedProminent).tint(olive).disabled(model.verifying || (model.busy && !model.running))
                        if model.connected, let url = model.origin?.appendingPathComponent("aura/") { Link(destination: url) { Image(systemName: "arrow.up.right.square").padding(9) }.buttonStyle(.bordered) }
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("服务器原件核对").font(.headline)
                    Button(model.verifying ? "停止核对" : "重新核对服务器") { model.verifyServer() }.disabled(!model.connected || model.busy)
                    if model.verifying { ProgressView(value: model.verificationProgress).tint(olive) }
                    Text(model.verificationStatus).font(.caption).foregroundStyle(.secondary)
                    if !model.lastVerified.isEmpty { Text("最近完成：\(displayDate(model.lastVerified))").font(.caption2).foregroundStyle(.secondary) }
                    Text("检查原件文件是否存在、大小是否匹配。仅补传未删除的缺失原件；不会恢复最近删除或永久删除，不执行完整哈希扫描。").font(.caption).foregroundStyle(.secondary)
                }
                if !model.errors.isEmpty {
                    DisclosureGroup("待处理记录 · \(model.errors.count)") {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(model.errors) { error in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("\(error.name) · \(error.stage.rawValue)").font(.caption).fontWeight(.medium)
                                    Text(error.message).font(.caption).foregroundStyle(.orange)
                                    Text(displayDate(error.occurredAt)).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            Button("重试待上传项目") { model.running ? model.rescan() : model.startUpload() }.disabled(model.busy || model.verifying)
                        }.padding(.top, 10)
                    }
                }
                if !model.lastScan.isEmpty { Text("最近扫描：\(displayDate(model.lastScan))").font(.caption2).foregroundStyle(.secondary) }
                Link("检查新版本与安装说明", destination: URL(string: "https://github.com/Crashmere/Aura/releases/latest")!).font(.caption)
                Text("原件、实况视频与编辑资源均直接读取，不重新压缩。首次读取 iCloud 原件可能需要等待下载。").font(.caption).foregroundStyle(.secondary).lineSpacing(4)
                #if os(iOS)
                Text("后台上传由 iOS 调度。首次大量导入时请保持应用打开；强制退出后，重新打开应用以继续。").font(.caption).foregroundStyle(.secondary).lineSpacing(4)
                #else
                Text("保持客户端运行即可监测新增照片；电脑休眠或网络中断后会继续补传。").font(.caption).foregroundStyle(.secondary).lineSpacing(4)
                #endif
            }.padding(30).frame(maxWidth: 520)
        }.background(Color(red: 0.97, green: 0.98, blue: 0.95)).tint(olive)
        .sheet(isPresented: $model.showLogin) {
            VStack(spacing: 0) {
                HStack { Text("门户设备授权").font(.headline); Spacer(); Button("完成") { Task { await model.loginFinished() } }; Button("关闭") { model.showLogin = false } }.padding()
                PortalView(model: model)
            }
            #if os(macOS)
            .frame(width: 620, height: 680)
            #endif
        }
    }
    func counter(_ count: Int, _ label: String) -> some View { VStack(alignment: .leading, spacing: 6) { Text("\(count)").font(.system(size: 24, weight: .light, design: .rounded)).monospacedDigit(); Text(label).font(.caption2).foregroundStyle(.secondary) } }
    func displayDate(_ value: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else { return value }
        return date.formatted(date: .numeric, time: .shortened)
    }
}

final class PortalNavigation: NSObject, WKNavigationDelegate {
    let model: AuraModel
    @MainActor init(_ model: AuraModel) { self.model = model }
    @MainActor func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { Task { await model.loginFinished() } }
    @MainActor func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        return url.host == model.origin?.host && ["https", "http"].contains(url.scheme ?? "") ? .allow : .cancel
    }
}
#if os(macOS)
struct PortalView: NSViewRepresentable {
    let model: AuraModel
    func makeCoordinator() -> PortalNavigation { PortalNavigation(model) }
    func makeNSView(context: Context) -> WKWebView { model.webView.navigationDelegate = context.coordinator; return model.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#else
struct PortalView: UIViewRepresentable {
    let model: AuraModel
    func makeCoordinator() -> PortalNavigation { PortalNavigation(model) }
    func makeUIView(context: Context) -> WKWebView { model.webView.navigationDelegate = context.coordinator; return model.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#endif

@main
struct AuraApplication: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AuraAppDelegate.self) private var delegate
    #endif
    @StateObject private var model = AuraModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup("Aura") { AuraContent(model: model)
            .onChange(of: scenePhase, initial: true) { _, phase in
                if phase == .active { Task { await model.restoreAuthorization() } }
                #if os(iOS)
                if phase == .background { model.scheduleBackground() }
                #endif
            }
            #if os(macOS)
            .frame(minWidth: 450, idealWidth: 490, maxWidth: 600, minHeight: 620)
            #endif
        }
        #if os(macOS)
        .windowResizability(.contentSize)
        #endif
    }
}
