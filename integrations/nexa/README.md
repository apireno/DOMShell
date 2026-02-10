# DOMShell + Nexa SDK: Local LLM Browser Automation

Run DOMShell with local models via [nexa-sdk](https://github.com/NexaAI/nexa-sdk) for fully on-device browser automation — no cloud API needed.

## Overview

This integration connects DOMShell's MCP-based browser tools to nexa-sdk's local inference engine. The agent script acts as an MCP client that:

1. Connects to DOMShell's MCP server (via the stdio proxy)
2. Fetches tool definitions and converts them to function-calling format
3. Sends the user's task to a local LLM running via `nexa serve` (OpenAI-compatible API)
4. Parses function calls from LLM output, executes via MCP, loops until done

```
                                        ┌─────────────────┐
                                        │   nexa serve     │
                                        │   (local LLM)    │
                                        │   OpenAI API     │
                                        │   :8080/v1       │
                                        └────────▲────────┘
                                                 │ HTTP
┌──────────────┐     stdio      ┌─────────────┐ │  HTTP      ┌──────────────┐     WS       ┌─────────────┐
│  agent.py    │ ◄────────────► │  proxy.ts   │ ◄───────────► │  MCP Server  │ ◄──────────► │  Chrome Ext │
│  (MCP client)│  MCP protocol  │  (bridge)   │  /mcp         │  (index.ts)  │  port 9876   │  (DOMShell) │
└──────────────┘                └─────────────┘               └──────────────┘              └─────────────┘
```

### Why DOMShell vs Browser-Use (Playwright)?

Nexa's existing [Web-Agent-Qwen3VL](https://github.com/NexaAI/nexa-sdk/tree/main/cookbook/PC/Web-Agent-Qwen3VL) cookbook uses Playwright + screenshots + a 4B vision model. DOMShell takes a different approach:

| Aspect | DOMShell (this integration) | Web-Agent (browser-use) |
|--------|---------------------------|------------------------|
| **Input to LLM** | Structured text (accessibility tree) | Screenshots (pixels) |
| **Model requirement** | Any text LLM with function calling | Vision-language model (4B+) |
| **Token efficiency** | Low (text commands + text results) | High (image tokens are expensive) |
| **Element targeting** | By name/role/path (e.g. `click submit_btn`) | By screen coordinates |
| **Output format** | Structured data (markdown tables, link lists) | Raw text from screenshots |
| **Minimum model size** | 0.6B+ (text-only) | 4B+ (VLM required) |

## Prerequisites

1. **DOMShell Chrome extension** installed and running
2. **DOMShell MCP server** running (`cd mcp-server && npx tsx index.ts --no-confirm --allow-all`)
3. **nexa-sdk** installed: see [nexa-sdk installation](https://github.com/NexaAI/nexa-sdk#installation)
4. **Node.js** and **npm** (for the MCP proxy)
5. **Python 3.10+**

## Quick Start

### 1. Install dependencies

```bash
cd integrations/nexa
pip install -r requirements.txt
```

### 2. Pull a model and start nexa serve

```bash
# Pull a model (examples — use whatever is available for your platform)
nexa pull NexaAI/Qwen3-1.7B-4bit-MLX    # Apple Silicon (MLX)
nexa pull NexaAI/Qwen3-4B-4bit-MLX       # Apple Silicon, larger
nexa pull NexaAI/Granite-4-Micro-GGUF    # Cross-platform (GGUF)

# Start the local inference server (default: 127.0.0.1:18181)
nexa serve
```

`nexa serve` exposes an OpenAI-compatible API at `http://127.0.0.1:18181/v1`. The agent auto-discovers which model is loaded.

### 3. Start the DOMShell MCP server

In a separate terminal:

```bash
cd mcp-server
npx tsx index.ts --no-confirm --allow-all
```

### 4. Run the agent

```bash
# Read-only task (extract content)
python agent.py --task "Open wikipedia.org/wiki/Artificial_intelligence and extract the first paragraph" --verbose

# With write access (clicking, typing, form submission)
python agent.py --task "Go to google.com and search for nexa ai" --allow-write --verbose

# Compact mode for smaller models (uses domshell_execute as single tool)
python agent.py --task "Open wikipedia.org/wiki/AI and list all headings" --mode compact

# Specify a model hint (matches against loaded models)
python agent.py --task "Summarize this page" --model qwen3-4b --verbose
```

## Usage

### Command-line options

| Flag | Default | Description |
|------|---------|-------------|
| `--task` | *(required)* | Task for the agent to perform |
| `--nexa-endpoint` | `http://127.0.0.1:18181/v1` | Nexa serve OpenAI-compatible API endpoint |
| `--model` | *(auto-discover)* | Model name hint — matches against models loaded in nexa serve |
| `--port` | `3001` | DOMShell MCP server port |
| `--token` | *(none)* | DOMShell MCP auth token |
| `--mode` | `full` | `full` (all tools) or `compact` (domshell_execute only) |
| `--allow-write` | off | Include write-tier tools (click, type, submit, navigate, open) |
| `--max-turns` | `20` | Maximum agent loop iterations |
| `--verbose` | off | Print each turn's tool calls and results |

### Modes

**Full mode** (`--mode full`): Exposes all DOMShell tools as individual functions. Best for models with 8K+ context windows that can handle 15+ tool definitions.

**Compact mode** (`--mode compact`): Exposes only `domshell_execute` as a single tool that accepts any command string. Better for smaller models with limited context, at the cost of losing structured parameter validation.

### Example tasks

```bash
# Content extraction
python agent.py --task "Open wikipedia.org/wiki/Machine_learning and extract the first 5 headings"

# Link harvesting
python agent.py --task "Open wikipedia.org/wiki/AI and list all links in the See Also section"

# Table extraction
python agent.py --task "Open wikipedia.org/wiki/Large_language_model and extract the comparison table"

# Multi-page navigation (requires --allow-write)
python agent.py --task "Open the AI Wikipedia article, find the first link in See Also, follow it, and extract the first paragraph" --allow-write

# Form interaction (requires --allow-write)
python agent.py --task "Go to wikipedia.org, search for 'neural network', and extract the first paragraph" --allow-write
```

## Model Recommendations

The agent auto-discovers models from `nexa serve`. Use whatever model you have pulled locally. Some options:

| Model | Size | Platform | Function Calling | Notes |
|-------|------|----------|-----------------|-------|
| `NexaAI/Qwen3-1.7B-4bit-MLX` | ~1GB | Apple Silicon | Basic | Good starting point for Mac users |
| `NexaAI/Qwen3-4B-4bit-MLX` | ~2.5GB | Apple Silicon | Good | Better reasoning, recommended for multi-step tasks |
| `NexaAI/Granite-4-Micro-GGUF` | ~2GB | Cross-platform | Good | Optimized for tool use |
| `NexaAI/Qwen3-0.6B-GGUF` | ~400MB | Cross-platform | Basic | Use with `--mode compact` for minimal footprint |

**Tip:** Qwen3 models output `<think>...</think>` reasoning blocks before their response. The agent automatically strips these during function call extraction.

## How It Works

The agent follows this loop:

1. User provides a task (e.g., "Extract the first paragraph from the AI article")
2. Agent connects to `nexa serve` (auto-discovers loaded model) and DOMShell MCP server
3. The system prompt includes DOMShell instructions and tool definitions
4. The LLM generates a JSON function call: `{"name": "domshell_open", "arguments": {"url": "wikipedia.org/wiki/AI"}}`
5. The agent parses the JSON, executes the tool via MCP, gets the result
6. The result is fed back to the LLM as context
7. The LLM decides: call another tool, or give the final answer
8. Loop repeats until the LLM responds in plain text (no function call)

This is the same pattern as Nexa's [function-calling cookbook](https://github.com/NexaAI/nexa-sdk/tree/main/cookbook/PC/function-calling), extended from single-shot (1 tool call) to multi-turn (5-15 calls for browser tasks).

## Troubleshooting

### "Cannot reach nexa serve"
Make sure `nexa serve` is running:
```bash
# Check if it's running
curl http://127.0.0.1:18181/v1/models

# Start it (default port 18181)
nexa serve
```

### "nexa serve has no models loaded"
Pull a model first:
```bash
nexa pull NexaAI/Qwen3-1.7B-4bit-MLX    # Apple Silicon
nexa pull NexaAI/Granite-4-Micro-GGUF    # Cross-platform
```

### "Connection refused" on port 3001
The DOMShell MCP server isn't running. Start it with:
```bash
cd mcp-server && npx tsx index.ts --no-confirm --allow-all
```

### "No browser tab found"
The DOMShell Chrome extension isn't connected. Open the extension popup and verify the WebSocket connection is active.

### Model outputs text instead of JSON
The model may not support function calling well. Try:
- A larger model (4B+ instead of 0.6B)
- Compact mode (`--mode compact`) which simplifies the tool interface
- Adding `--verbose` to see what the model is actually outputting

### Max turns reached
The task may be too complex for the model. Try:
- Breaking it into smaller sub-tasks
- Using `--max-turns 30` for complex multi-page tasks
- A more capable model
