#!/usr/bin/env python3
"""Fermi narrator — tails an executor's stream-json run log and posts a
templated one-line progress update per meaningful tool action to the task's
channel, via the worker's /admin/narrate endpoint (ephemeral, unlogged).

Usage: narrator.py <run-log-path>

Best-effort: any failure here must never affect the executor. Exits when the
run emits its final `result` event or the log stops growing.
"""
import json
import os
import subprocess
import sys
import time

DAEMON_HOME = os.path.expanduser("~/fermi-daemon")
POST_MIN_INTERVAL = 4.0  # seconds between posts per chat (respect Discord 5/5s)
IDLE_EXIT_SECONDS = 30   # give up if the log stops growing this long

# Tool name -> (emoji, verb, which input field to show)
TOOL_MAP = {
    "Read": ("📖", "Reading", "file_path"),
    "fs_read": ("📖", "Reading", "path"),
    "mac_file_read": ("📖", "Reading", "path"),
    "Write": ("✏️", "Writing", "file_path"),
    "Edit": ("✏️", "Editing", "file_path"),
    "fs_write": ("✏️", "Writing", "path"),
    "mac_file_write": ("✏️", "Writing", "path"),
    "Bash": ("⚙️", "Running", "command"),
    "execute": ("⚙️", "Running", "command"),
    "mac_shell": ("⚙️", "Running", "command"),
    "Grep": ("🔎", "Searching", "pattern"),
    "Glob": ("🔎", "Searching", "pattern"),
    "search": ("🔎", "Searching", "query"),
    "session_search": ("🔎", "Searching history", "query"),
    "WebFetch": ("🌐", "Fetching", "url"),
    "fetch_url": ("🌐", "Fetching", "url"),
    "browser_navigate": ("🌐", "Browsing", "url"),
    "browser_action": ("🌐", "Browsing", "url"),
    "mac_browser_action": ("🌐", "Browsing", "url"),
    "skill_search": ("📚", "Finding a skill for", "query"),
    "skill_load": ("📚", "Loading skill", "slug"),
}
# Control/own-output tools we never narrate.
SKIP = {
    "task_claim", "task_complete", "task_list", "task_enqueue",
    "context_bootstrap", "conversation_history", "channel_send",
    "memory_write", "memory_recall", "memory_update", "memory_list_recent",
    "profile_update",
    # Deferred-tool loading & introspection — pure plumbing, not user-meaningful.
    "ToolSearch", "meta_list_capabilities",
}


def load_env():
    cfg = {}
    try:
        with open(os.path.join(DAEMON_HOME, ".env")) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip()
    except OSError:
        pass
    return cfg


import re

# Redact anything secret-shaped before it reaches a chat message: quoted values
# assigned to KEY/TOKEN/SECRET/PASSWORD-ish names, bearer headers, and known
# API-key prefixes (Google AIza…, OpenAI sk-…, GitHub ghp_…, Slack xox…).
# Each pattern keeps group 1 (the identifying prefix) and redacts the rest.
_SECRET_PATTERNS = [
    re.compile(r"((?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH)[A-Z_]*\s*=\s*)['\"]?[^'\"\s;&|]+['\"]?", re.I),
    re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]+", re.I),
    re.compile(r"()AIza[0-9A-Za-z_\-]{30,}"),
    re.compile(r"()sk-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"()ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"()xox[a-z]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"([?&](?:key|token|api_key|apikey|access_token)=)[^&\s'\"]+", re.I),
]


def redact(text):
    for pat in _SECRET_PATTERNS:
        text = pat.sub(lambda m: m.group(1) + "«redacted»", text)
    return text


def bare_tool_name(name):
    # mcp__claude_ai_Fermi__skill_load -> skill_load
    return name.rsplit("__", 1)[-1] if "__" in name else name


def describe(name, tool_input):
    tool = bare_tool_name(name)
    if tool in SKIP:
        return None
    spec = TOOL_MAP.get(tool)
    if spec:
        emoji, verb, field = spec
        val = ""
        if isinstance(tool_input, dict):
            val = str(tool_input.get(field, "") or "")
        val = redact(val.replace("\n", " ").strip())
        if len(val) > 70:
            val = val[:67] + "…"
        # shorten file paths to basename-ish
        if field in ("file_path", "path") and "/" in val:
            val = ".../" + val.rsplit("/", 2)[-1] if val.count("/") > 1 else val
        return f"{emoji} {verb} `{val}`" if val else f"{emoji} {verb}"
    # generic MCP / unknown tool
    return f"🔧 {tool.replace('_', ' ')}"


def main():
    if len(sys.argv) < 2:
        return
    log_path = sys.argv[1]
    if not os.path.isabs(log_path):
        log_path = os.path.join(DAEMON_HOME, log_path)
    cfg = load_env()
    url = cfg.get("FERMI_URL")
    token = cfg.get("FERMI_BEARER_TOKEN")
    if not url or not token:
        return
    narrate_url = url.rstrip("/") + "/admin/narrate"

    channel = None
    chat_id = None
    last_post = 0.0
    last_growth = time.time()

    def post(text):
        nonlocal last_post
        if not channel or not chat_id:
            return
        now = time.time()
        if now - last_post < POST_MIN_INTERVAL:
            return  # throttle: drop rapid-fire (coalescing is implicit)
        # POST via curl — the python.org Python's urllib has no CA certs on this
        # Mac (CERTIFICATE_VERIFY_FAILED); curl uses the system trust store.
        try:
            body = json.dumps({"channel": channel, "chat_id": chat_id, "text": text})
            subprocess.run(
                [
                    "curl", "-s", "-m", "8", "-X", "POST", narrate_url,
                    "-H", "content-type: application/json",
                    "-H", f"authorization: Bearer {token}",
                    "-d", body,
                ],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            )
            last_post = now
        except Exception:
            pass  # best-effort

    # Wait for the log to exist
    for _ in range(30):
        if os.path.exists(log_path):
            break
        time.sleep(1)
    else:
        return

    with open(log_path) as f:
        while True:
            line = f.readline()
            if not line:
                if time.time() - last_growth > IDLE_EXIT_SECONDS:
                    return
                time.sleep(0.4)
                continue
            last_growth = time.time()
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                evt = json.loads(line)
            except ValueError:
                continue
            etype = evt.get("type")
            if etype == "result":
                return  # run finished
            # Learn chat context from task_claim results (in tool_result content)
            if etype == "user":
                for block in _content_blocks(evt.get("message", {})):
                    if block.get("type") == "tool_result":
                        ctx = _extract_chat(block)
                        if ctx:
                            channel, chat_id = ctx
                continue
            if etype == "assistant":
                for block in _content_blocks(evt.get("message", {})):
                    if block.get("type") == "tool_use":
                        text = describe(block.get("name", ""), block.get("input", {}))
                        if text:
                            post(text)


def _content_blocks(message):
    content = message.get("content")
    if isinstance(content, list):
        return content
    return []


def _extract_chat(tool_result_block):
    # tool_result content can be a string or list of {type:text,text:...}
    content = tool_result_block.get("content")
    raw = ""
    if isinstance(content, str):
        raw = content
    elif isinstance(content, list):
        raw = " ".join(b.get("text", "") for b in content if isinstance(b, dict))
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if isinstance(tasks, list) and tasks:
        t = tasks[0]
        ch, cid = t.get("channel"), t.get("chat_id")
        if ch and cid:
            return (ch, str(cid))
    return None


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # narrator must never crash loudly
