const api = window.cyberChest;

const terminalStatus = document.getElementById("terminal-status");
const fileStatus = document.getElementById("file-status");
const tree = document.getElementById("computer-tree");
const showHidden = document.getElementById("show-hidden");

const nodes = new Map();

let directory = "/";
let generation = 0;
let revealRequest = 0;
let term;
let fit;
let running = false;
let starting = false;

// Resize the terminal to fit its panel.
function resizeTerminal() {
  const workspace = document.getElementById("terminal-workspace");

  if (!term || !workspace.classList.contains("active")) return;

  fit.fit();

  if (running) {
    api.resizeShell({
      cols: term.cols,
      rows: term.rows
    });
  }
}

// Switch tools and their corresponding right-side panels.
document.querySelectorAll(".tool-tab[data-tool]").forEach((tab) => {
  tab.addEventListener("click", () => {
    const tool = tab.dataset.tool;

    document.querySelectorAll(".tool-tab[data-tool]").forEach((button) => {
      button.classList.toggle("active", button === tab);
    });

    document.querySelectorAll(".tool-workspace").forEach((panel) => {
      panel.classList.toggle(
        "active",
        panel.id === tool + "-workspace"
      );
    });

    document.getElementById("network-tree").classList.toggle(
      "active",
      tool === "nmap"
    );

    document.getElementById("file-tree").classList.toggle(
      "active",
      tool === "terminal"
    );

    if (tool === "terminal") {
      requestAnimationFrame(() => {
        resizeTerminal();
        term?.focus();
      });
    }
  });
});

// Highlight the shell's current folder.
function markDirectory() {
  document.getElementById("current-folder").textContent =
    "Shell folder: " + directory;

  for (const [fullPath, node] of nodes) {
    node.button.classList.toggle(
      "current",
      fullPath === directory
    );

    if (fullPath === directory) {
      node.button.setAttribute("aria-current", "location");
    } else {
      node.button.removeAttribute("aria-current");
    }
  }
}

// Create one expandable folder.
function createFolder(name, fullPath, parent) {
  const li = document.createElement("li");
  const button = document.createElement("button");

  button.className = "folder-button";
  button.textContent = "▸ " + name;
  button.title = fullPath;
  button.setAttribute("aria-expanded", "false");

  const children = document.createElement("ul");
  children.hidden = true;

  li.append(button, children);
  parent.append(li);

  const node = {
    button,
    children,
    name,
    fullPath,
    loaded: false,
    loading: null,
    generation
  };

  nodes.set(fullPath, node);

  button.addEventListener("click", async () => {
    if (!children.hidden) {
      children.hidden = true;
      button.textContent = "▸ " + name;
      button.setAttribute("aria-expanded", "false");
    } else {
      await expand(node);
    }
  });

  return node;
}

// Read a folder only when it is expanded.
async function expand(node) {
  node.children.hidden = false;
  node.button.textContent = "▾ " + node.name;
  node.button.setAttribute("aria-expanded", "true");

  if (node.loaded) return;
  if (node.loading) return node.loading;

  node.loading = (async () => {
    node.children.textContent = "Loading…";

    let response;

    try {
      response = await api.listDirectory(node.fullPath);
    } catch (error) {
      response = {
        ok: false,
        error: error.message
      };
    }

    // Ignore responses from an older tree after Refresh.
    if (node.generation !== generation) return;

    node.children.replaceChildren();

    if (!response.ok) {
      const error = document.createElement("li");
      error.textContent = response.error;
      node.children.append(error);
      return;
    }

    for (const entry of response.entries) {
      if (!showHidden.checked && entry.name.startsWith(".")) {
        continue;
      }

      if (entry.isDirectory) {
        createFolder(
          entry.name + (entry.isLink ? " ↗" : ""),
          entry.path,
          node.children
        );
      } else {
        const li = document.createElement("li");
        const label = document.createElement("span");

        label.className = "file-label";
        label.textContent =
          entry.name + (entry.isLink ? " ↗" : "");
        label.title = entry.path;

        li.append(label);
        node.children.append(li);
      }
    }

    if (!node.children.childElementCount) {
      const empty = document.createElement("li");
      empty.textContent = "(No visible files)";
      node.children.append(empty);
    }

    node.loaded = true;
    markDirectory();
  })();

  try {
    await node.loading;
  } finally {
    node.loading = null;
  }
}

