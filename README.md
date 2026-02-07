This is the **Master Technical Specification** for "AgentShell," the Chrome Extension that turns the DOM into a filesystem.

You can hand this document directly to a Coding Agent (like Cursor, Windsurf, or Devin) to scaffold and build the project.

### **Project: AgentShell (Chrome Extension)**

**Goal:** Create a "Headless OS" for agents to browse the web using standard Linux commands (`ls`, `cd`, `cat`, `grep`) via a terminal interface in the Chrome Side Panel.
**Core Tech Stack:** React, TypeScript, Vite, Xterm.js, Chrome DevTools Protocol (CDP).

---

### **1. High-Level Architecture**

The extension follows a **Thin Client / Fat Host** model.

* **The Client (Side Panel):** Dumb terminal. It captures keystrokes and renders text. It knows nothing about the DOM.
* **The Host (Background Service Worker):** The "Operating System." It maintains the Shell State (CWD, Environment Variables), manages the CDP connection, and executes logic.

---

### **2. Project Structure & Manifest**

**File Tree:**

```text
/src
  /background
    index.ts        # The "OS Kernel" (Command Parser, State Manager)
    cdp_client.ts   # Wrapper for chrome.debugger API
    vfs_mapper.ts   # Logic to map Accessibility Tree -> File System
  /sidepanel
    index.tsx       # Entry point
    Terminal.tsx    # Xterm.js React Component
  /shared
    types.ts        # Message passing types
  manifest.json

```

**`manifest.json` (Manifest V3)**

```json
{
  "manifest_version": 3,
  "name": "AgentShell",
  "version": "1.0.0",
  "permissions": [
    "sidePanel",
    "debugger",      // Vital: To read the AXTree and "click" blindly
    "activeTab",     // Vital: To attach debugger to current site
    "cookies",       // Vital: For 'whoami' session piggybacking
    "identity",      // Vital: For 'login' OAuth flows
    "storage"        // To save command history/env vars
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "src/background/index.ts",
    "type": "module"
  },
  "side_panel": {
    "default_path": "src/sidepanel/index.html"
  }
}

```

---

### **3. Core Module Specifications**

#### **Module A: The Shell Kernel (`background/index.ts`)**

This is the brain. It listens for messages from the Side Panel.

* **State:**
```typescript
interface ShellState {
  cwd: string[]; // e.g., ["root", "nav", "profile"]
  attachedTabId: number | null;
  env: Record<string, string>; // Variables like $USER, $API_KEY
}

```


* **Message Handler:**
* Receives: `{ type: "STDIN", input: "cd header" }`
* Action: Parses command  Calls `FileSystem`  Returns Output.
* Responds: `{ type: "STDOUT", output: "Changed directory to /header" }`



#### **Module B: The Virtual Filesystem (`background/vfs_mapper.ts`)**

This module translates the messy Accessibility Tree (AXTree) into clean filenames.

* **Core Function: `getDirectoryListing(nodeId)**`
1. Call CDP: `chrome.debugger.sendCommand({tabId}, "Accessibility.getChildIds", {id: nodeId})`.
2. Retrieve Node Info: `Accessibility.getPartialAXTree`.
3. **Heuristic Naming Algorithm (Critical):**
* If `role` is "button" and `name` is "Submit"  `submit_btn`
* If `role` is "link" and `name` is "Contact Us"  `contact_link`
* If `role` is "generic" but has ID "main-content"  `main_content/`
* *Fallback:* `element_452`





#### **Module C: The CDP Client (`background/cdp_client.ts`)**

Wraps the raw `chrome.debugger` API into Promises.

* **Method: `attach(tabId)**`
* Checks if already attached. If not, `chrome.debugger.attach({tabId}, "1.3")`.


