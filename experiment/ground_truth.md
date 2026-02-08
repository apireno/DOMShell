# Ground Truth Reference

Snapshot taken: 2026-02-07. Wikipedia content may drift — re-verify if running trials days apart.

---

## Task 1: Content Extraction

**Page:** https://en.wikipedia.org/wiki/Artificial_intelligence

### First Paragraph

"Artificial intelligence (AI) is the capability of computational systems to perform tasks typically associated with human intelligence, such as learning, reasoning, problem-solving, perception, and decision-making. It is a field of research in computer science that develops and studies methods and software that enable machines to perceive their environment and use learning and intelligence to take actions that maximize their chances of achieving defined goals."

### First 10 Links in Main Content

Note: The "first 10 links" depends on what counts as "main content." The sidebar/navbox links (Applications, Philosophy, History, Controversies, v/t/e) appear before the article body in the DOM. The first 10 **body** links (inside the lead paragraph and following text) are approximately:

1. computational systems → /wiki/Computer
2. human intelligence → /wiki/Human_intelligence
3. learning → /wiki/Learning
4. reasoning → /wiki/Reasoning
5. problem-solving → /wiki/Problem-solving
6. perception → /wiki/Perception
7. decision-making → /wiki/Decision-making
8. computer science → /wiki/Computer_science
9. software → /wiki/Software
10. defined goals → /wiki/Mathematical_optimization (or similar)

**Scoring note:** Accept any reasonable interpretation of "main content area." The key test is whether URLs are real Wikipedia links (not hallucinated) and whether titles match. Deduct for navbox/sidebar links only if the prompt said "article body."

---

## Task 2: Search + Navigate

**Page:** https://en.wikipedia.org/wiki/Machine_learning

### First Paragraph

"Machine learning (ML) is a field of study in artificial intelligence concerned with the development and study of statistical algorithms that can learn from data and generalize to unseen data, and thus perform tasks without explicit instructions. Within a subdiscipline in machine learning, advances in the field of deep learning have allowed neural networks, a class of statistical algorithms, to surpass many previous machine learning approaches in performance."

### "See also" Section Items

1. Automated machine learning
2. Big data
3. Deep learning
4. Differentiable programming
5. List of datasets for machine-learning research
6. List of machine learning algorithms / List of algorithms for machine learning and statistical classification
7. M-theory (learning framework)
8. Machine unlearning
9. Outline of machine learning
10. Solomonoff's theory of inductive inference

---

## Task 3: Multi-step Information Gathering

**Page:** https://en.wikipedia.org/wiki/Large_language_model

### First 5 Models in the Table

| # | Model | Organization |
|---|-------|-------------|
| 1 | GPT-1 | OpenAI |
| 2 | BERT | Google |
| 3 | T5 | Google |
| 4 | XLNet | Google |
| 5 | GPT-2 | OpenAI |

### First Model's Wikipedia Page

**GPT-1:** https://en.wikipedia.org/wiki/GPT-1

First paragraph of that page should describe GPT-1 as an early generative pre-trained transformer model by OpenAI.

---

## Scoring Rubric

### Correctness (0-3)

| Score | Definition |
|-------|-----------|
| 0 | Wrong page, completely fabricated content, or total failure |
| 1 | Right page but >50% of items wrong, missing, or hallucinated |
| 2 | Right page, most items correct, but some errors or omissions (1-3 items wrong) |
| 3 | All items correct and verifiable against this ground truth |

### Completeness

Count of requested items actually returned / total requested items. Express as a fraction (e.g., 8/10 links found).

### Hallucination

Binary: Did the agent fabricate any URL, title, name, or paragraph that doesn't exist on the page? Check every URL and title against ground truth. One fabrication = Yes.
