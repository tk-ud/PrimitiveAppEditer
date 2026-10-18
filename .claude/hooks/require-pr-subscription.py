#!/usr/bin/env python3
"""Stop hook: do not end a turn after creating a PR without subscribing to its activity.

Reads the session transcript; if the latest create_pull_request call has no later
subscribe_pr_activity (or merge_pull_request) call, block the stop once.
"""
import json
import sys

CREATE = "create_pull_request"
SUBSCRIBE = "subscribe_pr_activity"
DONE = ("merge_pull_request", "unsubscribe_pr_activity")


def main():
    data = json.load(sys.stdin)
    if data.get("stop_hook_active"):
        return
    path = data.get("transcript_path")
    if not path:
        return
    pending = False
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    msg = json.loads(line).get("message") or {}
                except ValueError:
                    continue
                content = msg.get("content")
                if msg.get("role") != "assistant" or not isinstance(content, list):
                    continue
                for block in content:
                    if block.get("type") != "tool_use":
                        continue
                    name = block.get("name", "")
                    if name.endswith(CREATE):
                        pending = True
                    elif name.endswith(SUBSCRIBE) or name.endswith(DONE):
                        pending = False
    except OSError:
        return
    if pending:
        print(json.dumps({
            "decision": "block",
            "reason": "PRを作成しましたが subscribe_pr_activity を呼んでいません。"
                      "終了前に作成したPRを購読し、コメント・CI・レビューの監視を開始してください。",
        }))


main()
