# Nexa Interface Experiment — Task Prompts

## Model

Qwen3-4B (same weights on both nexa serve and Ollama)

## Task Strings

### Task 1: Page Title

```
Go to https://en.wikipedia.org/wiki/Artificial_intelligence and return the page title.
```

### Task 2: First Paragraph

```
Go to https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first paragraph of the article body.
```

### Task 3: List Headings

```
Go to https://en.wikipedia.org/wiki/Artificial_intelligence and list all section headings on the page.
```

## Trial Matrix

12 trials: 3 tasks x 2 backends x 2 interfaces

| Trial | Task | Backend | Interface | Agent | Max Turns |
|-------|------|---------|-----------|-------|-----------|
| 1 | T1 | Nexa serve | DOMShell | agent.py --mode compact | 10 |
| 2 | T1 | Nexa serve | Raw HTML | raw_html_agent.py | 10 |
| 3 | T1 | Ollama | DOMShell | agent.py --mode compact | 10 |
| 4 | T1 | Ollama | Raw HTML | raw_html_agent.py | 10 |
| 5 | T2 | Nexa serve | DOMShell | agent.py --mode compact | 10 |
| 6 | T2 | Nexa serve | Raw HTML | raw_html_agent.py | 10 |
| 7 | T2 | Ollama | DOMShell | agent.py --mode compact | 10 |
| 8 | T2 | Ollama | Raw HTML | raw_html_agent.py | 10 |
| 9 | T3 | Nexa serve | DOMShell | agent.py --mode compact | 10 |
| 10 | T3 | Nexa serve | Raw HTML | raw_html_agent.py | 10 |
| 11 | T3 | Ollama | DOMShell | agent.py --mode compact | 10 |
| 12 | T3 | Ollama | Raw HTML | raw_html_agent.py | 10 |

## Backend Endpoints

- **Nexa serve**: `http://127.0.0.1:18181/v1`
- **Ollama**: `http://127.0.0.1:11434/v1`

## Notes

- DOMShell trials use compact mode (single `domshell_execute` tool) since 4B models perform better with fewer tool definitions
- DOMShell trials require `--allow-write` for `open` command
- Raw HTML trials are self-contained (no MCP server needed)
- All tasks use the same Wikipedia article to eliminate URL variability
