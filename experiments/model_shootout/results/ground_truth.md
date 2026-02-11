# Ground Truth — Model Shootout Experiment

Article: https://en.wikipedia.org/wiki/Artificial_intelligence
Snapshot taken: 2026-02-08. Wikipedia content may drift — re-verify if running trials days apart.

---

## Task 1: Page Title

**Expected answer:** "Artificial intelligence" (or "Artificial intelligence - Wikipedia")

**Scoring:**
- 3: Returns "Artificial intelligence" (exact or with "- Wikipedia" suffix)
- 2: Returns a close variant (e.g., different casing)
- 1: Returns something related but not the title
- 0: Wrong answer, hallucinated, or no answer

---

## Task 2: H1 Heading

**Expected answer:** "Artificial intelligence"

**Scoring:**
- 3: Returns "Artificial intelligence" (extracted via tool call)
- 2: Returns the title from open/fetch metadata (correct but didn't extract h1)
- 1: Returns a heading but not h1 (e.g., a section heading)
- 0: Wrong, hallucinated, or no tool calls

---

## Task 3: First Paragraph

**Expected answer:** The opening paragraph beginning with:

> "Artificial intelligence (AI) is the capability of computational systems to perform tasks typically associated with human intelligence, such as learning, reasoning, problem-solving, perception, and decision-making. It is a field of research in computer science that develops and studies methods and software that enable machines to perceive their environment and use learning and intelligence to take actions that maximize their chances of achieving defined goals."

**Scoring:**
- 3: Returns the actual first paragraph text (must be real content from the page)
- 2: Returns a paragraph from the article but not the first one
- 1: Returns some relevant content but not a clean paragraph
- 0: Hallucinated, summarized from memory, or no answer

---

## Task 4: Count Section Headings

**Expected answer:** ~10

Major h2 sections: Goals, Approaches, Applications, Ethics and safety, History, Philosophy, See also, References, Further reading, External links

**Scoring:**
- 3: Returns a number within +/- 1 of the correct count
- 2: Returns a number in the right ballpark (7-13)
- 1: Returns a list of headings but no count, or a very wrong count
- 0: No answer, hallucinated, or completely wrong

---

## Task 5: First 5 Links

**Expected answer:** The first 5 hyperlinks in the article body (from the first paragraph):

1. computational systems -> /wiki/Computer
2. human intelligence -> /wiki/Human_intelligence
3. learning -> /wiki/Learning
4. reasoning -> /wiki/Reason
5. problem-solving -> /wiki/Problem-solving

(These may shift with Wikipedia edits. Must be real links from the article.)

**Scoring:**
- 3: Returns 5 real links from the article body with both display text and URLs
- 2: Returns some real links but fewer than 5, or missing URLs, or includes nav links
- 1: Returns links but mostly from navigation/sidebar, or hallucinated links
- 0: No links extracted, hallucinated, or no answer

---

## General Scoring Rubric

### Hallucination

Binary: Did the agent fabricate any content that doesn't exist on the page? One fabrication = Yes.
