"""
LLM Agent — Natural-Language Q&A Engine

Provides ``ask_data()`` which:
1. Constructs a prompt describing the table schema and sample data.
2. Calls an OpenAI-compatible chat-completions API (pluggable credentials).
3. Returns the LLM's natural-language answer.

No code generation, no exec(), no chart rendering — pure NL answers.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def ask_data(
    query: str,
    schema: dict[str, Any],
    api_credentials: dict[str, str],
) -> dict[str, Any]:
    """Answer a natural-language question about the uploaded table.

    The LLM receives only the table schema (column names, types, stats,
    and a few sample rows) — **not** the full dataset.  It responds in
    plain natural language.

    Args:
        query:            User's natural-language question.
        schema:           Schema dict as returned by ``process_dataframe()``
                          (includes sample_data).
        api_credentials:  ``{api_key, base_url, model_name}`` — passed from
                          the frontend; never stored server-side.

    Returns:
        ``{"answer": str}`` — the LLM's plain-text reply.
    """
    system_prompt = _build_prompt(schema)
    raw_answer = _call_llm(system_prompt, query, api_credentials)
    return {"answer": raw_answer.strip()}


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT_TEMPLATE = """\
你是一个专业的数据分析助手。用户上传了一个表格，下面是该表格的结构摘要。

## 表格基本信息
- 文件名: {filename}
- 总行数: {total_rows}
- 总列数: {total_columns}

## 字段详情
{columns_desc}

## 样本数据（前 3 行）
{sample_data}

## 回答要求
1. 用**自然语言**直接回答用户的问题，不要生成代码、图表或 JSON。
2. 回答要简洁、有数据支撑。引用具体列名和可能的数值范围。
3. 如果需要做统计，可以根据样本数据和字段统计量（min/max/mean 等）给出合理推断。
4. 不要说"根据样本数据"或"我只能看到前3行"——直接给出有用的分析结论。
5. 用中文回答。
"""


def _build_prompt(schema: dict[str, Any]) -> str:
    """Render the system prompt with schema metadata and sample rows."""
    columns_desc_lines: list[str] = []
    for col in schema["columns"]:
        extra = ""
        if col["missing_rate"] > 0:
            extra = f"  [缺失率 {col['missing_rate']:.1%}]"
        stats = col.get("stats", {})
        top_info = ""
        if "top_values" in stats:
            top_items = list(stats["top_values"].items())[:3]
            top_info = f"  常见值: {top_items}"
        columns_desc_lines.append(
            f"  - {col['name']} ({col['dtype']}){extra}{top_info}"
        )

    # Format sample rows
    sample_rows = schema.get("sample_data", [])
    sample_str = json.dumps(sample_rows, ensure_ascii=False, indent=2) if sample_rows else "(无样本)"

    return _SYSTEM_PROMPT_TEMPLATE.format(
        filename=schema.get("filename", "unknown"),
        total_rows=schema["total_rows"],
        total_columns=schema["total_columns"],
        columns_desc="\n".join(columns_desc_lines),
        sample_data=sample_str,
    )


# ---------------------------------------------------------------------------
# LLM API call (OpenAI-compatible)
# ---------------------------------------------------------------------------

def _call_llm(
    system_prompt: str,
    user_query: str,
    credentials: dict[str, str],
    timeout: int = 30,
) -> str:
    """Send a chat-completions request to the configured LLM endpoint.

    Uses the OpenAI-compatible ``/chat/completions`` API.  All credentials
    are received from the frontend on each request — nothing is persisted.
    """
    api_key = credentials.get("api_key", "").strip()
    base_url = credentials.get("base_url", "").strip().rstrip("/")
    model_name = credentials.get("model_name", "").strip()

    if not api_key or not base_url or not model_name:
        raise ValueError("缺少 LLM 配置（API Key / Base URL / Model Name），请在左侧面板填写。")

    url = f"{base_url}/chat/completions"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_query},
        ],
        "temperature": 0.3,
        "max_tokens": 1024,
    }

    try:
        import httpx

        try:
            resp = httpx.post(url, headers=headers, json=payload, timeout=timeout)
        except httpx.HTTPError as exc:
            raise ValueError(f"LLM 网络请求失败: {exc}") from exc

        if resp.status_code != 200:
            detail = resp.text[:500]
            raise ValueError(f"LLM API 返回错误 {resp.status_code}: {detail}")

        data = resp.json()

    except ImportError:
        import requests as req

        try:
            resp = req.post(url, headers=headers, json=payload, timeout=timeout)
        except req.RequestException as exc:
            raise ValueError(f"LLM 网络请求失败: {exc}") from exc

        if resp.status_code != 200:
            detail = resp.text[:500]
            raise ValueError(f"LLM API 返回错误 {resp.status_code}: {detail}")

        data = resp.json()

    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        logger.warning("Unexpected LLM response shape: %s", str(data)[:300])
        raise ValueError(f"LLM 返回了非预期的数据结构: {exc}") from exc
