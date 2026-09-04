const readlineSync = require('readline-sync');
const http = require('http');
const https = require('https');
const fs = require('fs');
const Lexer = require('./lexer');
const Parser = require('./parser');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
class ReturnValue {
  constructor(value) { this.value = value; }
}
class BreakSignal {}
class ContinueSignal {}
const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m'
};
class RuntimeError extends Error {
  constructor(message, node, source, env = null) {
    const line = node?.line ?? '?';
    const column = node?.column ?? '?';

    let output =
      `${COLOR.red}${message}${COLOR.reset} at line ${line}, column ${column}\n`;

    if (source && node?.line != null) {
      const lines = source.split('\n');
      const srcLine = lines[node.line - 1] || '';
      const caretPos =
        typeof column === 'number' && column > 0 ? column - 1 : 0;

      output += `${COLOR.white}  ${srcLine}\n`;
      output += `  ${' '.repeat(caretPos)}^\n${COLOR.reset}`;
    }

    if (env && message.startsWith('Undefined variable:')) {
      const nameMatch = message.match(/"(.+?)"/);
      if (nameMatch) {
        const name = nameMatch[1];
        const suggestion = RuntimeError.suggest(name, env);
        if (suggestion) {
          output +=
            `${COLOR.yellow}Did you mean "${suggestion}"?${COLOR.reset}\n`;
        }
      }
    }

    super(output);
    this.name = 'RuntimeError';
    this.line = line;
    this.column = column;
  }

  static suggest(name, env) {
    const names = new Set();
    let current = env;

    while (current) {
      for (const key of Object.keys(current.store)) {
        names.add(key);
      }
      current = current.parent;
    }

    let best = null;
    let bestScore = Infinity;

    for (const item of names) {
      const dist =
        Math.abs(item.length - name.length) +
        [...name].filter((c, i) => c !== item[i]).length;

      if (dist < bestScore && dist <= 2) {
        bestScore = dist;
        best = item;
      }
    }

    return best;
  }
}

class Environment {
  constructor(parent = null) {
    this.store = Object.create(null);
    this.parent = parent;
  }

  has(name) {
    if (name in this.store) return true;
    if (this.parent) return this.parent.has(name);
    return false;
  }

 get(name, node, source) {
  if (name in this.store) return this.store[name];
  if (this.parent) return this.parent.get(name, node, source);

  throw new RuntimeError(`Undefined variable: "${name}"`, node, source, this);
}



  set(name, value) {
    if (name in this.store) { this.store[name] = value; return value; }
    if (this.parent && this.parent.has(name)) { return this.parent.set(name, value); }
    this.store[name] = value;
    return value;
  }

  define(name, value) {
    this.store[name] = value;
    return value;
  }
}

