#!/usr/bin/env python3
"""
DOMShell + Nexa SDK Agent — Local LLM-powered browser automation via MCP.

Connects DOMShell's MCP server to nexa-sdk's local inference engine,
enabling fully on-device browser control with no cloud API.

Prerequisites:
    1. nexa-sdk installed (pip install nexaai) with models downloaded (nexa pull ...)
    2. nexa serve running (nexa serve)
    3. DOMShell MCP server running (cd mcp-server && npx tsx index.ts --no-confirm --allow-all)
    4. DOMShell Chrome extension connected

Usage:
    python agent.py --task "Open wikipedia.org/wiki/AI and extract the first paragraph"
    python agent.py --task "Find all links on this page" --allow-write
    python agent.py --task "Search google for nexa ai" --mode compact
"""

import asyncio
import json
import os
import sys
import argparse
import re
from dataclasses import dataclass
from typing import List, Dict, Any, Optional, Tuple

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
PROXY_PATH = os.path.join(REPO_ROOT, "mcp-server", "proxy.ts")

DEFAULT_NEXA_ENDPOINT = "http://127.0.0.1:18181/v1"
DEFAULT_PORT = "3001"
DEFAULT_MAX_TURNS = 20

READ_TOOLS = {
    "domshell_tabs", "domshell_here", "domshell_ls", "domshell_cd",
    "domshell_pwd", "domshell_cat", "domshell_text", "domshell_read",
    "domshell_find", "domshell_grep", "domshell_tree",
    "domshell_extract_links", "domshell_extract_table",
    "domshell_refresh", "domshell_execute",
}

WRITE_TOOLS = {
    "domshell_click", "domshell_focus", "domshell_type",
    "domshell_navigate", "domshell_open", "domshell_submit",
}

# Abbreviated tool names that models might output → canonical MCP name
TOOL_ALIASES = {
    "ls": "domshell_ls", "cd": "domshell_cd", "pwd": "domshell_pwd",
    "cat": "domshell_cat", "text": "domshell_text", "read": "domshell_read",
    "find": "domshell_find", "grep": "domshell_grep", "tree": "domshell_tree",
    "click": "domshell_click", "focus": "domshell_focus", "type": "domshell_type",
    "submit": "domshell_submit", "navigate": "domshell_navigate",
    "open": "domshell_open", "tabs": "domshell_tabs", "here": "domshell_here",
    "refresh": "domshell_refresh", "extract_links": "domshell_extract_links",
    "extract_table": "domshell_extract_table", "execute": "domshell_execute",
    "whoami": "domshell_whoami",
}

# ---------------------------------------------------------------------------
# DOMShell instructions (condensed for local models)
# ---------------------------------------------------------------------------

COMPACT_INSTRUCTIONS = """\
You are a browser automation agent. You have ONE tool: domshell_execute. \
Pass any DOMShell command as the "command" parameter.

EXAMPLE CALLS:
{"name": "domshell_execute", "arguments": {"command": "tabs"}}
{"name": "domshell_execute", "arguments": {"command": "open wikipedia.org/wiki/AI"}}
{"name": "domshell_execute", "arguments": {"command": "cd main"}}
{"name": "domshell_execute", "arguments": {"command": "text"}}
{"name": "domshell_execute", "arguments": {"command": "find --type heading"}}

COMMANDS: tabs, open <url>, navigate <url>, cd <path>, ls, find [pattern], \
grep <pattern>, text [name], cat <name>, extract_links, extract_table <name>, \
click <name>, focus <name>, type <text>, submit <input> <value>

WORKFLOW: tabs → open URL → cd section → text to read content.

When done, respond in plain text (no JSON)."""

