const api = window.cyberChest;
const byId = (id) => document.getElementById(id);
let projects = [];
let activeProjectId = "";
let activeDetails = null;
let currentNote = "";
let noteDirty = false;

function switchTool(tool) {
  document.querySelectorAll(".tool-tab[data-tool]").forEach((tab) => tab.classList.toggle("active", tab.dataset.tool === tool));
  document.querySelectorAll(".tool-workspace").forEach((panel) => panel.classList.toggle("active", panel.id === tool + "-workspace"));
  const contexts = { terminal: "file-tree", nmap: "network-tree", projects: "project-context", notes: "notes-context" };
  document.querySelectorAll(".context-content").forEach((panel) => panel.classList.toggle("active", panel.id === contexts[tool]));
  if (tool === "terminal") requestAnimationFrame(() => { resizeTerminal(); term?.focus(); });
  if (tool === "notes") loadNotesForProject();
}

document.querySelectorAll(".tool-tab[data-tool]").forEach((tab) => tab.addEventListener("click", () => switchTool(tab.dataset.tool)));

function setActiveProject(id) {
  activeProjectId = id || "";
  const project = projects.find((item) => item.id === activeProjectId);
  byId("active-project-label").textContent = project ? project.name : "No project selected";
  document.querySelectorAll(".current-project-chip").forEach((chip) => chip.textContent = project ? project.name : "No project");
  byId("nmap-project").value = activeProjectId;
  byId("notes-project").value = activeProjectId;
  if (byId("save-command")) byId("save-command").disabled = !activeProjectId || !byId("scan-command").value.trim();
  if (byId("save-scan")) byId("save-scan").disabled = !activeProjectId || !scanCompleted;
}

async function loadProjects(preferredId) {
  const response = await api.listProjects();
  if (!response.ok) return;
  projects = response.projects;
  byId("projects-root").textContent = response.root;
  byId("project-count").textContent = projects.length;
  renderProjectOptions();
  renderProjectList();
  const next = preferredId || activeProjectId;
  if (next && projects.some((project) => project.id === next)) setActiveProject(next);
}

function renderProjectOptions() {
  const configs = [[byId("nmap-project"), "Don't save to a project"], [byId("notes-project"), "Select a project"]];
  configs.forEach(([select, placeholder]) => {
    const value = select.value;
    select.replaceChildren(new Option(placeholder, ""), ...projects.map((project) => new Option(project.name, project.id)));
    select.value = projects.some((project) => project.id === value) ? value : "";
  });
}

function renderProjectList() {
  const list = byId("project-list");
  list.replaceChildren();
  projects.forEach((project) => {
    const button = document.createElement("button");
    button.className = "project-item" + (project.id === activeProjectId ? " active" : "");
    const strong = document.createElement("strong");
    strong.textContent = project.name;
    const meta = document.createElement("span");
    meta.textContent = [project.status, project.target].filter(Boolean).join(" • ") || "No target set";
    button.append(strong, meta);
    button.addEventListener("click", () => selectProject(project.id));
    list.append(button);
  });
}

async function selectProject(id) {
  const response = await api.projectDetails(id);
  if (!response.ok) return;
  setActiveProject(id);
  activeDetails = response;
  renderProjectList();
  byId("project-empty").hidden = true;
  byId("project-form").hidden = false;
  byId("project-id").value = id;
  byId("project-name").value = response.project.name;
  byId("project-target").value = response.project.target || "";
  byId("project-status").value = response.project.status || "Active";
  byId("project-description").value = response.project.description || "";
  byId("project-form-title").textContent = response.project.name;
  byId("project-stats").innerHTML = `<div class="stat"><strong>${response.notes.length}</strong>Notes</div><div class="stat"><strong>${response.scans.length}</strong>Scans</div><div class="stat"><strong>${response.commands.length}</strong>Commands</div>`;
}

const projectDialog = byId("project-dialog");
function showProjectDialog() { byId("create-project-error").textContent = ""; byId("create-project-form").reset(); projectDialog.showModal(); requestAnimationFrame(() => byId("new-project-name").focus()); }
byId("new-project").addEventListener("click", showProjectDialog);
document.querySelector(".create-project-trigger").addEventListener("click", showProjectDialog);
byId("create-project-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const response = await api.createProject({ name: byId("new-project-name").value, target: byId("new-project-target").value, description: byId("new-project-description").value, status: "Active" });
  if (!response.ok) { byId("create-project-error").textContent = response.error; return; }
  projectDialog.close();
  await loadProjects(response.project.id);
  await selectProject(response.project.id);
});