class Evaluator {
  constructor(source = '') {
    this.source = source;
    this.global = new Environment();
    this.exports = {};
    this.setupBuiltins();
  }
async callFunction(fn, args, env, node = null) {
  if (typeof fn === 'function') {
    const val = await fn(...args);
    return val === undefined ? null : val; // <<< enforce null
  }

  if (fn && typeof fn === 'object' && fn.body && fn.params) {
    const callEnv = new Environment(fn.env);

    for (let i = 0; i < fn.params.length; i++) {
      const param = fn.params[i];
      const name = typeof param === 'string' ? param : param.name;
      callEnv.define(name, args[i]);
    }

    try {
      const val = await this.evaluate(fn.body, callEnv);
      return val === undefined ? null : val; // <<< enforce null
    } catch (e) {
      if (e instanceof ReturnValue) return e.value === undefined ? null : e.value; // <<< enforce null
      throw e;
    }
  }

  throw new RuntimeError('Value is not callable', node, this.source);
}
createBaseProxy(instance, parentEntity) {
  const evaluator = this;

  return new Proxy({}, {
    get(_, prop) {
      const method = parentEntity.methods[prop];

      if (!method) {
        throw new RuntimeError(
          `Base method '${prop}' not found`,
          null,
          evaluator.source
        );
      }

      return async (...args) => {
        const methodEnv = new Environment(parentEntity.env);

        methodEnv.define('self', instance);

        if (parentEntity.parent) {
          methodEnv.define(
            'base',
            evaluator.createBaseProxy(instance, parentEntity.parent)
          );
        }

        for (let i = 0; i < method.params.length; i++) {
          methodEnv.define(method.params[i], args[i]);
        }

        return await evaluator.evaluate(method.body, methodEnv);
      };
    }
  });
}
formatValue(value, seen = new Set()) {
  // Local output color system (self-contained)
  const outputColor = {
    reset: '\x1b[0m',

    red: (s) => `\x1b[31m${s}${outputColor.reset}`,
    green: (s) => `\x1b[32m${s}${outputColor.reset}`,
    yellow: (s) => `\x1b[33m${s}${outputColor.reset}`,
    blue: (s) => `\x1b[34m${s}${outputColor.reset}`,
    magenta: (s) => `\x1b[35m${s}${outputColor.reset}`,
    cyan: (s) => `\x1b[36m${s}${outputColor.reset}`,
    white: (s) => `\x1b[37m${s}${outputColor.reset}`,
    brightBlack: (s) => `\x1b[90m${s}${outputColor.reset}`
  };

  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) return outputColor.red('[Circular]');
    seen.add(value);
  }

  if (value === null) return outputColor.yellow('None');
  if (value === undefined) return outputColor.brightBlack('undefined');

  const t = typeof value;

  if (t === 'string') {
  return outputColor.cyan(value);
}

  if (t === 'number') {
    return outputColor.green(String(value));
  }

  if (t === 'boolean') {
    return value
      ? outputColor.yellow('true')
      : outputColor.yellow('false');
  }

  if (t === 'function') {
    return outputColor.magenta(
      value.name ? `<function ${value.name}>` : '<function>'
    );
  }

 if (Array.isArray(value)) {
  const items = value.map(v => this.formatValue(v, seen));
  return (
    outputColor.white('[ ') +
    items.join(outputColor.white(', ')) +
    outputColor.white(' ]')
  );
}

  if (t === 'object') {
    if (value.params && value.body) {
      return outputColor.magenta(
        value.name ? `<function ${value.name}>` : '<function>'
      );
    }

    const entries = Object.entries(value).map(([k, v]) => {
      return (
        outputColor.cyan(`${k}`) +
        outputColor.white(': ') +
        this.formatValue(v, seen)
      );
    });

    return (
      outputColor.white('{ ') +
      entries.join(outputColor.white(', ')) +
      outputColor.white(' }')
    );
  }

  try {
    return String(value);
  } catch {
    return outputColor.red('[Unprintable]');
  }
}
  setupBuiltins() {
    const evaluator = this;
    this.global.define('len', arg => {
        if (Array.isArray(arg) || typeof arg === 'string') return arg.length;
        if (arg && typeof arg === 'object') return Object.keys(arg).length;
        return 0;
    });
this.global.define('lower', arg => {
    if (typeof arg !== 'string') return String(arg).toLowerCase();
    return arg.toLowerCase();
  });
this.global.define('toStr', arg => String(arg));

  this.global.define('upper', arg => {
    if (typeof arg !== 'string') return String(arg).toUpperCase();
    return arg.toUpperCase();
  });

  this.global.define('trim', arg => {
    if (typeof arg !== 'string') return String(arg).trim();
    return arg.trim();
  });

  this.global.define('startsWith', (str, prefix) => {
    if (typeof str !== 'string') str = String(str);
    if (typeof prefix !== 'string') prefix = String(prefix);
    return str.startsWith(prefix);
  });

  this.global.define('endsWith', (str, suffix) => {
    if (typeof str !== 'string') str = String(str);
    if (typeof suffix !== 'string') suffix = String(suffix);
    return str.endsWith(suffix);
  });

  this.global.define('includes', (str, substr) => {
    if (typeof str !== 'string') str = String(str);
    if (typeof substr !== 'string') substr = String(substr);
    return str.includes(substr);
  });

  this.global.define('repeat', (str, times) => {
    if (typeof str !== 'string') str = String(str);
    return str.repeat(Number(times) || 0);
  });
this.global.define("process", process);
  this.global.define('replace', (str, search, replacement) => {
    if (typeof str !== 'string') str = String(str);
    if (typeof search !== 'string') search = String(search);
    if (typeof replacement !== 'string') replacement = String(replacement);
    return str.split(search).join(replacement);
  });
    this.global.define('type', arg => {
        if (Array.isArray(arg)) return 'array';
        return typeof arg;
    });
this.global.define('isNaN', arg => {
  return typeof arg !== 'number' || Number.isNaN(arg);
});


this.global.define('random', (min, max) => {
  if (max === undefined) {
    return Math.floor(Math.random() * min);
  }
  min = Number(min);
  max = Number(max);
  if (isNaN(min) || isNaN(max)) return 0;
  return Math.floor(Math.random() * (max - min)) + min;
});
const renderTemplate = (htmlContent, data = {}) => {
  const inheritsMatch = htmlContent.match(/\{\{\s*extends\s+["'](.+?)["']\s*\}\}/);

if (inheritsMatch) {
    const layoutPath = path.isAbsolute(inheritsMatch[1])
        ? inheritsMatch[1]
        : path.join(process.cwd(), inheritsMatch[1]);

    try {
        const layoutContent = fs.readFileSync(layoutPath, "utf8");

        const cleanChildContent = htmlContent.replace(
            /\{\{\s*extends\s+["'](.+?)["']\s*\}\}/,
            ""
        );

        htmlContent = layoutContent.replace(
            /\{\{\s*body\s*\}\}/g,
            cleanChildContent
        );
    } catch (e) {
        throw new Error(`Template inheritance compilation failed: ${e.message}`);
    }
}

  return htmlContent.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, expression) => {
    const keys = expression.split('.');
    let value = data;
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return '';
      }
    }
    return value !== undefined && value !== null ? String(value) : '';
  });
};

this.global.define('render', (filePath, data = {}) => {
  try {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const content = fs.readFileSync(fullPath, 'utf-8');
    return renderTemplate(content, data);
  } catch (e) {
    throw new RuntimeError(`Render error: ${e.message}`, null, evaluator.source);
  }
});

this.global.define('defineModel', (modelName, schema = {}) => {
  const dbDirectory = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dbDirectory)) fs.mkdirSync(dbDirectory, { recursive: true });
  const storageFile = path.join(dbDirectory, `${modelName.toLowerCase()}.json`);
  
  const loadCollection = () => {
    if (!fs.existsSync(storageFile)) return [];
    try { return JSON.parse(fs.readFileSync(storageFile, 'utf-8')); } catch { return []; }
  };
  
  const saveCollection = (data) => {
    fs.writeFileSync(storageFile, JSON.stringify(data, null, 2), 'utf-8');
  };

  const validate = (record) => {
    for (const field in schema) {
      const rule = schema[field];
      const val = record[field];
      if (rule.required && (val === undefined || val === null || val === '')) {
        throw new Error(`Validation Error: '${field}' field is strictly required.`);
      }
      if (val !== undefined && val !== null && rule.type && typeof val !== rule.type) {
        throw new Error(`Validation Error: '${field}' must match data structure type '${rule.type}'.`);
      }
    }
  };

  return {
    create: (entryData = {}) => {
      const collection = loadCollection();
      const record = { id: crypto.randomUUID(), ...entryData, createdAt: Date.now() };
      validate(record);
      collection.push(record);
      saveCollection(collection);
      return record;
    },
    find: (filters = {}) => {
      const collection = loadCollection();
      return collection.filter(item => {
        for (const key in filters) {
          if (item[key] !== filters[key]) return false;
        }
        return true;
      });
    },
    findById: (id) => {
      return loadCollection().find(item => item.id === id) || null;
    },
    update: (id, updates = {}) => {
      const collection = loadCollection();
      const idx = collection.findIndex(item => item.id === id);
      if (idx === -1) throw new Error(`Document identifier '${id}' not found inside collection.`);
      const updatedRecord = { ...collection[idx], ...updates, updatedAt: Date.now() };
      validate(updatedRecord);
      collection[idx] = updatedRecord;
      saveCollection(collection);
      return updatedRecord;
    },
    delete: (id) => {
      const collection = loadCollection();
      const filtered = collection.filter(item => item.id !== id);
      saveCollection(filtered);
      return true;
    }
  };
});
this.global.define('createServer', (options = {}) => {
  const routes = { GET: [], POST: [], PUT: [], DELETE: [], PATCH: [], OPTIONS: [] };
  const globalMiddlewares = [];
  const sessionMemoryStore = {};
  
  const MIME_TYPES = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
    '.ogv': 'video/ogg', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.html': 'text/html', '.htm': 'text/html',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.xml': 'application/xml', '.pdf': 'application/pdf',
    '.zip': 'application/zip', '.txt': 'text/plain'
  };

  // Helper function for HTML escaping to protect against XSS by default
  const escapeHtml = (str) => {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  // Helper to resolve dot-notation paths (e.g., "user.name") from a data context
  const resolveValue = (data, pathStr) => {
    if (!pathStr) return undefined;
    const keys = pathStr.split('.');
    let val = data;
    for (const k of keys) {
      val = val !== null && val !== undefined ? val[k] : undefined;
    }
    return val;
  };

  // Formatter for template values supporting strings, numbers, booleans, arrays, objects, and JSON
  const formatValue = (val, isJsonExplicit = false, isRawHtml = false) => {
    if (val === undefined || val === null) return '';
    if (isJsonExplicit || typeof val === 'object' || Array.isArray(val)) {
      return JSON.stringify(val);
    }
    const strVal = String(val);
    return isRawHtml ? strVal : escapeHtml(strVal);
  };

  const renderTemplate = (filePath, data = {}) => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Template view not found at path: ${filePath}`);
    }
    let templateContent = fs.readFileSync(filePath, 'utf-8');

    // 1. Handle loops: {{each collectionName}}...{{this.prop}}...{{endeach}}
    const eachRegex = /\{\{\s*each\s+([a-zA-Z0-9_.-]+)\s*\}\}([\s\S]*?)\{\{\s*endeach\s*\}\}/g;
    templateContent = templateContent.replace(eachRegex, (match, collectionKey, loopBlock) => {
      const collection = resolveValue(data, collectionKey);
      if (!Array.isArray(collection) || collection.length === 0) return '';
      
      return collection.map(item => {
        let renderedItem = loopBlock;
        // Support `{{this}}`, `{{this.property}}`, or direct property lookup if item is an object
        const itemContext = (typeof item === 'object' && item !== null) ? { ...data, this: item, ...item } : { ...data, this: item };
        
        // Replace inner variables in the loop item
        renderedItem = renderedItem.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (m, key) => {
          const val = resolveValue(itemContext, key);
          return formatValue(val);
        });
        return renderedItem;
      }).join('');
    });

    // 2. Handle conditional blocks: {{if condition}}...{{else}}...{{endif}}
    const ifRegex = /\{\{\s*if\s+([a-zA-Z0-9_.-]+)\s*\}\}([\s\S]*?)(?:\{\{\s*else\s*\}\}([\s\S]*?))?\{\{\s*endif\s*\}\}/g;
    templateContent = templateContent.replace(ifRegex, (match, conditionKey, trueBlock, falseBlock = '') => {
      const val = resolveValue(data, conditionKey);
      const isTruthy = Boolean(val) && (Array.isArray(val) ? val.length > 0 : true);
      return isTruthy ? trueBlock : falseBlock;
    });

    // 3. Handle standard errors array/string template injection
    let errorsHtml = '';
    if (data.errors) {
      if (Array.isArray(data.errors)) {
        errorsHtml = data.errors.map(err => `<div class="error-item">${escapeHtml(err)}</div>`).join('');
      } else if (typeof data.errors === 'string' && data.errors.trim() !== '') {
        errorsHtml = `<div class="error-item">${escapeHtml(data.errors)}</div>`;
      }
    }
    templateContent = templateContent.replace(/\{\{\s*errors\s*\}\}/g, errorsHtml);

    // 4. Handle explicit JSON directives: {{json messages}} or {{json user}}
    const jsonRegex = /\{\{\s*json\s+([a-zA-Z0-9_.-]+)\s*\}\}/g;
    templateContent = templateContent.replace(jsonRegex, (match, key) => {
      const val = resolveValue(data, key);
      return formatValue(val, true);
    });

    // 5. Handle raw HTML output without escaping: {{{html}}}
    const rawHtmlRegex = /\{\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}\}/g;
    templateContent = templateContent.replace(rawHtmlRegex, (match, key) => {
      const val = resolveValue(data, key);
      return formatValue(val, false, true);
    });

    // 6. Handle standard variable tags: {{username}}, {{messages}} (auto-serialized if object/array)
    const varRegex = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
    templateContent = templateContent.replace(varRegex, (match, key) => {
      const val = resolveValue(data, key);
      return formatValue(val);
    });

    return templateContent;
  };

  const dbConfig = options.database || {};
  const databaseDriver = {
    type: dbConfig.type || 'local',
    connectionString: dbConfig.url || null,
    query: async (queryStr, params = []) => {
      if (typeof dbConfig.query === 'function') {
        return await dbConfig.query(queryStr, params);
      }
      if (dbConfig.url && dbConfig.url.startsWith('http')) {
        const res = await fetch(dbConfig.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(dbConfig.headers || {}) },
          body: JSON.stringify({ query: queryStr, params })
        });
        return await res.json();
      }
      throw new Error('No database driver or query handler configured.');
    }
  };

  const storageEngine = {
    saveLocal: async (fileObject, destinationPath) => {
      const dir = path.dirname(destinationPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await fs.promises.writeFile(destinationPath, fileObject.buffer);
      return { path: destinationPath, size: fileObject.buffer.length };
    },
    uploadToUrl: async (fileObject, targetUrl, options = {}) => {
      const response = await fetch(targetUrl, {
        method: options.method || 'PUT',
        headers: { 'Content-Type': fileObject.mimetype || 'application/octet-stream', ...(options.headers || {}) },
        body: fileObject.buffer
      });
      return { status: response.status, statusText: response.statusText, ok: response.ok };
    },
    readLocal: async (filePath) => {
      return await fs.promises.readFile(filePath);
    }
  };

  const registerRoute = (method, pathPattern, handler, routeMiddlewares = []) => {
    const m = method.toUpperCase();
    if (!routes[m]) routes[m] = [];
    const paramNames = [];
    const regexPattern = '^' + pathPattern
      .replace(/:([a-zA-Z0-9_]+)/g, (_, paramName) => {
        paramNames.push(paramName);
        return '([^/]+)';
      })
      .replace(/\//g, '\\/') + '\\/?$';

    routes[m].push({
      pattern: new RegExp(regexPattern),
      paramNames: paramNames,
      middlewares: routeMiddlewares,
      handler: handler
    });
  };

  const requestHandler = async (req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`); 
    const pathname = decodeURIComponent(urlObj.pathname);  
    const method = req.method.toUpperCase(); 
     
    if (options.cors) { 
      const origin = options.cors.origin || '*'; 
      const methods = options.cors.methods || 'GET,POST,PUT,DELETE,PATCH,OPTIONS'; 
      const headers = options.cors.headers || 'Content-Type, Authorization'; 
       
      res.setHeader('Access-Control-Allow-Origin', origin); 
      res.setHeader('Access-Control-Allow-Methods', methods); 
      res.setHeader('Access-Control-Allow-Headers', headers); 

      if (method === 'OPTIONS') { 
        res.writeHead(204); 
        return res.end(); 
      } 
    } 

    if (options.staticDir && method === 'GET') { 
      const staticPath = path.join(options.staticDir, pathname); 
      if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) { 
        const ext = path.extname(staticPath).toLowerCase(); 
        const contentType = MIME_TYPES[ext] || 'application/octet-stream'; 
        const stat = fs.statSync(staticPath); 
        const fileSize = stat.size; 
        const range = req.headers.range; 

        if (range) { 
          const parts = range.replace(/bytes=/, "").split("-"); 
          const start = parseInt(parts[0], 10); 
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1; 
          const chunksize = (end - start) + 1; 
          const file = fs.createReadStream(staticPath, { start, end }); 

          res.writeHead(206, { 
            'Content-Range': `bytes ${start}-${end}/${fileSize}`, 
            'Accept-Ranges': 'bytes', 
            'Content-Length': chunksize, 
            'Content-Type': contentType, 
          }); 
          return file.pipe(res); 
        } else { 
          res.writeHead(200, { 
            'Content-Length': fileSize, 
            'Content-Type': contentType 
          }); 
          return fs.createReadStream(staticPath).pipe(res); 
        } 
      } 
    } 

    let matchedRoute = null; 
    let pathParams = {}; 

    if (routes[method]) { 
      for (const route of routes[method]) { 
        const match = pathname.match(route.pattern); 
        if (match) { 
          matchedRoute = route; 
          route.paramNames.forEach((name, index) => { 
            pathParams[name] = decodeURIComponent(match[index + 1]); 
          }); 
          break; 
        } 
      } 
    } 

    if (!matchedRoute) { 
      res.writeHead(404, { 'Content-Type': 'text/plain' }); 
      return res.end('404 Not Found'); 
    } 

    const rawCookies = req.headers.cookie || ''; 
    const cookies = {}; 
    rawCookies.split(';').forEach(cookie => { 
      const parts = cookie.split('='); 
      if (parts.length >= 2) cookies[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim()); 
    }); 

    let sessionId = cookies['LOPO_SESSID']; 
    if (!sessionId || !sessionMemoryStore[sessionId]) { 
      sessionId = crypto.randomBytes(16).toString('hex'); 
      sessionMemoryStore[sessionId] = { createdAt: Date.now() }; 
    } 
    const session = sessionMemoryStore[sessionId]; 

    const query = {}; 
    for (const [key, val] of urlObj.searchParams.entries()) { 
      query[decodeURIComponent(key)] = decodeURIComponent(val); 
    } 

    let body = {}; 
    let files = {}; 
    const contentType = req.headers['content-type'] || ''; 
     
    if (contentType.includes('multipart/form-data')) { 
      await new Promise((resolve) => { 
        let buffer = Buffer.alloc(0); 
        req.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); }); 
        req.on('end', () => { 
          const boundaryMatch = contentType.match(/boundary=(.+)$/); 
          if (boundaryMatch) { 
            const boundary = '--' + boundaryMatch[1].replace(/^["']|["']$/g, '').trim(); 
            const parts = buffer.toString('binary').split(boundary); 
             
            body = {}; 
            files = {}; 

            for (const part of parts) { 
              if (!part || part === '--\r\n' || part === '--') continue; 

              const headerBodySplit = part.split('\r\n\r\n'); 
              if (headerBodySplit.length < 2) continue; 

              const headers = headerBodySplit[0]; 
              let content = headerBodySplit.slice(1).join('\r\n\r\n'); 
              // Safer removal of trailing boundary newlines
              content = content.replace(/\r\n$/, ''); 

              const nameMatch = headers.match(/name="([^"]+)"/); 
              const filenameMatch = headers.match(/filename="([^"]+)"/); 
              const mimeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i); 

              if (nameMatch) { 
                const fieldName = nameMatch[1]; 

                if (filenameMatch && filenameMatch[1] !== '') { 
                  const filename = filenameMatch[1]; 
                  const ext = path.extname(filename).toLowerCase(); 
                  const detectedMime = mimeMatch ? mimeMatch[1].trim() : (MIME_TYPES[ext] || 'application/octet-stream'); 

                  files[fieldName] = { 
                    filename: filename, 
                    mimetype: detectedMime, 
                    buffer: Buffer.from(content, 'binary'), 
                    size: Buffer.byteLength(content, 'binary') 
                  }; 
                } else { 
                  body[fieldName] = Buffer.from(content, 'binary').toString('utf-8'); 
                } 
              } 
            } 
          } 
          resolve(); 
        }); 
      }); 
    } else { 
      let rawBody = ''; 
      await new Promise((resolve) => { 
        req.on('data', chunk => { rawBody += chunk; }); 
        req.on('end', resolve); 
      }); 

      if (rawBody) { 
        if (contentType.includes('application/json')) { 
          try { body = JSON.parse(rawBody); } catch { body = rawBody; } 
        } else if (contentType.includes('application/x-www-form-urlencoded')) { 
          const params = new URLSearchParams(rawBody); 
          const parsedForm = {}; 
          for (const [key, val] of params.entries()) { 
            parsedForm[key] = val; 
          } 
          body = parsedForm; 
        } else { 
          body = rawBody; 
        } 
      } 
    } 

    const customReq = { 
      path: pathname, 
      method: method, 
      params: pathParams,  
      query: query,        
      body: body, 
      files: files, 
      cookies: cookies, 
      session: session, 
      headers: req.headers, 
      storage: storageEngine, 
      db: databaseDriver 
    }; 

    const outboundCookiesQueue = []; 
    const customRes = { 
      setCookie: function (name, value, opts = {}) { 
        let str = `${name}=${encodeURIComponent(value)}`; 
        if (opts.maxAge) str += `; Max-Age=${opts.maxAge}`; 
        if (opts.httpOnly) str += '; HttpOnly'; 
        if (opts.path) str += `; Path=${opts.path}`; 
        if (opts.secure) str += '; Secure'; 
        if (opts.sameSite) str += `; SameSite=${opts.sameSite}`; 
        outboundCookiesQueue.push(str); 
      }, 
      clearCookie: function (name) { 
        outboundCookiesQueue.push(`${name}=; Max-Age=0; Path=/`); 
      }, 
      status: function (code) { 
        res.statusCode = code; 
        return this; 
      }, 
      json: function (payload) { 
        res.writeHead(res.statusCode || 200, { 'Content-Type': 'application/json' }); 
        res.end(JSON.stringify(payload)); 
      }, 
      send: function (data) { 
        res.writeHead(res.statusCode || 200, { 'Content-Type': 'text/html; charset=utf-8' }); 
        res.end(String(data ?? '')); 
      }, 
      render: function (viewPath, data) { 
        const viewData = data || {}; 
        const absolutePath = path.resolve(options.viewsDir || '.', viewPath); 
        return renderTemplate(absolutePath, viewData); 
      } 
    }; 

    const combinedChainStack = [...globalMiddlewares, ...matchedRoute.middlewares]; 
    let activeChainIndex = 0; 

    const pipelineStepRunner = async () => { 
      if (activeChainIndex < combinedChainStack.length) { 
        const nextMiddleware = combinedChainStack[activeChainIndex++]; 
        let advancedFlag = false; 
        const nextCallbackTrigger = () => { advancedFlag = true; }; 
        await evaluator.callFunction(nextMiddleware, [customReq, customRes, nextCallbackTrigger], evaluator.global); 
         
        if (advancedFlag) { 
          await pipelineStepRunner(); 
        } else { 
          if (!res.writableEnded) { 
            res.writeHead(400, { 'Content-Type': 'text/plain' }); 
            res.end('Request terminated early by system middleware controls.'); 
          } 
        } 
      } else { 
        try { 
          const responseOutput = await evaluator.callFunction(matchedRoute.handler, [customReq, customRes], evaluator.global); 
          if (res.writableEnded) return; 
          customRes.setCookie('LOPO_SESSID', sessionId, { httpOnly: true, path: '/' }); 

          if (outboundCookiesQueue.length > 0) { 
            res.setHeader('Set-Cookie', outboundCookiesQueue); 
          } 

          if (typeof responseOutput === 'object' && responseOutput !== null) { 
            res.writeHead(res.statusCode || 200, { 'Content-Type': 'application/json' }); 
            res.end(JSON.stringify(responseOutput)); 
          } else if (responseOutput !== undefined) { 
            res.writeHead(res.statusCode || 200, { 'Content-Type': 'text/html; charset=utf-8' }); 
            res.end(String(responseOutput ?? '')); 
          } 
        } catch (err) { 
          if (!res.writableEnded) { 
            res.writeHead(500, { 'Content-Type': 'text/plain' }); 
            res.end(`Internal Server Error Diagnostics: ${err.message}`); 
          } 
        } 
      } 
    }; 

    await pipelineStepRunner(); 
  }; 

  const nodeServer = (options.key && options.cert)  
    ? https.createServer({ key: fs.readFileSync(options.key), cert: fs.readFileSync(options.cert) }, requestHandler) 
    : http.createServer(requestHandler); 

  let wsServerInstance = null; 
  if (options.enableWebSockets) { 
    wsServerInstance = new WebSocketServer({ noServer: true }); 
     
    nodeServer.on('upgrade', (request, socket, head) => { 
      wsServerInstance.handleUpgrade(request, socket, head, (ws) => { 
        wsServerInstance.emit('connection', ws, request); 
      }); 
    }); 
  } 

  return { 
    use: (middlewareFn) => { globalMiddlewares.push(middlewareFn); return null; }, 
    get: (path, ...args) => { 
      const handler = args.pop(); 
      registerRoute('GET', path, handler, args); 
      return null; 
    }, 
    post: (path, ...args) => { 
      const handler = args.pop(); 
      registerRoute('POST', path, handler, args); 
      return null; 
    }, 
    put: (path, ...args) => { 
      const handler = args.pop(); 
      registerRoute('PUT', path, handler, args); 
      return null; 
    }, 
    patch: (path, ...args) => { 
      const handler = args.pop(); 
      registerRoute('PATCH', path, handler, args); 
      return null; 
    }, 
    delete: (path, ...args) => { 
      const handler = args.pop(); 
      registerRoute('DELETE', path, handler, args); 
      return null; 
    }, 
    options: (path, ...args) => { 
      const handler = args.pop(); 
      registerRoute('OPTIONS', path, handler, args); 
      return null; 
    }, 
    onWebSocket: (connectionCallback) => { 
      if (!wsServerInstance) return null; 
      wsServerInstance.on('connection', (ws, req) => { 
        const customWsObject = { 
          send: (msg) => ws.send(typeof msg === 'object' ? JSON.stringify(msg) : String(msg)), 
          onMessage: (msgCallback) => ws.on('message', (data) => evaluator.callFunction(msgCallback, [data.toString()], evaluator.global)), 
          onClose: (closeCallback) => ws.on('close', () => evaluator.callFunction(closeCallback, [], evaluator.global)) 
        }; 
        evaluator.callFunction(connectionCallback, [customWsObject, req], evaluator.global); 
      }); 
      return null; 
    }, 
    listen: (port, callback) => { 
      nodeServer.listen(port, () => { 
        if (callback) evaluator.callFunction(callback, [port], evaluator.global); 
      }); 
      return null; 
    } 
  }; 
});
this.global.define('JSONParse', arg => {
        if (typeof arg !== 'string') {
            throw new RuntimeError('JSONParse expects a string', null, evaluator.source);
        }
        try {
            return JSON.parse(arg);
        } catch (e) {
            throw new RuntimeError('Invalid JSON string: ' + e.message, null, evaluator.source);
        }
    });

    this.global.define('JSONStringify', arg => {
        try {
            return JSON.stringify(arg);
        } catch (e) {
            throw new RuntimeError('Cannot stringify value: ' + e.message, null, evaluator.source);
        }
    });
   this.global.define('map', async (array, fn) => {
    if (!Array.isArray(array)) {
      throw new RuntimeError('map() expects an array', null, evaluator.source);
    }

    const result = [];
    for (let i = 0; i < array.length; i++) {
      result.push(
        await evaluator.callFunction(
          fn,
          [array[i], i, array],
          evaluator.global
        )
      );
    }
    return result;
  });