// Expand the path from / to the shell's current folder.
async function revealDirectory(scroll = false) {
  const request = ++revealRequest;
  const target = directory;
  const version = generation;

  let fullPath = "/";
  let node = nodes.get("/");

  if (!node) return;

  await expand(node);

  for (const part of target.split("/").filter(Boolean)) {
    if (
      version !== generation ||
      request !== revealRequest
    ) {
      return;
    }

    fullPath =
      fullPath === "/"
        ? "/" + part
        : fullPath + "/" + part;

    node = nodes.get(fullPath);

    if (!node) {
      fileStatus.textContent =
        "Some of this path is hidden or inaccessible. Try Show hidden files.";
      return;
    }

    await expand(node);
  }

  if (
    version !== generation ||
    request !== revealRequest
  ) {
    return;
  }

  markDirectory();

  if (scroll) {
    node.button.scrollIntoView({
      block: "nearest"
    });
  }
}

async function resetTree() {
  generation++;
  nodes.clear();
  tree.replaceChildren();

  createFolder("Computer /", "/", tree);
  await revealDirectory();
}

document.getElementById("reveal-folder").addEventListener(
  "click",
  () => revealDirectory(true)
);

document.getElementById("refresh-tree").addEventListener(
  "click",
  resetTree
);

showHidden.addEventListener("change", resetTree);

// Open a shell or restart after exit.
async function startTerminal() {
  if (!api || !term || running || starting) return;

  starting = true;
  terminalStatus.textContent = "Starting shell…";

  try {
    const response = await api.startShell();

    if (!response.ok) {
      throw new Error(response.error);
    }

    running = true;
    directory = response.directory;
    terminalStatus.textContent = "Shell running";

    resizeTerminal();
    markDirectory();
    await resetTree();

    term.focus();
  } catch (error) {
    terminalStatus.textContent = "Shell could not start";

    term.writeln(
      "\r\n" + error.message.replace(/\n/g, "\r\n")
    );
  } finally {
    starting = false;
  }
}

document.getElementById("restart-terminal").addEventListener(
  "click",
  () => {
    if (!running) startTerminal();
  }
);

// Set up xterm.js and subscribe before starting the shell.
if (!api || !window.Terminal || !window.FitAddon) {
  terminalStatus.textContent =
    "Open with npm start after running npm install.";
} else {
  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "Menlo, Monaco, Consolas, monospace",
    scrollback: 5000,
    theme: {
      background: "#05090d",
      foreground: "#b7f7d2",
      cursor: "#26d980"
    }
  });

  fit = new FitAddon.FitAddon();

  term.loadAddon(fit);
  term.open(document.getElementById("terminal-screen"));

  const unsubscribers = [
    api.onData((data) => {
      term.write(data);
    }),

    api.onExit((code) => {
      running = false;

      terminalStatus.textContent =
        "Shell exited (" + code + ")";

      term.writeln(
        "\r\n[Shell exited. Click Restart exited shell.]"
      );
    }),

    api.onDirectory(({ directory: next, changed }) => {
      fileStatus.textContent = "";

      if (next === directory && !changed) return;

      directory = next;

      markDirectory();
      revealDirectory();
    }),

    api.onDirectoryError((message) => {
      fileStatus.textContent = message;
    })
  ];

  term.onData((data) => {
    if (!running) return;

    // Send large pastes in smaller chunks.
    for (let i = 0; i < data.length; i += 16384) {
      api.writeShell(data.slice(i, i + 16384));
    }
  });

  const observer = new ResizeObserver(resizeTerminal);

  observer.observe(
    document.getElementById("terminal-screen")
  );

  window.addEventListener("beforeunload", () => {
    observer.disconnect();

    unsubscribers.forEach((unsubscribe) => {
      unsubscribe();
    });

    term.dispose();
  });

  startTerminal();
}

