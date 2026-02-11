#!/usr/bin/env python3
"""
Raw HTML Agent — baseline for DOMShell interface comparison experiment.

Uses requests + BeautifulSoup to fetch and parse web pages, with the same
LLM loop and function-call extraction as the DOMShell agent (agent.py).

This agent exposes two tools:
  1. fetch_page(url) — GET the page, strip scripts/styles, return cleaned text
  2. extract(selector) — CSS selector on the last fetched page

Prerequisites:
    1. nexa serve or Ollama running (OpenAI-compatible /v1/chat/completions)
    2. pip install requests beautifulsoup4

Usage:
    python raw_html_agent.py --task "Open wikipedia.org/wiki/AI and extract the first paragraph" \
        --endpoint http://127.0.0.1:18181/v1 --model qwen3-4b --verbose
"""

import argparse
import json
import re
import urllib.request
import urllib.error
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Missing dependencies. Install with: pip install requests beautifulsoup4")
    raise SystemExit(1)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_ENDPOINT = "http://127.0.0.1:18181/v1"
DEFAULT_MAX_TURNS = 10
MAX_TEXT_CHARS = 4000  # Cap fetched page text to avoid context overflow

# ---------------------------------------------------------------------------
# HTML tools — the "raw HTML" side of the experiment
# ---------------------------------------------------------------------------

# Holds the last fetched page so extract() can query it
_last_page: Optional[BeautifulSoup] = None
_last_url: str = ""


def tool_fetch_page(url: str) -> str:
    """Fetch a web page and return cleaned text content."""
    global _last_page, _last_url

    if not url.startswith("http"):
        url = "https://" + url

    try:
        resp = requests.get(url, timeout=15, headers={
            "User-Agent": "Mozilla/5.0 (DOMShell raw-html-agent)"
        })
        resp.raise_for_status()
    except Exception as e:
        return f"Error fetching {url}: {e}"

    soup = BeautifulSoup(resp.text, "html.parser")

    # Remove scripts, styles, and hidden elements
    for tag in soup(["script", "style", "noscript", "meta", "link"]):
        tag.decompose()

    _last_page = soup
    _last_url = url

    # Return cleaned text, truncated to avoid context overflow
    text = soup.get_text(separator="\n", strip=True)
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS] + f"\n\n... (truncated at {MAX_TEXT_CHARS} chars)"

    return f"Fetched: {url}\n\n{text}"


def tool_extract(selector: str) -> str:
    """Run a CSS selector on the last fetched page and return matching text."""
    if _last_page is None:
        return "Error: no page fetched yet. Call fetch_page first."

    try:
        elements = _last_page.select(selector)
    except Exception as e:
        return f"Error with selector '{selector}': {e}"

    if not elements:
        return f"No elements matched selector: {selector}"

    results = []
    for el in elements[:20]:  # Limit to 20 matches
        text = el.get_text(separator=" ", strip=True)
        # Include href for links
        if el.name == "a" and el.get("href"):
            results.append(f"{text} [{el['href']}]")
        else:
            results.append(text)

    output = "\n".join(results)
    if len(output) > MAX_TEXT_CHARS:
        output = output[:MAX_TEXT_CHARS] + "\n... (truncated)"
    return output