byId("project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await api.updateProject({ id: byId("project-id").value, name: byId("project-name").value, target: byId("project-target").value, status: byId("project-status").value, description: byId("project-description").value });
  byId("project-form-status").textContent = response.ok ? "Saved" : response.error;
  if (response.ok) { await loadProjects(response.project.id); await selectProject(response.project.id); }
});
byId("open-project-folder").addEventListener("click", async () => { if (activeProjectId) await api.openProjectFolder(activeProjectId); });

byId("nmap-project").addEventListener("change", (event) => setActiveProject(event.target.value));
byId("notes-project").addEventListener("change", async (event) => { setActiveProject(event.target.value); await loadNotesForProject(); });

async function loadNotesForProject(openName) {
  const list = byId("note-list");
  list.replaceChildren();
  byId("new-note").disabled = !activeProjectId;
  if (!activeProjectId) { byId("notes-empty").hidden = false; byId("note-editor").hidden = true; return; }
  const response = await api.projectDetails(activeProjectId);
  if (!response.ok) return;
  activeDetails = response;
  response.notes.forEach((name) => {
    const button = document.createElement("button");
    button.className = "note-item" + (name === currentNote ? " active" : "");
    button.textContent = name;
    button.addEventListener("click", () => openNote(name));
    list.append(button);
  });
  byId("notes-empty").hidden = response.notes.length > 0;
  if (openName) await openNote(openName);
}

async function openNote(name) {
  if (noteDirty && !confirm("Discard unsaved note changes?")) return;
  const response = await api.readNote({ projectId: activeProjectId, name });
  if (!response.ok) return;
  currentNote = response.name;
  byId("note-name").value = response.name;
  byId("note-content").value = response.content;
  byId("note-editor").hidden = false;
  byId("notes-empty").hidden = true;
  noteDirty = false;
  byId("note-save-status").textContent = "Saved";
  await loadNotesForProject();
}

const noteDialog = byId("note-dialog");
byId("new-note").addEventListener("click", () => { byId("create-note-form").reset(); byId("create-note-error").textContent = ""; noteDialog.showModal(); requestAnimationFrame(() => byId("new-note-name").focus()); });
byId("create-note-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const name = byId("new-note-name").value;
  const response = await api.saveNote({ projectId: activeProjectId, name, content: `# ${name.replace(/\.md$/i, "")}\n\n` });
  if (!response.ok) { byId("create-note-error").textContent = response.error; return; }
  noteDialog.close();
  currentNote = response.name;
  noteDirty = false;
  await loadProjects(activeProjectId);
  await loadNotesForProject(response.name);
});

async function saveCurrentNote() {
  if (!activeProjectId) return;
  const response = await api.saveNote({ projectId: activeProjectId, name: byId("note-name").value, content: byId("note-content").value });
  byId("note-save-status").textContent = response.ok ? "Saved" : response.error;
  if (response.ok) { currentNote = response.name; noteDirty = false; await loadNotesForProject(); }
}
byId("save-note").addEventListener("click", saveCurrentNote);
[byId("note-name"), byId("note-content")].forEach((field) => field.addEventListener("input", () => { noteDirty = true; byId("note-save-status").textContent = "Unsaved changes"; }));
window.addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !byId("note-editor").hidden) { event.preventDefault(); saveCurrentNote(); } });

