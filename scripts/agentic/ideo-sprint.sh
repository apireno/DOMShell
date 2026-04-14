#!/bin/bash
# ideo-sprint.sh — IDEO-style ideation sprint using VP personas
#
# Compatible with bash 3.2+ (macOS default) — no associative arrays.
#
# Runs a structured creative ideation process across VP personas:
#   Phase 1: Independent ideation (each VP generates ideas given a goal)
#   Phase 2: Cross-pollination & voting (each VP votes on others' ideas)
#   Phase 3: Merge & tally (facilitator consolidates similar ideas, counts votes)
#   Phase 4: PRD generation (VP Prod drafts PRDs/ADRs from top-voted ideas)
#
# Each phase runs personas as separate CLI processes — zero shared context
# ensures truly independent creative thinking.
#
# Engine selection follows the same pattern as vp-review.sh:
#   1. REVIEW_ENGINE env var (gemini | claude | dual)
#   2. .review-engine file in repo root
#   3. Auto-detect installed CLIs
#
# Usage:
#   ./scripts/agentic/ideo-sprint.sh <goal-file> <output-dir> [--votes N] [--personas P1,P2,...]
#
# Examples:
#   ./scripts/agentic/ideo-sprint.sh docs/initiatives/INIT-001/ideation-goal.md docs/initiatives/INIT-001/ideation/
#   ./scripts/agentic/ideo-sprint.sh /tmp/goal.md docs/ideation/session-01/ --votes 3
#   ./scripts/agentic/ideo-sprint.sh goal.md output/ --personas vp-eng,vp-prod,vp-security

set -euo pipefail

# --- Configuration ---
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
VOTES_PER_PERSONA=3
PERSONAS="vp-eng vp-prod vp-security vp-devops"
EXTRA_CONTEXT_FILES=""

# --- Engine selection (shared with vp-review.sh) ---
resolve_engine() {
    if [ -n "${REVIEW_ENGINE:-}" ]; then
        echo "$REVIEW_ENGINE"
        return
    fi

    if [ -f "$REPO_ROOT/.review-engine" ]; then
        cat "$REPO_ROOT/.review-engine" | tr -d '[:space:]'
        return
    fi

    local HAS_GEMINI=0
    local HAS_CLAUDE=0

    if command -v gemini > /dev/null 2>&1; then
        HAS_GEMINI=1
    elif [ -x "$HOME/.local/bin/gemini" ]; then
        HAS_GEMINI=1
    fi

    if command -v claude > /dev/null 2>&1; then
        HAS_CLAUDE=1
    fi

    if [ "$HAS_GEMINI" -eq 1 ] && [ "$HAS_CLAUDE" -eq 1 ]; then
        echo "dual"
    elif [ "$HAS_GEMINI" -eq 1 ]; then
        echo "gemini"
    elif [ "$HAS_CLAUDE" -eq 1 ]; then
        echo "claude"
    else
        echo "none"
    fi
}

ENGINE=$(resolve_engine)

if [ "$ENGINE" = "none" ]; then
    echo "Error: No LLM CLI found. Install one of:"
    echo "  Gemini CLI: https://github.com/google-gemini/gemini-cli"
    echo "  Claude CLI: https://docs.anthropic.com/en/docs/claude-code"
    exit 1
fi

# Locate CLI commands
GEMINI_CMD=""
if command -v gemini > /dev/null 2>&1; then
    GEMINI_CMD="gemini"
elif [ -x "$HOME/.local/bin/gemini" ]; then
    GEMINI_CMD="$HOME/.local/bin/gemini"
elif [ -x "/usr/local/bin/gemini" ]; then
    GEMINI_CMD="/usr/local/bin/gemini"
fi

CLAUDE_CMD=""
if command -v claude > /dev/null 2>&1; then
    CLAUDE_CMD="claude"
fi

