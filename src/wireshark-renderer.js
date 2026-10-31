(() => {
  const el = id => document.getElementById('ws-' + id);
  const api = window.cyberChest;
  let rows = [], active = false, busy = false, available = false, hasCapture = false;
  function controls() {
    el('start').disabled = busy || active || !available;
    el('stop').disabled = busy || !active;
    el('refresh').disabled = busy || active;
    el('load').disabled = busy || active;
    el('save').disabled = busy || active || !hasCapture;
    el('interface').disabled = busy || active;
    el('capture-filter').disabled = busy || active;
  }
  function render() {
    const query = el('search').value.toLowerCase();
    const matches = rows.filter(row => row.some(value => value.toLowerCase().includes(query)));
    const fragment = document.createDocumentFragment();
    for (const row of matches.slice(-1000)) {
      const tr = document.createElement('tr');
      for (const value of row) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
      fragment.append(tr);
    }
    el('packets').replaceChildren(fragment);
    el('count').textContent = matches.length + ' matching / ' + rows.length + ' retained (latest 1,000 shown)';
  }
  async function invoke(fn) {
    busy = true; controls();
    try { const result = await fn(); if (!result.ok) throw new Error(result.error); return result; }
    catch (error) { el('status').textContent = error.message; return null; }
    finally { busy = false; controls(); }
  }
  async function detect() {
    el('status').textContent = 'Detecting TShark and interfaces…';
    await invoke(async () => {
      const result = await api.detectTshark();
      available = result.ok && result.interfaces.length > 0;
      el('interface').replaceChildren();
      if (result.ok) {
        for (const item of result.interfaces) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; el('interface').append(option); }
        el('status').textContent = result.version + (available ? ' — ready.' : ' — no capture interfaces available. Check Wireshark capture permissions.');
      }
      return result;
    });
  }
  el('refresh').addEventListener('click', detect);
  el('start').addEventListener('click', () => invoke(async () => {
    rows = []; render(); active = true; hasCapture = false;
    el('status').textContent = 'Starting capture…';
    const result = await api.startCapture({ interface: el('interface').value, filter: el('capture-filter').value });
    if (!result.ok) active = false;
    else { hasCapture = true; if (active) el('status').textContent = 'Capturing… Stop before saving. Automatic stop at 100 MB or one hour.'; }
    return result;
  }));
  el('stop').addEventListener('click', () => invoke(() => { el('status').textContent = 'Stopping capture…'; return api.stopCapture(); }));
  el('load').addEventListener('click', () => invoke(async () => {
    // Preserve the current table when the file picker is cancelled.
    const previous = rows; rows = []; active = true;
    const result = await api.loadCapture();
    if (result.cancelled || !result.ok) { rows = previous; active = false; render(); }
    else { hasCapture = true; render(); }
    return result;
  }));
  el('save').addEventListener('click', () => invoke(async () => { const result = await api.saveCapture(); if (result.ok && !result.cancelled) el('status').textContent = 'PCAPNG saved.'; return result; }));
  let renderTimer;
  el('search').addEventListener('input', () => { clearTimeout(renderTimer); renderTimer = setTimeout(() => { renderTimer = null; render(); }, 100); });
  const unsub = [api.onPackets(batch => {
    rows.push(...batch); if (rows.length > 10000) rows.splice(0, rows.length - 10000);
    if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 200);
  }), api.onCaptureComplete(result => {
    active = false;
    el('status').textContent = result.error || (result.live ? 'Capture stopped. Ready to save.' : 'Capture loaded (first 10,000 packets).');
    controls(); render();
  })];
  window.addEventListener('beforeunload', () => { clearTimeout(renderTimer); unsub.forEach(fn => fn()); });
  controls(); detect();
})();