const terminalStatus = byId("terminal-status"), fileStatus = byId("file-status"), tree = byId("computer-tree"), showHidden = byId("show-hidden");
const nodes = new Map(); let directory = "/", generation = 0, revealRequest = 0, term, fit, running = false, starting = false;
function resizeTerminal(){const workspace=byId("terminal-workspace");if(!term||!workspace.classList.contains("active"))return;fit.fit();if(running)api.resizeShell({cols:term.cols,rows:term.rows});}
function markDirectory(){byId("current-folder").textContent="Shell folder: "+directory;for(const [fullPath,node] of nodes){node.button.classList.toggle("current",fullPath===directory);}}
function createFolder(name,fullPath,parent){const li=document.createElement("li"),button=document.createElement("button"),children=document.createElement("ul");button.className="folder-button";button.textContent="▸ "+name;button.title=fullPath;children.hidden=true;li.append(button,children);parent.append(li);const node={button,children,name,fullPath,loaded:false,loading:null,generation};nodes.set(fullPath,node);button.addEventListener("click",async()=>{if(!children.hidden){children.hidden=true;button.textContent="▸ "+name;}else await expand(node);});return node;}
async function expand(node){node.children.hidden=false;node.button.textContent="▾ "+node.name;if(node.loaded)return;if(node.loading)return node.loading;node.loading=(async()=>{node.children.textContent="Loading…";let response;try{response=await api.listDirectory(node.fullPath);}catch(error){response={ok:false,error:error.message};}if(node.generation!==generation)return;node.children.replaceChildren();if(!response.ok){const item=document.createElement("li");item.textContent=response.error;node.children.append(item);return;}for(const entry of response.entries){if(!showHidden.checked&&entry.name.startsWith("."))continue;if(entry.isDirectory)createFolder(entry.name+(entry.isLink?" ↗":""),entry.path,node.children);else{const li=document.createElement("li"),label=document.createElement("span");label.className="file-label";label.textContent=entry.name+(entry.isLink?" ↗":"");label.title=entry.path;li.append(label);node.children.append(li);}}if(!node.children.childElementCount){const empty=document.createElement("li");empty.textContent="(No visible files)";node.children.append(empty);}node.loaded=true;markDirectory();})();try{await node.loading;}finally{node.loading=null;}}
async function revealDirectory(scroll=false){const request=++revealRequest,target=directory,version=generation;let fullPath="/",node=nodes.get("/");if(!node)return;await expand(node);for(const part of target.split("/").filter(Boolean)){if(version!==generation||request!==revealRequest)return;fullPath=fullPath==="/"?"/"+part:fullPath+"/"+part;node=nodes.get(fullPath);if(!node){fileStatus.textContent="Some of this path is hidden or inaccessible.";return;}await expand(node);}markDirectory();if(scroll)node.button.scrollIntoView({block:"nearest"});}
async function resetTree(){generation++;nodes.clear();tree.replaceChildren();createFolder("Computer /","/",tree);await revealDirectory();}
byId("reveal-folder").addEventListener("click",()=>revealDirectory(true));byId("refresh-tree").addEventListener("click",resetTree);showHidden.addEventListener("change",resetTree);
async function startTerminal(){if(!api||!term||running||starting)return;starting=true;terminalStatus.textContent="Starting shell…";try{const response=await api.startShell();if(!response.ok)throw new Error(response.error);running=true;directory=response.directory;terminalStatus.textContent="Shell running";resizeTerminal();await resetTree();term.focus();}catch(error){terminalStatus.textContent="Shell could not start";term.writeln("\r\n"+error.message.replace(/\n/g,"\r\n"));}finally{starting=false;}}
byId("restart-terminal").addEventListener("click",()=>{if(!running)startTerminal();});
if(!api||!window.Terminal||!window.FitAddon){terminalStatus.textContent="Open with npm start after running npm install.";}else{term=new Terminal({cursorBlink:true,fontSize:14,fontFamily:"Menlo, Monaco, Consolas, monospace",scrollback:5000,theme:{background:"#05090d",foreground:"#b7f7d2",cursor:"#31d983"}});fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open(byId("terminal-screen"));const unsub=[api.onData((data)=>term.write(data)),api.onExit((code)=>{running=false;terminalStatus.textContent="Shell exited ("+code+")";}),api.onDirectory(({directory:next})=>{directory=next;markDirectory();revealDirectory();}),api.onDirectoryError((message)=>fileStatus.textContent=message)];term.onData((data)=>{if(running)for(let i=0;i<data.length;i+=16384)api.writeShell(data.slice(i,i+16384));});const observer=new ResizeObserver(resizeTerminal);observer.observe(byId("terminal-screen"));window.addEventListener("beforeunload",()=>{observer.disconnect();unsub.forEach((fn)=>fn());term.dispose();});startTerminal();}

