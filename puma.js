const fs = require('fs');
const path = require('path');

const Lexer = require('./lexer');
const Parser = require('./parser');
const Evaluator = require('./evaluator');

const VERSION = '1.0.2';

const COLOR = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    green: '\x1b[32m',
    magenta: '\x1b[35m',
    white: '\x1b[37m'
};

function waitAndExit(code = 0) {
    console.log(COLOR.gray + '\nPress any key to exit...' + COLOR.reset);

    try {
        process.stdin.setRawMode(true);
    } catch {}

    process.stdin.resume();
    process.stdin.once('data', () => {
        process.exit(code);
    });
}

function fatal(msg) {
    console.error(COLOR.red + msg + COLOR.reset);
    waitAndExit(1);
}

async function runFile(filePath) {
    let code;

    try {
        code = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        return fatal(`Cannot read file: ${e.message}`);
    }

    let tokens, ast;

    try {
        const lexer = new Lexer(code);
        tokens = lexer.getTokens();

        const parser = new Parser(tokens, code);
        ast = parser.parse();
    } catch (e) {
        return fatal(e.message || 'Syntax error');
    }

    try {
        const evaluator = new Evaluator(code);
        await evaluator.evaluate(ast);
    } catch (e) {
        return fatal(e.message || 'Runtime error');
    }

    waitAndExit(0);
}

const args = process.argv.slice(2);

if (args.length === 0) {
    console.log(`
${COLOR.bold}Puma Programming Language${COLOR.reset}
Version ${VERSION}

Usage:
  puma <file.pulsar>
  puma -v
`);
    waitAndExit(0);
}

if (args[0] === '--version' || args[0] === '-v') {
    console.log(COLOR.cyan + `Puma CLI v${VERSION}` + COLOR.reset);
    waitAndExit(0);
    return; 
}

if (args[0].startsWith('-')) {
    fatal(`Unknown command: ${args[0]}`);
    return;
}

const file = path.resolve(args[0]);
const ext = path.extname(file).toLowerCase();

if (ext !== '.pulsar') {
    fatal('Only .pulsar files are supported');
    return;
}

runFile(file);
