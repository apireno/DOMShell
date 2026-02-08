import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const PROMPT = "\x1b[1;32mdom\x1b[0m@\x1b[1;34mshell\x1b[0m:\x1b[1;33m$\x1b[0m ";

export default function Terminal() {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerminal | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const lineBuffer = useRef("");
  const historyRef = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const completionPending = useRef(false);

  const writePrompt = useCallback(() => {
    xtermRef.current?.write(PROMPT);
  }, []);

  useEffect(() => {
    if (!termRef.current) return;

    // Initialize xterm
    const term = new XTerminal({
      cursorBlink: true,
      fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = term;

    // Connect to background service worker
    const port = chrome.runtime.connect({ name: "domshell" });
    portRef.current = port;

    // Handle messages from the background
    port.onMessage.addListener((msg) => {
      if (msg.type === "STDOUT" || msg.type === "STDERR") {
        if (msg.output || msg.error) {
          term.write((msg.output ?? msg.error) + "\r\n");
        }
        writePrompt();
      } else if (msg.type === "COMPLETE_RESPONSE") {
        handleCompletionResponse(term, msg.matches, msg.partial);
      }
    });

    // Tell the background we're ready
    port.postMessage({ type: "READY" });

    // Use onData for ALL input — handles both typing and paste
    term.onData((data) => {
      if (data === "\r") {
        // Enter
        term.write("\r\n");
        const command = lineBuffer.current.trim();
        if (command) {
          historyRef.current.push(command);
          historyIndex.current = historyRef.current.length;
          port.postMessage({ type: "STDIN", input: command });
        } else {
          writePrompt();
        }
        lineBuffer.current = "";
      } else if (data === "\x7f" || data === "\b") {
        // Backspace (0x7f on Mac, 0x08 on some terminals)
        if (lineBuffer.current.length > 0) {
          lineBuffer.current = lineBuffer.current.slice(0, -1);
          term.write("\b \b");
        }
      } else if (data === "\x1b[A") {
        // Arrow Up - history
        if (historyIndex.current > 0) {
          historyIndex.current--;
          replaceLineWith(term, historyRef.current[historyIndex.current]);
        }
      } else if (data === "\x1b[B") {
        // Arrow Down - history
        if (historyIndex.current < historyRef.current.length - 1) {
          historyIndex.current++;
          replaceLineWith(term, historyRef.current[historyIndex.current]);
        } else {
          historyIndex.current = historyRef.current.length;
          replaceLineWith(term, "");
        }
      } else if (data === "\x03") {
        // Ctrl+C
        lineBuffer.current = "";
        term.write("^C\r\n");
        writePrompt();
      } else if (data === "\x0c") {
        // Ctrl+L — clear
        term.clear();
        writePrompt();
      } else if (data === "\t") {
        // Tab — trigger completion
        handleTab(port);
      } else if (!data.startsWith("\x1b")) {
        // Regular characters or pasted text — append to buffer and echo
        // Filter out control characters but allow multi-char paste
        const clean = data.replace(/[\x00-\x08\x0e-\x1f]/g, "");
        if (clean) {
          lineBuffer.current += clean;
          term.write(clean);
        }
      }
    });

    // Resize handler
    const handleResize = () => fitAddon.fit();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      port.disconnect();
      term.dispose();
    };
  }, [writePrompt]);

  function replaceLineWith(term: XTerminal, newLine: string) {
    // Clear current line buffer from display
    const clearLen = lineBuffer.current.length;
    term.write("\b".repeat(clearLen) + " ".repeat(clearLen) + "\b".repeat(clearLen));
    lineBuffer.current = newLine;
    term.write(newLine);
  }

  function handleTab(port: chrome.runtime.Port) {
    if (completionPending.current) return;

    const line = lineBuffer.current;
    const parts = line.split(/\s+/);

    let command = "";
    let partial = "";

    if (parts.length <= 1) {
      // Completing the command name itself
      partial = parts[0] || "";
      command = partial;
    } else {
      // Completing an argument — use the last word as partial
      command = parts[0];
      partial = parts[parts.length - 1] || "";
    }

    completionPending.current = true;
    port.postMessage({ type: "COMPLETE", partial, command });
  }

  function handleCompletionResponse(
    term: XTerminal,
    matches: string[],
    partial: string
  ) {
    completionPending.current = false;

    if (matches.length === 0) return;

    const line = lineBuffer.current;
    const parts = line.split(/\s+/);
    const isCommandCompletion = parts.length <= 1;

    if (matches.length === 1) {
      // Single match — auto-complete
      const completion = matches[0];
      const suffix = completion.slice(partial.length);

      if (isCommandCompletion) {
        // Replace the whole partial with the match + trailing space
        lineBuffer.current = completion + " ";
        term.write(suffix + " ");
      } else {
        // Replace just the last word
        lineBuffer.current = parts.slice(0, -1).join(" ") + " " + completion;
        term.write(suffix);
      }
    } else {
      // Multiple matches — find common prefix for partial completion
      const commonPrefix = findCommonPrefix(matches);
      const extraChars = commonPrefix.slice(partial.length);

      if (extraChars.length > 0) {
        // Can extend the partial with common prefix
        if (isCommandCompletion) {
          lineBuffer.current = commonPrefix;
        } else {
          lineBuffer.current = parts.slice(0, -1).join(" ") + " " + commonPrefix;
        }
        term.write(extraChars);
      }

      // Show all options below
      term.write("\r\n");
      const display = matches.map((m) => `  ${m}`).join("\r\n");
      term.write(display + "\r\n");
      writePrompt();
      term.write(lineBuffer.current);
    }
  }

  function findCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return "";
    let prefix = strings[0];
    for (let i = 1; i < strings.length; i++) {
      while (!strings[i].startsWith(prefix)) {
        prefix = prefix.slice(0, -1);
        if (!prefix) return "";
      }
    }
    return prefix;
  }

  return (
    <div
      ref={termRef}
      style={{
        width: "100%",
        height: "100vh",
        backgroundColor: "#1a1b26",
        padding: 0,
        margin: 0,
      }}
    />
  );
}
