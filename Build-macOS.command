#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
NODE="${PLANNER_NODE:-$(command -v node || true)}"
if [[ -z "$NODE" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
    if [[ -x "$candidate" ]]; then NODE="$candidate"; break; fi
  done
fi
if [[ ! -x "$NODE" ]]; then echo '需要 Node.js 20+，可通过 PLANNER_NODE 指定路径。'; exit 1; fi
"$NODE" -e 'if (+process.versions.node.split(".")[0] < 20) process.exit(1)'
APP="$PWD/dist/Codex Usage Planner.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/server" "$PWD/.build/module-cache"
xcrun swiftc -O -target "$(uname -m)-apple-macosx13.0" -module-cache-path "$PWD/.build/module-cache" macos/UsageState.swift macos/main.swift -o "$APP/Contents/MacOS/CodexUsagePlanner" -framework AppKit -framework WebKit
cp ./*.mjs "$APP/Contents/Resources/server/"
cp -R public "$APP/Contents/Resources/server/"
cp "$NODE" "$APP/Contents/Resources/node"
# Keep the runtime license alongside the bundled executable when supplied by its distribution.
NODE_ROOT="$(dirname "$(dirname "$NODE")")"
if [[ -f "$NODE_ROOT/LICENSE" ]]; then cp "$NODE_ROOT/LICENSE" "$APP/Contents/Resources/Node-LICENSE"; fi
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.wheelbl.codex-usage-planner</string>
<key>CFBundleName</key><string>Codex Usage Planner</string>
<key>CFBundleExecutable</key><string>CodexUsagePlanner</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --deep --sign - "$APP"
echo "已构建：$APP"
