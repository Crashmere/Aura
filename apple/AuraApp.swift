import SwiftUI
import Photos
import WebKit
import CryptoKit
#if os(iOS)
import BackgroundTasks
#endif

struct TransferError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor
final class AuraModel: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    @Published var server = UserDefaults.standard.string(forKey: "server") ?? ""
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
    @Published var uploaded = 0
    @Published var duplicates = 0
    @Published var errors: [String] = []
    @Published var limited = false
    let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    private var timer: Timer?
    private var scanTask: Task<Void, Never>?
    private var receipts = Set<String>()
    private let sourceID: String
    private let cache: URL
    private var receiptURL: URL { cache.appendingPathComponent("receipts.jsonl") }
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
                if let data = line.data(using: .utf8), let row = try? JSONSerialization.jsonObject(with: data) as? [String: String], let key = row["key"] { receipts.insert(key) }
            }
        }
        PHPhotoLibrary.shared().register(self)
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in Task { @MainActor in self?.rescan() } }
        #if os(iOS)
        BGTaskScheduler.shared.register(forTaskWithIdentifier: "app.aura.photos.refresh", using: nil) { [weak self] task in
            Task { @MainActor in
                guard let self, let task = task as? BGProcessingTask else { task.setTaskCompleted(success: false); return }
                task.expirationHandler = { Task { @MainActor in self.scanTask?.cancel() } }
                await self.restoreAuthorization()
                if self.connected && UserDefaults.standard.bool(forKey: "continuous") {
                    self.running = true
                    self.scanTask = Task { await self.scan() }
                    await self.scanTask?.value
                }
                self.scheduleBackground()
                task.setTaskCompleted(success: true)
            }
        }
        #endif
        Task { await restoreAuthorization() }
    }
    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor [weak self] in self?.rescan() }
    }
    func restoreAuthorization() async {
        guard origin != nil else { return }
        await copyCookies()
        do {
            _ = try await json("info"); connected = true; status = "已连接 Aura"
            let access = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            if UserDefaults.standard.bool(forKey: "continuous") && (access == .authorized || access == .limited) && !running {
                running = true; rescan()
            }
        } catch { connected = false }
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
        UserDefaults.standard.set(true, forKey: "continuous")
        scanTask = Task {
            let access = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            guard access == .authorized || access == .limited else { status = "请在系统设置中允许 Aura 访问照片"; return }
            limited = access == .limited
            running = true
            #if os(iOS)
            scheduleBackground()
            #endif
            await scan()
        }
    }
    func pauseUpload() {
        running = false
        UserDefaults.standard.set(false, forKey: "continuous")
        status = busy ? "当前分片完成后暂停" : "已暂停"
        #if os(iOS)
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: "app.aura.photos.refresh")
        #endif
    }
    func rescan() {
        guard running && !busy else { return }
        scanTask = Task { await scan() }
    }
    #if os(iOS)
    func scheduleBackground() {
        guard UserDefaults.standard.bool(forKey: "continuous") else { return }
        let request = BGProcessingTaskRequest(identifier: "app.aura.photos.refresh")
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
    #endif
    func scan() async {
        guard running && !busy && connected else { return }
        busy = true; errors = []
        #if os(macOS)
        let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "Uploading original photo resources")
        defer { ProcessInfo.processInfo.endActivity(activity) }
        #endif
        defer { busy = false; current = ""; progress = 0; status = running ? (errors.isEmpty ? "持续监测中" : "部分文件待重试") : "已暂停" }
        let options = PHFetchOptions()
        let begin = Calendar.current.startOfDay(for: start)
        if openEnd { options.predicate = NSPredicate(format: "creationDate >= %@", begin as NSDate) }
        else {
            let finish = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: end))!
            options.predicate = NSPredicate(format: "creationDate >= %@ AND creationDate < %@", begin as NSDate, finish as NSDate)
        }
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let assets = PHAsset.fetchAssets(with: options)
        matched = assets.count
        for index in 0..<assets.count {
            guard running && !Task.isCancelled else { break }
            let asset = assets.object(at: index)
            let resources = PHAssetResource.assetResources(for: asset)
            for resource in resources {
                guard running && !Task.isCancelled else { break }
                let key = "\(origin!.absoluteString)|\(asset.localIdentifier)|\(asset.modificationDate?.timeIntervalSince1970 ?? 0)|\(resource.type.rawValue)|\(resource.originalFilename)"
                if receipts.contains(key) { continue }
                do {
                    current = resource.originalFilename
                    status = "读取原件 · \(index + 1) / \(assets.count)"
                    progress = 0
                    let file = cache.appendingPathComponent(UUID().uuidString + "-" + resource.originalFilename)
                    defer { try? FileManager.default.removeItem(at: file) }
                    try await export(resource, to: file)
                    guard running && !Task.isCancelled else { break }
                    let checksum = try await Task.detached { try Self.checksum(file) }.value
                    let size = (try file.resourceValues(forKeys: [.fileSizeKey])).fileSize!
                    var hints: [String: Any] = ["hash": checksum, "name": resource.originalFilename, "size": size,
                        "sourceKey": "photokit:\(sourceID):\(asset.localIdentifier)", "resourceType": Self.resourceName(resource.type), "favorite": asset.isFavorite]
                    if let date = asset.creationDate { hints["capturedAt"] = ISO8601DateFormatter().string(from: date) }
                    if let date = asset.modificationDate { hints["modifiedAt"] = ISO8601DateFormatter().string(from: date) }
                    if let location = asset.location { hints["latitude"] = location.coordinate.latitude; hints["longitude"] = location.coordinate.longitude }
                    let result = try await transfer(file: file, hints: hints)
                    if result { duplicates += 1 } else { uploaded += 1 }
                    try remember(key: key, hash: checksum)
                } catch {
                    if Task.isCancelled || !running { break }
                    errors.append("\(resource.originalFilename)：\(error.localizedDescription)")
                    if errors.count > 20 { errors.removeFirst() }
                }
            }
        }
    }
    private func export(_ resource: PHAssetResource, to file: URL) async throws {
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        options.progressHandler = { [weak self] value in Task { @MainActor in self?.progress = value * 0.1 } }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: resource, toFile: file, options: options) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }
    private func transfer(file: URL, hints: [String: Any]) async throws -> Bool {
        let hash = hints["hash"] as! String, size = hints["size"] as! Int
        let prepared = try await json("uploads", body: hints)
        if prepared["complete"] as? Bool == true { return true }
        var offset = prepared["offset"] as? Int ?? 0
        let chunkSize = prepared["chunkSize"] as? Int ?? 8 * 1024 * 1024
        let input = try FileHandle(forReadingFrom: file)
        defer { try? input.close() }
        status = "上传原件"
        var failures = 0
        while offset < size {
            guard running && !Task.isCancelled else { throw CancellationError() }
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
                let (data, response) = try await BackgroundTransfer.shared.upload(request, file: chunk)
                let row = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
                if response.statusCode == 409, let received = row["offset"] as? Int { offset = received; continue }
                guard (200..<300).contains(response.statusCode), let received = row["offset"] as? Int else { throw TransferError(message: row["error"] as? String ?? "上传失败 (\(response.statusCode))") }
                offset = received; failures = 0
                progress = 0.1 + 0.9 * Double(offset) / Double(size)
            } catch {
                failures += 1
                if failures > 3 { throw error }
                try await Task.sleep(nanoseconds: UInt64(1 << failures) * 1_000_000_000)
                let current = try await json("uploads/" + hash)
                offset = current["offset"] as? Int ?? offset
            }
        }
        _ = try await json("uploads/" + hash + "/complete", body: [:])
        return false
    }
    func json(_ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let origin else { throw TransferError(message: "服务器地址无效") }
        var request = URLRequest(url: origin.appendingPathComponent("aura/api/" + path))
        request.timeoutInterval = 60
        if let body { request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        let row = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode), !row.isEmpty else {
            if (response as? HTTPURLResponse)?.statusCode == 401 { connected = false; running = false }
            throw TransferError(message: row["error"] as? String ?? "请重新完成门户授权")
        }
        return row
    }
    nonisolated static func checksum(_ file: URL) throws -> String {
        let input = try FileHandle(forReadingFrom: file); defer { try? input.close() }
        var hash = SHA256()
        while let data = try input.read(upToCount: 4 * 1024 * 1024), !data.isEmpty { hash.update(data: data) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func remember(key: String, hash: String) throws {
        var line = try JSONSerialization.data(withJSONObject: ["key": key, "hash": hash]); line.append(10)
        if !FileManager.default.fileExists(atPath: receiptURL.path) { FileManager.default.createFile(atPath: receiptURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let file = try FileHandle(forWritingTo: receiptURL); defer { try? file.close() }
        try file.seekToEnd(); try file.write(contentsOf: line); try file.synchronize()
        receipts.insert(key)
    }
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

final class BackgroundTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = BackgroundTransfer()
    private let lock = NSLock()
    private var pending: [Int: CheckedContinuation<(Data, HTTPURLResponse), Error>] = [:]
    private var buffers: [Int: Data] = [:]
    var eventsCompletion: (() -> Void)?
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: "app.aura.photos.upload")
        config.isDiscretionary = false
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpMaximumConnectionsPerHost = 2
        config.timeoutIntervalForResource = 24 * 60 * 60
        #if os(iOS)
        config.sessionSendsLaunchEvents = true
        #endif
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    func reconnect() { _ = session }
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { self.eventsCompletion?(); self.eventsCompletion = nil }
    }
    func upload(_ request: URLRequest, file: URL) async throws -> (Data, HTTPURLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            var request = request
            if let cookies = HTTPCookieStorage.shared.cookies(for: request.url!) {
                for (key, value) in HTTPCookie.requestHeaderFields(with: cookies) { request.setValue(value, forHTTPHeaderField: key) }
            }
            let task = session.uploadTask(with: request, fromFile: file)
            task.taskDescription = file.path
            lock.lock(); pending[task.taskIdentifier] = continuation; buffers[task.taskIdentifier] = Data(); lock.unlock()
            task.resume()
        }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); defer { lock.unlock() }
        if (buffers[dataTask.taskIdentifier]?.count ?? 0) < 1_048_576 { buffers[dataTask.taskIdentifier, default: Data()].append(data) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let continuation = pending.removeValue(forKey: task.taskIdentifier); let data = buffers.removeValue(forKey: task.taskIdentifier) ?? Data(); lock.unlock()
        if let error { continuation?.resume(throwing: error) }
        else if let response = task.response as? HTTPURLResponse { continuation?.resume(returning: (data, response)) }
        else { continuation?.resume(throwing: TransferError(message: "上传响应无效")) }
        if continuation == nil, let path = task.taskDescription, URL(fileURLWithPath: path).lastPathComponent.hasPrefix("chunk-") { try? FileManager.default.removeItem(atPath: path) }
    }
}

