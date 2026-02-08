# Experiment Results

**Experimenter:** Alessandro Pireno
**Date:** 2026-02-07
**DOMShell model:** (fill in after AS trials)
**Claude in Chrome model:** claude-opus-4-6 (via Cowork)

**IMPORTANT CAVEAT:** All CiC trials were run in a single Cowork session. Repeat trials (4, 7, 12) benefited from same-session learning — the agent already knew which tool patterns worked and which failed. In a true fresh-session experiment, repeat trial tool counts would likely be closer to first-run numbers. First-run trials (2, 5, 10) are the most representative.

---

## Trial 1: Task 1 — DOMShell

**Task:** Content Extraction | **Method:** DOMShell

| Metric | Value |
|--------|-------|
| Tool calls | |
| Wall clock time (s) | |
| Correctness (0-3) | |
| Completeness | /10 links, paragraph: Y/N |
| Hallucination? | |
| Timed out? | |
| Input tokens | |
| Output tokens | |

**Tool call sequence:**

**Notes:**

---

## Trial 2: Task 1 — Claude in Chrome

**Task:** Content Extraction | **Method:** Claude in Chrome

| Metric | Value |
|--------|-------|
| Tool calls | 8 |
| Wall clock time (s) | 51 |
| Correctness (0-3) | 3 |
| Completeness | 10/10 links, paragraph: Y |
| Hallucination? | No |
| Timed out? | No |
| Input tokens | N/A |
| Output tokens | N/A |

**Tool call sequence:** `tabs_create → navigate → get_page_text(FAIL: too large) → javascript(FAIL: wrong action) → javascript(empty result) → javascript(debug structure) → javascript(paragraph + partial links) → javascript(full 10 links)`

**Notes:** First attempt at get_page_text failed because the AI article is >50K chars (224K). Had to fall back to javascript_tool for targeted DOM extraction. Also hit wrong action name on first JS attempt. Once the right selectors were found, extraction was clean. Links include "field of research" (not in original ground truth estimate) at position 8, pushing computer science to 9 and software to 10. All URLs verified real.

---

## Trial 3: Task 1 — DOMShell (repeat)

**Task:** Content Extraction | **Method:** DOMShell

| Metric | Value |
|--------|-------|
| Tool calls | |
| Wall clock time (s) | |
| Correctness (0-3) | |
| Completeness | /10 links, paragraph: Y/N |
| Hallucination? | |
| Timed out? | |
| Input tokens | |
| Output tokens | |

**Tool call sequence:**

**Notes:**

---

## Trial 4: Task 1 — Claude in Chrome (repeat)

**Task:** Content Extraction | **Method:** Claude in Chrome

| Metric | Value |
|--------|-------|
| Tool calls | 3 |
| Wall clock time (s) | 15 |
| Correctness (0-3) | 3 |
| Completeness | 10/10 links, paragraph: Y |
| Hallucination? | No |
| Timed out? | No |
| Input tokens | N/A |
| Output tokens | N/A |

**Tool call sequence:** `tabs_create → navigate → javascript(paragraph + all 10 links in one call)`

**Notes:** ⚠️ WARM SESSION — agent already knew get_page_text would fail and which JS selectors worked. Skipped directly to the optimal single-JS-call approach. In a fresh session this would likely be 6-8 calls (similar to Trial 2 minus the action-name mistake). This trial represents the theoretical best case, not a realistic cold start.

---

## Trial 5: Task 2 — Claude in Chrome

**Task:** Search + Navigate | **Method:** Claude in Chrome

| Metric | Value |
|--------|-------|
| Tool calls | 9 |
| Wall clock time (s) | 52 |
| Correctness (0-3) | 3 |
| Completeness | 10/10 see-also items, paragraph: Y |
| Hallucination? | No |
| Timed out? | No |
| Input tokens | N/A |
| Output tokens | N/A |

**Tool call sequence:** `tabs_create → navigate(REDIRECT: en.wikipedia.org→newtab) → navigate(Main_Page) → find(search box) → form_input("machine learning") → javascript(submit form) → javascript(check URL) → javascript(paragraph + partial see-also) → javascript(full see-also list)`

**Notes:** First navigate to bare "en.wikipedia.org" redirected to newtab (Chrome behavior) — had to retry with /wiki/Main_Page. Wikipedia auto-redirected search to the Machine Learning article (exact match). See-also extraction was truncated on first attempt due to output length of description text; needed a second pass to get clean item names only. All 10 items match ground truth exactly.

---

## Trial 6: Task 2 — DOMShell

**Task:** Search + Navigate | **Method:** DOMShell

| Metric | Value |
|--------|-------|
| Tool calls | |
| Wall clock time (s) | |
| Correctness (0-3) | |
| Completeness | /10 see-also items, paragraph: Y/N |
| Hallucination? | |
| Timed out? | |
| Input tokens | |
| Output tokens | |

**Tool call sequence:**

**Notes:**

---

## Trial 7: Task 2 — Claude in Chrome (repeat)

**Task:** Search + Navigate | **Method:** Claude in Chrome

| Metric | Value |
|--------|-------|
| Tool calls | 7 |
| Wall clock time (s) | 27 |
| Correctness (0-3) | 3 |
| Completeness | 10/10 see-also items, paragraph: Y |
| Hallucination? | No |
| Timed out? | No |
| Input tokens | N/A |
| Output tokens | N/A |

