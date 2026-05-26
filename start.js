require('dotenv').config();
const readline = require('readline');
const { spawn } = require('child_process');
const path = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('\nSpike — how would you like to launch?\n');
console.log('  1  Web app     (opens in your browser)');
console.log('  2  Desktop app (standalone window)\n');

rl.question('Choice [1/2]: ', (answer) => {
  rl.close();

  if (answer.trim() === '2') {
    let electronPath;
    try {
      electronPath = require('electron');
    } catch {
      console.error('\n  Electron is not installed. Run: npm install --save-dev electron\n');
      process.exit(1);
    }
    const proc = spawn(electronPath, [path.join(__dirname, 'electron-main.js')], {
      stdio: 'inherit',
      env: process.env
    });
    proc.on('close', code => process.exit(code ?? 0));
  } else {
    require('./server');
  }
});