# --- Argument parsing ---
GOAL_FILE=""
OUTPUT_DIR=""
POSITIONAL_ARGS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --votes)
            VOTES_PER_PERSONA="$2"
            shift 2
            ;;
        --personas)
            PERSONAS=$(echo "$2" | tr ',' ' ')
            shift 2
            ;;
        --context)
            EXTRA_CONTEXT_FILES="$EXTRA_CONTEXT_FILES $2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 <goal-file> <output-dir> [--votes N] [--personas P1,P2,...]"
            echo ""
            echo "Runs an IDEO-style ideation sprint across VP personas."
            echo ""
            echo "Arguments:"
            echo "  goal-file     Path to a markdown file describing the goal/requirement"
            echo "  output-dir    Directory where all ideation artifacts will be written"
            echo ""
            echo "Options:"
            echo "  --votes N              Votes per persona (default: 3)"
            echo "  --personas P1,P2,...   Comma-separated list of personas (default: vp-eng,vp-prod,vp-security,vp-devops)"
            echo "  --context FILE         Additional context file (repeatable). Auto-discovery also scans"
            echo "                         docs/roadmap/, docs/architecture/, docs/sprints/, docs/initiatives/"
            echo ""
            echo "Engine: $ENGINE (set via REVIEW_ENGINE env var, .review-engine file, or auto-detected)"
            echo ""
            echo "Phases:"
            echo "  1. Ideate    — Each VP independently generates maximum ideas"
            echo "  2. Vote      — Each VP reviews others' ideas, votes with improvements"
            echo "  3. Merge     — Facilitator consolidates similar ideas, tallies votes"
            echo "  4. Produce   — VP Prod drafts PRDs/ADRs from top-voted ideas"
            exit 0
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