**Tool call sequence:** `tabs_create → navigate(Main_Page) → find(search box) → form_input("machine learning") → javascript(submit) → javascript(paragraph + all see-also in one call)`

**Notes:** ⚠️ WARM SESSION — agent knew to go to /wiki/Main_Page directly (not bare domain), and combined paragraph + see-also extraction into one optimized JS call. Saved 2 calls vs Trial 5. In a fresh session, expect ~9 calls.

---

## Trial 8: Task 2 — DOMShell (repeat)

**Task:** Search + Navigate | **Method:** DOMShell

| Metric | Value |
|--------|-------|
| Tool calls | |
| Wall clock time (s) | |
| Correctness (0-3) | |
| Completeness | /10 see-also items, paragraph: Y/N |
| Hallucination? | |
| Timed out? | |
| Input tokens | |
| Output tokens | |

**Tool call sequence:**

**Notes:**

---

## Trial 9: Task 3 — DOMShell

**Task:** Multi-step Info Gathering | **Method:** DOMShell

| Metric | Value |
|--------|-------|
| Tool calls | |
| Wall clock time (s) | |
| Correctness (0-3) | |
| Completeness | /5 models, first-model paragraph: Y/N |
| Hallucination? | |
| Timed out? | |
| Input tokens | |
| Output tokens | |

**Tool call sequence:**

**Notes:**

---

## Trial 10: Task 3 — Claude in Chrome

**Task:** Multi-step Info Gathering | **Method:** Claude in Chrome

| Metric | Value |
|--------|-------|
| Tool calls | 9 |
| Wall clock time (s) | 57 |
| Correctness (0-3) | 3 |
| Completeness | 5/5 models, first-model paragraph: Y |
| Hallucination? | No |
| Timed out? | No |
| Input tokens | N/A |
| Output tokens | N/A |

**Tool call sequence:** `tabs_create → navigate(LLM page) → javascript(look for wikitables: 0 found) → javascript(find all tables + list link) → navigate(List_of_large_language_models) → javascript(extract table: wrong column index) → javascript(extract 5 models correctly) → navigate(GPT-1) → javascript(first paragraph)`

**Notes:** The LLM article has no wikitable of models — only navboxes and metadata tables. Had to discover the link to "List of large language models" page programmatically, then navigate there. First table extraction used wrong column index (cells[1] = release date, not developer) — needed a second JS call with cells[2]. All 5 models match ground truth exactly: GPT-1/OpenAI, BERT/Google, T5/Google, XLNet/Google, GPT-2/OpenAI. GPT-1 first paragraph extracted successfully.

---

## Trial 11: Task 3 — DOMShell (repeat)

**Task:** Multi-step Info Gathering | **Method:** DOMShell

| Metric | Value |
|--------|-------|
| Tool calls | |
| Wall clock time (s) | |
| Correctness (0-3) | |
| Completeness | /5 models, first-model paragraph: Y/N |
| Hallucination? | |
| Timed out? | |
| Input tokens | |
| Output tokens | |

**Tool call sequence:**

**Notes:**

---

## Trial 12: Task 3 — Claude in Chrome (repeat)

**Task:** Multi-step Info Gathering | **Method:** Claude in Chrome

| Metric | Value |
|--------|-------|
| Tool calls | 7 |
| Wall clock time (s) | 32 |
| Correctness (0-3) | 3 |
| Completeness | 5/5 models, first-model paragraph: Y |
| Hallucination? | No |
| Timed out? | No |
| Input tokens | N/A |
| Output tokens | N/A |

**Tool call sequence:** `tabs_create → navigate(LLM page) → javascript(find list link) → navigate(List page) → javascript(extract 5 models) → navigate(GPT-1) → javascript(first paragraph)`

**Notes:** ⚠️ WARM SESSION — agent already knew the LLM page has no model table and that the list link exists. Skipped the exploratory table search and wrong-column-index error. Went straight to finding the link, navigating, and extracting with correct column. Saved 2 calls vs Trial 10. In a fresh session, expect ~9 calls.

---

## CiC Summary (for quick reference)

| Trial | Task | Tool Calls | Time (s) | Correct | Complete | Notes |
|-------|------|-----------|----------|---------|----------|-------|
| 2 | T1 | 8 | 51 | 3 | 10/10, Y | Cold start, multiple retries |
| 4 | T1 | 3 | 15 | 3 | 10/10, Y | ⚠️ Warm session |
| 5 | T2 | 9 | 52 | 3 | 10/10, Y | Cold start, nav retry |
| 7 | T2 | 7 | 27 | 3 | 10/10, Y | ⚠️ Warm session |
| 10 | T3 | 9 | 57 | 3 | 5/5, Y | Cold start, table discovery |
| 12 | T3 | 7 | 32 | 3 | 5/5, Y | ⚠️ Warm session |

**Cold-start averages (Trials 2, 5, 10):** 8.7 tool calls, 53s, correctness 3.0
**Warm-session averages (Trials 4, 7, 12):** 5.7 tool calls, 25s, correctness 3.0
**Best realistic estimate for CiC:** Use cold-start numbers (8-9 tool calls, ~50-55s per task)
