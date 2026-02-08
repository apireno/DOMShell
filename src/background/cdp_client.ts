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