const scanTarget=byId("scan-target"),scanType=byId("scan-type"),scanButton=byId("scan-button"),cancelScan=byId("cancel-scan"),scanCommand=byId("scan-command"),scanStatus=byId("scan-status"),scanOutput=byId("scan-output");let scanRunning=false,previewVersion=0,scanCompleted=false,commandEdited=false,lastScanCommand="",lastScanTarget="";
const explanations={basic:"A balanced first look using Nmap's default selection of common ports.",quick:"A faster scan of fewer common ports using -T4 and -F.",service:"Adds -sV to identify services and version information on open ports.",ports:"Adds -p- to test every TCP port; this can take considerably longer.","operating-system":"Adds -O to estimate the operating system; elevated privileges may be required."};
function scanRequest(){return{target:scanTarget.value,preset:scanType.value,options:{skipDiscovery:byId("skip-discovery").checked,traceroute:byId("traceroute").checked,verbose:byId("verbose-scan").checked}};}
async function updateCommandPreview(){byId("scan-explanation").textContent=explanations[scanType.value];if(commandEdited)return;const version=++previewVersion;if(!scanTarget.value.trim()){scanCommand.value="";byId("save-command").disabled=true;return;}const response=await api.previewNmap(scanRequest());if(version!==previewVersion||commandEdited)return;scanCommand.value=response.ok?response.command:"";if(!response.ok)scanStatus.textContent=response.error;byId("save-command").disabled=!response.ok||!activeProjectId;}
function setScanRunning(value){scanRunning=value;scanCommand.disabled=value;byId("reset-command").disabled=value;scanButton.disabled=value;cancelScan.disabled=!value;scanTarget.disabled=value;scanType.disabled=value;document.querySelectorAll(".scan-options input").forEach((input)=>input.disabled=value);}
[scanTarget,scanType,...document.querySelectorAll(".scan-options input")].forEach((field)=>field.addEventListener(field===scanTarget?"input":"change",()=>{
  // Changing builder settings intentionally replaces any manual command edits.
  commandEdited=false;
  updateCommandPreview();
}));
scanButton.addEventListener("click",async()=>{if(scanRunning)return;setScanRunning(true);scanCompleted=false;byId("save-scan").disabled=true;scanStatus.textContent="Starting scan…";scanOutput.textContent="$ "+scanCommand.value+"\n\n";lastScanCommand=scanCommand.value;lastScanTarget=scanTarget.value;let response;try{response=await api.startNmap({command:lastScanCommand});}catch(error){response={ok:false,error:error.message};}if(!response.ok){setScanRunning(false);scanStatus.textContent=response.error;scanOutput.textContent=response.error;return;}if(response.terminal){setScanRunning(false);if(!running)await startTerminal();if(!running){scanStatus.textContent="Start the terminal shell and try again.";return;}switchTool("terminal");api.writeShell(response.command);scanStatus.textContent="Command placed in Terminal. Press Enter at the shell prompt to run; output and password entry stay in Terminal.";scanOutput.textContent=scanStatus.textContent;return;}scanStatus.textContent=scanRunning?"Scan running…":scanStatus.textContent;});
scanCommand.addEventListener("input",()=>{commandEdited=true;++previewVersion;byId("save-command").disabled=!activeProjectId||!scanCommand.value.trim();});
byId("reset-command").addEventListener("click",()=>{commandEdited=false;updateCommandPreview();});
cancelScan.addEventListener("click",async()=>{cancelScan.disabled=true;scanStatus.textContent="Stopping scan…";await api.cancelNmap();});
byId("save-command").addEventListener("click",async()=>{if(!activeProjectId)return;const response=await api.saveCommand({projectId:activeProjectId,command:scanCommand.value,description:explanations[scanType.value]});scanStatus.textContent=response.ok?"Command saved to project.":response.error;});
byId("save-scan").addEventListener("click",async()=>{if(!activeProjectId||!scanCompleted)return;const response=await api.saveScan({projectId:activeProjectId,target:lastScanTarget,command:lastScanCommand,output:scanOutput.textContent});scanStatus.textContent=response.ok?"Scan saved as "+response.name:response.error;if(response.ok)await loadProjects(activeProjectId);});
const nmapUnsub=[api.onNmapOutput(({stream,text})=>{scanOutput.textContent+=(stream==="stderr"?"[error] ":"")+text;scanOutput.scrollTop=scanOutput.scrollHeight;}),api.onNmapComplete((result)=>{setScanRunning(false);scanCompleted=!result.cancelled;if(result.cancelled){scanStatus.textContent="Scan cancelled.";scanOutput.textContent+="\n[Scan cancelled]\n";}else if(result.ok)scanStatus.textContent="Scan completed successfully.";else scanStatus.textContent=result.error||"Scan exited with code "+result.code+".";byId("save-scan").disabled=!scanCompleted||!activeProjectId;})];
window.addEventListener("beforeunload",()=>nmapUnsub.forEach((fn)=>fn()));
loadProjects().then(updateCommandPreview);
