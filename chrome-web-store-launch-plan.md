# DOMShell — Chrome Web Store Launch Plan

## Part 1: Getting Approved (First-Time Publisher Checklist)

### Step 1: Register as a Chrome Web Store Developer

Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) and pay the one-time **$5 registration fee**. Use the Google account you want associated with DOMShell long-term (your personal or a dedicated dev account). Enable **2-Step Verification** on that Google account — it's required before you can publish anything.

### Step 2: Create a Privacy Policy

This is the #1 rejection reason for first-time publishers. DOMShell needs one because it uses the `debugger` permission and `<all_urls>` host permission. Create a simple privacy policy page and host it — your best options are:

- **pireno.com/domshell/privacy** (preferred — drives traffic to your site)
- A GitHub Pages page at `apireno.github.io/DOMShell/privacy`
- A simple Google Doc made public

The policy should cover:

```
DOMShell Privacy Policy

Last updated: [date]

DOMShell is a Chrome extension that exposes the browser's Accessibility Tree
as a filesystem for AI agents and developers.

DATA COLLECTION
DOMShell does NOT collect, transmit, or store any personal data. All
processing happens locally in your browser.

LOCAL COMMUNICATION ONLY
DOMShell communicates with a locally-running MCP server via WebSocket
(localhost:9876). No data is sent to external servers, cloud services,
or third parties.

PERMISSIONS EXPLAINED
- debugger: Used to access the Chrome DevTools Protocol for reading the
  Accessibility Tree and executing page interactions
- activeTab: Accesses the current tab's content when you invoke DOMShell
- <all_urls>: Required for the debugger API to attach to any tab
- sidePanel: Renders the terminal interface
- storage: Saves your preferences locally
- cookies/identity: Reserved for future authentication features (not
  currently used)
- alarms: Used for periodic internal housekeeping

THIRD-PARTY SERVICES
DOMShell does not integrate with any third-party analytics, tracking,
or advertising services.

CONTACT
[your email] | https://pireno.com
```

### Step 3: Prepare Store Assets

You currently have icons (16, 48, 128px) but need additional assets:

**Required:**
- At least **1 screenshot** (1280×800 or 640×400) — aim for 3-5

**Recommended screenshots to create:**
1. **The side panel terminal** — show DOMShell open alongside a real website with a few commands visible (`ls`, `cd`, `find`)
2. **Multi-tab orchestration** — show the `each` command extracting from multiple tabs simultaneously
3. **MCP integration** — show Claude Desktop or another AI agent using DOMShell commands
4. **Before/after comparison** — split showing "fragile CSS selectors" vs "clean DOMShell commands"
5. **Script replay** — show the `script save` + `for` workflow

**Optional but high-impact:**
- **Promotional tile** (1280×800): A branded graphic with the DOMShell logo, tagline, and a terminal screenshot
- **Small promotional tile** (440×280): Cropped version for search results

**How to create these:** Open DOMShell, run representative commands, and use Chrome's built-in screenshot tool (Ctrl+Shift+I → Device toolbar → capture screenshot at 1280×800). For the promotional tiles, use Figma, Canva, or even a simple HTML page screenshot with your branding.

### Step 4: Prepare the Listing Details

When you upload to the Developer Dashboard, you'll fill in these fields:

**Name:** `DOMShell — Browser Filesystem for AI Agents`
(The name field allows up to 75 characters. Include your primary keyword.)

**Summary (132 chars max):**
`Browse the web with Linux commands. AI agents use ls, cd, grep, click via MCP. Terminal in Chrome Side Panel.`

**Description (16,000 chars max):**
See the SEO-optimized description in Part 2 below.

**Category:** `Developer Tools`

**Language:** English

**Privacy Policy URL:** `https://pireno.com/domshell/privacy`

**Homepage URL:** `https://github.com/apireno/DOMShell` (already in manifest)

**Support URL:** `https://github.com/apireno/DOMShell/issues`

### Step 5: Address Permission Justifications

The review team will scrutinize your permissions, especially `debugger` and `<all_urls>`. In the Developer Dashboard, you'll be asked to justify each permission. Here are the justifications:

