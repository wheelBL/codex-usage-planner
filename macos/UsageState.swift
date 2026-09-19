import Foundation

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
    let latest: Sample?
    let demo: Bool
    let stale: Bool
    let error: String?
    let windows: [UsageWindow]
    var weekly: UsageWindow? { windows.first { $0.bucket == "codex" && $0.duration == 604800000 } }
    var short: UsageWindow? { windows.first { $0.bucket == "codex" && $0.duration == 18000000 } }
    var invalid: Bool { stale || weekly?.remaining == nil || weekly?.staleWindow == true }
    var title: String {
        if invalid { return demo ? "演示 !" : "Codex !" }
        return (demo ? "演示 " : "") + "周 \(Int(weekly!.remaining!))%"
    }
    var tooltip: String {
        if invalid { return "Codex · " + (error ?? "数据过期或周额度不可用，点击查看详情") }
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