if [ ${#POSITIONAL_ARGS[@]} -lt 2 ]; then
    echo "Error: Missing required arguments."
    echo "Usage: $0 <goal-file> <output-dir> [--votes N] [--personas P1,P2,...]"
    exit 1
fi

GOAL_FILE="${POSITIONAL_ARGS[0]}"
OUTPUT_DIR="${POSITIONAL_ARGS[1]}"

if [ ! -f "$GOAL_FILE" ]; then
    echo "Error: Goal file not found: $GOAL_FILE"
    exit 1
fi

# --- Create output directory ---
mkdir -p "$OUTPUT_DIR"

# --- Auto-discover existing work ---
# Builds a context document so participants don't re-propose already-built features.
# Scans: roadmap, PRDs, ADRs, initiative briefs, completed sprint dev reports.
# Also includes any files passed via --context.

EXISTING_WORK_FILE=$(mktemp)
trap "rm -f '$EXISTING_WORK_FILE'" EXIT

echo "=== EXISTING WORK — DO NOT RE-PROPOSE THESE ===" > "$EXISTING_WORK_FILE"
echo "" >> "$EXISTING_WORK_FILE"
CONTEXT_FOUND=0

# Roadmap
if [ -f "$REPO_ROOT/docs/roadmap/ROADMAP.md" ]; then
    echo "--- ROADMAP ---" >> "$EXISTING_WORK_FILE"
    cat "$REPO_ROOT/docs/roadmap/ROADMAP.md" >> "$EXISTING_WORK_FILE"
    echo "" >> "$EXISTING_WORK_FILE"
    CONTEXT_FOUND=$((CONTEXT_FOUND + 1))
fi

# PRDs (titles + status + goal — not full content, to keep prompt manageable)
PRD_DIR="$REPO_ROOT/docs/roadmap/prds"
if [ -d "$PRD_DIR" ]; then
    PRD_FILES=$(find "$PRD_DIR" -name "*.md" -type f 2>/dev/null | sort)
    if [ -n "$PRD_FILES" ]; then
        echo "--- EXISTING PRDs ---" >> "$EXISTING_WORK_FILE"
        for prd in $PRD_FILES; do
            echo "" >> "$EXISTING_WORK_FILE"
            echo "File: $(basename "$prd")" >> "$EXISTING_WORK_FILE"
            # Extract first 30 lines (title, status, goal) to keep context lean
            head -30 "$prd" >> "$EXISTING_WORK_FILE"
            echo "" >> "$EXISTING_WORK_FILE"
            echo "..." >> "$EXISTING_WORK_FILE"
        done
        echo "" >> "$EXISTING_WORK_FILE"
        CONTEXT_FOUND=$((CONTEXT_FOUND + 1))
    fi
fi

# ADRs (titles + decision summaries)
ADR_DIR="$REPO_ROOT/docs/architecture/decisions"
if [ -d "$ADR_DIR" ]; then
    ADR_FILES=$(find "$ADR_DIR" -name "*.md" -type f 2>/dev/null | sort)
    if [ -n "$ADR_FILES" ]; then
        echo "--- EXISTING ADRs (Architectural Decisions) ---" >> "$EXISTING_WORK_FILE"
        for adr in $ADR_FILES; do
            echo "" >> "$EXISTING_WORK_FILE"
            echo "File: $(basename "$adr")" >> "$EXISTING_WORK_FILE"
            head -30 "$adr" >> "$EXISTING_WORK_FILE"
            echo "" >> "$EXISTING_WORK_FILE"
            echo "..." >> "$EXISTING_WORK_FILE"
        done
        echo "" >> "$EXISTING_WORK_FILE"
        CONTEXT_FOUND=$((CONTEXT_FOUND + 1))
    fi
fi

# Initiative briefs (what's been scoped or is in-flight)
INIT_DIR="$REPO_ROOT/docs/initiatives"
if [ -d "$INIT_DIR" ]; then
    BRIEF_FILES=$(find "$INIT_DIR" -name "initiative-brief.md" -not -path "*/_templates/*" -type f 2>/dev/null | sort)
    if [ -n "$BRIEF_FILES" ]; then
        echo "--- ACTIVE/COMPLETED INITIATIVES ---" >> "$EXISTING_WORK_FILE"
        for brief in $BRIEF_FILES; do
            echo "" >> "$EXISTING_WORK_FILE"
            echo "File: $brief" >> "$EXISTING_WORK_FILE"
            head -40 "$brief" >> "$EXISTING_WORK_FILE"
            echo "" >> "$EXISTING_WORK_FILE"
            echo "..." >> "$EXISTING_WORK_FILE"
        done
        echo "" >> "$EXISTING_WORK_FILE"
        CONTEXT_FOUND=$((CONTEXT_FOUND + 1))
    fi
fi

# Completed sprint dev reports (what was actually built)
SPRINT_DIRS="$REPO_ROOT/docs/sprints $REPO_ROOT/docs/initiatives"
for sdir in $SPRINT_DIRS; do
    if [ -d "$sdir" ]; then
        DEV_REPORTS=$(find "$sdir" -name "dev-report.md" -type f 2>/dev/null | sort)
        if [ -n "$DEV_REPORTS" ]; then
            echo "--- COMPLETED SPRINT DEV REPORTS (what was built) ---" >> "$EXISTING_WORK_FILE"
            for report in $DEV_REPORTS; do
                echo "" >> "$EXISTING_WORK_FILE"
                echo "File: $report" >> "$EXISTING_WORK_FILE"
                # Extract title + summary section (first 25 lines)
                head -25 "$report" >> "$EXISTING_WORK_FILE"
                echo "" >> "$EXISTING_WORK_FILE"
                echo "..." >> "$EXISTING_WORK_FILE"
            done
            echo "" >> "$EXISTING_WORK_FILE"
            CONTEXT_FOUND=$((CONTEXT_FOUND + 1))
        fi
    fi
done

# Extra context files passed via --context
for ctx_file in $EXTRA_CONTEXT_FILES; do
    if [ -f "$ctx_file" ]; then
        echo "--- ADDITIONAL CONTEXT: $(basename "$ctx_file") ---" >> "$EXISTING_WORK_FILE"
        cat "$ctx_file" >> "$EXISTING_WORK_FILE"
        echo "" >> "$EXISTING_WORK_FILE"
        CONTEXT_FOUND=$((CONTEXT_FOUND + 1))
    else
        echo "  ⚠ Context file not found: $ctx_file"
    fi
done

echo "=== END EXISTING WORK ===" >> "$EXISTING_WORK_FILE"

if [ "$CONTEXT_FOUND" -gt 0 ]; then
    CONTEXT_LINES=$(wc -l < "$EXISTING_WORK_FILE" | tr -d ' ')
    echo "  Auto-discovered existing work: $CONTEXT_FOUND sources ($CONTEXT_LINES lines)"
else
    echo "  No existing work found (clean repo). Ideation will start from scratch."
fi

# --- Helper: persona display name ---
persona_display_name() {
    case "$1" in
        vp-eng)        echo "VP of Engineering" ;;
        vp-prod)       echo "VP of Product" ;;
        vp-security)   echo "VP of Security" ;;
        vp-compliance) echo "VP of Compliance" ;;
        vp-devops)     echo "VP of DevOps" ;;
        *)             echo "$1" ;;
    esac
}

