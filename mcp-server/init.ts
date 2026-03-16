import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { randomBytes } from "node:crypto";
import { createInterface, Interface as RLInterface } from "node:readline";

// --- Types ---

interface ClientConfig {
  name: string;
  configPath: string;
  exists: boolean;
  mode: "proxy" | "url"; // proxy = command/args (Claude Desktop), url = direct HTTP
}

interface InitOptions {
  yes: boolean;
  allowWrite: boolean;
  allowSensitive: boolean;
  noConfirm: boolean;
  token: string | null;
  client: string | null;
}

// --- Helpers ---

function ask(rl: RLInterface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function log(msg: string): void {
  console.log(msg);
}

// --- Config Path Resolution ---

function getConfigPaths(): ClientConfig[] {
  const home = homedir();
  const p = platform();
  const clients: ClientConfig[] = [];

  // Claude Desktop config path varies by OS
  let claudeDesktopPath: string;
  if (p === "darwin") {
    claudeDesktopPath = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else if (p === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    claudeDesktopPath = join(appData, "Claude", "claude_desktop_config.json");
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
    claudeDesktopPath = join(xdgConfig, "Claude", "claude_desktop_config.json");
  }

  clients.push(
    { name: "Claude Desktop", configPath: claudeDesktopPath, exists: false, mode: "proxy" },
    { name: "Cursor", configPath: join(home, ".cursor", "mcp.json"), exists: false, mode: "url" },
    { name: "Windsurf", configPath: join(home, ".windsurf", "mcp.json"), exists: false, mode: "url" },
  );

  for (const c of clients) {
    c.exists = existsSync(c.configPath);
  }

  return clients;
}

// --- Interactive Prompts ---

async function promptClientSelection(clients: ClientConfig[]): Promise<ClientConfig[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  log("\nWhich MCP client(s) would you like to configure?\n");
  clients.forEach((c, i) => {
    const status = c.exists ? "(config exists)" : "(will create)";
    log(`  ${i + 1}. ${c.name} ${status}`);
  });
  log(`  a. All`);

  const answer = await ask(rl, "\nSelect (comma-separated numbers, or 'a' for all): ");
  rl.close();

  if (answer.trim().toLowerCase() === "a") return clients;

  const indices = answer
    .split(",")
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((i) => i >= 0 && i < clients.length);

  return indices.length > 0 ? indices.map((i) => clients[i]) : [clients[0]];
}

async function promptPermissions(): Promise<{ allowWrite: boolean; noConfirm: boolean }> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const writeAnswer = await ask(rl, "Enable write tools (click, type, navigate)? [Y/n]: ");
  const allowWrite = writeAnswer.trim().toLowerCase() !== "n";

  let noConfirm = false;
  if (allowWrite) {
    const confirmAnswer = await ask(rl, "Skip confirmation prompts for write actions? [y/N]: ");
    noConfirm = confirmAnswer.trim().toLowerCase() === "y";
  }

  rl.close();
  return { allowWrite, noConfirm };
}

async function promptOverwrite(clientName: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await ask(rl, `  "${clientName}" already has a domshell entry. Overwrite? [Y/n]: `);
  rl.close();
  return answer.trim().toLowerCase() !== "n";
}

// --- Config Read/Write ---

function writeConfig(
  client: ClientConfig,
  entry: Record<string, unknown>,
  skipConfirm: boolean,
  overwriteDecisions: Map<string, boolean>,
): void {
  let config: Record<string, unknown> = {};

  if (client.exists) {
    try {
      const raw = readFileSync(client.configPath, "utf-8");
      config = JSON.parse(raw);
    } catch {
      console.warn(`  Warning: Could not parse ${client.configPath}, creating fresh config`);
      config = {};
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  const hadExisting = "domshell" in servers;

  if (hadExisting && !skipConfirm) {
    const shouldOverwrite = overwriteDecisions.get(client.name);
    if (!shouldOverwrite) {
      log(`  Skipped ${client.name} (existing entry preserved)`);
      return;
    }
  }

  servers.domshell = entry;

  const dir = dirname(client.configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  try {
    writeFileSync(client.configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    log(`  ${hadExisting ? "Updated" : "Created"} ${client.configPath}`);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES") {
      console.error(`  Error: Permission denied writing ${client.configPath}`);
      console.error(`  Try fixing permissions or running with elevated privileges.`);
    } else {
      throw err;
    }
  }
}

// --- Summary ---

function printSummary(targets: ClientConfig[], token: string, options: InitOptions): void {
  const serverArgs = ["npx", "@apireno/domshell"];
  if (options.allowWrite) serverArgs.push("--allow-write");
  if (options.noConfirm) serverArgs.push("--no-confirm");
  serverArgs.push("--token", token);

  log("");
  log("=== DOMShell MCP Setup Complete ===");
  log("");
  log("Configured:");
  for (const t of targets) {
    log(`  - ${t.name}: ${t.configPath}`);
  }
  log("");
  log("Start the server (keep running in a terminal):");
  log(`  ${serverArgs.join(" ")}`);
  log("");
  log("Then connect the Chrome extension (in the DOMShell side panel):");
  log(`  connect ${token}`);
  log("");
  log(`Token: ${token}`);
  log("");
}

// --- Main ---

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const initIdx = args.indexOf("init");
  const initArgs = initIdx !== -1 ? args.slice(initIdx + 1) : [];

  const hasInitFlag = (name: string): boolean => initArgs.includes(name);
  const getInitFlagValue = (name: string): string | null => {
    const idx = initArgs.indexOf(name);
    return idx !== -1 && idx + 1 < initArgs.length ? initArgs[idx + 1] : null;
  };

  const nonInteractive = hasInitFlag("--yes") || hasInitFlag("-y") || !process.stdin.isTTY;

  const options: InitOptions = {
    yes: nonInteractive,
    allowWrite: nonInteractive,
    allowSensitive: false,
    noConfirm: nonInteractive,
    token: getInitFlagValue("--token"),
    client: getInitFlagValue("--client"),
  };

  log("");
  log("DOMShell MCP Setup Wizard");
  log("========================");

  // Generate or use provided token
  const token = options.token || randomBytes(24).toString("hex");

  // Get available clients
  const allClients = getConfigPaths();

  // Determine targets
  let targets: ClientConfig[];
  if (options.client) {
    const match = allClients.find((c) => c.name.toLowerCase().includes(options.client!.toLowerCase()));
    if (!match) {
      console.error(`Unknown client: ${options.client}`);
      console.error(`Available: ${allClients.map((c) => c.name).join(", ")}`);
      process.exit(1);
    }
    targets = [match];
  } else if (options.yes) {
    targets = allClients.filter((c) => c.exists);
    if (targets.length === 0) targets = [allClients[0]]; // default to Claude Desktop
  } else {
    targets = await promptClientSelection(allClients);
  }

  // Get permissions
  if (!options.yes) {
    const perms = await promptPermissions();
    options.allowWrite = perms.allowWrite;
    options.noConfirm = perms.noConfirm;
  }

  // Check for existing entries (interactive overwrite prompts)
  const overwriteDecisions = new Map<string, boolean>();
  if (!options.yes) {
    for (const target of targets) {
      if (target.exists) {
        try {
          const raw = readFileSync(target.configPath, "utf-8");
          const config = JSON.parse(raw);
          if (config.mcpServers && "domshell" in config.mcpServers) {
            const shouldOverwrite = await promptOverwrite(target.name);
            overwriteDecisions.set(target.name, shouldOverwrite);
          }
        } catch {
          // Can't parse — will be handled in writeConfig
        }
      }
    }
  }

  // Build and write configs per-client
  log("");
  for (const target of targets) {
    let entry: Record<string, unknown>;

    if (target.mode === "proxy") {
      // Claude Desktop: use stdio proxy that connects to the running server
      entry = {
        command: "npx",
        args: ["-y", "-p", "@apireno/domshell", "domshell-proxy", "--port", "3001", "--token", token],
      };
    } else {
      // Cursor, Windsurf, etc.: direct HTTP URL to running server
      entry = {
        url: `http://localhost:3001/mcp?token=${token}`,
      };
    }

    writeConfig(target, entry, options.yes, overwriteDecisions);
  }

  printSummary(targets, token, options);
}
