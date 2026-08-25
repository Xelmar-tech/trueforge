"""
Stream one turn against content-builder with Python requests.

  pip install requests
  python api/python_requests.py

Env: TRUEFORGE_URL, TRUEFORGE_TOKEN (optional), TRUEFORGE_AGENT, TRUEFORGE_PROMPT
"""

import json
import os
import sys

import requests

BASE_URL = os.environ.get("TRUEFORGE_URL", "http://localhost:8790").rstrip("/")
TOKEN = os.environ.get("TRUEFORGE_TOKEN")
AGENT_NAME = os.environ.get("TRUEFORGE_AGENT", "content-builder")
PROMPT = os.environ.get(
    "TRUEFORGE_PROMPT",
    "Write a 600-word article for engineering leaders on why agent harnesses matter in production. "
    "Research the topic first and cite sources.",
)


def headers() -> dict[str, str]:
    h = {"content-type": "application/json"}
    if TOKEN:
        h["authorization"] = f"Bearer {TOKEN}"
    return h


def create_session() -> str:
    response = requests.post(
        f"{BASE_URL}/api/v1/sessions",
        headers=headers(),
        json={"agent": {"name": AGENT_NAME}},
        timeout=60,
    )
    if not response.ok:
        raise RuntimeError(f"create session failed ({response.status_code}): {response.text}")
    return response.json()["data"]["id"]


def stream_turn(session_id: str) -> None:
    response = requests.post(
        f"{BASE_URL}/api/v1/sessions/{session_id}/turns",
        headers=headers(),
        json={"input": [{"type": "user.message", "content": PROMPT}]},
        stream=True,
        timeout=600,
    )
    if not response.ok:
        raise RuntimeError(f"create turn failed ({response.status_code}): {response.text}")

    buffer = ""
    for chunk in response.iter_content(chunk_size=None, decode_unicode=True):
        if not chunk:
            continue
        buffer += chunk
        while "\n\n" in buffer:
            block, buffer = buffer.split("\n\n", 1)
            data_line = next((line for line in block.split("\n") if line.startswith("data:")), None)
            if not data_line:
                continue
            payload = data_line[len("data:"):].strip()
            if not payload:
                continue
            event = json.loads(payload)
            if event.get("type") == "model.message.delta" and event.get("thread_id") == "main":
                sys.stdout.write(event.get("content") or "")
                sys.stdout.flush()
            if event.get("type") == "turn.done":
                print("\n\nstatus:", event.get("state", {}).get("status"))


def main() -> None:
    session_id = create_session()
    print(f"session: {session_id}")
    stream_turn(session_id)


if __name__ == "__main__":
    main()