# --- Helper: persona file path ---
persona_file_path() {
    case "$1" in
        vp-eng)        echo "$REPO_ROOT/docs/personas/vp-engineering.md" ;;
        vp-prod)       echo "$REPO_ROOT/docs/personas/vp-product.md" ;;
        vp-security)   echo "$REPO_ROOT/docs/personas/vp-security.md" ;;
        vp-compliance) echo "$REPO_ROOT/docs/personas/vp-compliance.md" ;;
        vp-devops)     echo "$REPO_ROOT/docs/personas/vp-devops.md" ;;
    esac
}

# --- Helper: run LLM CLI ---
run_llm() {
    local prompt_file="$1"
    local output_file="$2"

    case "$ENGINE" in
        gemini)
            cat "$prompt_file" | "$GEMINI_CMD" > "$output_file" 2>/dev/null
            ;;
        claude)
            cat "$prompt_file" | "$CLAUDE_CMD" -p --max-turns 1 > "$output_file" 2>/dev/null
            ;;
        dual)
            # In dual mode, use gemini as primary for ideation
            # (both engines would slow this down 2x per phase — use primary only)
            if [ -n "$GEMINI_CMD" ]; then
                cat "$prompt_file" | "$GEMINI_CMD" > "$output_file" 2>/dev/null
            else
                cat "$prompt_file" | "$CLAUDE_CMD" -p --max-turns 1 > "$output_file" 2>/dev/null
            fi
            ;;
        *)
            echo "Error: Unknown engine '$ENGINE'"
            exit 1
            ;;
    esac
}

# --- Count personas ---
PERSONA_COUNT=0
for p in $PERSONAS; do
    PERSONA_COUNT=$((PERSONA_COUNT + 1))
done

echo "============================================"
echo "  IDEO IDEATION SPRINT"
echo "============================================"
echo ""
echo "Goal:     $(basename "$GOAL_FILE")"
echo "Output:   $OUTPUT_DIR"
echo "Engine:   $ENGINE"
echo "Personas: $PERSONAS ($PERSONA_COUNT participants)"
echo "Votes:    $VOTES_PER_PERSONA per persona"
echo "Context:  $CONTEXT_FOUND existing work sources discovered"
echo ""

# =============================================
# PHASE 1: INDEPENDENT IDEATION
# =============================================
echo "──────────────────────────────────────────"
echo "  PHASE 1: INDEPENDENT IDEATION"
echo "──────────────────────────────────────────"
echo ""

GOAL_CONTENT=$(cat "$GOAL_FILE")

for PERSONA in $PERSONAS; do
    DISPLAY_NAME=$(persona_display_name "$PERSONA")
    PERSONA_PATH=$(persona_file_path "$PERSONA")
    IDEA_FILE="$OUTPUT_DIR/phase1-ideas-${PERSONA}.md"

    if [ ! -f "$PERSONA_PATH" ]; then
        echo "  ⚠ Skipping $PERSONA — persona file not found: $PERSONA_PATH"
        continue
    fi

    echo "  → $DISPLAY_NAME is ideating..."

    PROMPT_FILE=$(mktemp)
    cat > "$PROMPT_FILE" <<IDEATION_PROMPT
You are adopting the following persona for a creative ideation session.

=== PERSONA DEFINITION ===
$(cat "$PERSONA_PATH")
=== END PERSONA DEFINITION ===

=== IDEATION INSTRUCTIONS ===
You are participating in an IDEO-style ideation sprint. The goal is to generate the MAXIMUM NUMBER of NEW ideas possible. Quantity over quality at this stage — wild ideas are encouraged.

CRITICAL: Below you will find a section called "EXISTING WORK." These are features, systems, and decisions that ALREADY EXIST in this project. Read it carefully. DO NOT re-propose anything that has already been built, decided, or scoped. Your ideas must go BEYOND what exists. You may propose improvements or extensions to existing work, but label them clearly as "Extension of [existing thing]" and explain what is NEW.