this.global.define('encodeURLComponent', arg => {
    if (arg === null || arg === undefined) return '';
    return encodeURIComponent(String(arg));
});
this.global.define('httpFetch', async (url, options = {}) => {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const method = (options.method || 'GET').toUpperCase();
      const headers = options.headers || {};
      
      if (!headers['User-Agent']) {
        headers['User-Agent'] = 'LopoLangBot/1.0 (contact: admin@lopo.org) NodeJs/BuiltInClient';
      }

      let bodyData = '';
      if (options.body) {
        if (typeof options.body === 'object') {
          bodyData = JSON.stringify(options.body);
          if (!headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
          }
        } else {
          bodyData = String(options.body);
        }
        headers['Content-Length'] = Buffer.byteLength(bodyData);
      }

      const reqOptions = {
        method: method,
        headers: headers,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search
      };

      const request = client.request(reqOptions, (response) => {
        let responseData = '';
        response.on('data', (chunk) => { responseData += chunk; });
        response.on('end', () => {
          let parsedBody = responseData;
          if (response.headers['content-type']?.includes('application/json')) {
            try { parsedBody = JSON.parse(responseData); } catch {}
          }

          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: parsedBody
          });
        });
      });

      request.on('error', (err) => {
        reject(new RuntimeError(`httpFetch Error: ${err.message}`, null, evaluator.source));
      });

      if (bodyData) {
        request.write(bodyData);
      }
      request.end();

    } catch (e) {
      reject(new RuntimeError(`Invalid URL string provided to httpFetch: ${e.message}`, null, evaluator.source));
    }
  });
});
this.global.define("Date", Date);
this.global.define("Math", Math);
this.global.define("String", String);
  this.global.define('filter', async (array, fn) => {
    if (!Array.isArray(array)) {
      throw new RuntimeError('filter() expects an array', null, evaluator.source);
    }

    const result = [];
    for (let i = 0; i < array.length; i++) {
      if (
        await evaluator.callFunction(
          fn,
          [array[i], i, array],
          evaluator.global
        )
      ) {
        result.push(array[i]);
      }
    }
    return result;
  });

  this.global.define('reduce', async (array, fn, initial) => {
    if (!Array.isArray(array)) {
      throw new RuntimeError('reduce() expects an array', null, evaluator.source);
    }

    let acc;
    let i = 0;

    if (initial !== undefined) {
      acc = initial;
    } else {
      if (array.length === 0) {
        throw new RuntimeError(
          'reduce() of empty array with no initial value',
          null,
          evaluator.source
        );
      }
      acc = array[0];
      i = 1;
    }

    for (; i < array.length; i++) {
      acc = await evaluator.callFunction(
        fn,
        [acc, array[i], i, array],
        evaluator.global
      );
    }

    return acc;
  });