| Permission | Justification |
|-----------|---------------|
| `debugger` | Core functionality: DOMShell uses the Chrome DevTools Protocol (CDP) to read the Accessibility Tree of web pages, which is only accessible via the debugger API. This tree is mapped to a virtual filesystem. |
| `<all_urls>` | Required by the debugger API to attach to any tab the user navigates to. DOMShell must work on all websites — it's a general-purpose browser automation tool, not site-specific. |
| `activeTab` | Accesses the currently active tab when the user opens the DOMShell side panel. |
| `sidePanel` | DOMShell's primary UI is a terminal rendered in Chrome's Side Panel. |
| `storage` | Stores user preferences (e.g., saved scripts, configuration) locally. |
| `cookies` | Reserved for future features. Consider removing if not used — fewer permissions = faster approval. |
| `identity` | Reserved for future features. Consider removing if not used. |
| `alarms` | Used for periodic housekeeping tasks (e.g., cleanup of stale tab references). |

**Recommendation:** Remove `cookies` and `identity` from the manifest before submission if they're not actively used. Fewer permissions = fewer questions = faster approval.

### Step 6: Build and Package

```bash
cd /path/to/DOMShell
npm run build
cd dist
zip -r ../domshell-1.1.0.zip .
```

Upload `domshell-1.1.0.zip` to the Developer Dashboard. **Zip the contents of `dist/`, not the `dist/` folder itself.**

### Step 7: Submit and Wait

Submit for review. Typical timeline is **1-3 business days**. Extensions requesting `debugger` permission may take longer due to the sensitivity of that API. If it's been more than 3 weeks, contact developer support through the dashboard.

**Common rejection reasons to avoid:**
- Missing or inadequate privacy policy
- Permissions not justified in the single-purpose description
- Description doesn't clearly explain what the extension does
- No screenshots showing the extension in action

---

## Part 2: SEO-Optimized Store Listing

### Optimized Extension Name

`DOMShell — Browser Filesystem for AI Agents`

This hits three keyword clusters: "browser filesystem", "AI agents", and includes the brand name. The Chrome Web Store search heavily weights the extension name.

### Optimized Description

Use this as your Chrome Web Store description. It's structured to hit key search terms while remaining readable:

```
DOMShell turns your browser into a filesystem. Navigate Chrome with Linux
commands — ls, cd, grep, cat, click — through a terminal in the Side Panel.

AI agents (Claude, GPT, LLMs) control the browser via 39 MCP tools over
the Model Context Protocol. No screenshots, no pixel coordinates, no
brittle CSS selectors. Just clean, deterministic commands.

🔧 HOW IT WORKS

DOMShell maps the browser's Accessibility Tree into a virtual filesystem:
• Windows and tabs → top-level directories (~)
• Page sections → nested directories
• Buttons, links, inputs → files you can click, read, and interact with

Navigate a website the same way you'd navigate /usr/local/bin.

⚡ KEY FEATURES

Terminal Interface — A full terminal in Chrome's Side Panel with 39
commands: ls, cd, cat, grep, find, click, type, submit, scroll, and more.

AI Agent Integration — Connects to Claude Desktop, Cursor, Windsurf, or
any MCP-compatible client via the Model Context Protocol. Your AI agent
browses the web using familiar shell commands.

Multi-Tab Orchestration — Run commands across multiple open tabs
simultaneously with `each`. Open N URLs in a single call with `for`.
Save and replay workflows with `script`.

JavaScript Execution — Run arbitrary JS with `eval`, discover page APIs
with `functions`, invoke them with `call`, and detect changes with `watch`.

Page API Discovery — The `functions` command reveals callable JavaScript
functions on any page, filtered from standard browser APIs.

Batch Scripting — Save reusable command sequences with `script save`,
then replay across multiple inputs with `for` iteration.

🎯 USE CASES

• AI-powered web scraping and data extraction
• Automated testing and QA workflows
• Accessibility auditing
• Browser automation without Selenium or Puppeteer
• Research pipelines that extract from multiple pages
• Building MCP-powered AI agents that browse the web

🛠️ FOR DEVELOPERS

DOMShell exposes a WebSocket API (localhost:9876) and an HTTP MCP server
(localhost:3001). Integrate with any language or framework.

Works with: Claude Desktop, Claude Code, Cursor, Windsurf, Cline,
and any MCP-compatible AI client.

Open source: https://github.com/apireno/DOMShell
Documentation: https://github.com/apireno/DOMShell#readme
Built by Pireno — https://pireno.com

📋 PERMISSIONS

DOMShell uses the Chrome DevTools Protocol (debugger API) to read the
Accessibility Tree. All processing is local — no data leaves your browser.
See our privacy policy for full details.
```

### Keyword Strategy

These are the search terms DOMShell should rank for on the Chrome Web Store:

**Primary keywords** (include in name + first paragraph):
- browser automation
- AI agent browser
- MCP chrome extension
- browser filesystem

**Secondary keywords** (include in description body):
- Model Context Protocol
- Chrome DevTools Protocol
- web scraping AI
- Claude Desktop extension
- terminal chrome extension
- accessibility tree
- browser shell
- headless browser alternative

