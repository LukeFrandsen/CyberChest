const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const run = promisify(execFile);
const fields = ['frame.number', 'frame.time_relative', '_ws.col.Source', '_ws.col.Destination', '_ws.col.Protocol', 'frame.len', '_ws.col.Info'];
function outputArgs() { return ['-n', '-l', '-T', 'fields', '-E', 'separator=/t', '-E', 'quote=n', '-E', 'occurrence=f', ...fields.flatMap(f => ['-e', f])]; }
function filter(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('Invalid capture filter.');
  return value.trim();
}
function parseInterfaces(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\d+\. (\S+)(?: (.*))?$/);
    return match ? [{ id: match[1], label: match[1] + (match[2] ? ' ' + match[2] : '') }] : [];
  });
}
class Capture {
  constructor(send) { this.send = send; this.active = null; this.file = null; this.temp = null; this.busy = false; }
  async detect() {
    if (this.binary) return this.binary;
    for (const binary of ['tshark', '/Applications/Wireshark.app/Contents/MacOS/tshark', '/opt/homebrew/bin/tshark', '/usr/local/bin/tshark', '/usr/bin/tshark']) {
      try { const { stdout } = await run(binary, ['--version'], { timeout: 5000, maxBuffer: 65536 }); this.binary = binary; this.version = stdout.split('\n')[0]; return binary; } catch {}
    }
    throw new Error('TShark was not found. Install Wireshark or add TShark to PATH.');
  }
  async interfaces() {
    const binary = await this.detect();
    const { stdout } = await run(binary, ['-D'], { timeout: 10000, maxBuffer: 262144 });
    return { version: this.version, interfaces: parseInterfaces(stdout) };
  }
  async start(request) {
    if (this.busy || this.active) throw new Error('A capture operation is already running.');
    this.busy = true;
    try {
      const captureFilter = filter(request?.filter);
      const { interfaces } = await this.interfaces();
      if (!interfaces.some(item => item.id === request?.interface)) throw new Error('Select an available capture interface.');
      await this.clearTemp();
      this.temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cyberchest-capture-'));
      this.file = path.join(this.temp, 'capture.pcapng');
      const args = ['-i', request.interface, '-p', '-a', 'filesize:102400', '-a', 'duration:3600', '-w', this.file, '-P', ...outputArgs()];
      if (captureFilter) args.push('-f', captureFilter);
      await this.launch(args, true);
    } finally { this.busy = false; }
  }
  async load(file) {
    if (this.busy || this.active) throw new Error('Stop the current capture first.');
    this.busy = true;
    try {
      await this.detect();
      await this.clearTemp();
      this.file = file;
      await this.launch(['-r', file, '-c', '10000', ...outputArgs()], false);
    } finally { this.busy = false; }
  }
  launch(args, live) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const state = { child, live, stopped: false, rows: [], pending: '', error: '', timer: null };
      this.active = state;
      const flush = () => { if (state.rows.length) this.send('wireshark:packets', state.rows.splice(0)); };
      state.timer = setInterval(flush, 100);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', text => {
        state.pending += text;
        const lines = state.pending.split('\n'); state.pending = lines.pop();
        if (state.pending.length > 65536) state.pending = '';
        for (const line of lines) {
          const row = line.replace(/\r$/, '').split('\t');
          if (/^\d+$/.test(row[0]) && row.length >= 7) state.rows.push(row.slice(0, 7).map(v => v.slice(0, 2048)));
          if (state.rows.length >= 200) flush();
        }
      });
      child.stderr.on('data', data => { state.error = (state.error + data.toString()).slice(-8000); });
      child.once('spawn', () => resolve());
      child.once('error', error => { reject(error); state.error = error.message; });
      state.done = new Promise(done => child.once('close', code => {
        clearInterval(state.timer); clearTimeout(state.killTimer); flush();
        if (this.active === state) this.active = null;
        this.send('wireshark:complete', { ok: code === 0 || state.stopped, stopped: state.stopped, live, error: code !== 0 && !state.stopped ? state.error || 'TShark exited with code ' + code : '' });
        done();
      }));
    });
  }
  async stop() {
    const state = this.active;
    if (!state) return;
    state.stopped = true;
    state.child.kill('SIGTERM');
    state.killTimer = setTimeout(() => state.child.kill('SIGKILL'), 2500);
    await state.done;
  }
  async save(destination) {
    if (this.busy || this.active) throw new Error('Stop the capture before saving.');
    if (!this.file) throw new Error('No capture is available.');
    this.busy = true;
    try {
      // Re-encode imported PCAP as genuine PCAPNG, with no shell involved.
      const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cyberchest-export-'));
      try {
        const output = path.join(folder, 'export.pcapng');
        await run(await this.detect(), ['-r', this.file, '-w', output, '-F', 'pcapng'], { timeout: 60000, maxBuffer: 65536 });
        await fs.copyFile(output, destination);
      } finally { await fs.rm(folder, { recursive: true, force: true }); }
    } finally { this.busy = false; }
  }
  async clearTemp() {
    if (this.temp) await fs.rm(this.temp, { recursive: true, force: true });
    this.temp = null; this.file = null;
  }
  async cleanup() { await this.stop(); await this.clearTemp(); }
}
module.exports = { Capture, filter, parseInterfaces, outputArgs };