this.global.define('hasOwn', (obj, prop) => {
  return Object.prototype.hasOwnProperty.call(obj, prop)
});

    this.global.define('keys', arg => arg && typeof arg === 'object' ? Object.keys(arg) : []);
    this.global.define('values', arg => arg && typeof arg === 'object' ? Object.values(arg) : []);
this.global.define('range', (...args) => {
  let start = 0;
  let end = 0;
  let step = 1;

  if (args.length === 1) {
    end = Number(args[0]);
  } else if (args.length === 2) {
    start = Number(args[0]);
    end = Number(args[1]);
  } else if (args.length === 3) {
    start = Number(args[0]);
    end = Number(args[1]);
    step = Number(args[2]);
  } else {
    throw new RuntimeError('range() expects 1 to 3 arguments', null, this.source);
  }

  if (step === 0) {
    throw new RuntimeError('range() step cannot be 0', null, this.source);
  }

  const result = [];
  if (step > 0) {
    for (let i = start; i < end; i += step) {
      result.push(i);
    }
  } else {
    for (let i = start; i > end; i += step) {
      result.push(i);
    }
  }

  return result;
});
this.global.define('floor', arg => Math.floor(Number(arg)));
this.global.define('ceil', arg => Math.ceil(Number(arg)));
this.global.define('round', arg => Math.round(Number(arg)));
this.global.define('abs', arg => Math.abs(Number(arg)));
this.global.define('pow', (base, exp) => Math.pow(Number(base), Number(exp)));
this.global.define('sqrt', arg => Math.sqrt(Number(arg)));
this.global.define('min', (...args) => Math.min(...args.map(Number)));
this.global.define('max', (...args) => Math.max(...args.map(Number)));
this.global.define('randomFloat', (min, max) => {
    min = Number(min); max = Number(max);
    if (isNaN(min) || isNaN(max)) return 0;
    return Math.random() * (max - min) + min;
});

this.global.define('push', (arr, val) => {
    if (!Array.isArray(arr)) throw new RuntimeError('push() expects an array', null, this.source);
    arr.push(val); return arr.length;
});
this.global.define('pop', arr => {
    if (!Array.isArray(arr)) throw new RuntimeError('pop() expects an array', null, this.source);
    return arr.pop();
});
this.global.define('shift', arr => {
    if (!Array.isArray(arr)) throw new RuntimeError('shift() expects an array', null, this.source);
    return arr.shift();
});
this.global.define('unshift', (arr, val) => {
    if (!Array.isArray(arr)) throw new RuntimeError('unshift() expects an array', null, this.source);
    arr.unshift(val); return arr.length;
});
this.global.define('sort', (arr, fn) => {
    if (!Array.isArray(arr)) throw new RuntimeError('sort() expects an array', null, this.source);
    if (fn && typeof fn === 'function') return arr.sort(fn);
    return arr.sort();
});
this.global.define('reverse', arr => {
    if (!Array.isArray(arr)) throw new RuntimeError('reverse() expects an array', null, this.source);
    return arr.reverse();
});

this.global.define('has', (obj, key) => obj && typeof obj === 'object' ? obj.hasOwnProperty(key) : false);
this.global.define('merge', (obj1, obj2) => {
    if (!obj1 || typeof obj1 !== 'object') obj1 = {};
    if (!obj2 || typeof obj2 !== 'object') obj2 = {};
    return { ...obj1, ...obj2 };
});

this.global.define('uuid', () => {
    // simple random UUID v4
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
});
this.global.define('timestamp', () => Date.now());
this.global.define('clone', arg => {
    if (Array.isArray(arg)) return [...arg];
    if (arg && typeof arg === 'object') return { ...arg };
    return arg; // primitive types
});
this.global.define('typeOf', arg => {
    if (arg === null) return 'null';
    if (Array.isArray(arg)) return 'array';
    return typeof arg;
});

    this.global.define('ask', prompt => {
        const readlineSync = require('readline-sync');
        return readlineSync.question(prompt + ' ');
    });
    this.global.define('num', arg => {
    if (arg === null || arg === undefined) return 0;

    const t = typeof arg;

    if (t === 'number') return arg;       // already a number
    if (t === 'boolean') return arg ? 1 : 0;
    if (t === 'string') {
        const n = Number(arg);
        if (!Number.isNaN(n)) return n;  // numeric string
        return 0;                        // non-numeric string becomes 0
    }
    if (Array.isArray(arg)) return arg.length;   // array → length
    if (t === 'object') return Object.keys(arg).length; // object → number of keys

    // fallback for anything else
    const n = Number(arg);
    if (!Number.isNaN(n)) return n;
    return 0;
});

this.global.define('fetch', async (url, options = {}) => {
  const res = await fetch(url, options);
  return {
    status: res.status,
    ok: res.ok,
    text: async () => await res.text(),
    json: async () => await res.json()
  };
});

this.global.define('get', async (url) => {
  const res = await fetch(url);
  return await res.json();
});

this.global.define('post', async (url, data) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return await res.json();
});

this.global.define('sleep', async (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
});
this.global.define('str', arg => {
    return String(arg);
});
this.global.define('now', () => Date.now()); 
this.global.define('formatDate', (timestamp, locale = 'en-US', options = {}) => {
  if (timestamp === null || timestamp === undefined) timestamp = Date.now();
  const t = typeof timestamp === 'number' ? timestamp : Number(timestamp);
  if (isNaN(t)) t = Date.now();
  return new Date(t).toLocaleString(locale, options);
});

this.global.define('readFile', path => {
  if (typeof path !== 'string') path = String(path);
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch (e) {
    throw new RuntimeError('readFile error: ' + e.message, null, this.source);
  }
});
this.global.define('writeFile', (path, content) => {
  if (typeof path !== 'string') path = String(path);
  if (typeof content !== 'string') content = String(content);
  try {
    fs.writeFileSync(path, content, 'utf-8');
    return true;
  } catch (e) {
    throw new RuntimeError('writeFile error: ' + e.message, null, this.source);
  }
});

this.global.define('split', (str, separator) => {
  if (typeof str !== 'string') str = String(str);
  if (separator === undefined) separator = '';
  return str.split(separator);
});

this.global.define('join', (arr, separator = '') => {
  if (!Array.isArray(arr)) throw new RuntimeError('join() expects an array', null, this.source);
  return arr.join(separator);
});

this.global.define('substring', (str, start, end) => {
  if (typeof str !== 'string') str = String(str);
  start = Number(start) || 0;
  end = end !== undefined ? Number(end) : undefined;
  return str.substring(start, end);
});

this.global.define('padStart', (str, targetLength, padString = ' ') => {
  if (typeof str !== 'string') str = String(str);
  targetLength = Number(targetLength) || 0;
  return str.padStart(targetLength, padString);
});

this.global.define('padEnd', (str, targetLength, padString = ' ') => {
  if (typeof str !== 'string') str = String(str);
  targetLength = Number(targetLength) || 0;
  return str.padEnd(targetLength, padString);
});
this.global.define('unique', arr => {
    if (!Array.isArray(arr)) throw new RuntimeError('unique() expects an array', null, this.source);
    return [...new Set(arr)];
});

this.global.define('indexOf', (arr, val) => {
    if (!Array.isArray(arr)) throw new RuntimeError('indexOf() expects an array', null, this.source);
    return arr.indexOf(val);
});

this.global.define('includesArr', (arr, val) => {
    if (!Array.isArray(arr)) throw new RuntimeError('includesArr() expects an array', null, this.source);
    return arr.includes(val);
});

this.global.define('flatten', arr => {
    if (!Array.isArray(arr)) throw new RuntimeError('flatten() expects an array', null, this.source);
    return arr.flat(Infinity);
});

this.global.define('randomChoice', arr => {
    if (!Array.isArray(arr)) throw new RuntimeError('randomChoice() expects an array', null, this.source);
    return arr[Math.floor(Math.random() * arr.length)];
});