* **Method: `blindClick(nodeId)**`
* We cannot click an AXNode directly. We must resolve it to a DOM Node.
* Step 1: `DOM.describeNode({ backendNodeId: node.backendDOMNodeId })`
* Step 2: `Runtime.evaluate("document.querySelector(...)")` OR use `Input.dispatchMouseEvent` on the coordinates found in the AXTree.



---

### **4. Command Logic Implementation**

Here is the pseudo-code logic for the coding agent to implement for the key commands.

#### **Command: `ls` (List)**

```typescript
async function handleLs(state) {
  // 1. Get current node ID from state.cwd
  const currentNode = await CDP.getNode(state.cwd.last());
  
  // 2. Get children
  const children = await CDP.getChildren(currentNode);

  // 3. Format output
  return children.map(child => {
    const isDir = ["group", "navigation", "form", "section"].includes(child.role);
    const suffix = isDir ? "/" : "";
    const color = isDir ? "blue" : "white"; 
    // Return ANSI colored string
    return `\x1b[34m${child.generatedName}${suffix}\x1b[0m`;
  }).join("\n");
}

```

#### **Command: `cd` (Change Directory)**

```typescript
async function handleCd(args, state) {
  const targetName = args[0];
  // 1. Get children of current CWD
  const children = await CDP.getChildren(state.cwd.last());
  
  // 2. Find match
  const match = children.find(c => c.generatedName === targetName);
  
  if (!match) return "Error: No such directory";
  if (!match.isContainer) return "Error: Not a directory";

  // 3. Update State
  state.cwd.push(match.id);
  return "";
}

```

#### **Command: `click` (Execute)**

```typescript
async function handleClick(args, state) {
  const targetName = args[0];
  // 1. Resolve target to BackendNodeId
  const target = await resolveTarget(targetName, state);

  // 2. Perform Action (Prefer JS Click for reliability over raw input simulation)
  await CDP.send("Runtime.evaluate", {
    expression: `document.querySelector('[data-backend-node-id="${target.id}"]').click()`
    // Note: In reality, you map backendNodeId to a remote object ID first
  });
  
  return "Action: Clicked " + targetName;
}

```

#### **Command: `whoami` (Auth Check)**

```typescript
async function handleWhoami() {
  const url = await getCurrentTabUrl();
  const cookies = await chrome.cookies.getAll({ url });
  
  // Basic heuristic for common session cookies
  const sessionCookie = cookies.find(c => 
    c.name.match(/session|sid|auth|token/i)
  );
  
  if (sessionCookie) {
    return `User: Authenticated (via ${sessionCookie.name})\nExpires: ${sessionCookie.expirationDate}`;
  } else {
    return "User: Guest (No obvious session cookie found)";
  }
}

```

---

### **5. Instructions for the Coding Agent**

Copy and paste the following prompt to your coding agent to start the build:

> "I need you to build a Chrome Extension called 'AgentShell'. It is a Side Panel extension using React and Vite.
> **The Goal:** Provide a terminal interface (using xterm.js) that allows a user to navigate the current webpage's DOM as if it were a filesystem.
> **Tech Specs:**
> 1. **Manifest V3:** Use `sidePanel`, `debugger`, and `activeTab` permissions.
> 2. **Architecture:** React frontend in the Side Panel sends text commands to a Background Service Worker.
> 3. **The 'FileSystem':** The Background script must use `chrome.debugger` to fetch the 'Accessibility Tree' of the active tab. Map the Accessibility Nodes to a virtual folder structure.
> * Container nodes (Role=group, navigation) are 'Folders'.
> * Interactive nodes (Role=button, link) are 'Files'.
> 
> 
> 4. **Commands to Implement:**
> * `ls`: List children of the current node.
> * `cd [name]`: Enter a child node.
> * `click [name]`: Trigger a click on the element.
> * `pwd`: Show current path in the AXTree.
> 
> 
> 
> 
> **First Step:** Initialize the Vite project with the Manifest V3 setup and get the Xterm.js side panel rendering and communicating 'Hello World' to the background script." 
