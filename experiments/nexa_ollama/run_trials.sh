#!/bin/bash
# Run all 12 nexa_ollama experiment trials sequentially
# Matrix: [nexa, ollama] x [domshell, html] x 3 tasks

DOMSHELL_AGENT="/Users/apireno/repos/DOMShell/integrations/nexa/agent.py"
HTML_AGENT="/Users/apireno/repos/DOMShell/experiments/nexa_ollama/raw_html_agent.py"
OUT="/Users/apireno/repos/DOMShell/experiments/nexa_ollama/results/raw_output"

NEXA_ENDPOINT="http://127.0.0.1:18181/v1"
OLLAMA_ENDPOINT="http://127.0.0.1:11434/v1"
TOKEN="52642f3f8e93d6be3e59aa90aa3526d06392a2cb5493aaf4"

TASK1='Go to https://en.wikipedia.org/wiki/Artificial_intelligence and return the page title.'
TASK2='Go to https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first paragraph of the article body.'
TASK3='Go to https://en.wikipedia.org/wiki/Artificial_intelligence and list all section headings on the page.'

MAX_TURNS=10

echo "=== Nexa Interface Experiment ==="
echo "Matrix: [nexa, ollama] x [domshell, html] x 3 tasks = 12 trials"
echo "Model: Qwen3-4B (all trials)"
echo "Start time: $(date)"
echo ""

# --- T1: Page Title ---

echo "--- Trial 1: T1 Nexa+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$TASK1" --allow-write --verbose --max-turns $MAX_TURNS \
  --nexa-endpoint "$NEXA_ENDPOINT" --model qwen3-4b --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_01_t1_nexa_domshell.txt"
echo ""
sleep 2

echo "--- Trial 2: T1 Nexa+HTML ---"
python3 "$HTML_AGENT" --task "$TASK1" --verbose --max-turns $MAX_TURNS \
  --endpoint "$NEXA_ENDPOINT" --model qwen3-4b \
  2>&1 | tee "$OUT/trial_02_t1_nexa_html.txt"
echo ""
sleep 2

echo "--- Trial 3: T1 Ollama+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$TASK1" --allow-write --verbose --max-turns $MAX_TURNS \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model qwen3 --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_03_t1_ollama_domshell.txt"
echo ""
sleep 2

echo "--- Trial 4: T1 Ollama+HTML ---"
python3 "$HTML_AGENT" --task "$TASK1" --verbose --max-turns $MAX_TURNS \
  --endpoint "$OLLAMA_ENDPOINT" --model qwen3 \
  2>&1 | tee "$OUT/trial_04_t1_ollama_html.txt"
echo ""
sleep 2

# --- T2: First Paragraph ---

echo "--- Trial 5: T2 Nexa+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$TASK2" --allow-write --verbose --max-turns $MAX_TURNS \
  --nexa-endpoint "$NEXA_ENDPOINT" --model qwen3-4b --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_05_t2_nexa_domshell.txt"
echo ""
sleep 2

echo "--- Trial 6: T2 Nexa+HTML ---"
python3 "$HTML_AGENT" --task "$TASK2" --verbose --max-turns $MAX_TURNS \
  --endpoint "$NEXA_ENDPOINT" --model qwen3-4b \
  2>&1 | tee "$OUT/trial_06_t2_nexa_html.txt"
echo ""
sleep 2

echo "--- Trial 7: T2 Ollama+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$TASK2" --allow-write --verbose --max-turns $MAX_TURNS \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model qwen3 --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_07_t2_ollama_domshell.txt"
echo ""
sleep 2

echo "--- Trial 8: T2 Ollama+HTML ---"
python3 "$HTML_AGENT" --task "$TASK2" --verbose --max-turns $MAX_TURNS \
  --endpoint "$OLLAMA_ENDPOINT" --model qwen3 \
  2>&1 | tee "$OUT/trial_08_t2_ollama_html.txt"
echo ""
sleep 2

# --- T3: List Headings ---

echo "--- Trial 9: T3 Nexa+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$TASK3" --allow-write --verbose --max-turns $MAX_TURNS \
  --nexa-endpoint "$NEXA_ENDPOINT" --model qwen3-4b --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_09_t3_nexa_domshell.txt"
echo ""
sleep 2

echo "--- Trial 10: T3 Nexa+HTML ---"
python3 "$HTML_AGENT" --task "$TASK3" --verbose --max-turns $MAX_TURNS \
  --endpoint "$NEXA_ENDPOINT" --model qwen3-4b \
  2>&1 | tee "$OUT/trial_10_t3_nexa_html.txt"
echo ""
sleep 2

echo "--- Trial 11: T3 Ollama+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$TASK3" --allow-write --verbose --max-turns $MAX_TURNS \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model qwen3 --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_11_t3_ollama_domshell.txt"
echo ""
sleep 2

echo "--- Trial 12: T3 Ollama+HTML ---"
python3 "$HTML_AGENT" --task "$TASK3" --verbose --max-turns $MAX_TURNS \
  --endpoint "$OLLAMA_ENDPOINT" --model qwen3 \
  2>&1 | tee "$OUT/trial_12_t3_ollama_html.txt"
echo ""

echo "=== All trials complete ==="
echo "End time: $(date)"