this.global.define('entries', obj => {
    if (!obj || typeof obj !== 'object') throw new RuntimeError('entries() expects an object', null, this.source);
    return Object.entries(obj);
});

this.global.define('invert', obj => {
    if (!obj || typeof obj !== 'object') throw new RuntimeError('invert() expects an object', null, this.source);
    const result = {};
    for (const key in obj) result[obj[key]] = key;
    return result;
});

this.global.define('isEmpty', arg => {
    if (arg == null) return true;
    if (Array.isArray(arg) || typeof arg === 'string') return arg.length === 0;
    if (typeof arg === 'object') return Object.keys(arg).length === 0;
    return false;
});

this.global.define('deepClone', arg => {
    return JSON.parse(JSON.stringify(arg));
});

this.global.define('capitalize', str => {
    if (typeof str !== 'string') str = String(str);
    if (str.length === 0) return '';
    return str[0].toUpperCase() + str.slice(1);
});

this.global.define('reverseStr', str => {
    if (typeof str !== 'string') str = String(str);
    return str.split('').reverse().join('');
});

this.global.define('trimStart', str => {
    if (typeof str !== 'string') str = String(str);
    return str.trimStart();
});

this.global.define('trimEnd', str => {
    if (typeof str !== 'string') str = String(str);
    return str.trimEnd();
});

this.global.define('clamp', (value, min, max) => {
    value = Number(value); min = Number(min); max = Number(max);
    return Math.min(Math.max(value, min), max);
});

this.global.define('sign', value => {
    value = Number(value);
    return Math.sign(value);
});
this.global.define('parseJson', arg => {
    if (typeof arg !== 'string') {
        throw new RuntimeError('parseJson expects a string', null, evaluator.source);
    }
    
    // Fix: Handle empty or whitespace-only strings gracefully by returning an empty object/array
    if (!arg || arg.trim() === '') {
        return {}; 
    }

    try {
        return JSON.parse(arg);
    } catch (e) {
        throw new RuntimeError('Invalid JSON string: ' + e.message, null, evaluator.source);
    }
});
this.global.define('appendFile', (path, content) => {
    if (typeof path !== 'string') path = String(path);
    if (typeof content !== 'string') content = String(content);
    try {
        fs.appendFileSync(path, content, 'utf-8');
        return true;
    } catch (e) {
        throw new RuntimeError('appendFile error: ' + e.message, null, this.source);
    }
});

this.global.define('exists', path => {
    if (typeof path !== 'string') path = String(path);
    return fs.existsSync(path);
});

this.global.define('mkdir', path => {
    if (typeof path !== 'string') path = String(path);
    if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true });
    return true;
});
this.global.define('count', (arr, value) => {
    if (!Array.isArray(arr)) throw new RuntimeError('count() expects an array', null, this.source);
    return arr.filter(x => x === value).length;
});

this.global.define('uniqueBy', (arr, fn) => {
    if (!Array.isArray(arr)) throw new RuntimeError('uniqueBy() expects an array', null, this.source);
    const seen = new Set();
    const result = [];
    for (const item of arr) {
        const key = fn ? fn(item) : item;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(item);
        }
    }
    return result;
});
this.global.define('getIp', () => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
});

this.global.define('pingHost', async (host, port = 80, timeout = 2000) => {
  const net = require('net');
  const targetHost = String(host);
  const targetPort = parseInt(port, 10) || 80;
  
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let startTime = Date.now();

    socket.setTimeout(timeout);

    socket.connect(targetPort, targetHost, () => {
      const duration = Date.now() - startTime;
      socket.destroy();
      resolve({ online: true, time: duration, error: "" });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ online: false, time: -1, error: err.message });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ online: false, time: -1, error: "Connection timed out" });
    });
  });
});
this.global.define('delay', async (ms) => {
  const duration = typeof ms === 'number' ? ms : parseInt(ms, 10) || 0;
  return new Promise((resolve) => setTimeout(resolve, duration));
});
this.global.define('cryptoSign', (text, algorithm = 'sha256') => {
  try {
    
    return crypto.createHash(algorithm).update(String(text)).digest('hex');
  } catch (e) {
    throw new RuntimeError(`cryptoSign error: ${e.message}`, null, this.source);
  }
});
this.global.define('envGet', (key, fallback = null) => {
  if (typeof key !== 'string') key = String(key);
  return process.env[key] !== undefined ? process.env[key] : fallback;
});
this.global.define('getProp', (obj, key, defaultValue = null) => {
    if (!obj || typeof obj !== 'object') return defaultValue;
    const keys = key.split('.');
    let current = obj;
    for (const k of keys) {
        if (current[k] === undefined) return defaultValue;
        current = current[k];
    }
    return current;
});

this.global.define('setProp', (obj, key, value) => {
    if (!obj || typeof obj !== 'object') throw new RuntimeError('setProp() expects an object', null, this.source);
    const keys = key.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]] || typeof current[keys[i]] !== 'object') current[keys[i]] = {};
        current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
    return obj;
});

this.global.define('mergeDeep', (obj1, obj2) => {
    const isObject = val => val && typeof val === 'object';
    const result = {...obj1};
    for (const key in obj2) {
        if (isObject(obj2[key]) && isObject(result[key])) {
            result[key] = this.global.get('mergeDeep')(result[key], obj2[key]);
        } else {
            result[key] = obj2[key];
        }
    }
    return result;
});
this.global.define('camelCase', str => {
    if (typeof str !== 'string') str = String(str);
    return str
        .replace(/[-_ ]+./g, s => s.charAt(s.length - 1).toUpperCase())
        .replace(/^[A-Z]/, s => s.toLowerCase());
});

this.global.define('kebabCase', str => {
    if (typeof str !== 'string') str = String(str);
    return str
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/\s+/g, '-')
        .replace(/_+/g, '-')
        .toLowerCase();
});

this.global.define('repeatStr', (str, times) => {
    if (typeof str !== 'string') str = String(str);
    return str.repeat(Number(times) || 0);
});
this.global.define('randomInt', (min, max) => {
    min = Number(min); max = Number(max);
    if (isNaN(min) || isNaN(max)) return 0;
    return Math.floor(Math.random() * (max - min + 1)) + min;
});

this.global.define('lerp', (a, b, t) => {
    a = Number(a); b = Number(b); t = Number(t);
    return a + (b - a) * t;
});

this.global.define('degToRad', deg => Number(deg) * (Math.PI / 180));
this.global.define('radToDeg', rad => Number(rad) * (180 / Math.PI));
this.global.define('readJSON', path => {
    const content = this.global.get('readFile')(path);
    return JSON.parse(content);
});
this.global.define('fetchApi', async (url, method = 'GET', dataString = '') => {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const options = {
        method: method.toUpperCase(),
        headers: {
          'User-Agent': 'Lopo-Runtime-Engine',
          'Content-Type': 'application/json'
        }
      };

      if (options.method !== 'GET' && dataString) {
        options.headers['Content-Length'] = Buffer.byteLength(dataString);
      }

      const req = transport.request(url, options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: responseBody
          });
        });
      });
      req.on('error', (err) => {
        resolve({
          status: 0,
          headers: {},
          body: `Network Error: ${err.message}`
        });
      });

      req.setTimeout(10000, () => {
        req.destroy(new Error('Connection timed out'));
      });

      if (options.method !== 'GET' && dataString) {
        req.write(dataString);
      }
      req.end();
    } catch (e) {
      resolve({
        status: 0,
        headers: {},
        body: `Malformed execution parameter: ${e.message}`
      });
    }
  });
});

this.global.define('sha256', (text) => {
  try {
    return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
  } catch (e) {
    throw new Error(`Cryptographic hash calculation failed: ${e.message}`);
  }
});

this.global.define('getEnv', (key, fallback = '') => {
  const value = process.env[key];
  return value !== undefined ? value : fallback;
});
this.global.define('writeJSON', (path, obj) => {
    const content = JSON.stringify(obj, null, 2);
    return this.global.get('writeFile')(path, content);
});

this.global.define('deleteFile', path => {
    if (typeof path !== 'string') path = String(path);
    if (!fs.existsSync(path)) return false;
    fs.unlinkSync(path);
    return true;
});

this.global.define('rmdir', path => {
    if (typeof path !== 'string') path = String(path);
    if (!fs.existsSync(path)) return false;
    fs.rmSync(path, { recursive: true, force: true });
    return true;
});

}

