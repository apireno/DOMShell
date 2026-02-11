# Nexa Interface Experiment — Task Prompts

Progressive difficulty tasks for comparing DOMShell vs raw HTML across Nexa and Ollama backends.

## Model

Qwen3-4B (same weights on both nexa serve and Ollama)

## Task Strings

All tasks use the same article to eliminate URL variability.

### Task 1: Page Title (trivial)

```
Open https://en.wikipedia.org/wiki/Artificial_intelligence and tell me the page title.
```

**Capability tested:** Read metadata from first tool response
**Expected tool calls:** 1

### Task 2: H1 Heading (simple extraction)

```
Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the text of the main heading (h1) on the page.
```

**Capability tested:** Make a targeted second tool call
**Expected tool calls:** 1-2

### Task 3: First Paragraph (scoped extraction)

```
Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first paragraph of the article. Return the exact text, do not summarize.
```

**Capability tested:** Navigate DOM structure + extract specific content
**Expected tool calls:** 2-4 (DOMShell) / 2 (HTML)

### Task 4: Count Section Headings (extract + synthesize)

```
Open https://en.wikipedia.org/wiki/Artificial_intelligence and count how many top-level section headings (h2) are on the page. Return just the number.
```

**Capability tested:** Extract structured data + post-process (count)
**Expected tool calls:** 2-3

### Task 5: Extract 5 Links (multi-element structured extraction)

```
Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first 5 hyperlinks from the article body. For each link, return the display text and URL.
```

**Capability tested:** Scoped multi-field extraction
**Expected tool calls:** 3-5 (DOMShell) / 2 (HTML)

## Trial Matrix

20 trials: 5 tasks x 2 backends x 2 interfaces

| Trial | Task | Backend | Interface | Agent | Max Turns |
|-------|------|---------|-----------|-------|-----------|
| 1 | T1: Title | Nexa serve | DOMShell | agent.py --mode compact | 5 |
| 2 | T1: Title | Nexa serve | Raw HTML | raw_html_agent.py | 5 |
| 3 | T1: Title | Ollama | DOMShell | agent.py --mode compact | 5 |
| 4 | T1: Title | Ollama | Raw HTML | raw_html_agent.py | 5 |
| 5 | T2: H1 | Nexa serve | DOMShell | agent.py --mode compact | 5 |
| 6 | T2: H1 | Nexa serve | Raw HTML | raw_html_agent.py | 5 |
| 7 | T2: H1 | Ollama | DOMShell | agent.py --mode compact | 5 |
| 8 | T2: H1 | Ollama | Raw HTML | raw_html_agent.py | 5 |
| 9 | T3: Paragraph | Nexa serve | DOMShell | agent.py --mode compact | 8 |
| 10 | T3: Paragraph | Nexa serve | Raw HTML | raw_html_agent.py | 8 |
| 11 | T3: Paragraph | Ollama | DOMShell | agent.py --mode compact | 8 |
| 12 | T3: Paragraph | Ollama | Raw HTML | raw_html_agent.py | 8 |
| 13 | T4: Headings | Nexa serve | DOMShell | agent.py --mode compact | 8 |
| 14 | T4: Headings | Nexa serve | Raw HTML | raw_html_agent.py | 8 |
| 15 | T4: Headings | Ollama | DOMShell | agent.py --mode compact | 8 |
| 16 | T4: Headings | Ollama | Raw HTML | raw_html_agent.py | 8 |
| 17 | T5: Links | Nexa serve | DOMShell | agent.py --mode compact | 10 |
| 18 | T5: Links | Nexa serve | Raw HTML | raw_html_agent.py | 10 |
| 19 | T5: Links | Ollama | DOMShell | agent.py --mode compact | 10 |
| 20 | T5: Links | Ollama | Raw HTML | raw_html_agent.py | 10 |

## Backend Endpoints

- **Nexa serve**: `http://127.0.0.1:18181/v1`
- **Ollama**: `http://127.0.0.1:11434/v1`

## Notes

- DOMShell trials use compact mode (single `domshell_execute` tool)
- DOMShell trials require `--allow-write` for `open` command
- Raw HTML trials are self-contained (no MCP server needed)
- All tasks use the same Wikipedia article to eliminate URL variability
- Tasks progress from trivial (T1) to challenging (T5) to find where interfaces diverge
