#!/bin/bash
# Run all 20 nexa_ollama experiment trials sequentially
# Matrix: 5 progressive tasks x 2 backends x 2 interfaces

DOMSHELL_AGENT="/Users/apireno/repos/DOMShell/integrations/nexa/agent.py"
HTML_AGENT="/Users/apireno/repos/DOMShell/experiments/nexa_ollama/raw_html_agent.py"
OUT="/Users/apireno/repos/DOMShell/experiments/nexa_ollama/results/raw_output"

NEXA_ENDPOINT="http://127.0.0.1:18181/v1"
OLLAMA_ENDPOINT="http://127.0.0.1:11434/v1"
TOKEN="52642f3f8e93d6be3e59aa90aa3526d06392a2cb5493aaf4"

T1='Open https://en.wikipedia.org/wiki/Artificial_intelligence and tell me the page title.'
T2='Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the text of the main heading (h1) on the page.'
T3='Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first paragraph of the article. Return the exact text, do not summarize.'
T4='Open https://en.wikipedia.org/wiki/Artificial_intelligence and count how many top-level section headings (h2) are on the page. Return just the number.'
T5='Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first 5 hyperlinks from the article body. For each link, return the display text and URL.'

echo "=== Nexa Interface Experiment (Progressive Difficulty) ==="
echo "Matrix: 5 tasks x 2 backends x 2 interfaces = 20 trials"
echo "Start time: $(date)"
echo ""

# --- T1: Page Title (max 5 turns) ---

echo "--- Trial 1: T1 Nexa+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$T1" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$NEXA_ENDPOINT" --model qwen3-4b --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_01_t1_nexa_domshell.txt"
echo ""
sleep 2

echo "--- Trial 2: T1 Nexa+HTML ---"
python3 "$HTML_AGENT" --task "$T1" --verbose --max-turns 5 \
  --endpoint "$NEXA_ENDPOINT" --model qwen3-4b \
  2>&1 | tee "$OUT/trial_02_t1_nexa_html.txt"
echo ""
sleep 2

echo "--- Trial 3: T1 Ollama+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$T1" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model qwen3 --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_03_t1_ollama_domshell.txt"
echo ""
sleep 2

echo "--- Trial 4: T1 Ollama+HTML ---"
python3 "$HTML_AGENT" --task "$T1" --verbose --max-turns 5 \
  --endpoint "$OLLAMA_ENDPOINT" --model qwen3 \
  2>&1 | tee "$OUT/trial_04_t1_ollama_html.txt"
echo ""
sleep 2

# --- T2: H1 Heading (max 5 turns) ---

echo "--- Trial 5: T2 Nexa+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$T2" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$NEXA_ENDPOINT" --model qwen3-4b --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_05_t2_nexa_domshell.txt"
echo ""
sleep 2

echo "--- Trial 6: T2 Nexa+HTML ---"
python3 "$HTML_AGENT" --task "$T2" --verbose --max-turns 5 \
  --endpoint "$NEXA_ENDPOINT" --model qwen3-4b \
  2>&1 | tee "$OUT/trial_06_t2_nexa_html.txt"
echo ""
sleep 2

echo "--- Trial 7: T2 Ollama+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$T2" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model qwen3 --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_07_t2_ollama_domshell.txt"
echo ""
sleep 2

echo "--- Trial 8: T2 Ollama+HTML ---"
python3 "$HTML_AGENT" --task "$T2" --verbose --max-turns 5 \
  --endpoint "$OLLAMA_ENDPOINT" --model qwen3 \
  2>&1 | tee "$OUT/trial_08_t2_ollama_html.txt"
echo ""
sleep 2

# --- T3: First Paragraph (max 8 turns) ---

echo "--- Trial 9: T3 Nexa+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$T3" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$NEXA_ENDPOINT" --model qwen3-4b --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_09_t3_nexa_domshell.txt"
echo ""
sleep 2

echo "--- Trial 10: T3 Nexa+HTML ---"
python3 "$HTML_AGENT" --task "$T3" --verbose --max-turns 8 \
  --endpoint "$NEXA_ENDPOINT" --model qwen3-4b \
  2>&1 | tee "$OUT/trial_10_t3_nexa_html.txt"
echo ""
sleep 2

echo "--- Trial 11: T3 Ollama+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$T3" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model qwen3 --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_11_t3_ollama_domshell.txt"
echo ""
sleep 2

echo "--- Trial 12: T3 Ollama+HTML ---"
python3 "$HTML_AGENT" --task "$T3" --verbose --max-turns 8 \
  --endpoint "$OLLAMA_ENDPOINT" --model qwen3 \
  2>&1 | tee "$OUT/trial_12_t3_ollama_html.txt"
echo ""
sleep 2

# --- T4: Count Headings (max 8 turns) ---

echo "--- Trial 13: T4 Nexa+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$T4" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$NEXA_ENDPOINT" --model qwen3-4b --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_13_t4_nexa_domshell.txt"
echo ""
sleep 2

echo "--- Trial 14: T4 Nexa+HTML ---"
python3 "$HTML_AGENT" --task "$T4" --verbose --max-turns 8 \
  --endpoint "$NEXA_ENDPOINT" --model qwen3-4b \
  2>&1 | tee "$OUT/trial_14_t4_nexa_html.txt"
echo ""
sleep 2

echo "--- Trial 15: T4 Ollama+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$T4" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model qwen3 --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_15_t4_ollama_domshell.txt"
echo ""
sleep 2

echo "--- Trial 16: T4 Ollama+HTML ---"
python3 "$HTML_AGENT" --task "$T4" --verbose --max-turns 8 \
  --endpoint "$OLLAMA_ENDPOINT" --model qwen3 \
  2>&1 | tee "$OUT/trial_16_t4_ollama_html.txt"
echo ""
sleep 2

# --- T5: Extract 5 Links (max 10 turns) ---

echo "--- Trial 17: T5 Nexa+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$T5" --allow-write --verbose --max-turns 10 \
  --nexa-endpoint "$NEXA_ENDPOINT" --model qwen3-4b --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_17_t5_nexa_domshell.txt"
echo ""
sleep 2

echo "--- Trial 18: T5 Nexa+HTML ---"
python3 "$HTML_AGENT" --task "$T5" --verbose --max-turns 10 \
  --endpoint "$NEXA_ENDPOINT" --model qwen3-4b \
  2>&1 | tee "$OUT/trial_18_t5_nexa_html.txt"
echo ""
sleep 2

echo "--- Trial 19: T5 Ollama+DOMShell ---"
python3 "$DOMSHELL_AGENT" --task "$T5" --allow-write --verbose --max-turns 10 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model qwen3 --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_19_t5_ollama_domshell.txt"
echo ""
sleep 2

echo "--- Trial 20: T5 Ollama+HTML ---"
python3 "$HTML_AGENT" --task "$T5" --verbose --max-turns 10 \
  --endpoint "$OLLAMA_ENDPOINT" --model qwen3 \
  2>&1 | tee "$OUT/trial_20_t5_ollama_html.txt"
echo ""

echo "=== All trials complete ==="
echo "End time: $(date)"
