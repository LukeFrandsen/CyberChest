const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);

  ipcRenderer.on(channel, listener);

  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("cyberChest", {
  startShell: () => {
    return ipcRenderer.invoke("shell:start");
  },

  writeShell: (data) => {
    ipcRenderer.send("shell:input", data);
  },

  resizeShell: (size) => {
    ipcRenderer.send("shell:resize", size);
  },

  onData: (callback) => {
    return subscribe("shell:data", callback);
  },

  onExit: (callback) => {
    return subscribe("shell:exit", callback);
  },

  onDirectory: (callback) => {
    return subscribe("shell:cwd", callback);
  },

  onDirectoryError: (callback) => {
    return subscribe("shell:cwd-error", callback);
  },

  listDirectory: (directory) => {
    return ipcRenderer.invoke("files:list", directory);
  },

  previewNmap: (request) => {
    return ipcRenderer.invoke("nmap:preview", request);
  },

  startNmap: (request) => {
    return ipcRenderer.invoke("nmap:start", request);
  },

  cancelNmap: () => {
    return ipcRenderer.invoke("nmap:cancel");
  },

  onNmapOutput: (callback) => {
    return subscribe("nmap:output", callback);
  },

  onNmapComplete: (callback) => {
    return subscribe("nmap:complete", callback);
  },

  listProjects: () => ipcRenderer.invoke("projects:list"),
  createProject: (input) => ipcRenderer.invoke("projects:create", input),
  updateProject: (input) => ipcRenderer.invoke("projects:update", input),
  projectDetails: (projectId) => ipcRenderer.invoke("projects:details", projectId),
  openProjectFolder: (projectId) => ipcRenderer.invoke("projects:open-folder", projectId),
  readNote: (input) => ipcRenderer.invoke("notes:read", input),
  saveNote: (input) => ipcRenderer.invoke("notes:save", input),
  saveCommand: (input) => ipcRenderer.invoke("projects:save-command", input),
  saveScan: (input) => ipcRenderer.invoke("projects:save-scan", input)
});
