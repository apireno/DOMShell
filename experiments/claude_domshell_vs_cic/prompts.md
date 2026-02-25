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
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

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
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

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
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

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
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

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
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

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
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

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

## Task 4: Pagination + Comment Extraction (Hacker News)

### Trial 13 / Trial 15: Task 4 — DOMShell

```
RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to the page and read its content using your tools. Do NOT use prior knowledge or training data to answer. Every fact in your response must come from what you read on the page.
- If you cannot find an element after 3 attempts, skip it and note it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 20 tool calls, wrap up immediately with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

TASK:
Go to https://news.ycombinator.com/. Extract the title, URL, and point count of stories ranked #1 and #30 on the front page. Then click "More" at the bottom to go to page 2 and extract the title and URL of the first story (ranked #31). Finally, go back to page 1, navigate to the comments page of story #1, and extract the username and first sentence of the top 3 comments.

OUTPUT FORMAT:
## Page 1
### Story #1
- Title: ...
- URL: ...
- Points: ...

### Story #30
- Title: ...
- URL: ...
- Points: ...

## Page 2
### Story #31
- Title: ...
- URL: ...

## Comments (Story #1)
1. [username]: [first sentence]
2. [username]: [first sentence]
3. [username]: [first sentence]
```

### Trial 14 / Trial 16: Task 4 — Claude in Chrome

```
RULES — read these first:
- You MUST use your browser tools (navigate, read_page, find, get_page_text, etc.) to complete this task. Do NOT use domshell or any external MCP tools.
- You MUST actually navigate to the page and read its content using your tools. Do NOT use prior knowledge or training data to answer. Every fact in your response must come from what you read on the page.
- If you cannot find an element after 3 attempts, skip it and note it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 20 tool calls, wrap up immediately with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

TASK:
Go to https://news.ycombinator.com/. Extract the title, URL, and point count of stories ranked #1 and #30 on the front page. Then click "More" at the bottom to go to page 2 and extract the title and URL of the first story (ranked #31). Finally, go back to page 1, navigate to the comments page of story #1, and extract the username and first sentence of the top 3 comments.

OUTPUT FORMAT:
## Page 1
### Story #1
- Title: ...
- URL: ...
- Points: ...

### Story #30
- Title: ...
- URL: ...
- Points: ...

## Page 2
### Story #31
- Title: ...
- URL: ...

## Comments (Story #1)
1. [username]: [first sentence]
2. [username]: [first sentence]
3. [username]: [first sentence]
```

---

## Tool Call Caps Summary

| Task | Complexity | Tool call cap |
|------|-----------|--------------|
| Task 1 | Read-only extraction | 15 calls |
| Task 2 | Search + navigate + extract | 20 calls |
| Task 3 | Multi-page navigation + table extraction | 25 calls |
| Task 4 | Pagination + comment extraction | 20 calls |

Wall clock time is informative but not enforced in Cowork (interactive sessions). Tool call count is the primary efficiency metric.

---

## Task 5: Cross-Article Section Comparison

### Trial 17: Task 5 — DOMShell

```
RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to each page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 15 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

HINT: After opening multiple tabs, use "each --pattern wiki eval <JS>" to run
the same extraction across all Wikipedia tabs in ONE tool call instead of
extracting from each tab individually.

TASK:
Open these 3 Wikipedia articles in separate tabs:
1. https://en.wikipedia.org/wiki/Artificial_intelligence
2. https://en.wikipedia.org/wiki/Machine_learning
3. https://en.wikipedia.org/wiki/Deep_learning

Extract all h2 section headings from each article. Then identify which h2 headings
appear in ALL 3 articles (common sections).

OUTPUT FORMAT:
## Article 1: Artificial Intelligence
- heading1
- heading2
...

## Article 2: Machine Learning
- heading1
- heading2
...

## Article 3: Deep Learning
- heading1
- heading2
...

## Common Sections (in all 3)
- heading1
- heading2
...
```

### Trial 18: Task 5 — Claude in Chrome

