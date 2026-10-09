"""Read-only, bounded Codex log stream. Run over SSH stdin; install nothing.

Only response timing, token counts and session/model identifiers leave the host.
Conversation text, tool arguments, credentials and full log files are never sent.
"""
import json
import os
import re
import sys
import time

MAX_FILES = 24
MAX_ENTRIES = 20000
READ_BYTES = 2 * 1024 * 1024
MAX_LINE = 1024 * 1024


def emit(event):
    print(json.dumps(event, separators=(",", ":")), flush=True)


def fields(obj, names):
    return {k: obj[k] for k in names if k in obj}


def speed_record(row):
    if not isinstance(row, dict) or not isinstance(row.get("payload"), dict):
        return None
    kind, p = row.get("type"), row["payload"]
    if kind == "session_meta":
        out = fields(p, ("id", "session_id", "parent_thread_id"))
        if isinstance(p.get("source"), dict) and p["source"].get("subagent"):
            out["source"] = {"subagent": True}
    elif kind == "turn_context":
        out = fields(p, ("model", "effort", "turn_id"))
    elif kind == "response_item":
        out = fields(p, ("type", "role", "call_id"))
    elif kind == "token_usage_record":
        out = fields(p, ("response_id", "session_id", "turn_id"))
        out["usage"] = fields(p.get("usage") or {}, ("output_tokens", "reasoning_output_tokens"))
        out["thread_token_usage"] = fields(p.get("thread_token_usage") or {}, ("output_tokens",))
    elif kind == "event_msg" and p.get("type") in (
        "task_started", "task_complete", "turn_aborted", "task_aborted",
        "error", "stream_error", "user_message", "token_count",
    ):
        out = fields(p, ("type", "turn_id"))
        if p["type"] == "token_count":
            info = p.get("info") or {}
            out["info"] = {
                "last_token_usage": fields(info.get("last_token_usage") or {}, ("output_tokens", "reasoning_output_tokens")),
                "total_token_usage": fields(info.get("total_token_usage") or {}, ("output_tokens",)),
            }
    else:
        return None
    return {"type": kind, "timestamp": row.get("timestamp"), "payload": out}


class Collector:
    def __init__(self, home):
        self.root = os.path.join(home, "sessions")
        self.files = {}
        self.catalog = {}
        self.discovered = None
        self.truncated = False

    def discover(self):
        self.truncated = False
        found = {}
        count = 0

        def walk(directory, depth):
            nonlocal count
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        count += 1
                        if count > MAX_ENTRIES:
                            self.truncated = True
                            break
                        if entry.is_dir(follow_symlinks=False) and depth < 3 and re.fullmatch(r"\d{2,4}", entry.name):
                            walk(entry.path, depth + 1)
                        elif entry.is_file(follow_symlinks=False) and entry.name.endswith(".jsonl"):
                            try:
                                found[entry.path] = entry.stat(follow_symlinks=False).st_mtime_ns
                            except OSError:
                                pass
                        if self.truncated:
                            break
            except FileNotFoundError:
                pass
            except PermissionError:
                if depth == 0:
                    raise

        walk(self.root, 0)
        self.catalog = found
        self.discovered = time.monotonic()

    def record(self, file, raw):
        if len(raw) > MAX_LINE:
            emit({"type": "unreadable", "file": file, "reason": "oversized"})
            return
        try:
            row = speed_record(json.loads(raw))
            if row:
                emit({"type": "record", "file": file, "record": row})
        except (ValueError, TypeError, AttributeError):
            emit({"type": "unreadable", "file": file, "reason": "invalid_record"})

    def update(self):
        if self.discovered is None or time.monotonic() - self.discovered >= 5:
            self.discover()
        # Each covered file is checked every second; new/resumed files are
        # discovered across creation dates within approximately five seconds.
        for file in list(self.files):
            try:
                self.catalog[file] = os.stat(file).st_mtime_ns
            except OSError:
                self.catalog.pop(file, None)
        selected = sorted(self.catalog, key=self.catalog.get, reverse=True)[:MAX_FILES]
        for file in list(self.files):
            if file not in selected:
                del self.files[file]
                emit({"type": "drop", "file": os.path.relpath(file, self.root)})
        for file in selected:
            key = os.path.relpath(file, self.root)
            state = self.files.setdefault(file, {"identity": None, "offset": 0, "tail": b"", "skip": False})
            try:
                with open(file, "rb") as handle:
                    info = os.fstat(handle.fileno())
                    identity = (info.st_dev, info.st_ino)
                    if state["identity"] != identity or info.st_size < state["offset"]:
                        state.update(identity=identity, offset=0, tail=b"", skip=False)
                        emit({"type": "reset", "file": key})
                    if state["offset"] == 0 and info.st_size > READ_BYTES:
                        for raw in handle.read(65536).split(b"\n")[:-1]:
                            try:
                                if json.loads(raw).get("type") == "session_meta":
                                    self.record(key, raw)
                            except (ValueError, AttributeError):
                                pass
                        state["offset"] = info.st_size - READ_BYTES
                        state["skip"] = True
                    handle.seek(state["offset"])
                    chunk = handle.read(min(READ_BYTES, max(0, info.st_size - state["offset"])))
                    state["offset"] += len(chunk)
                    parts = (state["tail"] + chunk).split(b"\n")
                    state["tail"] = parts.pop()
                    for raw in parts:
                        if state["skip"]:
                            state["skip"] = False
                        else:
                            self.record(key, raw)
                    if len(state["tail"]) > MAX_LINE:
                        state["tail"] = b""
                        state["skip"] = True
                        emit({"type": "unreadable", "file": key, "reason": "oversized"})
            except OSError:
                emit({"type": "unreadable", "file": key, "reason": "file_unreadable"})
        emit({"type": "tick", "at": int(time.time() * 1000), "covered": len(selected), "truncated": self.truncated})


def main():
    # CODEX_HOME is taken from the remote process environment, never the client.
    home = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else os.environ.get("CODEX_HOME", "~/.codex")
    collector = Collector(os.path.expanduser(home))
    while True:
        started = time.monotonic()
        try:
            collector.update()
        except PermissionError:
            emit({"type": "error", "reason": "sessions_unreadable"})
            return
        time.sleep(max(0, 1 - (time.monotonic() - started)))


if __name__ == "__main__":
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