# Tool registry
TOOLS = {
    "fetch_page": {
        "func": tool_fetch_page,
        "description": "Fetch a web page and return its cleaned text content (scripts/styles removed, max 4K chars).",
        "parameters": {
            "url": {"type": "string", "description": "The URL to fetch (e.g. https://en.wikipedia.org/wiki/AI)"}
        },
        "required": ["url"],
    },
    "extract": {
        "func": tool_extract,
        "description": "Run a CSS selector on the last fetched page. Returns text of matching elements (max 20 matches).",
        "parameters": {
            "selector": {"type": "string", "description": "CSS selector (e.g. 'h1', 'p:first-of-type', 'h2, h3', '#firstHeading')"}
        },
        "required": ["selector"],
    },
}

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT_TEMPLATE = """\
You are a web scraping agent. You have two tools:

1. fetch_page(url) — Fetch a web page and get its cleaned text content.
2. extract(selector) — Run a CSS selector on the last fetched page to get specific elements.

EXAMPLE CALLS:
{{"name": "fetch_page", "arguments": {{"url": "https://en.wikipedia.org/wiki/Artificial_intelligence"}}}}
{{"name": "extract", "arguments": {{"selector": "h1"}}}}
{{"name": "extract", "arguments": {{"selector": "#mw-content-text p:first-of-type"}}}}
{{"name": "extract", "arguments": {{"selector": "h2, h3"}}}}

WORKFLOW: fetch_page to load the page, then extract with CSS selectors to get specific content.

AVAILABLE TOOLS:
1. fetch_page: Fetch a web page and return its cleaned text content (scripts/styles removed, max 4K chars).
  url (string) (REQUIRED): The URL to fetch

2. extract: Run a CSS selector on the last fetched page. Returns text of matching elements (max 20 matches).
  selector (string) (REQUIRED): CSS selector (e.g. 'h1', 'p:first-of-type', 'h2, h3')

RESPONSE FORMAT:
- To call a tool, respond with ONLY a JSON object: {{"name": "tool_name", "arguments": {{"param": "value"}}}}
- To give your final answer, respond in plain natural language (NO JSON).
- After each tool result, decide if you need more calls or can answer.
- Be efficient — use the minimum number of tool calls needed."""


# ---------------------------------------------------------------------------
# Function call extraction (same as agent.py)
# ---------------------------------------------------------------------------

def extract_function_call(text: str) -> Optional[Tuple[str, Dict[str, Any]]]:
    """Extract function call JSON from LLM response text."""
    if not text:
        return None

    text = re.sub(r"<\|[^|]+\|>", "", text.strip())
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    # Try parsing entire text as JSON
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and "name" in parsed:
            return parsed["name"], parsed.get("arguments", {})
    except json.JSONDecodeError:
        pass

    # Find first JSON object via brace matching
    json_start = text.find("{")
    if json_start == -1:
        return None

    brace_count = 0
    for i in range(json_start, len(text)):
        if text[i] == "{":
            brace_count += 1
        elif text[i] == "}":
            brace_count -= 1
            if brace_count == 0:
                json_str = text[json_start : i + 1]
                try:
                    parsed = json.loads(json_str)
                    if isinstance(parsed, dict) and "name" in parsed:
                        return parsed["name"], parsed.get("arguments", {})
                except json.JSONDecodeError:
                    pass
                break

    # Regex fallback for malformed JSON
    name_match = re.search(r'"name"\s*:\s*"([^"]+)"', text)
    if name_match:
        name = name_match.group(1)
        args_match = re.search(r'"arguments"\s*:\s*(\{[^}]*\})', text)
        if args_match:
            try:
                args = json.loads(args_match.group(1))
                return name, args
            except json.JSONDecodeError:
                pass
        return name, {}

    return None


# ---------------------------------------------------------------------------
# LLM inference (same as agent.py — OpenAI-compatible API)
# ---------------------------------------------------------------------------

def discover_model(endpoint: str, model_hint: str = "") -> str:
    """Discover available model from the inference server."""
    url = f"{endpoint}/models"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        raise RuntimeError(f"Cannot reach inference server at {endpoint}: {e}")

    models = [m["id"] for m in data.get("data", [])]
    if not models:
        raise RuntimeError("No models loaded. Pull a model first.")

    if model_hint:
        for m in models:
            if model_hint.lower() in m.lower():
                return m
    return models[0]