```
RULES — read these first:
- You MUST use your browser tools (navigate, read_page, find, get_page_text, etc.) to complete this task. Do NOT use domshell or any external MCP tools.
- You MUST actually navigate to each page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 15 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

TASK:
Navigate to these 3 Wikipedia articles one at a time:
1. https://en.wikipedia.org/wiki/Artificial_intelligence
2. https://en.wikipedia.org/wiki/Machine_learning
3. https://en.wikipedia.org/wiki/Deep_learning

Extract all h2 section headings from each article. Then identify which h2 headings
appear in ALL 3 articles (common sections).

OUTPUT FORMAT:
## Article 1: Artificial Intelligence
- heading1
- heading2
...

## Article 2: Machine Learning
- heading1
- heading2
...

## Article 3: Deep Learning
- heading1
- heading2
...

## Common Sections (in all 3)
- heading1
- heading2
...
```

---

## Task 6: See-Also Link Chasing

### Trial 19: Task 6 — DOMShell

```
RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to each page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 20 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

HINT: Use "for" to open multiple URLs in one call:
  for "eval [...document.querySelectorAll('#See_also ~ ul a')].slice(0,5).map(a=>a.href).join('\n')" : open {}
Then use "each --pattern wiki eval <JS>" to extract from all open tabs at once.

TASK:
Go to https://en.wikipedia.org/wiki/Artificial_intelligence. Find the "See also"
section. Take the first 5 links from "See also". Open each linked article in a
new tab. Extract the first sentence from each of those 5 articles.

OUTPUT FORMAT:
## See Also Links from AI Article
1. [Article Title] — first sentence
2. [Article Title] — first sentence
3. [Article Title] — first sentence
4. [Article Title] — first sentence
5. [Article Title] — first sentence
```

### Trial 20: Task 6 — Claude in Chrome

```
RULES — read these first:
- You MUST use your browser tools (navigate, read_page, find, get_page_text, etc.) to complete this task. Do NOT use domshell or any external MCP tools.
- You MUST actually navigate to each page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 20 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

TASK:
Go to https://en.wikipedia.org/wiki/Artificial_intelligence. Find the "See also"
section. Take the first 5 links from "See also". Navigate to each linked article
and extract the first sentence from each.

OUTPUT FORMAT:
## See Also Links from AI Article
1. [Article Title] — first sentence
2. [Article Title] — first sentence
3. [Article Title] — first sentence
4. [Article Title] — first sentence
5. [Article Title] — first sentence
```

---

## Task 7: Page API Discovery

### Trial 21: Task 7 — DOMShell

```
RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to each page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 15 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

HINT: Use "functions" to discover callable JavaScript functions on the page.
Wikipedia pages have a MediaWiki API accessible via mw.config.get().

TASK:
Go to https://en.wikipedia.org/wiki/Artificial_intelligence.

1. Use "functions" to list the callable window-level functions. Report the first
   10 function names that are NOT standard browser APIs (focus on MediaWiki/Wikipedia-specific ones).

2. Use eval to extract these MediaWiki config values in one call:
   - wgPageName
   - wgTitle
   - wgArticleId
   - wgRevisionId
   - wgCategories (first 5)

3. Use eval to call the Wikipedia REST API and get the page summary:
   eval fetch('/api/rest_v1/page/summary/Artificial_intelligence').then(r=>r.json()).then(d=>d.extract)

OUTPUT FORMAT:
## Page Functions (first 10 non-standard)
1. functionName
...

## MediaWiki Config
- wgPageName: ...
- wgTitle: ...
- wgArticleId: ...
- wgRevisionId: ...
- wgCategories: ...

## REST API Summary
(paste the extract text)
```

### Trial 22: Task 7 — Claude in Chrome

```
RULES — read these first:
- You MUST use your browser tools (navigate, read_page, find, get_page_text, javascript_exec, etc.) to complete this task. Do NOT use domshell or any external MCP tools.
- You MUST actually navigate to each page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 15 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

TASK:
Go to https://en.wikipedia.org/wiki/Artificial_intelligence.

1. Use javascript_exec to discover what MediaWiki/Wikipedia-specific global functions
   are available on the page. Report 10 non-standard function names.

2. Use javascript_exec to extract these MediaWiki config values:
   - wgPageName
   - wgTitle
   - wgArticleId
   - wgRevisionId
   - wgCategories (first 5)

3. Use javascript_exec to call the Wikipedia REST API and get the page summary:
   fetch('/api/rest_v1/page/summary/Artificial_intelligence').then(r=>r.json()).then(d=>d.extract)

OUTPUT FORMAT:
## Page Functions (first 10 non-standard)
1. functionName
...

## MediaWiki Config
- wgPageName: ...
- wgTitle: ...
- wgArticleId: ...
- wgRevisionId: ...
- wgCategories: ...

## REST API Summary
(paste the extract text)
```