Rules:
- Generate as many ideas as you can (aim for 8-15 minimum)
- Each idea should be 2-4 sentences: a title, what it does, and why it matters
- Ideas can be anything: features, architectures, algorithms, UX patterns, processes, experiments, tools
- Think from your persona's unique perspective (your expertise, your concerns, your domain)
- No idea is too crazy — include moonshots alongside practical ones
- Do NOT evaluate or critique ideas — just generate
- Do NOT reference other people's ideas (you haven't seen any yet)
- Do NOT re-propose things that already exist (see EXISTING WORK below)

Format each idea as:

### Idea N: [Short Title]
[2-4 sentence description of the idea, what it does, and why it matters from your perspective]

=== GOAL / REQUIREMENT ===
$GOAL_CONTENT
=== END GOAL ===

$(cat "$EXISTING_WORK_FILE")

Generate your ideas now. Start with "# Ideation — $DISPLAY_NAME" as the document title.
Remember: maximum quantity, think from your unique perspective as $DISPLAY_NAME. Do NOT re-propose anything listed in EXISTING WORK.
IDEATION_PROMPT

    run_llm "$PROMPT_FILE" "$IDEA_FILE"
    rm -f "$PROMPT_FILE"

    if [ -s "$IDEA_FILE" ]; then
        IDEA_COUNT=$(grep -c "^### Idea" "$IDEA_FILE" 2>/dev/null || echo "0")
        echo "    ✓ $IDEA_COUNT ideas written to $(basename "$IDEA_FILE")"
    else
        echo "    ✗ No output — LLM may have failed"
    fi
done

echo ""

# =============================================
# PHASE 2: CROSS-POLLINATION & VOTING
# =============================================
echo "──────────────────────────────────────────"
echo "  PHASE 2: VOTING & IMPROVEMENT"
echo "──────────────────────────────────────────"
echo ""

# Compile all ideas into a single document for voting
ALL_IDEAS_FILE="$OUTPUT_DIR/phase1-all-ideas.md"
cat > "$ALL_IDEAS_FILE" <<ALL_IDEAS_HEADER
# All Ideas — Compiled for Voting

ALL_IDEAS_HEADER

for PERSONA in $PERSONAS; do
    IDEA_FILE="$OUTPUT_DIR/phase1-ideas-${PERSONA}.md"
    if [ -f "$IDEA_FILE" ]; then
        DISPLAY_NAME=$(persona_display_name "$PERSONA")
        echo "" >> "$ALL_IDEAS_FILE"
        echo "---" >> "$ALL_IDEAS_FILE"
        echo "" >> "$ALL_IDEAS_FILE"
        echo "## Ideas from: $DISPLAY_NAME" >> "$ALL_IDEAS_FILE"
        echo "" >> "$ALL_IDEAS_FILE"
        cat "$IDEA_FILE" >> "$ALL_IDEAS_FILE"
    fi
done

echo "  Compiled all ideas into $(basename "$ALL_IDEAS_FILE")"
echo ""

# Each persona votes on ideas (not their own)
for PERSONA in $PERSONAS; do
    DISPLAY_NAME=$(persona_display_name "$PERSONA")
    PERSONA_PATH=$(persona_file_path "$PERSONA")
    VOTE_FILE="$OUTPUT_DIR/phase2-votes-${PERSONA}.md"

    if [ ! -f "$PERSONA_PATH" ]; then
        continue
    fi

    echo "  → $DISPLAY_NAME is reviewing and voting..."

    # Build the ideas document EXCLUDING this persona's own ideas
    OTHER_IDEAS_FILE=$(mktemp)
    cat > "$OTHER_IDEAS_FILE" <<OTHER_HEADER
# Ideas from Other Participants

