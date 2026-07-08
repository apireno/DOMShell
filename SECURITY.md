# Security Policy

Thanks for helping keep DOMShell users safe. This document is the disclosure ladder for security findings against the DOMShell Chrome extension and the `@apireno/domshell` MCP server.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security findings.** Public issues are indexed within minutes and would broadcast the exploit to every DOMShell user before a fix ships.

Use one of the following, in this order:

1. **GitHub Private Vulnerability Reporting (preferred)** — go to the [Security tab of this repository](https://github.com/apireno/DOMShell/security) and click **"Report a vulnerability"**. This opens a private issue thread that only you and the maintainer can see; GitHub also lets us cut a Security Advisory (GHSA) and coordinate a CVE from the same thread once the fix is ready.

2. **Email the maintainer** — `alessandro@pireno.com` (the address published on the [`@apireno/domshell` npm listing](https://www.npmjs.com/package/@apireno/domshell)). Include the finding ID / summary in the subject line so it doesn't sit unread in a filtered inbox.

Either channel is a good-faith disclosure. Please pick whichever you're more comfortable with — the private-issue thread is generally faster to coordinate on because it keeps the whole exchange in one place, but email is fine.

## What to include

A useful report has:

- **Repro steps or an assertion script** that a maintainer can run to confirm the finding. If you can't complete a stable end-to-end proof (e.g. couldn't get the extension bridge working in your test environment), a source-review that names the specific file/line/function chain is still valuable — call the caveat out explicitly.
- **The affected version(s)** and the git commit you reviewed. `@apireno/domshell@<version>` on npm and the repo commit hash are both fine.
- **Impact framing** — what capability a user or agent misgained, and against which threat model. OWASP LLM Top 10 / CWE class references are welcome but not required.
- **Suggested remediation direction** if you have one; totally fine to leave to the maintainer.

## What to expect

- Acknowledgment within **72 hours** on either channel.
- If the finding is verified, a fix is planned and the timeline shared with you before I publish anything.
- I'll offer credit in the CHANGELOG entry and the accompanying GitHub Security Advisory, in whatever form you prefer (name only / name + affiliation / anonymous "external reporter"). If you have a coordinated disclosure window (e.g. you're planning your own writeup), tell me the timing and I'll hold the advisory until then.
- Server-only fixes ship to npm + the MCP registry within a business day of verification. Extension fixes need Chrome Web Store review (typical 3-7 business days); I'll ship a pre-review unpacked build to affected integrators in the interim if needed.

## Scope

This policy covers:

- The `@apireno/domshell` MCP server (all versions on npm)
- The DOMShell Chrome extension (all versions in the Chrome Web Store, and unpacked builds distributed as `domshell-extension-<version>.zip`)
- The extension ↔ MCP server WebSocket bridge protocol
- Optional container / ToolHive install paths documented in `docs/deploy/`

Out of scope:

- Findings against integrator harnesses (HKUDS/CLI-Anything, kgspin QA-UX, third-party drives) — please report those to the respective maintainers.
- Denial-of-service against a caller's own browser via `--allow-write` commands the caller explicitly authorized.
- Social-engineering the human operator into pasting an unsafe command — the human-in-the-loop is a design premise, not a boundary.

## Non-security bug reports

For non-security bugs, please open a public GitHub issue: <https://github.com/apireno/DOMShell/issues>. That's the fastest path — public issues get attention from other users who may have workarounds or additional context.
