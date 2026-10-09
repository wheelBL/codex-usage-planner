import Foundation

struct SpeedSnapshot: Decodable {
    struct Session: Decodable {
        struct Source: Decodable { let label: String; let kind: String; let connected: Bool; let checkedAt: Double? }
        struct Response: Decodable { let tps: Double; let at: Double }
        let session: String
        let model: String?
        let status: String
        let last: Response?
        let source: Source?
    }
    let checkedAt: Double?
    let selected: Session?

    func label(now: Double, connected: Bool = true) -> String {
        if let source = selected?.source {
            guard source.connected, let at = source.checkedAt, now - at <= 10000, at <= now + 5000 else { return "— TPS" }
        }
        guard connected, selected?.source?.connected != false, let checkedAt, now - checkedAt <= 10000, checkedAt <= now + 5000,
              let sample = selected?.last, sample.tps.isFinite, sample.tps > 0,
              sample.at.isFinite, sample.at <= now + 5000 else { return "— TPS" }
        let value = String(format: "%.1f TPS", sample.tps) + (selected?.source?.kind == "ssh" ? "·SSH" : "")
        if now - sample.at > 300000 { return value + "·旧" }
        if selected?.status == "idle" { return value + "·闲" }
        if selected?.status == "unmeasurable" { return value + "·上次" }
        return value
    }

    func tooltip(now: Double, connected: Bool = true) -> String {
        guard label(now: now, connected: connected) != "— TPS", let selected, let last = selected.last else {
            return "最近会话 TPS 暂不可用；等待本机或 SSH 日志读数"
        }
        let time = Date(timeIntervalSince1970: last.at / 1000).formatted(date: .abbreviated, time: .standard)
        return "\(selected.source?.label ?? "本机") · 会话 \(selected.session.prefix(8)) · \(selected.model ?? "未知模型")\n最近响应 \(time) · \(label(now: now, connected: connected))\n包含首 token 等待，不是逐 token 解码速度；点击查看详情"
    }
}

struct UsageWindow: Decodable {
    let key: String
    let bucket: String
    let duration: Double?
    let remaining: Double?
    let resetsAt: Double?
    let gap: Double?
    let plannedPerWorkday: Double?
    let staleWindow: Bool?

    var pace: Double? {
        guard let gap, gap.isFinite, let rate = plannedPerWorkday, rate.isFinite, rate > 0 else { return nil }
        return min(100, max(0, 50 - 100 * gap / rate))
    }
}
struct UsageState: Decodable {
    struct Sample: Decodable { let at: Double }
    struct Reminder: Decodable { let id: String; let title: String; let body: String }
    let reminder: Reminder?
    let latest: Sample?
    let demo: Bool
    let stale: Bool
    let error: String?
    let validationWarning: String?
    let windows: [UsageWindow]
    var weekly: UsageWindow? { windows.first { $0.bucket == "codex" && $0.duration == 604800000 } }
    var short: UsageWindow? { windows.first { $0.bucket == "codex" && $0.duration == 18000000 } }
    var invalid: Bool { stale || weekly?.remaining == nil || weekly?.staleWindow == true }
    var title: String {
        if invalid { return demo ? "演示 !" : "Codex !" }
        return (demo ? "演示 " : "") + "周 \(Int(weekly!.remaining!))%"
    }
    var tooltip: String {
        if invalid { return "Codex · " + (validationWarning ?? error ?? "数据过期或周额度不可用，点击查看详情") }
        var text = String(format: "Codex · 周剩余 %.1f%%", weekly!.remaining!)
        if let value = short?.remaining { text += String(format: " · 5小时剩余 %.1f%%", value) }
        if let gap = weekly?.gap { text += String(format: "\n实际 − 计划 %+.1f 点", gap) }
        if let reset = weekly?.resetsAt {
            text += "\n周重置 " + Date(timeIntervalSince1970: reset / 1000).formatted(date: .abbreviated, time: .shortened)
        }
        if let at = latest?.at { text += "\n更新于 " + Date(timeIntervalSince1970: at / 1000).formatted(date: .omitted, time: .standard) }
        return text
    }
}