async evaluate(node, env = this.global) {
if (node.type === 'UrlencodeExpression') {
    try {
        const targetString = await this.evaluate(node.value, env);
        return encodeURIComponent(String(targetString ?? ''));
    } catch (err) {
        if (err instanceof RuntimeError) throw err;
        throw new RuntimeError(
            err.message || 'Error executing urlencode parsing syntax',
            node,
            this.source,
            env
        );
    }
}
  switch (node.type) {
    case 'Program': return await this.evalProgram(node, env);
    case 'BlockStatement': return await this.evalBlock(node, new Environment(env));
    case 'VarDeclaration': return await this.evalVarDeclaration(node, env);
    case 'AssignmentExpression': return await this.evalAssignment(node, env);
    case 'CompoundAssignment': return await this.evalCompoundAssignment(node, env);
    case 'SldeployStatement': return await this.evalSldeploy(node, env);
    case 'AskStatement': return await this.evalAsk(node, env);
    case 'DefineStatement': return await this.evalDefine(node, env);
    case 'FunctionExpression':
  return this.evalFunctionExpression(node, env);
case 'SliceExpression':
  return await this.evalSlice(node, env);
case 'DeployStatement': {
      let decl = node.declaration;
      let name = null;
      let value = await this.evaluate(decl, env);

      if (decl.type === 'FunctionDeclaration') {
        name = decl.name;
        value = env.get(name, node, this.source);
      } else if (decl.type === 'VarDeclaration' || decl.type === 'DefineStatement') {
        name = decl.id;
        value = env.get(name, node, this.source);
      }

      if (name) {
        this.exports[name] = value;
      }
      return value;
    }

    case 'DeployNamedStatement': {
      for (const spec of node.specifiers) {
        this.exports[spec] = env.get(spec, node, this.source);
      }
      return this.exports;
    }
    case 'ExpressionStatement': return await this.evaluate(node.expression, env);
    case 'BinaryExpression': return await this.evalBinary(node, env);
    case 'LogicalExpression': return await this.evalLogical(node, env);
    case 'UnaryExpression': return await this.evalUnary(node, env);
    case 'ConditionalExpression':
  return await this.evalConditional(node, env);
    case 'Literal': return node.value;
    case 'Identifier': return env.get(node.name, node, this.source);
    case 'IfStatement': return await this.evalIf(node, env);
    case 'WhileStatement': return await this.evalWhile(node, env);
    case 'EntityDeclaration':
  return await this.evalEntity(node, env);

case 'EntityInstantiation':
  return await this.evalEntityNew(node, env);

case 'SelfExpression':
  return env.get('self', node, this.source);

case 'InitMethod':
  return node;
case 'InheritsClause':
  return await this.evalInherits(node, env);
    case 'ForStatement':
case 'ForInStatement':
  return await this.evalFor(node, env);
case 'DoTrackStatement':
  return await this.evalDoTrack(node, env);
case 'StartStatement':
  return await this.evalStartStatement(node, env);

case 'RaceClause':
  return await this.evalRaceClause(node, env);

    case 'BreakStatement': throw new BreakSignal();
    case 'ContinueStatement': throw new ContinueSignal();
    case 'ImportStatement': return await this.evalImport(node, env);
    case 'FunctionDeclaration': return this.evalFunctionDeclaration(node, env);
    case 'CallExpression': return await this.evalCall(node, env);
    case 'ArrowFunctionExpression': return this.evalArrowFunction(node, env);
    case 'ReturnStatement': {
      const val = node.argument ? await this.evaluate(node.argument, env) : null;
      throw new ReturnValue(val);
    }
   
    case 'ArrayExpression':
      return await Promise.all(node.elements.map(el => this.evaluate(el, env)));
    case 'IndexExpression': return await this.evalIndex(node, env);
    case 'ObjectExpression': return await this.evalObject(node, env);


    case 'MemberExpression': return await this.evalMember(node, env);
    case 'UpdateExpression': return await this.evalUpdate(node, env);
    case 'AwaitExpression': {
      const val = await this.evaluate(node.argument, env);
      return val;
    }
    case 'NewExpression': { 
  const callee = await this.evaluate(node.callee, env); 
 
  const args = []; 
  for (const a of node.arguments) { 
    args.push(await this.evaluate(a, env)); 
  } 
  
  if (callee && callee.methods) { 
    const instance = {}; 
  
    const evaluator = this; 
 
    const entityEnv = new Environment(callee.env); 
    entityEnv.define('self', instance); 
  
    if (callee.parent) { 
      entityEnv.define( 
        'base', 
        this.createBaseProxy(instance, callee.parent) 
      ); 
    } 
  
    if (callee.methods.init) { 
      const init = callee.methods.init; 
 
      for (let i = 0; i < init.params.length; i++) { 
        entityEnv.define(init.params[i], args[i]); 
      } 
 
      try { 
        await evaluator.evaluate(init.body, entityEnv); 
      } catch (e) { 
        if (e instanceof ReturnValue) { 
        } else { 
          throw e; 
        } 
      } 
    } 
  
    for (const key in callee.methods) { 
      if (key === 'init') continue; 
 
      instance[key] = async (...callArgs) => { 
        const methodEnv = new Environment(callee.env); 
 
        methodEnv.define('self', instance); 
 
        if (callee.parent) { 
          methodEnv.define( 
            'base', 
            evaluator.createBaseProxy(instance, callee.parent) 
          ); 
        } 
 
        for (let i = 0; i < callee.methods[key].params.length; i++) { 
          methodEnv.define( 
            callee.methods[key].params[i], 
            callArgs[i] 
          ); 
        } 
 
        try { 
          return await evaluator.evaluate( 
            callee.methods[key].body, 
            methodEnv 
          ); 
        } catch (e) { 
          if (e instanceof ReturnValue) { 
            return e.value === undefined ? null : e.value; 
          } 
          throw e; 
        } 
      }; 
    } 
 
    return instance; 
  } 
  
  if (typeof callee === 'object' && callee.body) { 
    const evaluator = this; 
 
    const Constructor = function (...args) { 
      const newEnv = new Environment(callee.env); 
      newEnv.define('this', this); 
 
      for (let i = 0; i < callee.params.length; i++) { 
        const param = callee.params[i]; 
        const paramName = 
          typeof param === 'string' ? param : param.name; 
 
        newEnv.define(paramName, args[i]); 
      } 
 
      return (async () => { 
        try { 
          await evaluator.evaluate(callee.body, newEnv); 
        } catch (e) { 
          if (e instanceof ReturnValue) { 
            return e.value === undefined ? null : e.value; 
          } 
          throw e; 
        } 
        return this; 
      })(); 
    }; 
 
    return await new Constructor(...args); 
  } 
  
  if (typeof callee !== 'function') { 
    throw new RuntimeError( 
      'NewExpression callee is not a function', 
      node, 
      this.source 
    ); 
  } 
 
  return new callee(...args); 
}
    default:
       throw new RuntimeError(`Unknown node type in evaluator: ${node.type}`, node, this.source);

  }
}
async evalInherits(node, env) {
  const parent = await this.evaluate(node.parent, env);

  if (!parent || !parent.methods) {
    throw new RuntimeError(
      'Invalid parent entity',
      node,
      this.source,
      env
    );
  }

  return parent;
}
async evalProgram(node, env) {
  let result = null;
  for (const stmt of node.body) {
    try {
      result = await this.evaluate(stmt, env);
    } catch (e) {
      // Re-throw known runtime control signals
      if (e instanceof RuntimeError || e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnValue) {
        throw e;
      }
      // Wrap unexpected errors with RuntimeError including env for suggestions
      throw new RuntimeError(
        e.message || 'Error in program',
        stmt,
        this.source,
        env
      );
    }
  }
  return result;
}
async evalEntity(node, env) {
  const entity = {
    name: node.name,
    methods: {},
    parent: null,
    env
  };

  if (node.inherits) {
    entity.parent = await this.evaluate(node.inherits, env);
  }

  for (const method of node.body) {
    entity.methods[method.name] = {
      params: method.params,
      body: method.body,
      env
    };
  }

  env.define(node.name, entity);
  return entity;
}
async evalSlice(node, env) {
  try {
    const arr = await this.evaluate(node.object, env);

    if (!Array.isArray(arr)) {
      throw new RuntimeError(
        'Slice target must be an array',
        node,
        this.source,
        env
      );
    }

    let start = node.start ? await this.evaluate(node.start, env) : 0;
    let end = node.end ? await this.evaluate(node.end, env) : arr.length;
    let step = node.step ? await this.evaluate(node.step, env) : 1;

    if (step === 0) {
      throw new RuntimeError(
        'Slice step cannot be zero',
        node,
        this.source,
        env
      );
    }
    start = start < 0 ? arr.length + start : start;
    end = end < 0 ? arr.length + end : end;

    start = Math.min(Math.max(start, 0), arr.length);
    end = Math.min(Math.max(end, 0), arr.length);

    const result = [];

    if (step > 0) {
      for (let i = start; i < end; i += step) {
        result.push(arr[i]);
      }
    } else {
      for (let i = start; i > end; i += step) {
        result.push(arr[i]);
      }
    }

    return result;

  } catch (err) {
    if (err instanceof RuntimeError) throw err;
    throw new RuntimeError(
      err.message || 'Error evaluating slice expression',
      node,
      this.source,
      env
    );
  }
}


async evalStartStatement(node, env) {
  try {
    const value = await this.evaluate(node.discriminant, env);
    let executing = false;

    for (const c of node.cases) {
      try {
        if (!executing) {
          const testValue = await this.evaluate(c.test, env);
          if (testValue === value) executing = true;
        }

        if (executing) {
          await this.evaluate(c.consequent, new Environment(env));
        }
      } catch (caseErr) {
        if (caseErr instanceof BreakSignal) break;
        if (caseErr instanceof RuntimeError ||
            caseErr instanceof ReturnValue ||
            caseErr instanceof ContinueSignal) {
          throw caseErr; // propagate signals
        }
        throw new RuntimeError(
          caseErr.message || 'Error evaluating case in start statement',
          c,
          this.source,
          env
        );
      }
    }

    return null;
  } catch (err) {
    if (err instanceof RuntimeError ||
        err instanceof ReturnValue ||
        err instanceof BreakSignal ||
        err instanceof ContinueSignal) {
      throw err;
    }
    throw new RuntimeError(
      err.message || 'Error evaluating start statement',
      node,
      this.source,
      env
    );
  }
}
async evalConditional(node, env) {
  try {
    const test = await this.evaluate(node.test, env);
    if (test) {
      return await this.evaluate(node.consequent, env);
    } else {
      return await this.evaluate(node.alternate, env);
    }
  } catch (e) {
    if (e instanceof RuntimeError) throw e;
    throw new RuntimeError(
      e.message || 'Error evaluating conditional expression',
      node,
      this.source,
      env
    );
  }
}

async evalRaceClause(node, env) {
  try {
    const testValue = await this.evaluate(node.test, env);
    const result = await this.evaluate(node.consequent, new Environment(env));
    return { testValue, result };
  } catch (err) {
    if (
      err instanceof RuntimeError ||
      err instanceof ReturnValue ||
      err instanceof BreakSignal ||
      err instanceof ContinueSignal
    ) {
      throw err; 
    }
    throw new RuntimeError(
      err.message || 'Error evaluating race clause',
      node,
      this.source,
      env
    );
  }
}

