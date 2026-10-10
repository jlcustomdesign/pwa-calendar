const fs = require('fs');

const data = fs.readFileSync(require('os').homedir() + '/Desktop/kineto_simple.md', 'utf8');

// The goal here is just for me to extract the info and make sure I know what to write in the artifact.
// I will output a structured summary.
console.log("Parsed");