FULL_INSTRUCTIONS = """\
You are a browser automation agent using DOMShell. DOMShell gives you full browser \
control through a filesystem metaphor. The DOM's Accessibility Tree is mapped to \
directories (containers like navigation/, main/, form/) and files (interactive elements \
like submit_btn, search_input, login_link).

TYPICAL WORKFLOW:
1. Enter a tab: use domshell_open (new tab) or domshell_here (focused tab)
2. Understand structure: domshell_tree (overview), domshell_ls (children)
3. Extract content: domshell_text (bulk text — much faster than multiple cat calls)
4. Find specific elements: domshell_find with pattern or --type (link, button, heading)
5. Inspect details: domshell_cat shows full metadata — AX role, DOM tag, href, src, id, class, outerHTML
6. Interact: domshell_click, domshell_focus + domshell_type, or domshell_submit (atomic form fill)

BROWSER HIERARCHY:
- "~" or "/" = browser root. "ls" shows windows/ and tabs/.
- "~/tabs/<id>" = enter a tab by ID. "~/tabs/<pattern>" = match by title/URL.
- "%here%" = focused tab path variable.
- "cd .." from DOM root exits to browser level.

EFFICIENT PATTERNS:
1. Path Resolution: All commands accept relative paths — text main/article/paragraph
2. Scoped Extraction: open URL → cd main/article → find --type heading → cd section → text
3. Table Reading: find --type table → text table_element (reads ALL rows at once)
4. Link Extraction: find --type link --meta (shows href inline for every link)
5. Section Discovery: grep "section_name" (recursive) — NOT ls pagination
6. Sibling Navigation: ls --after heading_name -n 5 --text (elements after a heading)
7. Form Interaction: domshell_submit for atomic fill, or focus → type → click

COMMAND CHAINING:
grep discovers sections → cd scopes context → text/find/extract extracts content.
- Article: grep "article" (recursive) → cd article/ → text
- Links: grep "references" (recursive) → cd references/ → find --type link --meta
- Table: grep "table" (recursive) → extract_table table_name

ANTI-PATTERNS:
- Do NOT cd into an element just to read its text — use text element_name instead
- Do NOT call text on individual rows — text the parent container instead
- Do NOT make multiple cat calls for content — use text for bulk, find --meta for properties

When you have enough information to answer the user's question, respond in natural \
language WITHOUT a function call. The conversation ends when you give a plain text answer."""


# ---------------------------------------------------------------------------
# MCP tool → OpenAI function-calling format conversion
# (Adapted from NexaAI/nexa-sdk cookbook/PC/function-calling/main.py)
# ---------------------------------------------------------------------------