OTHER_HEADER

    for OTHER_PERSONA in $PERSONAS; do
        if [ "$OTHER_PERSONA" = "$PERSONA" ]; then
            continue
        fi
        OTHER_IDEA_FILE="$OUTPUT_DIR/phase1-ideas-${OTHER_PERSONA}.md"
        if [ -f "$OTHER_IDEA_FILE" ]; then
            OTHER_DISPLAY=$(persona_display_name "$OTHER_PERSONA")
            echo "" >> "$OTHER_IDEAS_FILE"
            echo "---" >> "$OTHER_IDEAS_FILE"
            echo "" >> "$OTHER_IDEAS_FILE"
            echo "## Ideas from: $OTHER_DISPLAY" >> "$OTHER_IDEAS_FILE"
            echo "" >> "$OTHER_IDEAS_FILE"
            cat "$OTHER_IDEA_FILE" >> "$OTHER_IDEAS_FILE"
        fi
    done

    PROMPT_FILE=$(mktemp)
    cat > "$PROMPT_FILE" <<VOTING_PROMPT
You are adopting the following persona for a creative ideation voting session.

=== PERSONA DEFINITION ===
$(cat "$PERSONA_PATH")
=== END PERSONA DEFINITION ===

=== ORIGINAL GOAL ===
$GOAL_CONTENT
=== END GOAL ===

=== VOTING INSTRUCTIONS ===
You are in Phase 2 of an IDEO-style ideation sprint. Other participants have generated ideas. You must now VOTE on the ideas you find most promising.

Rules:
- You have exactly $VOTES_PER_PERSONA votes
- You CANNOT vote for your own ideas (your ideas are not shown below)
- For EVERY vote you cast, you MUST also suggest a specific improvement to that idea
- Consider ideas from your unique perspective as $DISPLAY_NAME
- Be constructive — the improvement should make the idea stronger, not tear it down
- You may vote for ideas from different people or put multiple votes on one idea

Format each vote as:

### Vote N: [Idea Title] (by [Author Persona])
**Why:** [1-2 sentences on why this idea has potential]
**Improvement:** [1-2 sentences suggesting a specific enhancement, combination, or twist]

=== IDEAS FROM OTHER PARTICIPANTS ===
$(cat "$OTHER_IDEAS_FILE")
=== END IDEAS ===

Cast your $VOTES_PER_PERSONA votes now. Start with "# Votes — $DISPLAY_NAME" as the document title.
VOTING_PROMPT

    run_llm "$PROMPT_FILE" "$VOTE_FILE"
    rm -f "$PROMPT_FILE" "$OTHER_IDEAS_FILE"

    if [ -s "$VOTE_FILE" ]; then
        VOTE_COUNT=$(grep -c "^### Vote" "$VOTE_FILE" 2>/dev/null || echo "0")
        echo "    ✓ $VOTE_COUNT votes cast → $(basename "$VOTE_FILE")"
    else
        echo "    ✗ No output — LLM may have failed"
    fi
done

echo ""

# =============================================
# PHASE 3: MERGE & TALLY
# =============================================
echo "──────────────────────────────────────────"
echo "  PHASE 3: MERGE SIMILAR IDEAS & TALLY"
echo "──────────────────────────────────────────"
echo ""

# Compile all votes
ALL_VOTES_FILE="$OUTPUT_DIR/phase2-all-votes.md"
cat > "$ALL_VOTES_FILE" <<VOTES_HEADER
# All Votes — Compiled

VOTES_HEADER

for PERSONA in $PERSONAS; do
    VOTE_FILE="$OUTPUT_DIR/phase2-votes-${PERSONA}.md"
    if [ -f "$VOTE_FILE" ]; then
        cat "$VOTE_FILE" >> "$ALL_VOTES_FILE"
        echo "" >> "$ALL_VOTES_FILE"
        echo "---" >> "$ALL_VOTES_FILE"
        echo "" >> "$ALL_VOTES_FILE"
    fi
done

MERGE_OUTPUT="$OUTPUT_DIR/phase3-merged-results.md"

echo "  → Facilitator is merging similar ideas and tallying votes..."

PROMPT_FILE=$(mktemp)
cat > "$PROMPT_FILE" <<MERGE_PROMPT
You are a neutral facilitator running an IDEO-style ideation sprint. Your job is to:

1. Read ALL the ideas generated in Phase 1
2. Read ALL the votes and improvement suggestions from Phase 2
3. Cross-check ideas against EXISTING WORK (below) — flag and REMOVE any idea that re-proposes something already built. Note removed ideas in a "Duplicates of Existing Work" section.
4. Identify ideas that are similar enough to merge (same core concept, different angles)
5. Tally votes (merged ideas get combined vote counts)
6. Rank ideas by total votes (highest first)
7. For each top idea, incorporate the improvement suggestions from voters

