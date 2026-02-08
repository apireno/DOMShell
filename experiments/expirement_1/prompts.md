# Experiment Prompts

Each prompt has two versions: one for DOMShell (Method A) and one for Claude in Chrome (Method B). Copy-paste exactly — the guardrail preamble is intentional.

## How to Use

1. Open a **new Cowork session** in Claude Desktop (clean context — no carryover)
2. Copy the exact prompt block for the trial you're running
3. Paste it into the Cowork chat and let the agent work — **do not intervene**
4. When the agent produces its final answer, count tool calls and score against `results/ground_truth.md`

For the **shortcut method** (all 6 trials of one method in a single session), paste each prompt sequentially. Warm trials benefit from conversation context — note this in your methodology.

---

## Shared Preamble (baked into every prompt)

The preamble below is already included in each prompt. Do NOT modify it.

**Purpose of the preamble:**
- "Do not use prior knowledge" → forces the agent to actually read from the page, not recite from training data
- "If you cannot find an element after 3 attempts, skip it" → prevents infinite retry loops on gnarly DOM
- "Do not explore beyond what is needed" → stops the agent from doing a full page audit when we only need specific items
- "Return partial results if you run out of time" → ensures we always get scoreable output

---

## Task 1: Content Extraction

### Trial 1 / Trial 3: Task 1 — DOMShell

```
RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to the page and read its content using your tools. Do NOT use prior knowledge or training data to answer. Every fact in your response must come from what you read on the page.
- If you cannot find an element after 3 attempts, skip it and note it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 15 tool calls, wrap up immediately with whatever you have.
- Return partial results rather than nothing.

TASK:
Go to https://en.wikipedia.org/wiki/Artificial_intelligence. Extract the first paragraph of the article body (not the sidebar or infobox). Then list the first 10 hyperlinks in the article body with their display text and full URLs.

OUTPUT FORMAT:
## First Paragraph
(paste the paragraph text)

## Links
1. [display text](URL)
2. [display text](URL)
... (up to 10)
```

### Trial 2 / Trial 4: Task 1 — Claude in Chrome

```
RULES — read these first:
- You MUST use your browser tools (navigate, read_page, find, get_page_text, etc.) to complete this task. Do NOT use domshell or any external MCP tools.
- You MUST actually navigate to the page and read its content using your tools. Do NOT use prior knowledge or training data to answer. Every fact in your response must come from what you read on the page.
- If you cannot find an element after 3 attempts, skip it and note it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 15 tool calls, wrap up immediately with whatever you have.
- Return partial results rather than nothing.

TASK:
Go to https://en.wikipedia.org/wiki/Artificial_intelligence. Extract the first paragraph of the article body (not the sidebar or infobox). Then list the first 10 hyperlinks in the article body with their display text and full URLs.

OUTPUT FORMAT:
## First Paragraph
(paste the paragraph text)

## Links
1. [display text](URL)
2. [display text](URL)
... (up to 10)
```

---

## Task 2: Search + Navigate

### Trial 5 / Trial 7: Task 2 — Claude in Chrome

```
RULES — read these first:
- You MUST use your browser tools (navigate, read_page, find, get_page_text, form_input, etc.) to complete this task. Do NOT use domshell or any external MCP tools.
- You MUST actually navigate to each page and read its content using your tools. Do NOT use prior knowledge or training data to answer. Every fact in your response must come from what you read on the page.
- If you cannot find an element after 3 attempts, skip it and note it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 20 tool calls, wrap up immediately with whatever you have.
- Return partial results rather than nothing.

TASK:
Go to https://en.wikipedia.org. Search for "machine learning" using the search box. On the results page, click the first result. Then extract the first paragraph of the article and list all items in the "See also" section.

OUTPUT FORMAT:
## First Paragraph
(paste the paragraph text)

## See Also
1. item
2. item
... (all items)
```

### Trial 6 / Trial 8: Task 2 — DOMShell

```
RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to each page and read its content using your tools. Do NOT use prior knowledge or training data to answer. Every fact in your response must come from what you read on the page.
- If you cannot find an element after 3 attempts, skip it and note it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 20 tool calls, wrap up immediately with whatever you have.
- Return partial results rather than nothing.

TASK:
Go to https://en.wikipedia.org. Search for "machine learning" using the search box. On the results page, click the first result. Then extract the first paragraph of the article and list all items in the "See also" section.

OUTPUT FORMAT:
## First Paragraph
(paste the paragraph text)

## See Also
1. item
2. item
... (all items)
```

---

## Task 3: Multi-step Information Gathering

### Trial 9 / Trial 11: Task 3 — DOMShell

```
RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to each page and read its content using your tools. Do NOT use prior knowledge or training data to answer. Every fact in your response must come from what you read on the page.
- If you cannot find an element after 3 attempts, skip it and note it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 25 tool calls, wrap up immediately with whatever you have.
- Return partial results rather than nothing.

TASK:
Go to https://en.wikipedia.org/wiki/Large_language_model. Find the table or list of large language models. Extract the names and organizations of the first 5 models listed. Then follow the Wikipedia link for the first model in the list and extract the first paragraph of that model's page.

OUTPUT FORMAT:
## Models
| # | Model | Organization |
|---|-------|-------------|
| 1 | name | org |
| 2 | name | org |
| 3 | name | org |
| 4 | name | org |
| 5 | name | org |

## First Model's Page
(paste the first paragraph from that model's Wikipedia article)
```

### Trial 10 / Trial 12: Task 3 — Claude in Chrome

```
RULES — read these first:
- You MUST use your browser tools (navigate, read_page, find, get_page_text, etc.) to complete this task. Do NOT use domshell or any external MCP tools.
- You MUST actually navigate to each page and read its content using your tools. Do NOT use prior knowledge or training data to answer. Every fact in your response must come from what you read on the page.
- If you cannot find an element after 3 attempts, skip it and note it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 25 tool calls, wrap up immediately with whatever you have.
- Return partial results rather than nothing.

TASK:
Go to https://en.wikipedia.org/wiki/Large_language_model. Find the table or list of large language models. Extract the names and organizations of the first 5 models listed. Then follow the Wikipedia link for the first model in the list and extract the first paragraph of that model's page.

OUTPUT FORMAT:
## Models
| # | Model | Organization |
|---|-------|-------------|
| 1 | name | org |
| 2 | name | org |
| 3 | name | org |
| 4 | name | org |
| 5 | name | org |

## First Model's Page
(paste the first paragraph from that model's Wikipedia article)
```

---

## Tool Call Caps Summary

| Task | Complexity | Tool call cap |
|------|-----------|--------------|
| Task 1 | Read-only extraction | 15 calls |
| Task 2 | Search + navigate + extract | 20 calls |
| Task 3 | Multi-page navigation + table extraction | 25 calls |

Wall clock time is informative but not enforced in Cowork (interactive sessions). Tool call count is the primary efficiency metric.
