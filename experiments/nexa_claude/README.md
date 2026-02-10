# Experiment: DOMShell + Nexa (Local LLM)

## Hypothesis

Small local LLMs (1.7B–4B parameters) running via nexa-sdk can perform the same browser automation tasks as Claude Opus using DOMShell's MCP tools.

## What We're Testing

| | **Nexa Agent** | **Experiment 1 Baseline** |
|---|---|---|
| **Runner** | `agent.py` + nexa serve | Claude Desktop — Cowork mode |
| **LLM** | Qwen3-1.7B / Qwen3-4B (local) | Claude Opus 4.6 (cloud) |
| **Parameters** | 1.7B / 4B | ~175B+ |
| **Tools** | DOMShell MCP (full + compact mode) | DOMShell MCP / Claude in Chrome |
| **Inference** | On-device (Apple Silicon MLX) | Cloud API |

## Tasks

Same three Wikipedia tasks as Experiment 1:

1. **Content Extraction** — Extract first paragraph + 10 links from the AI article
2. **Search + Navigate** — Search Wikipedia for "machine learning", extract paragraph + See Also
3. **Multi-step** — Find LLM table, extract 5 models, follow first model's link

## Trial Matrix

12 trials: 3 tasks × 2 models × 2 modes

| Trial | Task | Model | Mode | Max Turns |
|-------|------|-------|------|-----------|
| 1–4 | T1 | 1.7B / 4B | Full / Compact | 15 |
| 5–8 | T2 | 1.7B / 4B | Full / Compact | 20 |
| 9–12 | T3 | 1.7B / 4B | Full / Compact | 25 |

## Results

**0 out of 12 trials completed their assigned task.**

| Task | 1.7B Full | 4B Full | 1.7B Compact | 4B Compact |
|------|-----------|---------|--------------|------------|
| T1 | 2 calls, gave up | 3 calls, crash | 15 calls, ls loop | 6 calls, partial |
| T2 | 1 call, stopped | 3 calls, errors | 3 calls, wrong page | 0 calls, nothing |
| T3 | 2 calls, stopped | 1 call, stopped | 1 call, hallucinated | 25 calls, loop |

See [results/results.md](results/results.md) for full trial details and [results/analysis.md](results/analysis.md) for analysis.

## Key Finding

The capability gap between 1.7B–4B and 175B+ models is **binary, not gradual** for multi-step tool use. Small models can open pages (step 1) but cannot:
- Discover DOM element names (e.g., `main_940/` vs `main`)
- Adapt to errors and try alternative approaches
- Maintain task context across multiple tool calls
- Resist hallucinating answers from training data

## How to Reproduce

```bash
# 1. Start nexa serve
nexa serve

# 2. Start DOMShell MCP server (separate terminal)
cd mcp-server && npx tsx index.ts --no-confirm --allow-all

# 3. Run all trials
bash experiments/nexa_claude/run_trials.sh
```

## File Structure

```
experiments/nexa_claude/
├── README.md               ← You are here
├── nexa_prompts.md         ← Task strings and trial matrix
├── run_trials.sh           ← Automated runner script
└── results/
    ├── ground_truth.md     ← Expected answers (same as experiment_1)
    ├── results.md          ← Full trial data
    ├── analysis.md         ← Analysis and recommendations
    └── raw_output/         ← Raw agent.py output per trial
        ├── trial_01_t1_1.7b_full.txt
        ├── trial_02_t1_4b_full.txt
        └── ...
```
