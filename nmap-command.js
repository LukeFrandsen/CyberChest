// Parse arguments without invoking a shell. Quoted paths and script arguments
// remain single arguments; shell pipelines and substitutions are not supported.
function parseCommand(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4096 || /[\x00-\x1f\x7f]/.test(command)) {
    throw new Error('Enter a single-line Nmap command.');
  }
  const tokens = [];
  let word = '', quote = '', escaped = false, started = false;
  for (const char of command.trim()) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = ''; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) tokens.push(word); word = ''; started = false; continue; }
    if (';|&<>`$'.includes(char)) throw new Error('Use a single Nmap command, without shell operators.');
    word += char; started = true;
  }
  if (quote || escaped) throw new Error('Finish the quotation or escape in your command.');
  if (started) tokens.push(word);
  const sudo = tokens[0] === 'sudo';
  if (sudo) tokens.shift();
  if (tokens.shift() !== 'nmap') throw new Error('Start the command with nmap or sudo nmap.');
  if (!tokens.length) throw new Error('Add Nmap options or a target.');
  const shellQuote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  return { args: tokens, sudo, terminalCommand: (sudo ? 'sudo ' : '') + 'nmap ' + tokens.map(shellQuote).join(' ') };
}
module.exports = { parseCommand };
