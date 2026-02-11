# Nexa Claude Experiment — Task Prompts

Progressive difficulty tasks for comparing Qwen3-1.7B vs Qwen3-4B on DOMShell.

## Model

Qwen3-1.7B and Qwen3-4B (via nexa serve, MLX 4-bit)

## Task Strings

All tasks use the same article to eliminate URL variability.

### Task 1: Page Title (trivial)

```
Open https://en.wikipedia.org/wiki/Artificial_intelligence and tell me the page title.
```

**Capability tested:** Read metadata from first tool response
**Expected tool calls:** 1 (open)

### Task 2: H1 Heading (simple extraction)

```
Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the text of the main heading (h1) on the page.
```

**Capability tested:** Make a targeted second tool call
**Expected tool calls:** 1-2 (open, then find/text)

### Task 3: First Paragraph (scoped extraction)

```
Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first paragraph of the article. Return the exact text, do not summarize.
```

**Capability tested:** Navigate DOM structure + extract specific content
**Expected tool calls:** 2-4 (open, find/cd, text)

### Task 4: Count Section Headings (extract + synthesize)

```
Open https://en.wikipedia.org/wiki/Artificial_intelligence and count how many top-level section headings (h2) are on the page. Return just the number.
```

**Capability tested:** Extract structured data + post-process (count)
**Expected tool calls:** 2-3 (open, find headings, count)

### Task 5: Extract 5 Links (multi-element structured extraction)

```
Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first 5 hyperlinks from the article body. For each link, return the display text and URL.
```

**Capability tested:** Scoped multi-field extraction
**Expected tool calls:** 3-5 (open, navigate to article body, extract links)

## Trial Matrix

10 trials: 5 tasks x 2 models (compact mode only)

| Trial | Task | Model | Max Turns |
|-------|------|-------|-----------|
| 1 | T1: Title | Qwen3-1.7B | 5 |
| 2 | T1: Title | Qwen3-4B | 5 |
| 3 | T2: H1 heading | Qwen3-1.7B | 5 |
| 4 | T2: H1 heading | Qwen3-4B | 5 |
| 5 | T3: First paragraph | Qwen3-1.7B | 8 |
| 6 | T3: First paragraph | Qwen3-4B | 8 |
| 7 | T4: Count headings | Qwen3-1.7B | 8 |
| 8 | T4: Count headings | Qwen3-4B | 8 |
| 9 | T5: Extract 5 links | Qwen3-1.7B | 10 |
| 10 | T5: Extract 5 links | Qwen3-4B | 10 |

## Notes

- All trials use compact mode (single `domshell_execute` tool) — full mode with 21 tools overwhelms small models
- All trials use nexa serve endpoint `http://127.0.0.1:18181/v1`
- All trials require `--allow-write` for the `open` command
- Tasks progress from trivial (T1) to challenging (T5) to find the capability cliff
