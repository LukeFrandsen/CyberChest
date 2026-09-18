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
  }
});