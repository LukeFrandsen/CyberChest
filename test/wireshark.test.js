const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Capture, filter, parseInterfaces, outputArgs } = require('../wireshark');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
test('filters reject malformed input while shell metacharacters remain literal arguments', () => {
  assert.equal(filter(' tcp port 443 '), 'tcp port 443');
  assert.equal(filter('$(touch /tmp/not-executed)'), '$(touch /tmp/not-executed)');
  for (const input of [42, {}, 'tcp\0', 'tcp\n', 'x'.repeat(4097)]) assert.throws(() => filter(input));
});
test('interface parsing preserves IDs and descriptions', () => {
  assert.deepEqual(parseInterfaces('1. en0 (Wi-Fi)\n2. lo0 (Loopback)\nnoise'), [{id:'en0',label:'en0 (Wi-Fi)'},{id:'lo0',label:'lo0 (Loopback)'}]);
  assert.ok(outputArgs().includes('_ws.col.Info'));
});
test('real TShark detects, reads a generated capture, and writes PCAPNG', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyberchest-test-'));
  const events = [];
  const capture = new Capture((channel, value) => events.push({channel, value}));
  try {
    await capture.detect();
    // Classic PCAP containing one Ethernet/IPv4/UDP packet.
    const packet = Buffer.from('ffffffffffff00112233445508004500001c00000000401100007f0000017f00000104d2162e00080000','hex');
    const header = Buffer.alloc(24); header.writeUInt32LE(0xa1b2c3d4); header.writeUInt16LE(2,4); header.writeUInt16LE(4,6); header.writeUInt32LE(65535,16); header.writeUInt32LE(1,20);
    const record = Buffer.alloc(16); record.writeUInt32LE(1700000000); record.writeUInt32LE(packet.length,8); record.writeUInt32LE(packet.length,12);
    const input = path.join(dir, 'input.pcap'); const output = path.join(dir, 'output.pcapng');
    await fs.writeFile(input, Buffer.concat([header, record, packet]));
    await capture.load(input); if(capture.active) await capture.active.done;
    assert.ok(events.some(event => event.channel === 'wireshark:packets' && event.value[0][0] === '1'));
    assert.ok(events.some(event => event.channel === 'wireshark:complete' && event.value.ok));
    await capture.save(output);
    assert.equal((await fs.readFile(output)).readUInt32LE(0),0x0a0d0d0a);
    await assert.rejects(capture.start({interface:';touch /tmp/not-executed'}), /available capture interface/);
  } finally { await capture.cleanup(); await fs.rm(dir,{recursive:true,force:true}); }
});
