import Foundation

@main struct StateTests {
    static func main() throws {
        func state(_ extra: String = "", stale: Bool = false, remaining: String = "45", gap: String = "-5", rate: String = "20", expired: Bool = false) throws -> UsageState {
            let json = """
            {"demo":false,"stale":\(stale),"error":null,"windows":[
              {"key":"codex:secondary","bucket":"codex","duration":604800000,"remaining":\(remaining),"resetsAt":1900000000000,"gap":\(gap),"plannedPerWorkday":\(rate),"staleWindow":\(expired)}\(extra)]}
            """
            return try JSONDecoder().decode(UsageState.self, from: Data(json.utf8))
        }
        func check(_ condition: Bool, _ label: String) { if !condition { fatalError(label) }; print("PASS \(label)") }
        let fast = try state()
        check(fast.weekly?.pace == 75, "fast use fills inner ring beyond halfway")
        check(try state(gap: "5").weekly?.pace == 25, "slow use below halfway")
        check(try state(rate: "0").weekly?.pace == nil, "no division by zero on rest days")
        check(try state(gap: "null").weekly?.pace == nil, "unknown pace remains unknown")
        check(try state(gap: "-100").weekly?.pace == 100, "pace clamps")
        check(try state(stale: true).invalid, "failed read invalidates cached value")
        check(try state(remaining: "null").invalid, "missing remaining is not zero")
        check(try state(expired: true).invalid, "expired reset is stale")
        check(fast.title == "周 45%", "remaining rather than used percentage")
        let short = try state(",{\"key\":\"codex:primary\",\"bucket\":\"codex\",\"duration\":18000000,\"remaining\":80}")
        check(short.short?.remaining == 80, "select lanes by duration")
        check(short.tooltip.contains("5小时剩余 80.0%"), "short window in tooltip")
        func speed(_ status: String = "generating", at: Double = 98000, checkedAt: Double = 100000, tps: Double = 23.5) throws -> SpeedSnapshot {
            let json = """
            {"checkedAt":\(checkedAt),"selected":{"session":"recent-session","model":"test","status":"\(status)","last":{"tps":\(tps),"at":\(at)}}}
            """
            return try JSONDecoder().decode(SpeedSnapshot.self, from: Data(json.utf8))
        }
        check(try speed().label(now: 100000) == "23.5 TPS", "recent response appears in menu bar")
        check(try speed("idle").label(now: 100000) == "23.5 TPS·闲", "idle sample is marked")
        check(try speed(checkedAt: 500000).label(now: 500000) == "23.5 TPS·旧", "old sample is marked")
        check(try speed().label(now: 100000, connected: false) == "— TPS", "disconnected speed is not current")
        check(try speed().label(now: 111000) == "— TPS", "stale collector is not current")
        check(try speed(tps: -1).label(now: 100000) == "— TPS", "invalid speed is rejected")
        let missing = try JSONDecoder().decode(SpeedSnapshot.self, from: Data("{\"selected\":null}".utf8))
        check(missing.label(now: 100000) == "— TPS", "no sample is not zero TPS")
        check(try speed().tooltip(now: 100000).contains("最近响应"), "tooltip explains response timing")
        func remoteSpeed(connected: Bool = true, checked: Double = 100000) throws -> SpeedSnapshot {
            let json = """
            {"checkedAt":100000,"selected":{"session":"remote-session","model":"test","status":"completed","source":{"kind":"ssh","label":"v100","connected":\(connected),"checkedAt":\(checked)},"last":{"tps":31.5,"at":99000}}}
            """
            return try JSONDecoder().decode(SpeedSnapshot.self, from: Data(json.utf8))
        }
        check(try remoteSpeed().label(now: 100000) == "31.5 TPS·SSH", "remote response is identified in menu bar")
        check(try remoteSpeed().tooltip(now: 100000).contains("v100"), "remote tooltip identifies the host")
        check(try remoteSpeed(connected: false).label(now: 100000) == "— TPS", "remote disconnect cannot be masked by healthy local server")
        check(try remoteSpeed(checked: 80000).label(now: 100000) == "— TPS", "stale remote heartbeat is not current TPS")
    }
}