async evalDoTrack(node, env) {
  try {
    return await this.evaluate(node.body, env);
  } catch (err) {
    if (!node.handler) {
      if (err instanceof RuntimeError) throw err;
      throw new RuntimeError(
        err.message || 'Error in doTrack body',
        node.body,
        this.source,
        env
      );
    }

    const trackEnv = new Environment(env);
    trackEnv.define('error', err);

    try {
      return await this.evaluate(node.handler, trackEnv);
    } catch (handlerErr) {
      if (handlerErr instanceof RuntimeError) throw handlerErr;
      throw new RuntimeError(
        handlerErr.message || 'Error in doTrack handler',
        node.handler,
        this.source,
        trackEnv
      );
    }
  }
}
async evalImport(node, env) {
  const spec = node.path;
  let lib;

  const basePaths = [
    ...(require.main?.paths || []),
    process.cwd(),
    path.dirname(process.execPath),
    path.join(path.dirname(process.execPath), "node_modules"),
    __dirname
  ].filter(Boolean);

  const resolveNodeModule = () => {
    try {
      const resolved = require.resolve(spec, {
        paths: basePaths
      });
      return require(resolved);
    } catch {
      return null;
    }
  };

  const resolveLocalFile = async () => {
    let fullPath = path.isAbsolute(spec)
      ? spec
      : path.join(process.cwd(), spec);

    if (!fullPath.endsWith(".pulsar") && !fs.existsSync(fullPath)) {
      fullPath += ".pulsar";
    }

    if (!fs.existsSync(fullPath)) return null;

    const code = fs.readFileSync(fullPath, "utf-8");

    const tokens = new Lexer(code).getTokens();
    const ast = new Parser(tokens, code).parse(); 
    const moduleEvaluator = new Evaluator(code);
    const moduleEnv = moduleEvaluator.global; 
    await moduleEvaluator.evaluate(ast, moduleEnv);
    
    const exported = moduleEvaluator.exports || {};
    for (const key in moduleEnv.store) {
      if (!(key in exported)) {
        exported[key] = moduleEnv.store[key];
      }
    }

    return { default: exported, ...exported };
  };

  lib = resolveNodeModule() || (await resolveLocalFile());
  if (!lib) {
    throw new RuntimeError(
      `Import not found: ${spec}`,
      node,
      this.source,
      env
    );
  }

  for (const imp of node.specifiers) {
    if (imp.type === "DefaultImport") {
      env.define(imp.local, lib.default ?? lib);

    } else if (imp.type === "NamespaceImport") {
      env.define(imp.local, lib);

    } else if (imp.type === "NamedImport") {
      if (!(imp.imported in lib)) {
        throw new RuntimeError(
          `Module '${spec}' has no export '${imp.imported}'`,
          node,
          this.source,
          env
        );
      }

      env.define(imp.local, lib[imp.imported]);
    }
  }

  return null;
}
async evalBlock(node, env) {
  let result = null;
  for (const stmt of node.body) {
    try {
      result = await this.evaluate(stmt, env);
    } catch (e) {
      if (
        e instanceof RuntimeError ||
        e instanceof ReturnValue ||
        e instanceof BreakSignal ||
        e instanceof ContinueSignal
      ) {
        throw e; 
      }

      throw new RuntimeError(
        e.message || 'Error in block',
        stmt,
        this.source,
        env // pass env for suggestions
      );
    }
  }
  return result;
}

async evalVarDeclaration(node, env) {
  if (!node.expr) {
    throw new RuntimeError(
      'Variable declaration requires an initializer',
      node,
      this.source,
      env // pass env for suggestions
    );
  }

  try {
    const val = await this.evaluate(node.expr, env);
    return env.define(node.id, val);
  } catch (e) {
    if (e instanceof RuntimeError) throw e;
    throw new RuntimeError(
      e.message || 'Error evaluating variable declaration',
      node,
      this.source,
      env
    );
  }
}

evalArrowFunction(node, env) {
  if (!node.body) {
    throw new RuntimeError(
      'Arrow function missing body',
      node,
      this.source,
      env
    );
  }

  if (!Array.isArray(node.params)) {
    throw new RuntimeError(
      'Invalid arrow function parameters',
      node,
      this.source,
      env
    );
  }

  const evaluator = this;

  return async function (...args) {
    const localEnv = new Environment(env);

    node.params.forEach((p, i) => {
      const paramName = typeof p === 'string' ? p : p.name;
      localEnv.define(paramName, args[i]);
    });

    try {
      if (node.isBlock) {
        const result = await evaluator.evaluate(node.body, localEnv);
        return result === undefined ? null : result; 
      } else {
        const result = await evaluator.evaluate(node.body, localEnv);
        return result === undefined ? null : result; 
      }
    } catch (err) {
      if (err instanceof ReturnValue) return err.value === undefined ? null : err.value;
      if (err instanceof RuntimeError) throw err; // preserve RuntimeErrors
      throw new RuntimeError(
        err.message || 'Error evaluating arrow function',
        node,
        evaluator.source,
        localEnv
      );
    }
  };
}

async evalAssignment(node, env) {
  const rightVal = await this.evaluate(node.right, env);
  const left = node.left;

  try {
    if (left.type === 'Identifier') return env.set(left.name, rightVal);

    if (left.type === 'MemberExpression') {
      const obj = await this.evaluate(left.object, env);
      if (obj == null) throw new RuntimeError(
        'Cannot assign to null or undefined',
        node,
        this.source,
        env
      );
      obj[left.property] = rightVal; // dynamic creation allowed
      return rightVal;
    }

    if (left.type === 'IndexExpression') {
      const obj = await this.evaluate(left.object, env);
      const idx = await this.evaluate(left.indexer, env);
      if (obj == null) throw new RuntimeError(
        'Cannot assign to null or undefined',
        node,
        this.source,
        env
      );
      obj[idx] = rightVal; // dynamic creation allowed
      return rightVal;
    }

    throw new RuntimeError(
      'Invalid assignment target',
      node,
      this.source,
      env
    );

  } catch (e) {
    if (e instanceof RuntimeError) throw e;
    throw new RuntimeError(
      e.message || 'Error in assignment',
      node,
      this.source,
      env
    );
  }
}

async evalCompoundAssignment(node, env) {
  const left = node.left;
  let current;

  try {
    if (left.type === 'Identifier') current = env.get(left.name, left, this.source);
    else if (left.type === 'MemberExpression') current = await this.evalMember(left, env) ?? 0;
    else if (left.type === 'IndexExpression') current = await this.evalIndex(left, env) ?? 0;
    else throw new RuntimeError(
      'Invalid compound assignment target',
      node,
      this.source,
      env
    );

    const rhs = await this.evaluate(node.right, env);
    let computed;

    switch (node.operator) {
      case 'PLUSEQ': computed = current + rhs; break;
      case 'MINUSEQ': computed = current - rhs; break;
      case 'STAREQ': computed = current * rhs; break;
      case 'SLASHEQ': computed = current / rhs; break;
      case 'MODEQ': computed = current % rhs; break;
      default: throw new RuntimeError(
        `Unknown compound operator: ${node.operator}`,
        node,
        this.source,
        env
      );
    }

    if (left.type === 'Identifier') env.set(left.name, computed);
    else if (left.type === 'MemberExpression' || left.type === 'IndexExpression') {
      await this.evalAssignment(
        { left, right: { type: 'Literal', value: computed }, type: 'AssignmentExpression' },
        env
      );
    }

    return computed;

  } catch (e) {
    if (e instanceof RuntimeError) throw e;
    throw new RuntimeError(
      e.message || 'Error in compound assignment',
      node,
      this.source,
      env
    );
  }
}

async evalSldeploy(node, env) {
  const val = await this.evaluate(node.expr, env);
  console.log(this.formatValue(val));
  return val;
}


async evalAsk(node, env) {
  try {
    const prompt = await this.evaluate(node.prompt, env);

    if (typeof prompt !== 'string') {
      throw new RuntimeError('ask() prompt must be a string', node, this.source, env);
    }

    const input = readlineSync.question(prompt + ' ');
    return input;

  } catch (e) {
    if (e instanceof RuntimeError) throw e;
    throw new RuntimeError(
      e.message || 'Error evaluating ask()',
      node,
      this.source,
      env
    );
  }
}

async evalDefine(node, env) {
  try {
    if (!node.id || typeof node.id !== 'string') {
      throw new RuntimeError('Invalid identifier in define statement', node, this.source, env);
    }

    const val = node.expr ? await this.evaluate(node.expr, env) : null;
    return env.define(node.id, val);

  } catch (e) {
    if (e instanceof RuntimeError) throw e;
    throw new RuntimeError(
      e.message || 'Error in define statement',
      node,
      this.source,
      env
    );
  }
}

async evalBinary(node, env) {
  try {
    const l = await this.evaluate(node.left, env);
    const r = await this.evaluate(node.right, env);

    if (node.operator === 'SLASH' && r === 0) {
      throw new RuntimeError('Division by zero', node, this.source, env);
    }

    switch (node.operator) {
      case 'PLUS': {
        if (Array.isArray(l) && Array.isArray(r)) return l.concat(r);
        if (typeof l === 'string' || typeof r === 'string') return String(l) + String(r);
        if (typeof l === 'number' && typeof r === 'number') return l + r;
        if (typeof l === 'object' && typeof r === 'object') return { ...l, ...r };

        throw new RuntimeError(
          `Unsupported operands for +: ${typeof l} and ${typeof r}`,
          node,
          this.source,
          env
        );
      }
      case 'MINUS': return l - r;
      case 'STAR': return l * r;
      case 'SLASH': return l / r;
      case 'MOD': return l % r;
      case 'EQEQ': return l === r;
      case 'NOTEQ': return l !== r;
      case 'LT': return l < r;
      case 'LTE': return l <= r;
      case 'GT': return l > r;
      case 'GTE': return l >= r;
      default:
        throw new RuntimeError(
          `Unknown binary operator: ${node.operator}`,
          node,
          this.source,
          env
        );
    }

  } catch (e) {
    if (e instanceof RuntimeError) throw e;
    throw new RuntimeError(
      e.message || 'Error evaluating binary expression',
      node,
      this.source,
      env
    );
  }
}
async evalLogical(node, env) {
  try {
    const l = await this.evaluate(node.left, env);

    switch (node.operator) {
      case 'AND': return l && await this.evaluate(node.right, env);
      case 'OR': return l || await this.evaluate(node.right, env);
      case '??': {
        const r = await this.evaluate(node.right, env);
        return (l !== null && l !== undefined) ? l : r;
      }
      default:
        throw new RuntimeError(
          `Unknown logical operator: ${node.operator}`,
          node,
          this.source,
          env
        );
    }

  } catch (e) {
    if (e instanceof RuntimeError) throw e;
    throw new RuntimeError(
      e.message || 'Error evaluating logical expression',
      node,
      this.source,
      env
    );
  }
}

async evalUnary(node, env) {
  try {
    // Handle prefix update operators
    if (node.type === 'UpdateExpression' && node.prefix) {
      if (node.argument.type !== 'Identifier') {
        throw new RuntimeError(
          `Invalid operand for update operator: ${node.operator}`,
          node,
          this.source,
          env
        );
      }

      const varName = node.argument.name;
      let currentVal = await env.get(varName); // assuming env.get returns the variable value

      switch (node.operator) {
        case 'PLUSPLUS':
          currentVal++;
          await env.set(varName, currentVal);
          return currentVal;
        case 'MINUSMINUS':
          currentVal--;
          await env.set(varName, currentVal);
          return currentVal;
        default:
          throw new RuntimeError(
            `Unknown update operator: ${node.operator}`,
            node,
            this.source,
            env
          );
      }
    }

    // Evaluate the argument first
    const val = await this.evaluate(node.argument, env);

    switch (node.operator) {
      case 'NOT':
        return !val;
      case 'MINUS':
        return -val;
      case 'PLUS':
        return +val;
      default:
        throw new RuntimeError(
          `Unknown unary operator: ${node.operator}`,
          node,
          this.source,
          env
        );
    }
  } catch (e) {
    if (e instanceof RuntimeError) throw e;
    throw new RuntimeError(
      e.message || 'Error evaluating unary expression',
      node,
      this.source,
      env
    );
  }
}