def generate_response(
    endpoint: str,
    model: str,
    system_prompt: str,
    conversation: List[Dict[str, str]],
) -> str:
    """Generate a response via OpenAI-compatible chat API."""
    messages = [{"role": "system", "content": system_prompt}] + conversation

    payload = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": 2048,
        "temperature": 0.1,
    }).encode()

    req = urllib.request.Request(
        f"{endpoint}/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.URLError as e:
        return f"(LLM error: {e})"

    choices = data.get("choices", [])
    if not choices:
        return "(empty response from model)"

    content = choices[0].get("message", {}).get("content", "")
    return content.strip()


# ---------------------------------------------------------------------------
# Tool execution
# ---------------------------------------------------------------------------

def execute_tool(tool_name: str, arguments: Dict[str, Any]) -> str:
    """Execute a local tool by name."""
    if tool_name not in TOOLS:
        return f"Error: unknown tool '{tool_name}'. Available: {', '.join(TOOLS.keys())}"

    tool = TOOLS[tool_name]
    func = tool["func"]

    # Extract required parameters
    try:
        kwargs = {}
        for param_name in tool["parameters"]:
            if param_name in arguments:
                kwargs[param_name] = arguments[param_name]
            elif param_name in tool.get("required", []):
                return f"Error: missing required parameter '{param_name}'"
        return func(**kwargs)
    except Exception as e:
        return f"Error executing {tool_name}: {e}"


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

@dataclass
class AgentResult:
    answer: str
    tool_calls: int
    history: List[Dict[str, str]]


def run_agent(
    endpoint: str,
    model: str,
    system_prompt: str,
    task: str,
    max_turns: int = DEFAULT_MAX_TURNS,
    verbose: bool = False,
) -> AgentResult:
    """Run the multi-turn agent loop."""
    conversation = [{"role": "user", "content": task}]
    tool_calls = 0

    for turn in range(max_turns):
        if verbose:
            print(f"\n--- Turn {turn + 1} ---")

        response = generate_response(endpoint, model, system_prompt, conversation)

        if verbose:
            display = re.sub(r"<think>.*?</think>", "[thinking...]", response, flags=re.DOTALL)
            print(f"LLM: {display[:300]}{'...' if len(display) > 300 else ''}")

        func_call = extract_function_call(response)

        if not func_call:
            # Final answer
            clean = re.sub(r"<think>.*?</think>", "", response, flags=re.DOTALL)
            clean = re.sub(r"^.*?</think>", "", clean, flags=re.DOTALL)
            clean = re.sub(r"<think>.*$", "", clean, flags=re.DOTALL)
            clean = re.sub(r"<\|[^|]+\|>", "", clean).strip()
            return AgentResult(answer=clean, tool_calls=tool_calls, history=conversation)

        func_name, func_args = func_call
        tool_calls += 1

        if verbose:
            print(f"Tool: {func_name}({json.dumps(func_args)})")

        result = execute_tool(func_name, func_args)

        if verbose:
            preview = result[:300] + ("..." if len(result) > 300 else "")
            print(f"Result: {preview}")

        conversation.append({"role": "assistant", "content": response})
        conversation.append({
            "role": "user",
            "content": f"Tool result:\n{result}\n\nContinue with the task. "
                       "Call another tool or provide your final answer in plain text.",
        })

    return AgentResult(
        answer="(max turns reached — task incomplete)",
        tool_calls=tool_calls,
        history=conversation,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Raw HTML Agent — baseline for DOMShell interface comparison",
    )
    parser.add_argument("--task", required=True, help="Task for the agent to perform")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT,
                        help=f"OpenAI-compatible API endpoint (default: {DEFAULT_ENDPOINT})")
    parser.add_argument("--model", default="", help="Model name hint (auto-discovers if empty)")
    parser.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS, help="Max agent loop turns")
    parser.add_argument("--verbose", action="store_true", help="Print each turn's tool calls and results")
    args = parser.parse_args()

    print(f"Connecting to inference server at {args.endpoint}...")
    model = discover_model(args.endpoint, args.model)
    print(f"Using model: {model}")
    print(f"Tools: fetch_page, extract (raw HTML mode)\n")

    print(f"Task: {args.task}\n")
    result = run_agent(
        args.endpoint, model, SYSTEM_PROMPT_TEMPLATE,
        args.task, max_turns=args.max_turns, verbose=args.verbose,
    )

    print(f"\n{'=' * 60}")
    print(f"Answer ({result.tool_calls} tool calls):\n")
    print(result.answer)


if __name__ == "__main__":
    main()
