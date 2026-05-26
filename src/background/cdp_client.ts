import type { AXNode } from "../shared/types.ts";

/**
 * CDPClient wraps chrome.debugger into an async/await interface.
 * It manages attachment to browser tabs and sends CDP commands.
 */
export class CDPClient {
  private attachedTabId: number | null = null;

  async attach(tabId: number): Promise<void> {
    if (this.attachedTabId === tabId) return;

    // Detach from previous tab if needed
    if (this.attachedTabId !== null) {
      await this.detach();
    }

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          this.attachedTabId = tabId;
          resolve();
        }
      });
    });

    // Enable required CDP domains
    await this.send("Accessibility.enable");
    await this.send("DOM.enable");
    await this.send("Page.enable");
    await this.send("Runtime.enable");
  }

  async detach(): Promise<void> {
    if (this.attachedTabId === null) return;

    const tabId = this.attachedTabId;
    this.attachedTabId = null;

    await new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        // Ignore errors on detach (tab may already be closed)
        resolve();
      });
    });
  }

  getAttachedTabId(): number | null {
    return this.attachedTabId;
  }

  async send<T = any>(method: string, params?: Record<string, any>): Promise<T> {
    if (this.attachedTabId === null) {
      throw new Error("Not attached to any tab. Run 'attach' first.");
    }

    return new Promise<T>((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId: this.attachedTabId! },
        method,
        params ?? {},
        (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result as T);
          }
        }
      );
    });
  }

  /**
   * Fetch the full Accessibility Tree for the attached tab.
   */
  async getFullAXTree(): Promise<AXNode[]> {
    const result = await this.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    return result.nodes;
  }

  /**
   * Fetch a partial AX tree rooted at a specific node.
   */
  async getPartialAXTree(nodeId: string, depth: number = 2): Promise<AXNode[]> {
    try {
      const result = await this.send<{ nodes: AXNode[] }>("Accessibility.getPartialAXTree", {
        nodeId,
        fetchRelatives: false,
      });
      return result.nodes;
    } catch {
      // Fallback: get full tree and filter
      const fullTree = await this.getFullAXTree();
      return fullTree;
    }
  }

  /**
   * Click an element by resolving its backendDOMNodeId to coordinates.
   */
  async clickByBackendNodeId(backendDOMNodeId: number): Promise<void> {
    // Resolve the backend node to a RemoteObject
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    // Use Runtime.callFunctionOn to click it
    await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function() { this.click(); }`,
      arguments: [],
      returnByValue: true,
    });
  }

  /**
   * Click using mouse coordinates by getting the element's bounding box.
   */
  async clickByCoordinates(backendDOMNodeId: number): Promise<void> {
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    // Get bounding rect
    const { result } = await this.send<{ result: { value: any } }>(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function() {
          const rect = this.getBoundingClientRect();
          return JSON.stringify({ x: rect.x + rect.width/2, y: rect.y + rect.height/2 });
        }`,
        returnByValue: true,
      }
    );

    const coords = JSON.parse(result.value);

    // Dispatch mouse events
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: coords.x,
      y: coords.y,
      button: "left",
      clickCount: 1,
    });

    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: coords.x,
      y: coords.y,
      button: "left",
      clickCount: 1,
    });
  }

  /**
   * Type text into a focused element.
   */
  async typeText(text: string): Promise<void> {
    for (const char of text) {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
      });
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        text: char,
      });
    }
  }

  /**
   * Dispatch a single trusted key event pair to whatever element currently has
   * DOM focus. Produces real CDP-level events that React-driven SPAs respect
   * (event.isTrusted === true) — useful when an element's activation handler
   * listens for Enter rather than click. (#40)
   *
   * Down-event type matters: CDP's "keyDown" implies "this event will produce
   * text input" and Chrome can silently drop it for non-text-producing keys
   * (Enter, Escape, arrows, F-keys). Use "rawKeyDown" for those, and reserve
   * "keyDown" for printable characters where `text` carries the produced char.
   * (Matches Puppeteer/Playwright behavior.)
   *
   * `key` is the DOM key value ("Enter", "Escape", "Tab", "ArrowDown", "a", …).
   * `modifiers` is a CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
   */
  /** Result of a key dispatch — `trusted: true` means the CDP path fired
   *  (event.isTrusted will be true on the page); `false` means the JS
   *  synthetic fallback was used (no focus shift, but isTrusted will be
   *  false on the page). */
  async dispatchKey(key: string, modifiers: number = 0): Promise<{ trusted: boolean }> {
    const params = keyEventParams(key, modifiers);

    // Chrome's chrome.debugger.sendCommand path silently drops
    // Input.dispatchKeyEvent when the target tab isn't the active tab in its
    // window — the CDP call returns success ({}) but the renderer never fires
    // keydown. Two paths from here:
    //
    //   (a) The target tab IS already the active tab. The CDP trusted path
    //       will fire normally. Use it — agents that need event.isTrusted
    //       (React SPAs that guard activation) get what they need.
    //
    //   (b) The target tab is NOT active. We could call Page.bringToFront,
    //       but that visibly steals focus — disruptive when the agent runs
    //       from another window (Claude Desktop, the side panel). Instead,
    //       fall back to a JS-synthesized KeyboardEvent dispatched against
    //       document.activeElement. Untrusted, but works without shifting
    //       focus and triggers any handler that doesn't check isTrusted
    //       (which is most of them).
    //
    // Agents that hit an isTrusted-checking SPA simply make the target tab
    // active first (click on it, or cd %here% to the focused tab) and re-run
    // `key` — path (a) takes over automatically. (#40)
    const isActive = await this.targetTabIsActive();

    if (isActive) {
      const downType = "text" in params ? "keyDown" : "rawKeyDown";
      await this.send("Input.dispatchKeyEvent", { type: downType, ...params });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
      return { trusted: true };
    }

    // Synthetic fallback — dispatch KeyboardEvents directly on activeElement.
    const eventOpts = JSON.stringify({
      key: params.key,
      code: params.code ?? "",
      keyCode: params.windowsVirtualKeyCode ?? 0,
      which: params.windowsVirtualKeyCode ?? 0,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    await this.send("Runtime.evaluate", {
      expression: `(() => {
        const target = document.activeElement || document.body;
        const opts = ${eventOpts};
        target.dispatchEvent(new KeyboardEvent("keydown", opts));
        target.dispatchEvent(new KeyboardEvent("keyup", opts));
      })()`,
      returnByValue: true,
    });
    return { trusted: false };
  }

  /** Whether the currently-attached tab is the active (visible) tab in its
   *  window. Used to decide between the trusted CDP key-dispatch path and the
   *  untrusted JS synthetic fallback. (#40) */
  private async targetTabIsActive(): Promise<boolean> {
    if (this.attachedTabId === null) return false;
    return new Promise((resolve) => {
      chrome.tabs.get(this.attachedTabId!, (tab) => {
        if (chrome.runtime.lastError || !tab) return resolve(false);
        resolve(tab.active === true);
      });
    });
  }

  /**
   * Focus an element by its backend node ID.
   */
  async focusByBackendNodeId(backendDOMNodeId: number): Promise<void> {
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function() { this.focus(); }`,
      returnByValue: true,
    });
  }

  /**
   * Read the text content of an element.
   */
  async getTextContent(backendDOMNodeId: number): Promise<string> {
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    const { result } = await this.send<{ result: { value: string } }>(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function() { return this.textContent || this.value || ''; }`,
        returnByValue: true,
      }
    );

    return result.value;
  }

  /**
   * Extract text content with link URLs inlined as markdown [text](url).
   * Uses a single CDP call to walk the DOM tree efficiently.
   */
  async getTextContentWithLinks(backendDOMNodeId: number): Promise<string> {
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    const { result } = await this.send<{ result: { value: string } }>(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function() {
          function walk(node) {
            var out = '';
            for (var i = 0; i < node.childNodes.length; i++) {
              var child = node.childNodes[i];
              if (child.nodeType === 3) {
                out += child.textContent;
              } else if (child.nodeType === 1) {
                if (child.tagName === 'A' && child.href) {
                  var text = (child.innerText || '').trim();
                  if (text) {
                    out += '[' + text + '](' + child.href + ')';
                  } else {
                    out += child.href;
                  }
                } else {
                  out += walk(child);
                }
              }
            }
            return out;
          }
          return walk(this);
        }`,
        returnByValue: true,
      }
    );

    return result.value;
  }

  /**
   * Read the visible (rendered) text of an element using innerText.
   * Unlike textContent, innerText respects CSS visibility (display:none, etc.)
   * and returns only what the user would see on the rendered page.
   */
  async getInnerText(backendDOMNodeId: number): Promise<string> {
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    const { result } = await this.send<{ result: { value: string } }>(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function() { return this.innerText || this.value || ''; }`,
        returnByValue: true,
      }
    );

    return result.value;
  }

  /**
   * Get useful DOM properties for an element (tag, href, src, id, class, outerHTML snippet).
   */
  async getElementProperties(backendDOMNodeId: number): Promise<Record<string, string>> {
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    const { result } = await this.send<{ result: { value: Record<string, string> } }>(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function() {
          var o = {};
          if (this.tagName) o.tag = this.tagName.toLowerCase();
          if (this.href) o.href = this.href;
          if (this.src) o.src = this.src;
          if (this.action) o.action = this.action;
          if (this.id) o.id = this.id;
          if (this.className && typeof this.className === 'string') o.class = this.className;
          if (this.type) o.type = this.type;
          if (this.name) o.name = this.name;
          if (this.placeholder) o.placeholder = this.placeholder;
          if (this.alt) o.alt = this.alt;
          if (this.title) o.title = this.title;
          if (this.target) o.target = this.target;
          if (this.rel) o.rel = this.rel;
          var html = this.outerHTML || '';
          if (html.length > 300) html = html.slice(0, 300) + '...';
          if (html) o.outerHTML = html;
          return o;
        }`,
        returnByValue: true,
      }
    );

    return result.value;
  }

  /**
   * Get the current page URL.
   */
  async getPageUrl(): Promise<string> {
    const { result } = await this.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      {
        expression: "window.location.href",
        returnByValue: true,
      }
    );
    return result.value;
  }

  /**
   * Get the page title.
   */
  async getPageTitle(): Promise<string> {
    const { result } = await this.send<{ result: { value: string } }>(
      "Runtime.evaluate",
      {
        expression: "document.title",
        returnByValue: true,
      }
    );
    return result.value;
  }

  /**
   * Navigate back in browser history. Returns the new URL, or null if no history.
   */
  async goBack(): Promise<string | null> {
    const { currentIndex, entries } = await this.send<{
      currentIndex: number;
      entries: Array<{ id: number; url: string; title: string }>;
    }>("Page.getNavigationHistory");

    if (currentIndex <= 0) return null;

    await this.send("Page.navigateToHistoryEntry", {
      entryId: entries[currentIndex - 1].id,
    });

    return entries[currentIndex - 1].url;
  }

  /**
   * Navigate forward in browser history. Returns the new URL, or null if no forward history.
   */
  async goForward(): Promise<string | null> {
    const { currentIndex, entries } = await this.send<{
      currentIndex: number;
      entries: Array<{ id: number; url: string; title: string }>;
    }>("Page.getNavigationHistory");

    if (currentIndex >= entries.length - 1) return null;

    await this.send("Page.navigateToHistoryEntry", {
      entryId: entries[currentIndex + 1].id,
    });

    return entries[currentIndex + 1].url;
  }

  /**
   * Capture a screenshot of the current tab.
   */
  async captureScreenshot(format: "png" | "jpeg" = "png", quality?: number): Promise<string> {
    const params: Record<string, any> = { format };
    if (format === "jpeg" && quality !== undefined) {
      params.quality = quality;
    }
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", params);
    return data;
  }

  /**
   * Select an option in a <select> element by value or visible text.
   */
  async selectOption(backendDOMNodeId: number, value: string): Promise<string> {
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );

    const { result } = await this.send<{ result: { value: string } }>(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function(val) {
          if (this.tagName !== 'SELECT') return 'Error: not a <select> element (got <' + this.tagName.toLowerCase() + '>)';
          // Try matching by value first
          for (var i = 0; i < this.options.length; i++) {
            if (this.options[i].value === val) {
              this.value = val;
              this.dispatchEvent(new Event('change', { bubbles: true }));
              this.dispatchEvent(new Event('input', { bubbles: true }));
              return 'Selected: ' + this.options[i].text + ' (value=' + val + ')';
            }
          }
          // Fallback: match by visible text (case-insensitive)
          var lower = val.toLowerCase();
          for (var i = 0; i < this.options.length; i++) {
            if (this.options[i].text.toLowerCase() === lower) {
              this.value = this.options[i].value;
              this.dispatchEvent(new Event('change', { bubbles: true }));
              this.dispatchEvent(new Event('input', { bubbles: true }));
              return 'Selected: ' + this.options[i].text + ' (value=' + this.options[i].value + ')';
            }
          }
          // List available options
          var opts = [];
          for (var i = 0; i < this.options.length; i++) {
            opts.push(this.options[i].text + ' [value=' + this.options[i].value + ']');
          }
          return 'Error: no option matching "' + val + '". Available: ' + opts.join(', ');
        }`,
        arguments: [{ value }],
        returnByValue: true,
      }
    );

    return result.value;
  }

  /**
   * Get the frame tree to discover iframes.
   */
  async getFrameTree(): Promise<FrameTreeNode> {
    const result = await this.send<{ frameTree: FrameTreeNode }>("Page.getFrameTree");
    return result.frameTree;
  }

  /**
   * Fetch the full AX tree for a specific frame.
   */
  async getFrameAXTree(frameId: string): Promise<AXNode[]> {
    try {
      const result = await this.send<{ nodes: AXNode[] }>(
        "Accessibility.getFullAXTree",
        { frameId }
      );
      return result.nodes;
    } catch {
      return [];
    }
  }

  /**
   * Scroll the page (or an inner container) by viewport-height increments.
   *
   * If `fromBackendDOMNodeId` is provided, walks up the DOM tree from that node
   * looking for the nearest scrollable ancestor (overflow-y: auto/scroll AND
   * scrollHeight > clientHeight) and scrolls IT. This handles virtualized
   * lists (LinkedIn, Twitter, react-window, …) where the document itself isn't
   * the scroll container — without the walk-up, `scroll down` would scroll
   * `window` to no effect and never reveal off-screen rows. (#35)
   *
   * Falls back to `window` if no scrollable ancestor exists or
   * `fromBackendDOMNodeId` is not provided.
   */
  async scrollPage(
    direction: "up" | "down",
    viewports: number = 1,
    fromBackendDOMNodeId?: number
  ): Promise<{ scrollY: number; scrollHeight: number; viewportHeight: number; container: "window" | "inner" }> {
    const sign = direction === "down" ? 1 : -1;

    // The page-scope function we'll invoke. Same logic whether we have a
    // cursor node (then `this` is the cursor) or not (then `this` is the
    // window, which the walk-up immediately bails out of into the window
    // branch).
    const fnSrc = `function(viewports, sign) {
      function findScrollable(start) {
        var el = start;
        while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
          var style = window.getComputedStyle(el);
          var oy = style.overflowY;
          if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
          el = el.parentElement;
        }
        return null;
      }
      var container = (this && this.nodeType === 1) ? findScrollable(this) : null;
      if (container) {
        var vh = container.clientHeight;
        container.scrollBy({ top: sign * vh * viewports, behavior: 'instant' });
        return { scrollY: Math.round(container.scrollTop), scrollHeight: container.scrollHeight, viewportHeight: vh, container: 'inner' };
      }
      var wvh = window.innerHeight;
      window.scrollBy({ top: sign * wvh * viewports, behavior: 'instant' });
      return { scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight, viewportHeight: wvh, container: 'window' };
    }`;

    if (fromBackendDOMNodeId !== undefined) {
      const { object } = await this.send<{ object: { objectId: string } }>(
        "DOM.resolveNode",
        { backendNodeId: fromBackendDOMNodeId }
      );
      const { result } = await this.send<{ result: { value: any } }>(
        "Runtime.callFunctionOn",
        {
          objectId: object.objectId,
          functionDeclaration: fnSrc,
          arguments: [{ value: viewports }, { value: sign }],
          returnByValue: true,
        }
      );
      return result.value;
    }

    // No cursor — scroll window directly.
    const { result } = await this.send<{ result: { value: any } }>(
      "Runtime.evaluate",
      {
        expression: `(${fnSrc}).call(window, ${viewports}, ${sign})`,
        returnByValue: true,
      }
    );
    return result.value;
  }

  /**
   * Scroll a specific element into view by its backend DOM node ID.
   */
  async scrollIntoView(backendDOMNodeId: number): Promise<void> {
    const { object } = await this.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: backendDOMNodeId }
    );
    await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'nearest' }); }`,
      returnByValue: true,
    });
  }

  /**
   * Evaluate arbitrary JavaScript in the tab context.
   * Supports async/await (Promises are automatically awaited).
   *
   * Times out after `timeoutMs` (default 30s) to prevent a non-resolving
   * Promise from hanging the entire MCP call — Runtime.evaluate with
   * awaitPromise: true has no built-in cancellation, so the whole CDP
   * connection stalls until the parent client kills the request. (#38)
   */
  async evaluateJs(code: string, timeoutMs: number = 30000): Promise<{ value: any; type: string }> {
    type EvalResp = {
      result: { value: any; type: string; description?: string };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };

    const evalPromise = this.send<EvalResp>(
      "Runtime.evaluate",
      {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
      }
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Best-effort: ask the runtime to abandon whatever it's running so the
        // page isn't left in a stuck evaluator state. Swallow the result —
        // some CDP targets don't expose terminateExecution at all.
        this.send("Runtime.terminateExecution", {}).catch(() => {});
        reject(new Error(`js evaluation timed out after ${timeoutMs}ms — the expression returned a Promise that never resolved (or hit a page-level deadlock). Try wrapping it in Promise.race with your own timeout, or use 'eval' for a sync expression.`));
      }, timeoutMs);
    });

    let resp: EvalResp;
    try {
      resp = await Promise.race([evalPromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (resp.exceptionDetails) {
      const msg = resp.exceptionDetails.exception?.description || resp.exceptionDetails.text || "Unknown error";
      throw new Error(msg);
    }
    return { value: resp.result.value, type: resp.result.type };
  }

  /**
   * Fetch AX trees for all frames (main + iframes) and merge them.
   * Iframe roots are injected as children of the node that owns them.
   */
  async getAllFrameAXTrees(): Promise<AXNode[]> {
    // Get main frame tree first
    const mainNodes = await this.getFullAXTree();

    try {
      await this.send("Page.enable");
      const frameTree = await this.getFrameTree();
      const childFrames = collectChildFrames(frameTree);

      if (childFrames.length === 0) return mainNodes;

      // Fetch each iframe's AX tree and merge
      for (const frame of childFrames) {
        const frameNodes = await this.getFrameAXTree(frame.id);
        if (frameNodes.length > 0) {
          // Prefix iframe node IDs to avoid collisions with main frame
          const prefix = `frame_${frame.id}_`;
          for (const node of frameNodes) {
            node.nodeId = prefix + node.nodeId;
            if (node.childIds) {
              node.childIds = node.childIds.map((id) => prefix + id);
            }
          }
          mainNodes.push(...frameNodes);
        }
      }

      return mainNodes;
    } catch {
      // Page.enable or getFrameTree may fail on some pages
      return mainNodes;
    }
  }
}

interface FrameTreeNode {
  frame: { id: string; url: string; name?: string };
  childFrames?: FrameTreeNode[];
}

function collectChildFrames(tree: FrameTreeNode): Array<{ id: string; url: string; name?: string }> {
  const frames: Array<{ id: string; url: string; name?: string }> = [];
  if (tree.childFrames) {
    for (const child of tree.childFrames) {
      frames.push(child.frame);
      frames.push(...collectChildFrames(child));
    }
  }
  return frames;
}

/**
 * Build the Input.dispatchKeyEvent parameter object for a named DOM key.
 *
 * CDP needs both `key` (DOM key value) and `code` (DOM physical-key code) on
 * keyDown/Up for React's synthetic event system to fire correctly. Many
 * non-character keys also need `windowsVirtualKeyCode` for legacy handler
 * paths. Character keys additionally need `text` so the page's `keypress`
 * (and `input`) events carry the right character.
 */
function keyEventParams(key: string, modifiers: number = 0): Record<string, any> {
  const k = NAMED_KEYS[key];
  if (k) return { ...k, modifiers };

  // Single character — treat as a printable key. Use the upper-case form for
  // `code` (e.g. "KeyA"), the actual char for `key` and `text`.
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : undefined;
    return {
      key,
      code,
      text: key,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      modifiers,
    };
  }

  // Unknown — pass through and let CDP decide. Logs will show if the page
  // didn't respond.
  return { key, modifiers };
}

/** DOM key name → CDP params for non-character keys we want to ship working
 *  out of the box. Extend as new SPAs surface needs.
 *
 *  `text` is set for keys that conventionally produce text input (Enter='\r',
 *  Tab='\t', Space=' '). Its presence routes the down event through CDP's
 *  text-producing `keyDown` path; without it `dispatchKey` falls back to
 *  `rawKeyDown` which is what Chrome wants for special keys like Escape,
 *  arrows, and F-keys. (Matches Puppeteer/Playwright key dispatch.) */
const NAMED_KEYS: Record<string, { key: string; code?: string; windowsVirtualKeyCode?: number; text?: string }> = {
  Enter:       { key: "Enter",       code: "Enter",       windowsVirtualKeyCode: 13, text: "\r" },
  Tab:         { key: "Tab",         code: "Tab",         windowsVirtualKeyCode: 9,  text: "\t" },
  Space:       { key: " ",           code: "Space",       windowsVirtualKeyCode: 32, text: " "  },
  Escape:      { key: "Escape",      code: "Escape",      windowsVirtualKeyCode: 27 },
  Backspace:   { key: "Backspace",   code: "Backspace",   windowsVirtualKeyCode: 8  },
  Delete:      { key: "Delete",      code: "Delete",      windowsVirtualKeyCode: 46 },
  ArrowUp:     { key: "ArrowUp",     code: "ArrowUp",     windowsVirtualKeyCode: 38 },
  ArrowDown:   { key: "ArrowDown",   code: "ArrowDown",   windowsVirtualKeyCode: 40 },
  ArrowLeft:   { key: "ArrowLeft",   code: "ArrowLeft",   windowsVirtualKeyCode: 37 },
  ArrowRight:  { key: "ArrowRight",  code: "ArrowRight",  windowsVirtualKeyCode: 39 },
  Home:        { key: "Home",        code: "Home",        windowsVirtualKeyCode: 36 },
  End:         { key: "End",         code: "End",         windowsVirtualKeyCode: 35 },
  PageUp:      { key: "PageUp",      code: "PageUp",      windowsVirtualKeyCode: 33 },
  PageDown:    { key: "PageDown",    code: "PageDown",    windowsVirtualKeyCode: 34 },
  F1:  { key: "F1",  code: "F1",  windowsVirtualKeyCode: 112 },
  F2:  { key: "F2",  code: "F2",  windowsVirtualKeyCode: 113 },
  F3:  { key: "F3",  code: "F3",  windowsVirtualKeyCode: 114 },
  F4:  { key: "F4",  code: "F4",  windowsVirtualKeyCode: 115 },
  F5:  { key: "F5",  code: "F5",  windowsVirtualKeyCode: 116 },
  F6:  { key: "F6",  code: "F6",  windowsVirtualKeyCode: 117 },
  F7:  { key: "F7",  code: "F7",  windowsVirtualKeyCode: 118 },
  F8:  { key: "F8",  code: "F8",  windowsVirtualKeyCode: 119 },
  F9:  { key: "F9",  code: "F9",  windowsVirtualKeyCode: 120 },
  F10: { key: "F10", code: "F10", windowsVirtualKeyCode: 121 },
  F11: { key: "F11", code: "F11", windowsVirtualKeyCode: 122 },
  F12: { key: "F12", code: "F12", windowsVirtualKeyCode: 123 },
};
