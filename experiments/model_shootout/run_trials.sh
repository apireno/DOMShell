#!/bin/bash
# Run all 20 model shootout experiment trials sequentially
# Matrix: 5 progressive tasks x 4 models (Ollama + DOMShell compact)

DOMSHELL_AGENT="/Users/apireno/repos/DOMShell/integrations/nexa/agent.py"
OUT="/Users/apireno/repos/DOMShell/experiments/model_shootout/results/raw_output"

OLLAMA_ENDPOINT="http://127.0.0.1:11434/v1"
TOKEN="52642f3f8e93d6be3e59aa90aa3526d06392a2cb5493aaf4"

# Models
M1="qwen3"                         # Qwen3-4B (baseline)
M2="hermes3:3b"                    # Hermes 3 3B (NousResearch)
M3="ibm/granite4:tiny-h-q4_K_M"   # Granite 4 Tiny (IBM)
M4="llama3.2:3b"                   # Llama 3.2 3B (Meta)

# Task prompts
T1='Open https://en.wikipedia.org/wiki/Artificial_intelligence and tell me the page title.'
T2='Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the text of the main heading (h1) on the page.'
T3='Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first paragraph of the article. Return the exact text, do not summarize.'
T4='Open https://en.wikipedia.org/wiki/Artificial_intelligence and count how many top-level section headings (h2) are on the page. Return just the number.'
T5='Open https://en.wikipedia.org/wiki/Artificial_intelligence and extract the first 5 hyperlinks from the article body. For each link, return the display text and URL.'

echo "=== Model Shootout Experiment ==="
echo "Matrix: 5 tasks x 4 models = 20 trials"
echo "Backend: Ollama | Interface: DOMShell compact"
echo "Start time: $(date)"
echo ""

# --- T1: Page Title (max 5 turns) ---

echo "--- Trial 1: T1 Qwen3-4B ---"
python3 "$DOMSHELL_AGENT" --task "$T1" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M1" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_01_t1_qwen3.txt"
echo ""
sleep 2

echo "--- Trial 2: T1 Hermes3-3B ---"
python3 "$DOMSHELL_AGENT" --task "$T1" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M2" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_02_t1_hermes3.txt"
echo ""
sleep 2

echo "--- Trial 3: T1 Granite4-Tiny ---"
python3 "$DOMSHELL_AGENT" --task "$T1" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M3" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_03_t1_granite4.txt"
echo ""
sleep 2

echo "--- Trial 4: T1 Llama3.2-3B ---"
python3 "$DOMSHELL_AGENT" --task "$T1" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M4" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_04_t1_llama32.txt"
echo ""
sleep 2

# --- T2: H1 Heading (max 5 turns) ---

echo "--- Trial 5: T2 Qwen3-4B ---"
python3 "$DOMSHELL_AGENT" --task "$T2" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M1" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_05_t2_qwen3.txt"
echo ""
sleep 2

echo "--- Trial 6: T2 Hermes3-3B ---"
python3 "$DOMSHELL_AGENT" --task "$T2" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M2" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_06_t2_hermes3.txt"
echo ""
sleep 2

echo "--- Trial 7: T2 Granite4-Tiny ---"
python3 "$DOMSHELL_AGENT" --task "$T2" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M3" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_07_t2_granite4.txt"
echo ""
sleep 2

echo "--- Trial 8: T2 Llama3.2-3B ---"
python3 "$DOMSHELL_AGENT" --task "$T2" --allow-write --verbose --max-turns 5 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M4" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_08_t2_llama32.txt"
echo ""
sleep 2

# --- T3: First Paragraph (max 8 turns) ---

echo "--- Trial 9: T3 Qwen3-4B ---"
python3 "$DOMSHELL_AGENT" --task "$T3" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M1" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_09_t3_qwen3.txt"
echo ""
sleep 2

echo "--- Trial 10: T3 Hermes3-3B ---"
python3 "$DOMSHELL_AGENT" --task "$T3" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M2" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_10_t3_hermes3.txt"
echo ""
sleep 2

echo "--- Trial 11: T3 Granite4-Tiny ---"
python3 "$DOMSHELL_AGENT" --task "$T3" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M3" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_11_t3_granite4.txt"
echo ""
sleep 2

echo "--- Trial 12: T3 Llama3.2-3B ---"
python3 "$DOMSHELL_AGENT" --task "$T3" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M4" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_12_t3_llama32.txt"
echo ""
sleep 2

# --- T4: Count Headings (max 8 turns) ---

echo "--- Trial 13: T4 Qwen3-4B ---"
python3 "$DOMSHELL_AGENT" --task "$T4" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M1" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_13_t4_qwen3.txt"
echo ""
sleep 2

echo "--- Trial 14: T4 Hermes3-3B ---"
python3 "$DOMSHELL_AGENT" --task "$T4" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M2" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_14_t4_hermes3.txt"
echo ""
sleep 2

echo "--- Trial 15: T4 Granite4-Tiny ---"
python3 "$DOMSHELL_AGENT" --task "$T4" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M3" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_15_t4_granite4.txt"
echo ""
sleep 2

echo "--- Trial 16: T4 Llama3.2-3B ---"
python3 "$DOMSHELL_AGENT" --task "$T4" --allow-write --verbose --max-turns 8 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M4" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_16_t4_llama32.txt"
echo ""
sleep 2

# --- T5: Extract 5 Links (max 10 turns) ---

echo "--- Trial 17: T5 Qwen3-4B ---"
python3 "$DOMSHELL_AGENT" --task "$T5" --allow-write --verbose --max-turns 10 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M1" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_17_t5_qwen3.txt"
echo ""
sleep 2

echo "--- Trial 18: T5 Hermes3-3B ---"
python3 "$DOMSHELL_AGENT" --task "$T5" --allow-write --verbose --max-turns 10 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M2" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_18_t5_hermes3.txt"
echo ""
sleep 2

echo "--- Trial 19: T5 Granite4-Tiny ---"
python3 "$DOMSHELL_AGENT" --task "$T5" --allow-write --verbose --max-turns 10 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M3" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_19_t5_granite4.txt"
echo ""
sleep 2

echo "--- Trial 20: T5 Llama3.2-3B ---"
python3 "$DOMSHELL_AGENT" --task "$T5" --allow-write --verbose --max-turns 10 \
  --nexa-endpoint "$OLLAMA_ENDPOINT" --model "$M4" --mode compact \
  ${TOKEN:+--token "$TOKEN"} \
  2>&1 | tee "$OUT/trial_20_t5_llama32.txt"
echo ""

echo "=== All trials complete ==="
echo "End time: $(date)"
