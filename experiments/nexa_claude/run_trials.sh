#!/bin/bash
# Run all 10 nexa_claude experiment trials sequentially
# Matrix: 5 progressive tasks x 2 models (1.7B, 4B), compact mode only

AGENT="/Users/apireno/repos/DOMShell/integrations/nexa/agent.py"
OUT="/Users/apireno/repos/DOMShell/experiments/nexa_claude/results/raw_output"
ENDPOINT="http://127.0.0.1:18181/v1"
TOKEN="52642f3f8e93d6be3e59aa90aa3526d06392a2cb5493aaf4"

T1='Open https://en.wikipedia.org/wiki/Artificial_intelligence and tell me the page title.'
T2='Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the text of the main heading (h1) on the page.'
T3='Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first paragraph of the article. Return the exact text, do not summarize.'
T4='Open https://en.wikipedia.org/wiki/Artificial_intelligence and count how many top-level section headings (h2) are on the page. Return just the number.'
T5='Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first 5 hyperlinks from the article body. For each link, return the display text and URL.'

echo "=== Nexa Claude Experiment (Progressive Difficulty) ==="
echo "Matrix: 5 tasks x 2 models (compact mode only) = 10 trials"
echo "Start time: $(date)"
echo ""

# --- T1: Page Title ---

echo "--- Trial 1: T1 Qwen3-1.7B ---"
python3 "$AGENT" --task "$T1" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-1.7b --mode compact \
  2>&1 | tee "$OUT/trial_01_t1_1.7b.txt"
echo ""
sleep 2

echo "--- Trial 2: T1 Qwen3-4B ---"
python3 "$AGENT" --task "$T1" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-4b --mode compact \
  2>&1 | tee "$OUT/trial_02_t1_4b.txt"
echo ""
sleep 2

# --- T2: H1 Heading ---

echo "--- Trial 3: T2 Qwen3-1.7B ---"
python3 "$AGENT" --task "$T2" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-1.7b --mode compact \
  2>&1 | tee "$OUT/trial_03_t2_1.7b.txt"
echo ""
sleep 2

echo "--- Trial 4: T2 Qwen3-4B ---"
python3 "$AGENT" --task "$T2" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-4b --mode compact \
  2>&1 | tee "$OUT/trial_04_t2_4b.txt"
echo ""
sleep 2

# --- T3: First Paragraph ---

echo "--- Trial 5: T3 Qwen3-1.7B ---"
python3 "$AGENT" --task "$T3" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-1.7b --mode compact \
  2>&1 | tee "$OUT/trial_05_t3_1.7b.txt"
echo ""
sleep 2

echo "--- Trial 6: T3 Qwen3-4B ---"
python3 "$AGENT" --task "$T3" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-4b --mode compact \
  2>&1 | tee "$OUT/trial_06_t3_4b.txt"
echo ""
sleep 2

# --- T4: Count Headings ---

echo "--- Trial 7: T4 Qwen3-1.7B ---"
python3 "$AGENT" --task "$T4" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-1.7b --mode compact \
  2>&1 | tee "$OUT/trial_07_t4_1.7b.txt"
echo ""
sleep 2

echo "--- Trial 8: T4 Qwen3-4B ---"
python3 "$AGENT" --task "$T4" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-4b --mode compact \
  2>&1 | tee "$OUT/trial_08_t4_4b.txt"
echo ""
sleep 2

# --- T5: Extract 5 Links ---

echo "--- Trial 9: T5 Qwen3-1.7B ---"
python3 "$AGENT" --task "$T5" --allow-write --verbose --max-turns 10 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-1.7b --mode compact \
  2>&1 | tee "$OUT/trial_09_t5_1.7b.txt"
echo ""
sleep 2

echo "--- Trial 10: T5 Qwen3-4B ---"
python3 "$AGENT" --task "$T5" --allow-write --verbose --max-turns 10 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-4b --mode compact \
  2>&1 | tee "$OUT/trial_10_t5_4b.txt"
echo ""

echo "=== All trials complete ==="
echo "End time: $(date)"
