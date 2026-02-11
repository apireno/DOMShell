# Experiment: Model Shootout (Tool-Calling Specialists)

## Hypothesis

Models purpose-built for tool/function calling will break through the T3 capability cliff observed with Qwen3-4B, even at smaller parameter counts.

## What We're Testing

Four models on Ollama + DOMShell compact mode (the strongest backend+interface combination from nexa_ollama results).

| Model | Size | Why Selected |
|-------|------|-------------|
| **Qwen3-4B** (baseline) | 4B | Current best, 0.971 F1 on Docker eval but hits T3 cliff |
| **Hermes 3** | 3B | NousResearch, purpose-built for function calling + structured output |
| **IBM Granite 4 Tiny** | ~1B (hybrid Mamba-2) | IBM's agentic tool-calling architecture, smallest model tested |
| **Llama 3.2** | 3B | Meta's tool-calling fine-tuned model, BFCL V2 score 67.0 |

## Tasks (Progressive Difficulty)

All tasks use the same Wikipedia article: https://en.wikipedia.org/wiki/Artificial_intelligence

| Task | Goal | Expected Calls | Max Turns |
|------|------|----------------|-----------|
| **T1: Title** | Return the page title | 1 | 5 |
| **T2: H1 heading** | Extract the main heading text | 1-2 | 5 |
| **T3: First paragraph** | Extract the first paragraph verbatim | 2-4 | 8 |
| **T4: Count headings** | Count how many h2 sections exist | 2-3 | 8 |
| **T5: Extract 5 links** | Return first 5 article links with text + URL | 3-5 | 10 |

## Trial Matrix

20 trials: 5 tasks x 4 models

| | Qwen3-4B | Hermes3-3B | Granite4-Tiny | Llama3.2-3B |
|---|---|---|---|---|
| **T1: Title** | Trial 1 | Trial 2 | Trial 3 | Trial 4 |
| **T2: H1** | Trial 5 | Trial 6 | Trial 7 | Trial 8 |
| **T3: Paragraph** | Trial 9 | Trial 10 | Trial 11 | Trial 12 |
| **T4: Headings** | Trial 13 | Trial 14 | Trial 15 | Trial 16 |
| **T5: Links** | Trial 17 | Trial 18 | Trial 19 | Trial 20 |

All trials: Ollama backend, DOMShell compact mode.

## Metrics

- **Correctness** (0-3 scale: 0=wrong, 1=partial, 2=mostly correct, 3=correct)
- **Tool calls** (fewer = more efficient)
- **Hallucination** (binary: did the model fabricate content?)

## How to Reproduce

```bash
# 1. Start Ollama
ollama serve

# 2. Pull models
ollama pull qwen3:4b
ollama pull hermes3:3b
ollama pull ibm/granite4:tiny-h-q4_K_M
ollama pull llama3.2:3b

# 3. Start DOMShell MCP server (separate terminal)
cd mcp-server && npx tsx index.ts --no-confirm --allow-all

# 4. Run all trials
bash experiments/model_shootout/run_trials.sh
```

## File Structure

```
experiments/model_shootout/
├── README.md               <- You are here
├── run_trials.sh           <- Automated runner script
└── results/
    ├── ground_truth.md     <- Expected answers
    ├── results.md          <- Full trial data (populated after running)
    ├── analysis.md         <- Analysis (populated after running)
    └── raw_output/         <- Raw agent output per trial
```