---

## Task 8: Article Network Mapping

### Trial 23: Task 8 — DOMShell

```
RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to each page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 20 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

HINT: Use "for" to open linked articles in one call:
  for "eval [...document.querySelector('.mw-parser-output > p').querySelectorAll('a[href^=\"/wiki/\"]')].slice(0,3).map(a=>'https://en.wikipedia.org'+a.getAttribute('href')).join('\n')" : open {}
Then use "each --pattern wiki eval <JS>" to extract structured data from all tabs at once.

TASK:
Go to https://en.wikipedia.org/wiki/Artificial_intelligence. Find the first 3
hyperlinks in the first paragraph of the article body (links to other Wikipedia
articles, not external links).

Open each linked article in a new tab. For ALL 4 articles (the original AI
article + the 3 linked articles), extract:
- Article title
- First sentence of the article
- Number of references (count of elements in the References section)

OUTPUT FORMAT:
## Article Network
| # | Title | First Sentence | Ref Count |
|---|-------|----------------|-----------|
| 1 | Artificial intelligence | ... | N |
| 2 | [linked article] | ... | N |
| 3 | [linked article] | ... | N |
| 4 | [linked article] | ... | N |
```

### Trial 24: Task 8 — Claude in Chrome

```
RULES — read these first:
- You MUST use your browser tools (navigate, read_page, find, get_page_text, javascript_exec, etc.) to complete this task. Do NOT use domshell or any external MCP tools.
- You MUST actually navigate to each page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 20 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

TASK:
Go to https://en.wikipedia.org/wiki/Artificial_intelligence. Find the first 3
hyperlinks in the first paragraph of the article body (links to other Wikipedia
articles, not external links).

Navigate to each linked article. For ALL 4 articles (the original AI article + the 3
linked articles), extract:
- Article title
- First sentence of the article
- Number of references (count of elements in the References section)

OUTPUT FORMAT:
## Article Network
| # | Title | First Sentence | Ref Count |
|---|-------|----------------|-----------|
| 1 | Artificial intelligence | ... | N |
| 2 | [linked article] | ... | N |
| 3 | [linked article] | ... | N |
| 4 | [linked article] | ... | N |
```

---

## Task 9: Dynamic Page Monitoring

### Trial 25: Task 9 — DOMShell

```
RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to the page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 15 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

HINT: Use "functions" to discover what's callable, "call funcName args" to invoke
functions, and "watch cmd --until-change --interval 1" to detect when the clock changes.

TASK:
Open https://www.time.gov/

1. Use "functions" to discover the page's callable functions. List all NON-STANDARD
   functions (exclude browser builtins like alert, fetch, setTimeout, etc.).

2. Call checkTime(5) and report the returned value.

3. Read the current time displayed on the page (find the element with id "myTime").

4. Use "watch" with --until-change to detect when the displayed time changes.
   Report the before and after values.

5. Read the UTC time (element with id "timeUTC") and compare it to the local time.

OUTPUT FORMAT:
## Discovered Functions
- function1()
- function2(args)
...

## Function Calls
- checkTime(5): [value]

## Current Time
- Local time (#myTime): [value]
- UTC time (#timeUTC): [value]
- Offset: [difference]

## Change Detection
- Before: [value]
- After: [value]
- Detected at iteration: [N]
```

### Trial 26: Task 9 — Claude in Chrome

