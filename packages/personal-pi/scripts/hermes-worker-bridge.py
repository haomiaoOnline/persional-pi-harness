#!/usr/bin/env python3
"""Fixed synthetic Hermes probe for the Personal PI Worker adapter.

This bridge is intentionally not a general prompt forwarder. It accepts no
stdin and sends only the constant probe prompt below. The TypeScript adapter
adds the matching synthetic Task Contract guard before invoking it.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit


SYNTHETIC_PROBE_PROMPT = (
    "PPH_SYNTHETIC_HERMES_PROBE_v1\n"
    "Return exactly one JSON object and no Markdown. Use this exact object: "
    '{"status":"success","summary":"PPH_HERMES_PROBE_OK",'
    '"changed_files":[],"artifacts":[],"evidence":[],"errors":[],'
    '"work_receipt":{"work_attempted":true,"effects_count":0,'
    '"artifacts_created":[],"state_changed":false,"no_op":true,'
    '"no_op_reason":"synthetic identity probe","evidence_refs":[]}}'
)
EXPECTED_PROVIDER = "custom"
EXPECTED_MODEL = "ArkCoding/deepseek-v4-flash-ga-260731"


def _safe_string(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _safe_host(value: object) -> str | None:
    raw = _safe_string(value)
    if not raw:
        return None
    try:
        return urlsplit(raw).hostname
    except Exception:
        return None


def _safe_usage(value: object) -> dict[str, int | float] | None:
    if not isinstance(value, dict):
        return None
    aliases = {
        "input_tokens": ("input_tokens", "prompt_tokens"),
        "output_tokens": ("output_tokens", "completion_tokens"),
        "total_tokens": ("total_tokens",),
        "cost_usd": ("cost_usd",),
    }
    usage: dict[str, int | float] = {}
    for target, keys in aliases.items():
        for key in keys:
            raw = value.get(key)
            if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                usage[target] = raw
                break
    return usage or None


def _response_id(response: object, *names: str) -> str | None:
    for name in names:
        value = _safe_string(getattr(response, name, None))
        if value:
            return value
    return None


def _first_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (tuple, list)):
        for item in value:
            text = _first_text(item)
            if text:
                return text
        return ""
    if isinstance(value, dict):
        for key in ("text", "content", "output_text", "response"):
            text = _first_text(value.get(key))
            if text:
                return text
    return ""


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _cli_version(command: str) -> str | None:
    try:
        completed = subprocess.run(
            [command, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None
    for stream in (completed.stdout, completed.stderr):
        line = next((line.strip() for line in stream.splitlines() if line.strip()), None)
        if line:
            return line[:256]
    return None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _main() -> int:
    if len(sys.argv) != 9:
        print(json.dumps({"type": "hermes.error", "error_type": "invalid_bridge_arguments"}))
        return 1
    try:
        values = dict(zip(sys.argv[1::2], sys.argv[2::2], strict=True))
    except (TypeError, ValueError):
        print(json.dumps({"type": "hermes.error", "error_type": "invalid_bridge_arguments"}))
        return 1
    required = {"--hermes-command", "--provider", "--model", "--pph-run-id"}
    if set(values) != required or not all(values.values()):
        print(json.dumps({"type": "hermes.error", "error_type": "invalid_bridge_arguments"}))
        return 1

    hermes_command = values["--hermes-command"]
    provider = values["--provider"]
    model = values["--model"]
    pph_run_id = values["--pph-run-id"]
    if provider != EXPECTED_PROVIDER or model != EXPECTED_MODEL:
        print(json.dumps({"type": "hermes.error", "error_type": "unsupported_probe_route"}))
        return 1
    identity_events: list[dict[str, object]] = []
    started_at = _utc_now()
    stage = "import"

    try:
        from hermes_cli import plugins
        from hermes_cli.oneshot import _run_agent

        stage = "register_hooks"
        manager = plugins.get_plugin_manager()
        manifest = plugins.PluginManifest(
            name="pph-hermes-worker-observer",
            version="1",
            description="Personal PI same-run runtime identity observer",
            source="entrypoint",
            kind="standalone",
            key="pph-hermes-worker-observer",
        )
        context = plugins.PluginContext(manifest, manager)

        def on_pre_api_request(**kwargs: object) -> None:
            del kwargs

        def on_post_api_request(**kwargs: object) -> None:
            response = kwargs.get("response")
            identity_events.append(
                {
                    "type": "hermes.identity",
                    "identity": {
                        "pph_run_id": pph_run_id,
                        "hermes_session_id": _safe_string(kwargs.get("session_id")),
                        "hermes_task_id": _safe_string(kwargs.get("task_id")),
                        "api_call_count": kwargs.get("api_call_count")
                        if isinstance(kwargs.get("api_call_count"), (int, float))
                        else 0,
                        "started_at": _safe_string(kwargs.get("started_at")) or started_at,
                        "ended_at": _safe_string(kwargs.get("ended_at")) or _utc_now(),
                        "api_duration": kwargs.get("api_duration")
                        if isinstance(kwargs.get("api_duration"), (int, float))
                        else None,
                        "provider": _safe_string(kwargs.get("provider")),
                        "configured_model": _safe_string(kwargs.get("model")),
                        # Hermes fills this from response.model on the actual
                        # response, so it is response-side runtime evidence.
                        "response_model": _safe_string(kwargs.get("response_model")),
                        "api_mode": _safe_string(kwargs.get("api_mode")),
                        "base_url_host": _safe_host(kwargs.get("base_url")),
                        "response_id": _response_id(response, "id"),
                        "request_id": _response_id(response, "_request_id", "request_id"),
                        "finish_reason": _safe_string(kwargs.get("finish_reason")),
                        "usage": _safe_usage(kwargs.get("usage")),
                        "cli_path": os.path.realpath(hermes_command),
                        "cli_version": _cli_version(hermes_command),
                        "identity_source": "post_api_request.response_model",
                        "source_event": "post_api_request",
                    },
                }
            )

        def block_tool_call(**kwargs: object) -> dict[str, str]:
            del kwargs
            return {
                "action": "block",
                "message": "PPH Hermes Worker has no Task Contract tool bridge",
            }

        context.register_hook("pre_api_request", on_pre_api_request)
        context.register_hook("post_api_request", on_post_api_request)
        context.register_hook("pre_tool_call", block_tool_call)
        plugins.set_thread_tool_whitelist(set())

        stage = "run_agent"
        os.environ["HERMES_YOLO_MODE"] = "1"
        os.environ["HERMES_ACCEPT_HOOKS"] = "1"
        os.environ["HERMES_INTERACTIVE"] = "0"
        with open(os.devnull, "w", encoding="utf-8") as sink:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                raw_result = _run_agent(
                    SYNTHETIC_PROBE_PROMPT,
                    model=model,
                    # v0.18.2 resolves this local custom route from its
                    # configured direct alias when provider is omitted. The
                    # observed provider is still checked against this
                    # expected value in the post_api_request event.
                    provider=None,
                    toolsets=[],
                    use_config_toolsets=False,
                )

        result_text = _first_text(raw_result)
        for event in identity_events:
            print(json.dumps(event, ensure_ascii=False, separators=(",", ":")))
        print(
            json.dumps(
                {
                    "type": "hermes.result",
                    "text": result_text,
                    "result_digest": _sha256_text(result_text),
                    "prompt_response_captured": False,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 0
    except Exception as error:
        print(
            json.dumps(
                {
                    "type": "hermes.error",
                    "error_type": type(error).__name__,
                    "stage": stage,
                    "prompt_response_captured": False,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 1
    finally:
        plugins.clear_thread_tool_whitelist() if "plugins" in locals() else None


if __name__ == "__main__":
    raise SystemExit(_main())
