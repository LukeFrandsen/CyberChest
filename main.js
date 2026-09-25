const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");

const { parseCommand } = require("./nmap-command");
const runFile = promisify(execFile);
const page = pathToFileURL(
  path.join(__dirname, "src/index.html")
).href;

let window;
let session;
let timer;
let polling = false;
let currentDirectory = os.homedir();
let nmapScan;

function projectsRoot() {
  return path.join(app.getPath("documents"), "CyberChest", "projects");
}

function safeSegment(value, label = "Name") {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") ||
      value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error(label + " is invalid.");
  }
  return value.trim();
}

function projectPath(projectId) {
  return path.join(projectsRoot(), safeSegment(projectId, "Project"));
}

function noteFilename(value) {
  const name = safeSegment(value, "Note name");
  return name.toLowerCase().endsWith(".md") ? name : name + ".md";
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function ensureProjectFolders(folder) {
  await Promise.all([
    fs.mkdir(path.join(folder, "notes"), { recursive: true }),
    fs.mkdir(path.join(folder, "scans"), { recursive: true }),
    fs.mkdir(path.join(folder, "files"), { recursive: true })
  ]);
}

async function loadProject(projectId) {
  const folder = projectPath(projectId);
  const metadata = await readJson(path.join(folder, "project.json"), null);
  if (!metadata) throw new Error("Project not found.");
  return { folder, metadata };
}

const nmapPresets = Object.freeze({
  basic: [],
  quick: ["-T4", "-F"],
  service: ["-sV"],
  ports: ["-p-"],
  "operating-system": ["-O"]
});

function nmapArguments(request) {
  if (!request || typeof request !== "object") {
    throw new Error("Invalid scan request.");
  }

  const target = typeof request.target === "string"
    ? request.target.trim()
    : "";

  if (
    !target ||
    target.length > 253 ||
    target.startsWith("-") ||
    !/^[A-Za-z0-9._:/%-]+$/.test(target)
  ) {
    throw new Error(
      "Enter one hostname, IP address, or CIDR range without spaces."
    );
  }

  const preset = nmapPresets[request.preset];

  if (!preset) {
    throw new Error("Unknown scan preset.");
  }

  const options = request.options || {};
  const args = [...preset];

  if (options.skipDiscovery === true) args.push("-Pn");
  if (options.traceroute === true) args.push("--traceroute");
  if (options.verbose === true) args.push("-v");

  // The target cannot begin with a dash, so it cannot become an option.
  args.push(target);
  return args;
}

function displayCommand(args) {
  return ["nmap", ...args]
    .map((part) => /^[A-Za-z0-9._:/%-]+$/.test(part)
      ? part
      : JSON.stringify(part))
    .join(" ");
}

// Only accept requests from our own app window.
function trusted(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== page
  ) {
    throw new Error("Untrusted request");
  }
}

function send(channel, data) {
  if (
    window &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed()
  ) {
    window.webContents.send(channel, data);
  }
}

function stopShell() {
  clearInterval(timer);

  const old = session;
  session = null;

  if (old) {
    try {
      old.kill();
    } catch {}
  }
}

function stopNmap() {
  const scan = nmapScan;
  nmapScan = null;

  if (scan && !scan.child.killed) {
    scan.cancelled = true;
    scan.child.kill("SIGTERM");
  }
}

// Read the local shell's current working directory.
async function updateDirectory() {
  if (!session || polling) return;

  polling = true;
  const active = session;

  try {
    let directory;

    if (process.platform === "darwin") {
      const { stdout } = await runFile(
        "/usr/sbin/lsof",
        ["-a", "-p", String(active.pid), "-d", "cwd", "-F0n"],
        {
          timeout: 1500,
          maxBuffer: 65536
        }
      );

      const field = stdout
        .split("\0")
        .map((value) => value.replace(/^\n/, ""))
        .find((value) => value.startsWith("n"));

      directory = field && field.slice(1);
    } else {
      directory = await fs.readlink(
        "/proc/" + active.pid + "/cwd"
      );
    }

    if (!directory || !path.isAbsolute(directory)) {
      throw new Error("Current directory unavailable");
    }

    if (session === active) {
      const changed = directory !== currentDirectory;
      currentDirectory = directory;

      send("shell:cwd", { directory, changed });
    }
  } catch {
    if (session === active) {
      send(
        "shell:cwd-error",
        "Could not track the shell folder. File browsing still works."
      );
    }
  } finally {
    polling = false;
  }
}

// Start one persistent shell for the app window.
ipcMain.handle("shell:start", async (event) => {
  trusted(event);

  if (session) {
    return {
      ok: true,
      directory: currentDirectory
    };
  }

  if (!["darwin", "linux"].includes(process.platform)) {
    return {
      ok: false,
      error: "This version targets macOS and Linux."
    };
  }

  try {
    // Load here so installation errors appear in the interface.
    const pty = require("node-pty");

    const shell =
      process.env.SHELL ||
      (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");

    currentDirectory = os.homedir();

    const active = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: currentDirectory,
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
    });

    session = active;

    active.onData((data) => {
      if (session === active) {
        send("shell:data", data);
      }
    });

    active.onExit(({ exitCode }) => {
      if (session !== active) return;

      session = null;
      clearInterval(timer);
      send("shell:exit", exitCode);
    });

    timer = setInterval(updateDirectory, 1000);

    return {
      ok: true,
      directory: currentDirectory
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error.message +
        "\nTry npm run rebuild in your project terminal."
    };
  }
});