def _convert_schema_property(prop_schema: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively convert a schema property, handling nested objects."""
    result = {"type": prop_schema.get("type", "string")}
    if "description" in prop_schema:
        result["description"] = prop_schema["description"]
    if prop_schema.get("type") == "object" and "properties" in prop_schema:
        nested_props = {}
        nested_required = []
        for name, schema in prop_schema["properties"].items():
            nested_props[name] = _convert_schema_property(schema)
            if name in prop_schema.get("required", []):
                nested_required.append(name)
        result["properties"] = nested_props
        if nested_required:
            result["required"] = nested_required
    if prop_schema.get("type") == "array" and "items" in prop_schema:
        result["items"] = _convert_schema_property(prop_schema["items"])
    return result


def mcp_tool_to_openai_format(tool) -> Dict[str, Any]:
    """Convert MCP tool to OpenAI function calling format."""
    properties = {}
    required = []
    if tool.inputSchema and "properties" in tool.inputSchema:
        for prop_name, prop_schema in tool.inputSchema["properties"].items():
            properties[prop_name] = _convert_schema_property(prop_schema)
            if tool.inputSchema.get("required") and prop_name in tool.inputSchema["required"]:
                required.append(prop_name)
    return {
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description or "",
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


async def get_mcp_tools(
    session: ClientSession,
    allowed: set,
) -> List[Dict[str, Any]]:
    """Get tools from MCP server, filter by allowed set, convert to OpenAI format."""
    result = await session.list_tools()
    return [
        mcp_tool_to_openai_format(tool)
        for tool in result.tools
        if tool.name in allowed
    ]


# ---------------------------------------------------------------------------
# Tool name normalization
# ---------------------------------------------------------------------------

def normalize_tool_name(name: str, available: List[Dict[str, Any]]) -> str:
    """Resolve abbreviated or aliased tool names to canonical MCP names."""
    tool_names = {t["function"]["name"] for t in available}
    if name in tool_names:
        return name
    alias = TOOL_ALIASES.get(name.lower())
    if alias and alias in tool_names:
        return alias
    # Try prefixing with domshell_
    prefixed = f"domshell_{name.lower()}"
    if prefixed in tool_names:
        return prefixed
    return name


# ---------------------------------------------------------------------------
# Function call extraction from LLM text output
# (Adapted from NexaAI/nexa-sdk cookbook/PC/function-calling/main.py)
# ---------------------------------------------------------------------------

def extract_function_call(text: str) -> Optional[Tuple[str, Dict[str, Any]]]:
    """Extract function call JSON from LLM response text.

    Handles common local-model quirks: <think> blocks, special tokens,
    malformed JSON (e.g. {"name":"foo","arguments":{"}} instead of {}).
    """
    if not text:
        return None

    # Strip special tokens and <think>...</think> reasoning blocks
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

    # Fallback: regex extraction for malformed JSON from small models
    # Matches: {"name": "tool_name", "arguments": ...}
    name_match = re.search(r'"name"\s*:\s*"([^"]+)"', text)
    if name_match:
        name = name_match.group(1)
        # Try to extract arguments object
        args_match = re.search(r'"arguments"\s*:\s*(\{[^}]*\})', text)
        if args_match:
            try:
                args = json.loads(args_match.group(1))
                return name, args
            except json.JSONDecodeError:
                pass
        # No parseable arguments — call with empty args
        return name, {}

    return None


# ---------------------------------------------------------------------------
# MCP tool execution
# ---------------------------------------------------------------------------

async def execute_mcp_tool(
    session: ClientSession,
    tool_name: str,
    arguments: Dict[str, Any],
    available: List[Dict[str, Any]],
) -> str:
    """Execute a tool call via MCP server.

    If the model outputs a bare command name (e.g. "ls") in compact mode,
    auto-wraps it as a domshell_execute call.
    """
    available_names = {t["function"]["name"] for t in available}
    canonical = normalize_tool_name(tool_name, available)

    # Compact mode fallback: if the resolved name isn't in the available set
    # but domshell_execute is, wrap it as a domshell_execute call
    if canonical not in available_names and "domshell_execute" in available_names:
        # Build the command string from the original tool name + arguments
        cmd_parts = [tool_name]
        for v in arguments.values():
            cmd_parts.append(str(v))
        canonical = "domshell_execute"
        arguments = {"command": " ".join(cmd_parts)}

    try:
        result = await session.call_tool(canonical, arguments=arguments)
        # Extract text content from result
        texts = []
        for item in (result.content or []):
            if hasattr(item, "text"):
                texts.append(item.text)
        return "\n".join(texts) if texts else "(no output)"
    except Exception as e:
        return f"Error: {e}"


# ---------------------------------------------------------------------------
# System prompt builder
# ---------------------------------------------------------------------------

def _format_tool_params(func: Dict[str, Any]) -> str:
    """Format tool parameters for the system prompt."""
    params = func.get("parameters", {})
    props = params.get("properties", {})
    required = set(params.get("required", []))
    if not props:
        return "  (no parameters)"
    lines = []
    for name, info in props.items():
        ptype = info.get("type", "string")
        desc = info.get("description", "")
        req = " (REQUIRED)" if name in required else ""
        lines.append(f"  {name} ({ptype}){req}: {desc}")
    return "\n".join(lines)


def build_system_prompt(tools: List[Dict[str, Any]], mode: str) -> str:
    """Build the system prompt with instructions and tool definitions."""
    instructions = COMPACT_INSTRUCTIONS if mode == "compact" else FULL_INSTRUCTIONS

    tools_section = []
    for i, t in enumerate(tools, 1):
        func = t["function"]
        name = func["name"]
        desc = func.get("description", "")
        # Truncate long descriptions for compact mode
        if mode == "compact" and len(desc) > 200:
            desc = desc[:200] + "..."
        params = _format_tool_params(func)
        tools_section.append(f"{i}. {name}: {desc}\n{params}")

    tools_list = "\n\n".join(tools_section)

    return f"""{instructions}

AVAILABLE TOOLS:
{tools_list}

RESPONSE FORMAT:
- To call a tool, respond with ONLY a JSON object: {{"name": "tool_name", "arguments": {{"param": "value"}}}}
- To give your final answer, respond in plain natural language (NO JSON).
- After each tool result, decide if you need more calls or can answer.
- Be efficient — use the minimum number of tool calls needed."""


# ---------------------------------------------------------------------------
# LLM inference via nexa serve OpenAI-compatible API
# ---------------------------------------------------------------------------

import urllib.request
import urllib.error


def discover_model(endpoint: str, model_hint: str = "") -> str:
    """Discover available model from nexa serve, optionally matching a hint."""
    url = f"{endpoint}/models"
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        raise RuntimeError(f"Cannot reach nexa serve at {endpoint}: {e}")

    models = [m["id"] for m in data.get("data", [])]
    if not models:
        raise RuntimeError("nexa serve has no models loaded. Pull a model first: nexa pull <model>")

    if model_hint:
        for m in models:
            if model_hint.lower() in m.lower():
                return m
    # Default to first available
    return models[0]


def generate_response(
    endpoint: str,
    model: str,
    system_prompt: str,
    conversation: List[Dict[str, str]],
) -> str:
    """Generate a response via the nexa serve OpenAI-compatible chat API."""
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
# Agent loop
# ---------------------------------------------------------------------------

@dataclass
class AgentResult:
    """Result of agent execution."""
    answer: str
    tool_calls: int
    history: List[Dict[str, str]]


async def run_agent(
    endpoint: str,
    model: str,
    system_prompt: str,
    session: ClientSession,
    tools: List[Dict[str, Any]],
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
            # Strip <think> blocks for display
            display = re.sub(r"<think>.*?</think>", "[thinking...]", response, flags=re.DOTALL)
            print(f"LLM: {display[:300]}{'...' if len(display) > 300 else ''}")

        # Try to extract a function call
        func_call = extract_function_call(response)

        if not func_call:
            # No function call → LLM is giving its final answer
            # Strip <think> blocks and special tokens from the final answer
            clean = re.sub(r"<think>.*?</think>", "", response, flags=re.DOTALL)
            clean = re.sub(r"^.*?</think>", "", clean, flags=re.DOTALL)  # orphaned closing tag
            clean = re.sub(r"<think>.*$", "", clean, flags=re.DOTALL)    # orphaned opening tag
            clean = re.sub(r"<\|[^|]+\|>", "", clean).strip()
            return AgentResult(answer=clean, tool_calls=tool_calls, history=conversation)

        func_name, func_args = func_call
        tool_calls += 1

        if verbose:
            print(f"Tool: {func_name}({json.dumps(func_args)})")

        # Execute the tool via MCP
        result = await execute_mcp_tool(session, func_name, func_args, tools)

        if verbose:
            preview = result[:300] + ("..." if len(result) > 300 else "")
            print(f"Result: {preview}")

        # Feed result back into conversation
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
# MCP server connection
# ---------------------------------------------------------------------------

def create_domshell_server(port: str, token: str) -> StdioServerParameters:
    """Create DOMShell MCP server parameters (connects via proxy.ts)."""
    args = ["tsx", PROXY_PATH, "--port", port]
    if token:
        args.extend(["--token", token])
    return StdioServerParameters(command="npx", args=args)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    parser = argparse.ArgumentParser(
        description="DOMShell + Nexa SDK Agent — local LLM browser automation",
    )
    parser.add_argument("--task", required=True, help="Task for the agent to perform")
    parser.add_argument("--nexa-endpoint", default=DEFAULT_NEXA_ENDPOINT,
                        help=f"Nexa serve API endpoint (default: {DEFAULT_NEXA_ENDPOINT})")
    parser.add_argument("--model", default="", help="Model name hint (auto-discovers from nexa serve if empty)")
    parser.add_argument("--port", default=DEFAULT_PORT, help="DOMShell MCP server port")
    parser.add_argument("--token", default="", help="DOMShell MCP auth token")
    parser.add_argument("--mode", choices=["full", "compact"], default="full",
                        help="full = all tools (8K+ ctx models), compact = domshell_execute only (small models)")
    parser.add_argument("--allow-write", action="store_true", help="Include write-tier tools (click, type, submit)")
    parser.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS, help="Max agent loop turns")
    parser.add_argument("--verbose", action="store_true", help="Print each turn's tool calls and results")
    args = parser.parse_args()

    # Discover model from nexa serve
    print(f"Connecting to nexa serve at {args.nexa_endpoint}...")
    model = discover_model(args.nexa_endpoint, args.model)
    print(f"Using model: {model}")

    # Determine allowed tools
    allowed = set(READ_TOOLS)
    if args.allow_write:
        allowed |= WRITE_TOOLS
    if args.mode == "compact":
        allowed = {"domshell_execute"}

    # Connect to DOMShell MCP server
    server_params = create_domshell_server(args.port, args.token)
    print(f"Connecting to DOMShell MCP server on port {args.port}...")

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            # Fetch and filter tools
            tools = await get_mcp_tools(session, allowed)
            print(f"Loaded {len(tools)} tools ({args.mode} mode)\n")

            # Build system prompt
            system_prompt = build_system_prompt(tools, args.mode)

            # Run agent
            print(f"Task: {args.task}\n")
            result = await run_agent(
                args.nexa_endpoint, model, system_prompt,
                session, tools, args.task,
                max_turns=args.max_turns,
                verbose=args.verbose,
            )

            print(f"\n{'=' * 60}")
            print(f"Answer ({result.tool_calls} tool calls):\n")
            print(result.answer)


if __name__ == "__main__":
    asyncio.run(main())