const scanTarget = document.getElementById("scan-target");
const scanType = document.getElementById("scan-type");
const scanButton = document.getElementById("scan-button");
const cancelScan = document.getElementById("cancel-scan");
const scanCommand = document.getElementById("scan-command");
const scanStatus = document.getElementById("scan-status");
const scanOutput = document.getElementById("scan-output");
let scanRunning = false;
let previewVersion = 0;

function scanRequest() {
  return {
    target: scanTarget.value,
    preset: scanType.value,
    options: {
      skipDiscovery: document.getElementById("skip-discovery").checked,
      traceroute: document.getElementById("traceroute").checked,
      verbose: document.getElementById("verbose-scan").checked
    }
  };
}

async function updateCommandPreview() {
  const version = ++previewVersion;

  if (!scanTarget.value.trim()) {
    scanCommand.textContent = "Enter a target to preview the command.";
    return;
  }

  const response = await api.previewNmap(scanRequest());
  if (version !== previewVersion) return;

  scanCommand.textContent = response.ok
    ? response.command
    : response.error;
}

function setScanRunning(value) {
  scanRunning = value;
  scanButton.disabled = value;
  cancelScan.disabled = !value;
  scanTarget.disabled = value;
  scanType.disabled = value;
  document.querySelectorAll(".scan-options input").forEach((input) => {
    input.disabled = value;
  });
}

scanTarget.addEventListener("input", updateCommandPreview);
scanType.addEventListener("change", updateCommandPreview);
document.querySelectorAll(".scan-options input").forEach((input) => {
  input.addEventListener("change", updateCommandPreview);
});

scanTarget.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !scanRunning) scanButton.click();
});

scanButton.addEventListener("click", async () => {
  if (scanRunning) return;

  setScanRunning(true);
  scanStatus.textContent = "Starting scan…";
  scanOutput.textContent = "$ " + scanCommand.textContent + "\n\n";

  const response = await api.startNmap(scanRequest());

  if (!response.ok) {
    setScanRunning(false);
    scanStatus.textContent = response.error;
    scanOutput.textContent = response.error;
    return;
  }

  scanCommand.textContent = response.command;
  scanStatus.textContent = "Scan running…";
});

cancelScan.addEventListener("click", async () => {
  if (!scanRunning) return;
  cancelScan.disabled = true;
  scanStatus.textContent = "Stopping scan…";

  const response = await api.cancelNmap();
  if (!response.ok) scanStatus.textContent = response.error;
});

const nmapUnsubscribers = [
  api.onNmapOutput(({ stream, text }) => {
    scanOutput.textContent += stream === "stderr"
      ? "[error] " + text
      : text;
    scanOutput.scrollTop = scanOutput.scrollHeight;
  }),
  api.onNmapComplete((result) => {
    setScanRunning(false);

    if (result.cancelled) {
      scanStatus.textContent = "Scan cancelled.";
      scanOutput.textContent += "\n[Scan cancelled]\n";
    } else if (!result.ok && result.error) {
      scanStatus.textContent = result.error;
      scanOutput.textContent += "\n[Error] " + result.error + "\n";
    } else if (result.ok) {
      scanStatus.textContent = "Scan completed successfully.";
    } else {
      scanStatus.textContent = "Scan exited with code " + result.code + ".";
    }
  })
];

window.addEventListener("beforeunload", () => {
  nmapUnsubscribers.forEach((unsubscribe) => unsubscribe());
});

updateCommandPreview();