// Handle postfix updates (x++ or x--)
async evalPostfixUpdate(node, env) {
  if (node.type !== 'UpdateExpression' || node.prefix) {
    throw new RuntimeError(
      `Invalid postfix update node`,
      node,
      this.source,
      env
    );
  }

  if (node.argument.type !== 'Identifier') {
    throw new RuntimeError(
      `Invalid operand for postfix update operator: ${node.operator}`,
      node,
      this.source,
      env
    );
  }

  const varName = node.argument.name;
  let currentVal = await env.get(varName);

  let returnVal = currentVal;

  switch (node.operator) {
    case 'PLUSPLUS':
      currentVal++;
      await env.set(varName, currentVal);
      return returnVal; // return original value
    case 'MINUSMINUS':
      currentVal--;
      await env.set(varName, currentVal);
      return returnVal; // return original value
    default:
      throw new RuntimeError(
        `Unknown postfix operator: ${node.operator}`,
        node,
        this.source,
        env
      );
  }
}


async evalIf(node, env) {
  let test = await this.evaluate(node.test, env);
  test = !!test; // coerce to boolean

  if (test) {
    return await this.evaluate(node.consequent, env);
  }

  if (node.alternate) {
    return await this.evaluate(node.alternate, env);
  }

  return null;
}

async evalWhile(node, env) {
  try {
    while (true) {
      let test = await this.evaluate(node.test, env);
      test = !!test;

      if (!test) break;

      try {
        await this.evaluate(node.body, env);
      } catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }

    return null;

  } catch (e) {
    if (e instanceof RuntimeError || e instanceof BreakSignal || e instanceof ContinueSignal) throw e;
    throw new RuntimeError(
      e.message || 'Error evaluating while loop',
      node,
      this.source,
      env
    );
  }
}
async evalFor(node, env) {
  try {
    if (node.type === 'ForInStatement') {
      const iterable = await this.evaluate(node.iterable, env);

      if (iterable == null || typeof iterable !== 'object') {
        throw new RuntimeError(
          'Cannot iterate over non-iterable',
          node,
          this.source,
          env
        );
      }

      const loopVar = node.variable;
      const createLoopEnv = () =>
        node.defineKeyword
          ? new Environment(env)
          : env;

      if (Array.isArray(iterable)) {
        for (const value of iterable) {
          const loopEnv = createLoopEnv();

          loopEnv.define(loopVar, value);

          try {
            await this.evaluate(node.body, loopEnv);
          } catch (e) {
            if (e instanceof BreakSignal) {
              break;
            }

            if (e instanceof ContinueSignal) {
              continue;
            }
            if (e instanceof ReturnValue) {
              throw e;
            }

            throw e;
          }
        }
      }

      else {
        for (const key of Object.keys(iterable)) {
          const loopEnv = createLoopEnv();

          loopEnv.define(loopVar, key);

          try {
            await this.evaluate(node.body, loopEnv);
          } catch (e) {
            if (e instanceof BreakSignal) {
              break;
            }

            if (e instanceof ContinueSignal) {
              continue;
            }

            if (e instanceof ReturnValue) {
              throw e;
            }

            throw e;
          }
        }
      }

      return null;
    }
    const local = new Environment(env);
    if (node.init) {
      await this.evaluate(node.init, local);
    }
    while (
      !node.test ||
      await this.evaluate(node.test, local)
    ) {
      try {
        await this.evaluate(node.body, local);
      } catch (e) {
        if (e instanceof BreakSignal) {
          break;
        }
        if (e instanceof ContinueSignal) {
          if (node.update) {
            await this.evaluate(node.update, local);
          }

          continue;
        }
        if (e instanceof ReturnValue) {
          throw e;
        }
        throw e;
      }
      if (node.update) {
        await this.evaluate(node.update, local);
      }
    }

    return null;

  } catch (err) {
    if (
      err instanceof RuntimeError ||
      err instanceof BreakSignal ||
      err instanceof ContinueSignal ||
      err instanceof ReturnValue
    ) {
      throw err;
    }

    throw new RuntimeError(
      err.message || 'Error evaluating for loop',
      node,
      this.source,
      env
    );
  }
}
evalFunctionExpression(node, env) {
  if (!node.body || !Array.isArray(node.params)) {
    throw new RuntimeError(
      'Invalid function expression',
      node,
      this.source,
      env
    );
  }

  const evaluator = this;

  const fn = async function (...args) {
    const localEnv = new Environment(env);

    for (let i = 0; i < node.params.length; i++) {
      const param = node.params[i];
      const paramName = typeof param === 'string' ? param : param.name;
      localEnv.define(paramName, args[i]);
    }

    try {
      const result = await evaluator.evaluate(node.body, localEnv);
      return result === undefined ? null : result;
    } catch (e) {
      if (e instanceof ReturnValue) return e.value === undefined ? null : e.value;
      throw e;
    }
  };
  fn.params = node.params;
  fn.body = node.body;
  fn.env = env;

  return fn;
}

evalFunctionDeclaration(node, env) {
  try {
    if (!node.name || typeof node.name !== 'string') {
      throw new RuntimeError('Function declaration requires a valid name', node, this.source, env);
    }

    if (!Array.isArray(node.params)) {
      throw new RuntimeError(`Invalid parameter list in function '${node.name}'`, node, this.source, env);
    }

    if (!node.body) {
      throw new RuntimeError(`Function '${node.name}' has no body`, node, this.source, env);
    }

    const fn = {
      params: node.params,
      body: node.body,
      env,
      async: node.async || false
    };

    env.define(node.name, fn);
    return null;

  } catch (err) {
    if (err instanceof RuntimeError) throw err;
    throw new RuntimeError(
      err.message || 'Error defining function',
      node,
      this.source,
      env
    );
  }
}
async evalCall(node, env) {
  try {
    const calleeEvaluated = await this.evaluate(node.callee, env);

    // Native JS function
    if (typeof calleeEvaluated === 'function') {
      const args = [];
      for (const a of node.arguments) args.push(await this.evaluate(a, env));
      return await calleeEvaluated(...args);
    }

    // Not a callable object
    if (!calleeEvaluated || typeof calleeEvaluated !== 'object' || !calleeEvaluated.body) {
      throw new RuntimeError(
        'Call to non-function',
        node,
        this.source,
        env
      );
    }

    const fn = calleeEvaluated;
    const callEnv = new Environment(fn.env);

    for (let i = 0; i < fn.params.length; i++) {
      const argVal = node.arguments[i]
        ? await this.evaluate(node.arguments[i], env)
        : null;

      const param = fn.params[i];
      const paramName = typeof param === 'string' ? param : param.name;
      callEnv.define(paramName, argVal);
    }

    try {
      const result = await this.evaluate(fn.body, callEnv);
      return result === undefined ? null : result; // enforce null instead of undefined
    } catch (e) {
      if (e instanceof ReturnValue) return e.value === undefined ? null : e.value;
      throw e;
    }

  } catch (err) {
    if (err instanceof RuntimeError) throw err;
    throw new RuntimeError(
      err.message || 'Error during function call',
      node,
      this.source,
      env
    );
  }
}
async evalIndex(node, env) {
  try {
    const obj = await this.evaluate(node.object, env);
    const idx = await this.evaluate(node.indexer, env);

    if (obj == null) {
      throw new RuntimeError(
        'Cannot index null or undefined',
        node,
        this.source,
        env
      );
    }

    if (Array.isArray(obj)) {
      if (idx < 0 || idx >= obj.length) return undefined;
      return obj[idx];
    }

    if (typeof obj === 'object') return obj[idx]; // undefined if missing

    return undefined;
  } catch (err) {
    if (err instanceof RuntimeError) throw err;
    throw new RuntimeError(
      err.message || 'Error during index access',
      node,
      this.source,
      env
    );
  }
} 

async evalObject(node, env) {
  try {
    const out = {};
    for (const p of node.props) {
      if (!p.key) {
        throw new RuntimeError(
          'Object property must have a key',
          node,
          this.source,
          env
        );
      }

      const key = await this.evaluate(p.key, env);
      let value = null;

      if (p.value) {
        value = await this.evaluate(p.value, env);
        if (value === undefined) value = null; // force null instead of undefined
      }

      out[key] = value;
    }
    return out;
  } catch (err) {
    if (err instanceof RuntimeError) throw err;
    throw new RuntimeError(
      err.message || 'Error evaluating object literal',
      node,
      this.source,
      env
    );
  }
}


async evalMember(node, env) {
  const obj = await this.evaluate(node.object, env);

  if (obj == null) {
    throw new RuntimeError('Member access of null or undefined', node, this.source);
  }

  const prop = obj[node.property];

  if (typeof prop === 'function') {
    return prop.bind(obj);
  }

  return prop;
}

async evalUpdate(node, env) {
  const arg = node.argument;

  const getCurrent = async () => {
    try {
      if (arg.type === 'Identifier') return env.get(arg.name, arg, this.source);
      if (arg.type === 'MemberExpression') return await this.evalMember(arg, env);
      if (arg.type === 'IndexExpression') return await this.evalIndex(arg, env);
      throw new RuntimeError('Invalid update target', node, this.source, env);
    } catch (err) {
      if (err instanceof RuntimeError) throw err;
      throw new RuntimeError(
        err.message || 'Error accessing update target',
        node,
        this.source,
        env
      );
    }
  };

  const setValue = async (v) => {
    try {
      if (arg.type === 'Identifier') {
        env.set(arg.name, v);
      } else if (arg.type === 'MemberExpression') {
        const obj = await this.evaluate(arg.object, env);
        if (obj == null) throw new RuntimeError('Cannot update property of null or undefined', node, this.source, env);
        obj[arg.property] = v;
      } else if (arg.type === 'IndexExpression') {
        const obj = await this.evaluate(arg.object, env);
        const idx = await this.evaluate(arg.indexer, env);
        if (obj == null) throw new RuntimeError('Cannot update index of null or undefined', node, this.source, env);
        obj[idx] = v;
      }
    } catch (err) {
      if (err instanceof RuntimeError) throw err;
      throw new RuntimeError(
        err.message || 'Error setting update target',
        node,
        this.source,
        env
      );
    }
  };

  const current = await getCurrent();
  const newVal = node.operator === 'PLUSPLUS' ? current + 1 : current - 1;

  if (node.prefix) {
    await setValue(newVal);
    return newVal;
  } else {
    await setValue(newVal);
    return current;
  }
}

}

module.exports = Evaluator;   
