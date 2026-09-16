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
    }
}