=== ORIGINAL GOAL ===
$GOAL_CONTENT
=== END GOAL ===

$(cat "$EXISTING_WORK_FILE")

=== ALL IDEAS (Phase 1) ===
$(cat "$ALL_IDEAS_FILE")
=== END ALL IDEAS ===

=== ALL VOTES (Phase 2) ===
$(cat "$ALL_VOTES_FILE")
=== END ALL VOTES ===

=== OUTPUT FORMAT ===
Produce a document titled "# IDEO Sprint Results — Merged & Ranked"

Start with a summary table:

| Rank | Idea | Original Author(s) | Votes | Merged From |
|------|------|-------------------|-------|-------------|

Then for each idea (ranked by votes, descending), write a section:

## Rank N: [Idea Title] — [X votes]
**Original Author(s):** [persona names]
**Merged From:** [list of original idea titles if merged, or "Original" if standalone]

### Core Concept
[2-4 sentences synthesizing the idea, incorporating voter improvements]

### Voter Improvements Incorporated
- [Improvement 1 from Voter A]
- [Improvement 2 from Voter B]

### Suggested Next Steps
[1-2 sentences on what the product team should do with this idea]

---

Include ALL genuinely new ideas, even those with zero votes (rank them last).

Before the ranked list, add a section:
## Duplicates of Existing Work (Removed)
| Idea | Proposed By | Duplicates |
|------|------------|------------|
[List any ideas that re-propose features/systems that already exist, with the existing work they duplicate. These are EXCLUDED from ranking and vote tallying.]

At the end, add a section "## Session Statistics" with: total ideas generated, duplicates removed, total unique ideas after merge, total votes cast, and participation by persona.
=== END OUTPUT FORMAT ===

Produce the merged results document now.
MERGE_PROMPT

run_llm "$PROMPT_FILE" "$MERGE_OUTPUT"
rm -f "$PROMPT_FILE"

if [ -s "$MERGE_OUTPUT" ]; then
    echo "    ✓ Merged results written to $(basename "$MERGE_OUTPUT")"
else
    echo "    ✗ Merge failed — no output"
    exit 1
fi

echo ""

# =============================================
# PHASE 4: VP PROD GENERATES PRDs/ADRs
# =============================================
echo "──────────────────────────────────────────"
echo "  PHASE 4: PRD/ADR GENERATION"
echo "──────────────────────────────────────────"
echo ""

VP_PROD_PERSONA="$REPO_ROOT/docs/personas/vp-product.md"
PRD_OUTPUT="$OUTPUT_DIR/phase4-prds.md"

if [ ! -f "$VP_PROD_PERSONA" ]; then
    echo "  ⚠ VP Product persona not found — skipping Phase 4"
    echo "    You can run VP Prod manually against: $MERGE_OUTPUT"
else
    echo "  → VP of Product is drafting PRDs from top-voted ideas..."

    # Check for PRD template
    PRD_TEMPLATE=""
    if [ -f "$REPO_ROOT/docs/sprints/_templates/prd-template.md" ]; then
        PRD_TEMPLATE=$(cat "$REPO_ROOT/docs/sprints/_templates/prd-template.md")
    fi

    PROMPT_FILE=$(mktemp)
    cat > "$PROMPT_FILE" <<PRD_PROMPT
You are adopting the following persona to generate product artifacts from ideation results.

=== PERSONA DEFINITION ===
$(cat "$VP_PROD_PERSONA")
=== END PERSONA DEFINITION ===

=== TASK ===
An IDEO-style ideation sprint has just completed. The merged and ranked results are below.
Your job is to take the TOP-VOTED ideas (those with 2+ votes, or top 5 if fewer qualify)
and draft actionable product artifacts for each:

For each qualifying idea, produce:

### PRD Draft: [Idea Title]
**PRD Number:** PRD-IDEO-[N]
**Status:** Draft (from ideation — needs CEO review)
**Origin:** IDEO Sprint — [X] votes from [persona names]