**Long-tail keywords** (include in use cases section):
- AI-powered web scraping
- automated browser testing
- MCP tools for Chrome
- Claude browser integration
- LLM browser control

### GitHub README SEO

Your README is already strong (1,105 lines). Add these to improve discoverability via Google search (which also drives CWS installs):

1. **Add a "badges" row** at the top: Chrome Web Store version badge, license badge, GitHub stars badge
2. **Add "Chrome Web Store" install link** as the primary installation method (above "From Source")
3. **Add structured keywords** in the first paragraph for Google indexing
4. **Create a `docs/` folder** with guides that target specific search queries:
   - `docs/mcp-setup.md` → "How to connect DOMShell to Claude Desktop"
   - `docs/ai-web-scraping.md` → "AI web scraping with DOMShell"
   - `docs/comparison.md` → "DOMShell vs Puppeteer vs Playwright"

---

## Part 3: Promoting pireno.com

### In-Extension Promotion

**Options page:** Your `options.html` already exists. Add a "Built by [Pireno](https://pireno.com)" footer with a brief line about your services.

**Side panel footer:** Add a subtle "Built by Pireno" link at the bottom of the terminal side panel. Keep it unobtrusive — a small text link, not a banner.

**Manifest homepage_url:** Already set to GitHub. Consider changing to `https://pireno.com/domshell` and creating a landing page there that links to both the CWS listing and GitHub.

### DOMShell Landing Page on pireno.com

Create `pireno.com/domshell` as a landing page. This serves three purposes: SEO juice for pireno.com, a professional home for DOMShell, and a place to host the privacy policy. Structure:

```
pireno.com/domshell/
├── index.html     — Landing page with install CTA, features, demo GIF
├── privacy/       — Privacy policy (required for CWS)
├── docs/          — Optional: tutorials, guides
└── experiment/    — Optional: link to your DOMShell vs CiC results
```

The landing page should include:
- Hero section with DOMShell logo + "Install from Chrome Web Store" button
- Brief feature overview (the same content as the CWS description, reformatted)
- A terminal demo GIF or embedded video
- "Built by Pireno" section linking to your services
- Footer with links to pireno.com main site, GitHub, CWS listing

### Content Marketing

Write 2-3 blog posts or articles that naturally link back to both DOMShell and pireno.com:

1. **"Why I Built a Filesystem for the Browser"** — Origin story, post on dev.to, Hacker News, Reddit r/programming. Links to pireno.com/domshell.

2. **"DOMShell vs Claude in Chrome: Benchmark Results"** — You already have the data from our experiment. Turn final_report.md into a blog post. Developers love benchmarks. Post on dev.to, HN, Reddit r/LocalLLaMA and r/ClaudeAI.

3. **"Building MCP Tools for Chrome"** — Technical deep-dive for the MCP/AI agent community. Post on the Anthropic community forum, dev.to, and your own blog at pireno.com.

### Community Promotion

- **Hacker News:** Submit `pireno.com/domshell` as a Show HN post. The "filesystem metaphor for browsers" angle is exactly the kind of thing HN loves.
- **Reddit:** r/ClaudeAI, r/LocalLLaMA, r/programming, r/webdev, r/chrome
- **Anthropic Community:** Post in the MCP tools/integrations section
- **Twitter/X:** Tag @AnthropicAI and use #MCP, #AIAgents, #ChromeExtension hashtags
- **Product Hunt:** Launch DOMShell as a product. The "AI agent browser automation" category is hot right now.

### Backlink Strategy

Every external mention should link to `pireno.com/domshell` (not directly to GitHub or CWS). This builds domain authority for pireno.com. The landing page then links out to CWS for installs and GitHub for source code.

```
Blog post / HN / Reddit → pireno.com/domshell → Chrome Web Store (install)
                                               → GitHub (source code)
                                               → pireno.com (services)
```

---

## Quick-Start Action Items

1. **Today:** Remove unused permissions (`cookies`, `identity`) from manifest if not needed
2. **Today:** Create privacy policy, host at pireno.com/domshell/privacy
3. **This week:** Take 3-5 screenshots of DOMShell in action
4. **This week:** Register CWS developer account ($5), upload extension
5. **This week:** Create pireno.com/domshell landing page
6. **After approval:** Write "Show HN" post and dev.to article
7. **After approval:** Post benchmark results (DOMShell vs CiC) as a blog post
8. **Ongoing:** Respond to GitHub issues and CWS reviews promptly — engagement signals matter for ranking
