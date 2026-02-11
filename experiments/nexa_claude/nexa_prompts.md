# Nexa Experiment Prompts

Task strings for `agent.py`. Each task is run with multiple model/mode combinations.

## How to Run

```bash
cd integrations/nexa

# Make sure nexa serve is running
nexa serve

# Make sure DOMShell MCP server is running (separate terminal)
cd mcp-server && npx tsx index.ts --no-confirm --allow-all

# Run a trial
python agent.py --task "TASK_STRING" --allow-write --verbose --max-turns MAX --nexa-endpoint http://127.0.0.1:18181/v1 --token YOUR_TOKEN --model MODEL_HINT --mode MODE
```

## Trial Matrix

| Trial | Task | Model | Mode | Max Turns |
|-------|------|-------|------|-----------|
| 1 | T1 | Qwen3-1.7B | full | 15 |
| 2 | T1 | Qwen3-4B | full | 15 |
| 3 | T1 | Qwen3-1.7B | compact | 15 |
| 4 | T1 | Qwen3-4B | compact | 15 |
| 5 | T2 | Qwen3-1.7B | full | 20 |
| 6 | T2 | Qwen3-4B | full | 20 |
| 7 | T2 | Qwen3-1.7B | compact | 20 |
| 8 | T2 | Qwen3-4B | compact | 20 |
| 9 | T3 | Qwen3-1.7B | full | 25 |
| 10 | T3 | Qwen3-4B | full | 25 |
| 11 | T3 | Qwen3-1.7B | compact | 25 |
| 12 | T3 | Qwen3-4B | compact | 25 |

---

## Task 1: Content Extraction

```
Go to https://en.wikipedia.org/wiki/Artificial_intelligence. Extract the first paragraph of the article body. Then list the first 10 hyperlinks in the article body with their display text and full URLs.
```

**Max turns:** 15
**Required flags:** `--allow-write` (for domshell_open)

---

## Task 2: Search + Navigate

```
Go to https://en.wikipedia.org. Search for "machine learning" using the search box. On the results page, click the first result. Then extract the first paragraph of the article and list all items in the See also section.
```

**Max turns:** 20
**Required flags:** `--allow-write` (for open, submit, click)

---

## Task 3: Multi-step Information Gathering

```
Go to https://en.wikipedia.org/wiki/Large_language_model. Find the table of large language models. Extract the names and organizations of the first 5 models listed. Then follow the Wikipedia link for the first model in the list and extract the first paragraph of that model's page.
```

**Max turns:** 25
**Required flags:** `--allow-write` (for open, navigate)

---

## Tool Call Caps (matching claude_domshell_vs_cic)

| Task | Complexity | Max turns |
|------|-----------|-----------|
| Task 1 | Read-only extraction | 15 |
| Task 2 | Search + navigate + extract | 20 |
| Task 3 | Multi-page navigation + table extraction | 25 |

## Key Differences from Experiment 1

| Aspect | Experiment 1 | Nexa Experiment |
|--------|-------------|-----------------|
| LLM | Claude Opus 4.6 | Qwen3-1.7B / Qwen3-4B (local) |
| Runner | Claude Desktop Cowork | agent.py + nexa serve |
| Parameters | ~175B+ (cloud) | 1.7B / 4B (on-device) |
| Warm/Cold | Yes (conversation context) | No (fresh each run) |
| Modes | Full tools only | Full + Compact |