**Goal:** [1-2 sentences — what problem does this solve?]
**Background:** [Why this idea surfaced, what perspectives drove it]
**Requirements:**
- Must Have: [from the core concept + voter improvements]
- Nice to Have: [extensions or optional enhancements]
**Success Metrics:** [How do we know this worked?]
**Effort Estimate:** [T-shirt size: S/M/L/XL with brief justification]
**Dependencies:** [What else needs to exist first?]
**Open Questions:** [What needs to be resolved before implementation?]

If any idea clearly warrants an ADR (architectural decision), also produce:

### ADR Draft: [Decision Title]
**ADR Number:** ADR-IDEO-[N]
**Status:** Proposed
**Context:** [Why this decision needs to be made]
**Decision:** [The recommended approach]
**Alternatives Considered:** [Other options and why they were rejected]
**Consequences:** [Trade-offs of this decision]

=== ORIGINAL GOAL ===
$GOAL_CONTENT
=== END GOAL ===

=== MERGED & RANKED IDEATION RESULTS ===
$(cat "$MERGE_OUTPUT")
=== END RESULTS ===

$(if [ -n "$PRD_TEMPLATE" ]; then echo "=== PRD TEMPLATE (for reference) ==="; echo "$PRD_TEMPLATE"; echo "=== END TEMPLATE ==="; fi)

Start with "# PRD Drafts — IDEO Sprint Output" as the document title.
Include a summary table at the top listing all PRDs and ADRs produced.
These are DRAFTS — note that they require CEO review and approval before entering the roadmap.
PRD_PROMPT

    run_llm "$PROMPT_FILE" "$PRD_OUTPUT"
    rm -f "$PROMPT_FILE"

    if [ -s "$PRD_OUTPUT" ]; then
        PRD_COUNT=$(grep -c "^### PRD Draft:" "$PRD_OUTPUT" 2>/dev/null || echo "0")
        ADR_COUNT=$(grep -c "^### ADR Draft:" "$PRD_OUTPUT" 2>/dev/null || echo "0")
        echo "    ✓ $PRD_COUNT PRD drafts and $ADR_COUNT ADR drafts → $(basename "$PRD_OUTPUT")"
    else
        echo "    ✗ PRD generation failed — no output"
    fi
fi

echo ""

# =============================================
# SUMMARY
# =============================================
echo "============================================"
echo "  IDEO SPRINT COMPLETE"
echo "============================================"
echo ""
echo "Output directory: $OUTPUT_DIR"
echo ""
echo "Phase 1 — Ideas:"
for PERSONA in $PERSONAS; do
    IDEA_FILE="$OUTPUT_DIR/phase1-ideas-${PERSONA}.md"
    if [ -f "$IDEA_FILE" ]; then
        COUNT=$(grep -c "^### Idea" "$IDEA_FILE" 2>/dev/null || echo "0")
        DISPLAY_NAME=$(persona_display_name "$PERSONA")
        echo "  $DISPLAY_NAME: $COUNT ideas"
    fi
done
echo ""
echo "Phase 2 — Votes:"
for PERSONA in $PERSONAS; do
    VOTE_FILE="$OUTPUT_DIR/phase2-votes-${PERSONA}.md"
    if [ -f "$VOTE_FILE" ]; then
        COUNT=$(grep -c "^### Vote" "$VOTE_FILE" 2>/dev/null || echo "0")
        DISPLAY_NAME=$(persona_display_name "$PERSONA")
        echo "  $DISPLAY_NAME: $COUNT votes"
    fi
done
echo ""
echo "Phase 3 — Merged results: $(basename "$MERGE_OUTPUT")"
if [ -f "$PRD_OUTPUT" ] && [ -s "$PRD_OUTPUT" ]; then
    echo "Phase 4 — PRD drafts:     $(basename "$PRD_OUTPUT")"
fi
echo ""
echo "Next steps:"
echo "  1. Review merged results:  cat $MERGE_OUTPUT"
echo "  2. Review PRD drafts:      cat $PRD_OUTPUT"
echo "  3. Present to CEO for approval"
echo "  4. Approved PRDs → docs/roadmap/prds/PRD-XXX-{slug}.md"
echo "  5. Approved ADRs → docs/architecture/decisions/ADR-XXX-{slug}.md"
echo ""
