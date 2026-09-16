#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -d "dist/Codex Usage Planner.app" ]]; then ./Build-macOS.command; fi
open "dist/Codex Usage Planner.app" --args "$@"
