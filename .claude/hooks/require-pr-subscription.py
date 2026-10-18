#!/usr/bin/env python3
"""Stop hook: do not end a turn after creating a PR without subscribing to its activity.

Reads the session transcript; if the latest successful create_pull_request call has no
later subscribe_pr_activity (or merge_pull_request) call, block the stop once.
A create_pull_request whose tool_result is an error is not treated as pending, and
malformed stdin fails open (no output, exit 0).
"""
import json
import sys

CREATE = "create_pull_request"
SUBSCRIBE = "subscribe_pr_activity"
DONE = ("merge_pull_request", "unsubscribe_pr_activity")


def result_failed(block):
    if block.get("is_error"):
        return True
    content = block.get("content")
    if isinstance(content, list):
        content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
    if isinstance(content, str):
        head = content.lstrip().lower()
        return head.startswith(("error", "failed", "unprocessable", "missing required"))
    return False


def main():
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict) or data.get("stop_hook_active"):
            return
        path = data.get("transcript_path")
        if not path:
            return
    except Exception:
        return
    pending = False
    creates = set()
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    msg = json.loads(line).get("message") or {}
                    content = msg.get("content")
                    if not isinstance(content, list):
                        continue
                    for block in content:
                        if not isinstance(block, dict):
                            continue
                        kind = block.get("type")
                        if msg.get("role") == "assistant" and kind == "tool_use":
                            name = block.get("name", "")
                            if name.endswith(CREATE):
                                creates.add(block.get("id"))
                            elif name.endswith(SUBSCRIBE) or name.endswith(DONE):
                                pending = False
                        elif kind == "tool_result" and block.get("tool_use_id") in creates:
                            creates.discard(block.get("tool_use_id"))
                            if not result_failed(block):
                                pending = True
                except (ValueError, AttributeError):
                    continue
    except OSError:
        return
    if pending:
        print(json.dumps({
            "decision": "block",
            "reason": "PRを作成しましたが subscribe_pr_activity を呼んでいません。"
                      "終了前に作成したPRを購読し、コメント・CI・レビューの監視を開始してください。",
        }))


main()