// Forward typing, Enter, Tab, arrow keys, and Ctrl+C.
ipcMain.on("shell:input", (event, input) => {
  try {
    trusted(event);

    if (
      session &&
      typeof input === "string" &&
      input.length <= 65536
    ) {
      session.write(input);
    }
  } catch {
    // Ignore invalid or already-closed sessions.
  }
});

ipcMain.on("shell:resize", (event, size) => {
  try {
    trusted(event);

    if (
      session &&
      size &&
      Number.isInteger(size.cols) &&
      Number.isInteger(size.rows) &&
      size.cols >= 2 &&
      size.cols <= 1000 &&
      size.rows >= 1 &&
      size.rows <= 500
    ) {
      session.resize(size.cols, size.rows);
    }
  } catch {}
});

// List a real directory anywhere the user's account can access.
ipcMain.handle("files:list", async (event, directory) => {
  trusted(event);

  try {
    if (
      typeof directory !== "string" ||
      directory.includes("\0") ||
      !path.isAbsolute(directory)
    ) {
      throw new Error("An absolute folder path is required.");
    }

    const entries = await fs.readdir(directory, {
      withFileTypes: true
    });

    const result = [];

    // Process links in small batches.
    for (let i = 0; i < entries.length; i += 32) {
      const batch = await Promise.all(
        entries.slice(i, i + 32).map(async (entry) => {
          const fullPath = path.join(directory, entry.name);
          let isDirectory = entry.isDirectory();

          if (entry.isSymbolicLink()) {
            try {
              isDirectory = (
                await fs.stat(fullPath)
              ).isDirectory();
            } catch {}
          }

          return {
            name: entry.name,
            path: fullPath,
            isDirectory,
            isLink: entry.isSymbolicLink()
          };
        })
      );

      result.push(...batch);
    }

    // Folders first, then alphabetical order.
    result.sort(
      (a, b) =>
        Number(b.isDirectory) - Number(a.isDirectory) ||
        a.name.localeCompare(b.name, undefined, {
          numeric: true
        })
    );

    return {
      ok: true,
      entries: result
    };
  } catch (error) {
    return {
      ok: false,
      error: ["EACCES", "EPERM"].includes(error.code)
        ? "Permission denied for this folder."
        : error.message
    };
  }
});