#if os(iOS)
final class AuraAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        BackgroundTransfer.shared.eventsCompletion = completionHandler
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
                    Text("Aura").font(.system(size: 32, weight: .medium, design: .rounded))
                    Spacer()
                    if model.connected { Label("已连接", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(olive) }
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("服务器").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        TextField("https://服务器地址", text: $model.server).textFieldStyle(.roundedBorder).disabled(model.running)
                        Button(model.connected ? "重新授权" : "连接") { model.connect() }.disabled(model.busy)
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
                HStack(spacing: 30) {
                    counter(model.matched, "范围内项目")
                    counter(model.uploaded, "已上传原件")
                    counter(model.duplicates, "重复原件")
                }.padding(.vertical, 5)
                VStack(alignment: .leading, spacing: 10) {
                    HStack { if model.busy { ProgressView().controlSize(.small) }; Text(model.status).font(.subheadline); Spacer() }
                    if !model.current.isEmpty { Text(model.current).font(.caption).foregroundStyle(.secondary).lineLimit(1); ProgressView(value: model.progress).tint(olive) }
                    HStack {
                        Button { model.running ? model.pauseUpload() : model.startUpload() } label: {
                            Label(model.running ? "暂停" : "开始持续上传", systemImage: model.running ? "pause.fill" : "arrow.up.circle.fill").frame(maxWidth: .infinity).padding(.vertical, 7)
                        }.buttonStyle(.borderedProminent).tint(olive).disabled(model.busy && !model.running)
                        if model.connected, let url = model.origin?.appendingPathComponent("aura/") { Link(destination: url) { Image(systemName: "arrow.up.right.square").padding(9) }.buttonStyle(.bordered) }
                    }
                }
                if !model.errors.isEmpty { VStack(alignment: .leading, spacing: 8) { ForEach(Array(model.errors.enumerated()), id: \.offset) { _, error in Text(error).font(.caption).foregroundStyle(.orange) }; Button("重试") { model.rescan() } } }
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
    var body: some Scene {
        WindowGroup("Aura") { AuraContent(model: model)
            #if os(macOS)
            .frame(minWidth: 450, idealWidth: 490, maxWidth: 600, minHeight: 620)
            #endif
        }
        #if os(macOS)
        .windowResizability(.contentSize)
        #endif
    }
}
