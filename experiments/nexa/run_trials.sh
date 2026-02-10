#!/bin/bash
# Run all 12 Nexa experiment trials sequentially
# Each trial output saved to raw_output/trial_NN.txt

AGENT="/Users/apireno/repos/DOMShell/integrations/nexa/agent.py"
OUT="/Users/apireno/repos/DOMShell/experiments/nexa/results/raw_output"
ENDPOINT="http://127.0.0.1:8080/v1"
TOKEN="52642f3f8e93d6be3e59aa90aa3526d06392a2cb5493aaf4"

TASK1='Go to https://en.wikipedia.org/wiki/Artificial_intelligence. Extract the first paragraph of the article body. Then list the first 10 hyperlinks in the article body with their display text and full URLs.'
TASK2='Go to https://en.wikipedia.org. Search for "machine learning" using the search box. On the results page, click the first result. Then extract the first paragraph of the article and list all items in the See also section.'
TASK3='Go to https://en.wikipedia.org/wiki/Large_language_model. Find the table of large language models. Extract the names and organizations of the first 5 models listed. Then follow the Wikipedia link for the first model in the list and extract the first paragraph of that models page.'

echo "=== Starting Nexa Experiment Trials ==="
echo "Start time: $(date)"
echo ""

# Trial 1: T1 Qwen3-1.7B full
echo "--- Trial 1: T1 Qwen3-1.7B full ---"
python3 "$AGENT" --task "$TASK1" --allow-write --verbose --max-turns 15 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-1.7b --mode full \
  2>&1 | tee "$OUT/trial_01_t1_1.7b_full.txt"
echo ""
sleep 2

# Trial 2: T1 Qwen3-4B full
echo "--- Trial 2: T1 Qwen3-4B full ---"
python3 "$AGENT" --task "$TASK1" --allow-write --verbose --max-turns 15 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-4b --mode full \
  2>&1 | tee "$OUT/trial_02_t1_4b_full.txt"
echo ""
sleep 2

# Trial 3: T1 Qwen3-1.7B compact
echo "--- Trial 3: T1 Qwen3-1.7B compact ---"
python3 "$AGENT" --task "$TASK1" --allow-write --verbose --max-turns 15 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-1.7b --mode compact \
  2>&1 | tee "$OUT/trial_03_t1_1.7b_compact.txt"
echo ""
sleep 2

# Trial 4: T1 Qwen3-4B compact
echo "--- Trial 4: T1 Qwen3-4B compact ---"
python3 "$AGENT" --task "$TASK1" --allow-write --verbose --max-turns 15 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-4b --mode compact \
  2>&1 | tee "$OUT/trial_04_t1_4b_compact.txt"
echo ""
sleep 2

# Trial 5: T2 Qwen3-1.7B full
echo "--- Trial 5: T2 Qwen3-1.7B full ---"
python3 "$AGENT" --task "$TASK2" --allow-write --verbose --max-turns 20 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-1.7b --mode full \
  2>&1 | tee "$OUT/trial_05_t2_1.7b_full.txt"
echo ""
sleep 2

# Trial 6: T2 Qwen3-4B full
echo "--- Trial 6: T2 Qwen3-4B full ---"
python3 "$AGENT" --task "$TASK2" --allow-write --verbose --max-turns 20 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-4b --mode full \
  2>&1 | tee "$OUT/trial_06_t2_4b_full.txt"
echo ""
sleep 2

# Trial 7: T2 Qwen3-1.7B compact
echo "--- Trial 7: T2 Qwen3-1.7B compact ---"
python3 "$AGENT" --task "$TASK2" --allow-write --verbose --max-turns 20 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-1.7b --mode compact \
  2>&1 | tee "$OUT/trial_07_t2_1.7b_compact.txt"
echo ""
sleep 2

# Trial 8: T2 Qwen3-4B compact
echo "--- Trial 8: T2 Qwen3-4B compact ---"
python3 "$AGENT" --task "$TASK2" --allow-write --verbose --max-turns 20 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-4b --mode compact \
  2>&1 | tee "$OUT/trial_08_t2_4b_compact.txt"
echo ""
sleep 2

# Trial 9: T3 Qwen3-1.7B full
echo "--- Trial 9: T3 Qwen3-1.7B full ---"
python3 "$AGENT" --task "$TASK3" --allow-write --verbose --max-turns 25 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-1.7b --mode full \
  2>&1 | tee "$OUT/trial_09_t3_1.7b_full.txt"
echo ""
sleep 2

# Trial 10: T3 Qwen3-4B full
echo "--- Trial 10: T3 Qwen3-4B full ---"
python3 "$AGENT" --task "$TASK3" --allow-write --verbose --max-turns 25 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-4b --mode full \
  2>&1 | tee "$OUT/trial_10_t3_4b_full.txt"
echo ""
sleep 2

# Trial 11: T3 Qwen3-1.7B compact
echo "--- Trial 11: T3 Qwen3-1.7B compact ---"
python3 "$AGENT" --task "$TASK3" --allow-write --verbose --max-turns 25 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-1.7b --mode compact \
  2>&1 | tee "$OUT/trial_11_t3_1.7b_compact.txt"
echo ""
sleep 2

# Trial 12: T3 Qwen3-4B compact
echo "--- Trial 12: T3 Qwen3-4B compact ---"
python3 "$AGENT" --task "$TASK3" --allow-write --verbose --max-turns 25 \
  --nexa-endpoint "$ENDPOINT" --token "$TOKEN" --model qwen3-4b --mode compact \
  2>&1 | tee "$OUT/trial_12_t3_4b_compact.txt"
echo ""

echo "=== All trials complete ==="
echo "End time: $(date)"