```
RULES — read these first:
- You MUST use your browser tools (navigate, read_page, find, get_page_text, javascript_exec, etc.) to complete this task. Do NOT use domshell or any external MCP tools.
- You MUST actually navigate to the page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 15 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

TASK:
Navigate to https://www.time.gov/

1. Use javascript_exec to discover what callable functions are defined on window
   (not standard browser APIs). List them all.
   HINT: Create a hidden iframe to get the default window properties, then diff
   against the current window: Object.getOwnPropertyNames(window).filter(k =>
   typeof window[k] === 'function' && !defaultKeys.has(k))

2. Call checkTime(5) via javascript_exec and report the returned value.

3. Read the current time displayed on the page (find the element with id "myTime").

4. Read the time again after a short wait. Report the before and after values.
   HINT: Top-level await is NOT supported in javascript_exec. Use a Promise wrapper:
   new Promise(resolve => {
     const before = document.getElementById('myTime').textContent.trim();
     setTimeout(() => {
       const after = document.getElementById('myTime').textContent.trim();
       resolve(JSON.stringify({ before, after }));
     }, 2000);
   })

5. Read the UTC time (element with id "timeUTC") and compare it to the local time.

OUTPUT FORMAT:
## Discovered Functions
- function1()
- function2(args)
...

## Function Calls
- checkTime(5): [value]

## Current Time
- Local time (#myTime): [value]
- UTC time (#timeUTC): [value]
- Offset: [difference]

## Change Detection
- Before: [value]
- After: [value]
```

---

## Task 10: Search Pipeline with Replay

### Trial 27: Task 10 — DOMShell

```
RULES — read these first:
- You MUST use domshell MCP tools exclusively. No other browser tools.
- You MUST actually navigate to each page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 20 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

HINT: Save a 2-command script using direct URL navigation (faster than open+submit):
  script save wiki_direct navigate https://en.wikipedia.org/wiki/$1 ; eval document.querySelector('.mw-parser-output > p:not(.mw-empty-elt)').textContent
Then use "for" to run it for each article using underscore-separated slugs:
  for "eval ['Artificial_intelligence','Machine_learning','Deep_learning'].join('\n')" : script run wiki_direct "{}"
NOTE: Use underscore slugs (Artificial_intelligence) not spaces — direct URL
navigation avoids the search form entirely and is faster inside "for" loops.

TASK:
Search Wikipedia for 3 different topics: "Artificial intelligence", "Machine learning",
and "Deep learning". For each, extract the first sentence of the resulting article.

Do this efficiently by:
1. Saving a reusable search-and-extract script with variable substitution ($1)
2. Running the script for all 3 terms using a loop

Compare the first sentences and identify what they have in common.

OUTPUT FORMAT:
## Search Results
1. **Artificial intelligence**: first sentence
2. **Machine learning**: first sentence
3. **Deep learning**: first sentence

## Comparison
(what the 3 topics have in common based on their first sentences)
```

### Trial 28: Task 10 — Claude in Chrome

```
RULES — read these first:
- You MUST use your browser tools (navigate, read_page, find, get_page_text, form_input, etc.) to complete this task. Do NOT use domshell or any external MCP tools.
- You MUST actually navigate to each page and read its content using your tools.
  Do NOT use prior knowledge or training data to answer.
- If you cannot find an element after 3 attempts, skip it as "[not found]".
- Do not explore the page beyond what is needed for the task.
- Be fast and direct. Minimize unnecessary tool calls.
- If you are still working after 20 tool calls, wrap up with whatever you have.
- Return partial results rather than nothing.
- When done, close all tabs you opened during this task to keep the browser clean for the next task.

TASK:
Search Wikipedia for 3 different topics: "Artificial intelligence", "Machine learning",
and "Deep learning". For each, go to wikipedia.org, search using the search box,
click the first result, and extract the first sentence of the article.

Compare the first sentences and identify what they have in common.

OUTPUT FORMAT:
## Search Results
1. **Artificial intelligence**: first sentence
2. **Machine learning**: first sentence
3. **Deep learning**: first sentence

## Comparison
(what the 3 topics have in common based on their first sentences)
```

---

## Tool Call Caps Summary (Updated)

| Task | Complexity | Tool call cap |
|------|-----------|--------------|
| Task 1 | Read-only extraction | 15 calls |
| Task 2 | Search + navigate + extract | 20 calls |
| Task 3 | Multi-page navigation + table extraction | 25 calls |
| Task 4 | Pagination + comment extraction | 20 calls |
| Task 5 | Multi-tab heading comparison | 15 calls |
| Task 6 | Link chasing + multi-tab extraction | 20 calls |
| Task 7 | Page API discovery + REST call | 15 calls |
| Task 8 | Article network mapping (4 articles) | 20 calls |
| Task 9 | Dynamic page monitoring + function calls | 15 calls |
| Task 10 | Parameterized search pipeline | 20 calls |