ipcMain.handle("nmap:preview", (event, request) => {
  trusted(event);

  try {
    const args = nmapArguments(request);
    return { ok: true, command: displayCommand(args) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("nmap:start", async (event, request) => {
  trusted(event);

  if (nmapScan) {
    return { ok: false, error: "A scan is already running." };
  }

  try {
    const parsed = request?.command !== undefined ? parseCommand(request.command) : { args: nmapArguments(request), sudo: false };
    if (parsed.sudo) return { ok: true, terminal: true, command: parsed.terminalCommand };
    const args = parsed.args;
    const child = spawn("nmap", args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const scan = { child, cancelled: false };
    nmapScan = scan;
    let launched = false;
    let resolveLaunch;
    const launchResult = new Promise((resolve) => {
      resolveLaunch = resolve;
    });

    child.stdout.on("data", (data) => {
      if (nmapScan === scan) send("nmap:output", {
        stream: "stdout",
        text: data.toString()
      });
    });

    child.stderr.on("data", (data) => {
      if (nmapScan === scan) send("nmap:output", {
        stream: "stderr",
        text: data.toString()
      });
    });

    child.on("error", (error) => {
      if (nmapScan !== scan) return;

      if (!launched) {
        nmapScan = null;
        resolveLaunch(error);
        return;
      }

      nmapScan = null;
      send("nmap:complete", {
        ok: false,
        error: error.code === "ENOENT"
          ? "Nmap is not installed or is not available in PATH."
          : error.message
      });
    });

    child.once("spawn", () => {
      launched = true;
      resolveLaunch(null);
    });

    child.on("close", (code, signal) => {
      if (nmapScan !== scan) return;
      nmapScan = null;
      send("nmap:complete", {
        ok: code === 0,
        code,
        signal,
        cancelled: scan.cancelled
      });
    });

    const launchError = await launchResult;

    if (launchError) {
      return {
        ok: false,
        error: launchError.code === "ENOENT"
          ? "Nmap is not installed or is not available in PATH."
          : launchError.message
      };
    }

    return {
      ok: true,
      command: displayCommand(args)
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("nmap:cancel", (event) => {
  trusted(event);

  if (!nmapScan) return { ok: false, error: "No scan is running." };

  nmapScan.cancelled = true;
  nmapScan.child.kill("SIGTERM");
  return { ok: true };
});

ipcMain.handle("projects:list", async (event) => {
  trusted(event);
  try {
    const root = projectsRoot();
    await fs.mkdir(root, { recursive: true });
    const entries = await fs.readdir(root, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadata = await readJson(path.join(root, entry.name, "project.json"), null);
      if (metadata) projects.push(metadata);
    }
    projects.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return { ok: true, root, projects };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("projects:create", async (event, input) => {
  trusted(event);
  try {
    const name = safeSegment(input?.name, "Project name");
    const now = new Date().toISOString();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    const id = (slug || "project") + "-" + randomUUID().slice(0, 8);
    const folder = projectPath(id);
    await ensureProjectFolders(folder);
    const metadata = {
      id,
      name,
      description: String(input?.description || "").trim().slice(0, 1000),
      target: String(input?.target || "").trim().slice(0, 253),
      status: String(input?.status || "Active").trim().slice(0, 40),
      createdAt: now,
      updatedAt: now
    };
    await writeJson(path.join(folder, "project.json"), metadata);
    await writeJson(path.join(folder, "commands.json"), []);
    return { ok: true, project: metadata };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("projects:update", async (event, input) => {
  trusted(event);
  try {
    const { folder, metadata } = await loadProject(input?.id);
    const updated = {
      ...metadata,
      name: safeSegment(input?.name, "Project name"),
      description: String(input?.description || "").trim().slice(0, 1000),
      target: String(input?.target || "").trim().slice(0, 253),
      status: String(input?.status || "Active").trim().slice(0, 40),
      updatedAt: new Date().toISOString()
    };
    await writeJson(path.join(folder, "project.json"), updated);
    return { ok: true, project: updated };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("projects:details", async (event, projectId) => {
  trusted(event);
  try {
    const { folder, metadata } = await loadProject(projectId);
    await ensureProjectFolders(folder);
    const noteEntries = await fs.readdir(path.join(folder, "notes"), { withFileTypes: true });
    const scanEntries = await fs.readdir(path.join(folder, "scans"), { withFileTypes: true });
    const commands = await readJson(path.join(folder, "commands.json"), []);
    return {
      ok: true,
      project: metadata,
      folder,
      notes: noteEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort(),
      scans: scanEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort().reverse(),
      commands
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("projects:open-folder", async (event, projectId) => {
  trusted(event);
  try {
    const { folder } = await loadProject(projectId);
    const error = await shell.openPath(folder);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("notes:read", async (event, input) => {
  trusted(event);
  try {
    const { folder } = await loadProject(input?.projectId);
    const name = noteFilename(input?.name);
    const content = await fs.readFile(path.join(folder, "notes", name), "utf8");
    return { ok: true, name, content };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("notes:save", async (event, input) => {
  trusted(event);
  try {
    const { folder, metadata } = await loadProject(input?.projectId);
    const name = noteFilename(input?.name);
    const content = String(input?.content || "");
    if (content.length > 5_000_000) throw new Error("Note is too large.");
    await fs.writeFile(path.join(folder, "notes", name), content, "utf8");
    metadata.updatedAt = new Date().toISOString();
    await writeJson(path.join(folder, "project.json"), metadata);
    return { ok: true, name };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("projects:save-command", async (event, input) => {
  trusted(event);
  try {
    const { folder } = await loadProject(input?.projectId);
    const command = String(input?.command || "").trim();
    if (!command || command.length > 4000) throw new Error("Command is invalid.");
    const file = path.join(folder, "commands.json");
    const commands = await readJson(file, []);
    commands.unshift({ id: randomUUID(), command, description: String(input?.description || "").trim().slice(0, 500), createdAt: new Date().toISOString() });
    await writeJson(file, commands.slice(0, 500));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("projects:save-scan", async (event, input) => {
  trusted(event);
  try {
    const { folder } = await loadProject(input?.projectId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = String(input?.target || "scan").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 50) || "scan";
    const name = timestamp + "-" + target + ".txt";
    const body = ["CyberChest Nmap Scan", "Saved: " + new Date().toISOString(), "Command: " + String(input?.command || ""), "", String(input?.output || "")].join("\n");
    if (body.length > 20_000_000) throw new Error("Scan output is too large.");
    await fs.writeFile(path.join(folder, "scans", name), body, "utf8");
    return { ok: true, name };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 850,
    minHeight: 550,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({
    action: "deny"
  }));

  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => {
      callback(false);
    }
  );

  window.webContents.on("did-start-loading", stopShell);
  window.webContents.on("did-start-loading", stopNmap);
  window.webContents.on("render-process-gone", stopShell);
  window.webContents.on("render-process-gone", stopNmap);

  window.on("closed", () => {
    stopShell();
    stopNmap();
    window = null;
  });

  window.loadURL(page);
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (!window) createWindow();
  });
});

app.on("before-quit", () => {
  stopShell();
  stopNmap();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
