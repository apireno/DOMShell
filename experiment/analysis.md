# Experiment Analysis

Fill in after all 12 trials are complete. Correctness scored against `ground_truth.md`.

## Per-Task Comparison

### Task 1: Content Extraction (read-only)

| Metric | DOMShell (avg of 2) | Claude in Chrome (avg of 2) | Winner |
|--------|------------------------|---------------------------|--------|
| Tool calls | | | |
| Wall clock time (s) | | | |
| Correctness (0-3) | | | |
| Completeness | | | |
| Hallucination rate | | | |
| Timeout rate | | | |

**Typical tool sequence (AS):**
**Typical tool sequence (CiC):**

### Task 2: Search + Navigate (interaction required)

| Metric | DOMShell (avg of 2) | Claude in Chrome (avg of 2) | Winner |
|--------|------------------------|---------------------------|--------|
| Tool calls | | | |
| Wall clock time (s) | | | |
| Correctness (0-3) | | | |
| Completeness | | | |
| Hallucination rate | | | |
| Timeout rate | | | |

**Typical tool sequence (AS):**
**Typical tool sequence (CiC):**

### Task 3: Multi-step Info Gathering (cross-page)

| Metric | DOMShell (avg of 2) | Claude in Chrome (avg of 2) | Winner |
|--------|------------------------|---------------------------|--------|
| Tool calls | | | |
| Wall clock time (s) | | | |
| Correctness (0-3) | | | |
| Completeness | | | |
| Hallucination rate | | | |
| Timeout rate | | | |

**Typical tool sequence (AS):**
**Typical tool sequence (CiC):**

---

## Overall Averages (all 6 trials per method)

| Metric | DOMShell | Claude in Chrome | Winner |
|--------|-------------|-----------------|--------|
| Avg tool calls | | | |
| Avg wall clock time (s) | | | |
| Avg correctness (0-3) | | | |
| Avg completeness | | | |
| Hallucination rate | | | |
| Timeout rate | | | |

---

## Efficiency Ratios

**Tool call ratio** (AS / CiC): ___
- < 1.0 → DOMShell uses fewer tool calls

**Speed ratio** (AS / CiC): ___
- < 1.0 → DOMShell is faster

---

## Qualitative Observations

### Where DOMShell excelled
(fill in)

### Where DOMShell struggled
(fill in)

### Where Claude in Chrome excelled
(fill in)

### Where Claude in Chrome struggled
(fill in)

### Common failure modes
(fill in — e.g., "both methods struggled with finding the See also section because...")

### Tool design insights
(fill in — what does the data suggest about filesystem metaphor vs. structured API for LLM tool use?)

---

## Conclusion

**Which tool design is faster?**

**Which tool design is more accurate?**

**Which tool design uses fewer tool calls?**

**For what task types does each method work best?**

**Recommendations for DOMShell development:**
