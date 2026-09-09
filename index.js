import { watch, createReadStream, mkdirSync, createWriteStream, existsSync, cpSync, readFileSync, writeFileSync, accessSync, constants } from "node:fs";
import { readdir, stat, appendFile, mkdir, unlink, readFile, rename, writeFile, chmod, rm, open, access } from "node:fs/promises";
import { resolve, sep, extname, relative, basename, join, dirname, isAbsolute } from "node:path";
import { randomUUID, createHash, randomBytes, generateKeyPairSync, diffieHellman, hkdfSync, createPrivateKey, createPublicKey, createCipheriv, createDecipheriv } from "node:crypto";
import { safeStorage, app, session, dialog, shell, BrowserWindow, ipcMain, clipboard, protocol, nativeTheme, desktopCapturer, systemPreferences } from "electron";
import { pathToFileURL } from "node:url";
import { Readable as Readable$1 } from "node:stream";
import require$$1 from "util";
import stream, { Readable } from "stream";
import require$$1$1, { resolve as resolve$1 } from "path";
import http$a from "http";
import https from "https";
import require$$5 from "url";
import require$$6 from "fs";
import require$$8 from "crypto";
import require$$0$3 from "net";
import require$$1$3 from "tls";
import require$$3 from "assert";
import require$$1$2 from "tty";
import require$$0$1 from "os";
import require$$0$2, { EventEmitter } from "events";
import http2 from "http2";
import zlib from "zlib";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { createServer as createServer$1 } from "node:net";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
class ConnectorRegistry {
  connectors = /* @__PURE__ */ new Map();
  register(connector) {
    if (this.connectors.has(connector.kind)) {
      throw new Error(`Connector already registered: ${connector.kind}`);
    }
    this.connectors.set(connector.kind, connector);
    return this;
  }
  get(kind) {
    const connector = this.connectors.get(kind);
    if (!connector) throw new Error(`不支持的数据源类型：${kind}`);
    return connector;
  }
}
const LOCAL_PARSEABLE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".md",
  ".mdx",
  ".text",
  ".txt"
]);
const OFFICE_FILE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".docm",
  ".dot",
  ".dotx",
  ".dotm",
  ".rtf",
  ".odt",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".xlsb",
  ".xlt",
  ".xltx",
  ".xltm",
  ".xla",
  ".xlam",
  ".ods",
  ".ppt",
  ".pptx",
  ".pptm",
  ".pot",
  ".potx",
  ".potm",
  ".pps",
  ".ppsx",
  ".ppsm",
  ".sldx",
  ".sldm",
  ".odp"
]);
const LOCAL_AUTO_SCAN_EXTENSIONS = /* @__PURE__ */ new Set([
  ...OFFICE_FILE_EXTENSIONS,
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".text",
  ".csv",
  ".html",
  ".htm"
]);
function isLowRiskFileExtension(extension) {
  return OFFICE_FILE_EXTENSIONS.has(extension.toLowerCase());
}
const HIGH_RISK_FILE_BATCH_THRESHOLD = 100;
const LOCAL_NEVER_SCAN_EXTENSIONS = /* @__PURE__ */ new Set([".json"]);
function isLocalParseableExtension(extension) {
  const normalized = extension.toLowerCase();
  return !LOCAL_NEVER_SCAN_EXTENSIONS.has(normalized) && LOCAL_PARSEABLE_EXTENSIONS.has(normalized);
}
const IGNORED_LOCAL_DIRECTORY_NAMES = /* @__PURE__ */ new Set([
  ".cache",
  ".dart_tool",
  ".git",
  ".gradle",
  ".hg",
  ".idea",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".pnpm-store",
  ".pytest_cache",
  ".svn",
  ".terraform",
  ".tox",
  ".turbo",
  "__pycache__",
  "applications",
  "bin",
  "bower_components",
  "build",
  "cache",
  "caches",
  "coverage",
  "deriveddata",
  "dist",
  "env",
  "logs",
  "node_modules",
  "obj",
  "out",
  "pods",
  "target",
  "temp",
  "tmp",
  "vendor",
  "venv"
]);
function isIgnoredLocalDirectory(name) {
  return name.startsWith(".") || IGNORED_LOCAL_DIRECTORY_NAMES.has(name.toLowerCase());
}
class LocalFolderConnector {
  constructor(scanExtensions = LOCAL_AUTO_SCAN_EXTENSIONS) {
    this.scanExtensions = scanExtensions;
  }
  kind = "local-folder";
  capabilities = ["pull", "incremental", "watch"];
  getConnectionKey(config) {
    return resolve(config.rootPath);
  }
  async scan(connection) {
    const items = [];
    let failed = 0;
    const visit = async (directory, isRoot = false) => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isRoot) throw error;
        failed += 1;
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory() && isIgnoredLocalDirectory(entry.name)) continue;
        const absolutePath = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = extname(entry.name).toLowerCase();
        if (!this.scanExtensions.has(extension)) continue;
        try {
          const info = await stat(absolutePath);
          const itemPath = relative(connection.config.rootPath, absolutePath).split(sep).join("/");
          items.push({
            remoteId: info.ino > 0 ? `${info.dev}:${info.ino}` : itemPath,
            title: basename(itemPath),
            uri: pathToFileURL(absolutePath).toString(),
            path: itemPath,
            extension,
            byteSize: info.size,
            modifiedAt: info.mtime.toISOString(),
            openContent: () => createReadStream(absolutePath)
          });
        } catch {
          failed += 1;
        }
      }
    };
    await visit(connection.config.rootPath, true);
    return { items, failed };
  }
  watch(connection, onChange, onError) {
    try {
      const watcher = watch(connection.config.rootPath, { recursive: true }, onChange);
      let closedByCaller = false;
      let reportedError = false;
      const reportError = () => {
        if (reportedError || closedByCaller) return;
        reportedError = true;
        onError?.();
        watcher.close();
      };
      watcher.on("error", reportError);
      watcher.on("close", () => {
        if (!closedByCaller && !reportedError) {
          reportedError = true;
          onError?.();
        }
      });
      return {
        close: () => {
          closedByCaller = true;
          watcher.close();
        }
      };
    } catch {
      return null;
    }
  }
  resolveLocalPath(connection, itemPath) {
    const rootPath = resolve(connection.config.rootPath);
    const localPath = resolve(rootPath, itemPath);
    if (localPath !== rootPath && !localPath.startsWith(`${rootPath}${sep}`)) {
      throw new Error("文件位置超出已授权目录。");
    }
    return localPath;
  }
}
function bind(fn, thisArg) {
  return function wrap() {
    return fn.apply(thisArg, arguments);
  };
}
const { toString } = Object.prototype;
const { getPrototypeOf } = Object;
const { iterator, toStringTag } = Symbol;
const hasOwnProperty = (({ hasOwnProperty: hasOwnProperty2 }) => (obj, prop) => hasOwnProperty2.call(obj, prop))(Object.prototype);
const hasOwnInPrototypeChain = (thing, prop) => {
  let obj = thing;
  const seen = [];
  while (obj != null && obj !== Object.prototype) {
    if (seen.indexOf(obj) !== -1) {
      return false;
    }
    seen.push(obj);
    if (hasOwnProperty(obj, prop)) {
      return true;
    }
    obj = getPrototypeOf(obj);
  }
  return false;
};
const getSafeProp = (obj, prop) => obj != null && hasOwnInPrototypeChain(obj, prop) ? obj[prop] : void 0;
const kindOf = /* @__PURE__ */ ((cache) => (thing) => {
  const str = toString.call(thing);
  return cache[str] || (cache[str] = str.slice(8, -1).toLowerCase());
})(/* @__PURE__ */ Object.create(null));
const kindOfTest = (type2) => {
  type2 = type2.toLowerCase();
  return (thing) => kindOf(thing) === type2;
};
const typeOfTest = (type2) => (thing) => typeof thing === type2;
const { isArray } = Array;
const isUndefined = typeOfTest("undefined");
function isBuffer(val) {
  return val !== null && !isUndefined(val) && val.constructor !== null && !isUndefined(val.constructor) && isFunction$1(val.constructor.isBuffer) && val.constructor.isBuffer(val);
}
const isArrayBuffer = kindOfTest("ArrayBuffer");
function isArrayBufferView(val) {
  let result;
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView) {
    result = ArrayBuffer.isView(val);
  } else {
    result = val && val.buffer && isArrayBuffer(val.buffer);
  }
  return result;
}
const isString = typeOfTest("string");
const isFunction$1 = typeOfTest("function");
const isNumber = typeOfTest("number");
const isObject = (thing) => thing !== null && typeof thing === "object";
const isBoolean = (thing) => thing === true || thing === false;
const isPlainObject = (val) => {
  if (!isObject(val)) {
    return false;
  }
  const prototype2 = getPrototypeOf(val);
  return (prototype2 === null || prototype2 === Object.prototype || getPrototypeOf(prototype2) === null) && // Treat any genuine (non-Object.prototype-polluted) Symbol.toStringTag or
  // Symbol.iterator as evidence the value is a tagged/iterable type rather
  // than a plain object, while ignoring keys injected onto Object.prototype.
  !hasOwnInPrototypeChain(val, toStringTag) && !hasOwnInPrototypeChain(val, iterator);
};
const isEmptyObject = (val) => {
  if (!isObject(val) || isBuffer(val)) {
    return false;
  }
  try {
    return Object.keys(val).length === 0 && Object.getPrototypeOf(val) === Object.prototype;
  } catch (e) {
    return false;
  }
};
const isDate = kindOfTest("Date");
const isFile = kindOfTest("File");
const isReactNativeBlob = (value) => {
  return !!(value && typeof value.uri !== "undefined");
};
const isReactNative = (formData) => formData && typeof formData.getParts !== "undefined";
const isBlob = kindOfTest("Blob");
const isFileList = kindOfTest("FileList");
const isSet = kindOfTest("Set");
const isStream = (val) => isObject(val) && isFunction$1(val.pipe);
function getGlobal() {
  if (typeof globalThis !== "undefined") return globalThis;
  if (typeof self !== "undefined") return self;
  if (typeof window !== "undefined") return window;
  if (typeof global !== "undefined") return global;
  return {};
}
const G = getGlobal();
const FormDataCtor = typeof G.FormData !== "undefined" ? G.FormData : void 0;
const isFormData = (thing) => {
  if (!thing) return false;
  if (FormDataCtor && thing instanceof FormDataCtor) return true;
  const proto = getPrototypeOf(thing);
  if (!proto || proto === Object.prototype) return false;
  if (!isFunction$1(thing.append)) return false;
  const kind = kindOf(thing);
  return kind === "formdata" || // detect form-data instance
  kind === "object" && isFunction$1(thing.toString) && thing.toString() === "[object FormData]";
};
const isURLSearchParams = kindOfTest("URLSearchParams");
const [isReadableStream, isRequest, isResponse, isHeaders] = [
  "ReadableStream",
  "Request",
  "Response",
  "Headers"
].map(kindOfTest);
const trim = (str) => {
  return str.trim ? str.trim() : str.replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, "");
};
function forEach(obj, fn, { allOwnKeys = false } = {}) {
  if (obj === null || typeof obj === "undefined") {
    return;
  }
  let i;
  let l;
  if (typeof obj !== "object") {
    obj = [obj];
  }
  if (isArray(obj)) {
    for (i = 0, l = obj.length; i < l; i++) {
      fn.call(null, obj[i], i, obj);
    }
  } else {
    if (isBuffer(obj)) {
      return;
    }
    const keys = allOwnKeys ? Object.getOwnPropertyNames(obj) : Object.keys(obj);
    const len = keys.length;
    let key;
    for (i = 0; i < len; i++) {
      key = keys[i];
      fn.call(null, obj[key], key, obj);
    }
  }
}
function findKey(obj, key) {
  if (isBuffer(obj)) {
    return null;
  }
  key = key.toLowerCase();
  const keys = Object.keys(obj);
  let i = keys.length;
  let _key;
  while (i-- > 0) {
    _key = keys[i];
    if (key === _key.toLowerCase()) {
      return _key;
    }
  }
  return null;
}
const _global = (() => {
  if (typeof globalThis !== "undefined") return globalThis;
  return typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : global;
})();
const isContextDefined = (context) => !isUndefined(context) && context !== _global;
function merge(...objs) {
  const { caseless, skipUndefined } = isContextDefined(this) && this || {};
  const result = {};
  const assignValue = (val, key) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return;
    }
    const targetKey = caseless && typeof key === "string" && findKey(result, key) || key;
    const existing = hasOwnProperty(result, targetKey) ? result[targetKey] : void 0;
    if (isPlainObject(existing) && isPlainObject(val)) {
      result[targetKey] = merge(existing, val);
    } else if (isPlainObject(val)) {
      result[targetKey] = merge({}, val);
    } else if (isArray(val)) {
      result[targetKey] = val.slice();
    } else if (!skipUndefined || !isUndefined(val)) {
      result[targetKey] = val;
    }
  };
  for (let i = 0, l = objs.length; i < l; i++) {
    const source = objs[i];
    if (!source || isBuffer(source)) {
      continue;
    }
    forEach(source, assignValue);
    if (typeof source !== "object" || isArray(source)) {
      continue;
    }
    const symbols = Object.getOwnPropertySymbols(source);
    for (let j = 0; j < symbols.length; j++) {
      const symbol = symbols[j];
      if (propertyIsEnumerable.call(source, symbol)) {
        assignValue(source[symbol], symbol);
      }
    }
  }
  return result;
}
const extend = (a, b, thisArg, { allOwnKeys } = {}) => {
  forEach(
    b,
    (val, key) => {
      if (thisArg && isFunction$1(val)) {
        Object.defineProperty(a, key, {
          // Null-proto descriptor so a polluted Object.prototype.get cannot
          // hijack defineProperty's accessor-vs-data resolution.
          __proto__: null,
          value: bind(val, thisArg),
          writable: true,
          enumerable: true,
          configurable: true
        });
      } else {
        Object.defineProperty(a, key, {
          __proto__: null,
          value: val,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
    },
    { allOwnKeys }
  );
  return a;
};
const stripBOM = (content) => {
  if (content.charCodeAt(0) === 65279) {
    content = content.slice(1);
  }
  return content;
};
const inherits = (constructor, superConstructor, props, descriptors) => {
  constructor.prototype = Object.create(superConstructor.prototype, descriptors);
  Object.defineProperty(constructor.prototype, "constructor", {
    __proto__: null,
    value: constructor,
    writable: true,
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(constructor, "super", {
    __proto__: null,
    value: superConstructor.prototype
  });
  props && Object.assign(constructor.prototype, props);
};
const toFlatObject = (sourceObj, destObj, filter2, propFilter) => {
  let props;
  let i;
  let prop;
  const merged = {};
  destObj = destObj || {};
  if (sourceObj == null) return destObj;
  do {
    props = Object.getOwnPropertyNames(sourceObj);
    i = props.length;
    while (i-- > 0) {
      prop = props[i];
      if ((!propFilter || propFilter(prop, sourceObj, destObj)) && !merged[prop]) {
        destObj[prop] = sourceObj[prop];
        merged[prop] = true;
      }
    }
    sourceObj = filter2 !== false && getPrototypeOf(sourceObj);
  } while (sourceObj && (!filter2 || filter2(sourceObj, destObj)) && sourceObj !== Object.prototype);
  return destObj;
};
const endsWith = (str, searchString, position) => {
  str = String(str);
  if (position === void 0 || position > str.length) {
    position = str.length;
  }
  position -= searchString.length;
  const lastIndex = str.indexOf(searchString, position);
  return lastIndex !== -1 && lastIndex === position;
};
const toArray = (thing) => {
  if (!thing) return null;
  if (isArray(thing)) return thing;
  let i = thing.length;
  if (!isNumber(i)) return null;
  const arr = new Array(i);
  while (i-- > 0) {
    arr[i] = thing[i];
  }
  return arr;
};
const isTypedArray = /* @__PURE__ */ ((TypedArray) => {
  return (thing) => {
    return TypedArray && thing instanceof TypedArray;
  };
})(typeof Uint8Array !== "undefined" && getPrototypeOf(Uint8Array));
const forEachEntry = (obj, fn) => {
  const generator = obj && obj[iterator];
  const _iterator = generator.call(obj);
  let result;
  while ((result = _iterator.next()) && !result.done) {
    const pair = result.value;
    fn.call(obj, pair[0], pair[1]);
  }
};
const matchAll = (regExp, str) => {
  let matches;
  const arr = [];
  while ((matches = regExp.exec(str)) !== null) {
    arr.push(matches);
  }
  return arr;
};
const isHTMLForm = kindOfTest("HTMLFormElement");
const toCamelCase = (str) => {
  return str.toLowerCase().replace(/[-_\s]([a-z\d])(\w*)/g, function replacer(m, p1, p2) {
    return p1.toUpperCase() + p2;
  });
};
const { propertyIsEnumerable } = Object.prototype;
const isRegExp = kindOfTest("RegExp");
const reduceDescriptors = (obj, reducer) => {
  const descriptors = Object.getOwnPropertyDescriptors(obj);
  const reducedDescriptors = {};
  forEach(descriptors, (descriptor, name) => {
    let ret;
    if ((ret = reducer(descriptor, name, obj)) !== false) {
      reducedDescriptors[name] = ret || descriptor;
    }
  });
  Object.defineProperties(obj, reducedDescriptors);
};
const freezeMethods = (obj) => {
  reduceDescriptors(obj, (descriptor, name) => {
    if (isFunction$1(obj) && ["arguments", "caller", "callee"].includes(name)) {
      return false;
    }
    const value = obj[name];
    if (!isFunction$1(value)) return;
    descriptor.enumerable = false;
    if ("writable" in descriptor) {
      descriptor.writable = false;
      return;
    }
    if (!descriptor.set) {
      descriptor.set = () => {
        throw Error("Can not rewrite read-only method '" + name + "'");
      };
    }
  });
};
const toObjectSet = (arrayOrString, delimiter) => {
  const obj = {};
  const define = (arr) => {
    arr.forEach((value) => {
      obj[value] = true;
    });
  };
  isArray(arrayOrString) ? define(arrayOrString) : define(String(arrayOrString).split(delimiter));
  return obj;
};
const noop = () => {
};
const toFiniteNumber = (value, defaultValue) => {
  return value != null && Number.isFinite(value = +value) ? value : defaultValue;
};
function isSpecCompliantForm(thing) {
  return !!(thing && isFunction$1(thing.append) && thing[toStringTag] === "FormData" && thing[iterator]);
}
const toJSONObject = (obj) => {
  const visited = /* @__PURE__ */ new WeakSet();
  const visit = (source) => {
    if (isObject(source)) {
      if (visited.has(source)) {
        return;
      }
      if (isBuffer(source)) {
        return source;
      }
      if (!("toJSON" in source)) {
        visited.add(source);
        let target;
        if (isSet(source)) {
          target = [];
          for (const value of source) {
            const reducedValue = visit(value);
            !isUndefined(reducedValue) && target.push(reducedValue);
          }
        } else {
          target = isArray(source) ? [] : {};
          forEach(source, (value, key) => {
            const reducedValue = visit(value);
            !isUndefined(reducedValue) && (target[key] = reducedValue);
          });
        }
        visited.delete(source);
        return target;
      }
    }
    return source;
  };
  return visit(obj);
};
const isAsyncFn = kindOfTest("AsyncFunction");
const isThenable = (thing) => thing && (isObject(thing) || isFunction$1(thing)) && isFunction$1(thing.then) && isFunction$1(thing.catch);
const _setImmediate = ((setImmediateSupported, postMessageSupported) => {
  if (setImmediateSupported) {
    return setImmediate;
  }
  return postMessageSupported ? ((token, callbacks) => {
    _global.addEventListener(
      "message",
      ({ source, data }) => {
        if (source === _global && data === token) {
          callbacks.length && callbacks.shift()();
        }
      },
      false
    );
    return (cb) => {
      callbacks.push(cb);
      _global.postMessage(token, "*");
    };
  })(`axios@${Math.random()}`, []) : (cb) => setTimeout(cb);
})(typeof setImmediate === "function", isFunction$1(_global.postMessage));
const asap = typeof queueMicrotask !== "undefined" ? queueMicrotask.bind(_global) : typeof process !== "undefined" && process.nextTick || _setImmediate;
const isIterable = (thing) => thing != null && isFunction$1(thing[iterator]);
const isSafeIterable = (thing) => thing != null && hasOwnInPrototypeChain(thing, iterator) && isIterable(thing);
const utils$1 = {
  isArray,
  isArrayBuffer,
  isBuffer,
  isFormData,
  isArrayBufferView,
  isString,
  isNumber,
  isBoolean,
  isObject,
  isPlainObject,
  isEmptyObject,
  isReadableStream,
  isRequest,
  isResponse,
  isHeaders,
  isUndefined,
  isDate,
  isFile,
  isReactNativeBlob,
  isReactNative,
  isBlob,
  isRegExp,
  isFunction: isFunction$1,
  isStream,
  isURLSearchParams,
  isTypedArray,
  isFileList,
  forEach,
  merge,
  extend,
  trim,
  stripBOM,
  inherits,
  toFlatObject,
  kindOf,
  kindOfTest,
  endsWith,
  toArray,
  forEachEntry,
  matchAll,
  isHTMLForm,
  hasOwnProperty,
  hasOwnProp: hasOwnProperty,
  // an alias to avoid ESLint no-prototype-builtins detection
  hasOwnInPrototypeChain,
  getSafeProp,
  reduceDescriptors,
  freezeMethods,
  toObjectSet,
  toCamelCase,
  noop,
  toFiniteNumber,
  findKey,
  global: _global,
  isContextDefined,
  isSpecCompliantForm,
  toJSONObject,
  isAsyncFn,
  isThenable,
  setImmediate: _setImmediate,
  asap,
  isIterable,
  isSafeIterable
};
const ignoreDuplicateOf = utils$1.toObjectSet([
  "age",
  "authorization",
  "content-length",
  "content-type",
  "etag",
  "expires",
  "from",
  "host",
  "if-modified-since",
  "if-unmodified-since",
  "last-modified",
  "location",
  "max-forwards",
  "proxy-authorization",
  "referer",
  "retry-after",
  "user-agent"
]);
const parseHeaders = (rawHeaders) => {
  const parsed = {};
  let key;
  let val;
  let i;
  rawHeaders && rawHeaders.split("\n").forEach(function parser(line) {
    i = line.indexOf(":");
    key = line.substring(0, i).trim().toLowerCase();
    val = line.substring(i + 1).trim();
    const hasKey = utils$1.hasOwnProp(parsed, key);
    if (!key || hasKey && utils$1.hasOwnProp(ignoreDuplicateOf, key)) {
      return;
    }
    if (key === "set-cookie") {
      if (hasKey) {
        parsed[key].push(val);
      } else {
        parsed[key] = [val];
      }
    } else {
      parsed[key] = hasKey ? parsed[key] + ", " + val : val;
    }
  });
  return parsed;
};
function trimSPorHTAB(str) {
  let start = 0;
  let end = str.length;
  while (start < end) {
    const code = str.charCodeAt(start);
    if (code !== 9 && code !== 32) {
      break;
    }
    start += 1;
  }
  while (end > start) {
    const code = str.charCodeAt(end - 1);
    if (code !== 9 && code !== 32) {
      break;
    }
    end -= 1;
  }
  return start === 0 && end === str.length ? str : str.slice(start, end);
}
const INVALID_UNICODE_HEADER_VALUE_CHARS = new RegExp("[\\u0000-\\u0008\\u000a-\\u001f\\u007f]+", "g");
const INVALID_BYTE_STRING_HEADER_VALUE_CHARS = new RegExp("[^\\u0009\\u0020-\\u007e\\u0080-\\u00ff]+", "g");
function sanitizeValue(value, invalidChars) {
  if (utils$1.isArray(value)) {
    return value.map((item) => sanitizeValue(item, invalidChars));
  }
  return trimSPorHTAB(String(value).replace(invalidChars, ""));
}
const sanitizeHeaderValue = (value) => sanitizeValue(value, INVALID_UNICODE_HEADER_VALUE_CHARS);
const sanitizeByteStringHeaderValue = (value) => sanitizeValue(value, INVALID_BYTE_STRING_HEADER_VALUE_CHARS);
function toByteStringHeaderObject(headers) {
  const byteStringHeaders = /* @__PURE__ */ Object.create(null);
  utils$1.forEach(headers.toJSON(), (value, header) => {
    byteStringHeaders[header] = sanitizeByteStringHeaderValue(value);
  });
  return byteStringHeaders;
}
const $internals = Symbol("internals");
function normalizeHeader(header) {
  return header && String(header).trim().toLowerCase();
}
function normalizeValue(value) {
  if (value === false || value == null) {
    return value;
  }
  return utils$1.isArray(value) ? value.map(normalizeValue) : sanitizeHeaderValue(String(value));
}
function parseTokens(str) {
  const tokens = /* @__PURE__ */ Object.create(null);
  const tokensRE = /([^\s,;=]+)\s*(?:=\s*([^,;]+))?/g;
  let match;
  while (match = tokensRE.exec(str)) {
    tokens[match[1]] = match[2];
  }
  return tokens;
}
const parameterNameRE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function trimOWS(value) {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const code = value.charCodeAt(start);
    if (code !== 9 && code !== 32) {
      break;
    }
    start += 1;
  }
  while (end > start) {
    const code = value.charCodeAt(end - 1);
    if (code !== 9 && code !== 32) {
      break;
    }
    end -= 1;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}
function decodeQuotedString(value) {
  const last = value.length - 1;
  if (last < 1 || value.charCodeAt(0) !== 34 || value.charCodeAt(last) !== 34) {
    return value;
  }
  let decoded = "";
  for (let i = 1; i < last; i++) {
    const code = value.charCodeAt(i);
    if (code === 34) {
      return value;
    }
    if (code === 92) {
      i += 1;
      if (i >= last) {
        return value;
      }
    }
    decoded += value[i];
  }
  return decoded;
}
function parseParameters(value) {
  const parameters = /* @__PURE__ */ Object.create(null);
  const str = String(value);
  let start = 0;
  let quoted = false;
  let escaped = false;
  function parseParameter(end) {
    const part = trimOWS(str.slice(start, end));
    const equals = part.indexOf("=");
    if (equals < 1) {
      return;
    }
    const name = trimOWS(part.slice(0, equals));
    if (!parameterNameRE.test(name)) {
      return;
    }
    const normalizedName = name.toLowerCase();
    if (normalizedName === "__proto__" || normalizedName === "constructor" || normalizedName === "prototype") {
      return;
    }
    const parameterValue = trimOWS(part.slice(equals + 1));
    parameters[normalizedName] = decodeQuotedString(parameterValue);
  }
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (code === 92) {
        escaped = true;
      } else if (code === 34) {
        quoted = false;
      }
    } else if (code === 34) {
      quoted = true;
    } else if (code === 44 || code === 59) {
      parseParameter(i);
      start = i + 1;
    }
  }
  parseParameter(str.length);
  return parameters;
}
const isValidHeaderName = (str) => /^[-_a-zA-Z0-9^`|~,!#$%&'*+.]+$/.test(str.trim());
function matchHeaderValue(context, value, header, filter2, isHeaderNameFilter) {
  if (utils$1.isFunction(filter2)) {
    return filter2.call(this, value, header);
  }
  if (isHeaderNameFilter) {
    value = header;
  }
  if (!utils$1.isString(value)) return;
  if (utils$1.isString(filter2)) {
    return value.indexOf(filter2) !== -1;
  }
  if (utils$1.isRegExp(filter2)) {
    return filter2.test(value);
  }
}
function formatHeader(header) {
  return header.trim().toLowerCase().replace(/([a-z\d])(\w*)/g, (w, char, str) => {
    return char.toUpperCase() + str;
  });
}
function buildAccessors(obj, header) {
  const accessorName = utils$1.toCamelCase(" " + header);
  ["get", "set", "has"].forEach((methodName) => {
    Object.defineProperty(obj, methodName + accessorName, {
      // Null-proto descriptor so a polluted Object.prototype.get cannot turn
      // this data descriptor into an accessor descriptor on the way in.
      __proto__: null,
      value: function(arg1, arg2, arg3) {
        return this[methodName].call(this, header, arg1, arg2, arg3);
      },
      configurable: true
    });
  });
}
let AxiosHeaders$1 = class AxiosHeaders {
  constructor(headers) {
    headers && this.set(headers);
  }
  set(header, valueOrRewrite, rewrite) {
    const self2 = this;
    function setHeader(_value, _header, _rewrite) {
      const lHeader = normalizeHeader(_header);
      if (!lHeader) {
        return;
      }
      const key = utils$1.findKey(self2, lHeader);
      if (!key || self2[key] === void 0 || _rewrite === true || _rewrite === void 0 && self2[key] !== false) {
        self2[key || _header] = normalizeValue(_value);
      }
    }
    const setHeaders = (headers, _rewrite) => utils$1.forEach(headers, (_value, _header) => setHeader(_value, _header, _rewrite));
    if (utils$1.isPlainObject(header) || header instanceof this.constructor) {
      setHeaders(header, valueOrRewrite);
    } else if (utils$1.isString(header) && (header = header.trim()) && !isValidHeaderName(header)) {
      setHeaders(parseHeaders(header), valueOrRewrite);
    } else if (utils$1.isObject(header) && utils$1.isSafeIterable(header)) {
      let obj = /* @__PURE__ */ Object.create(null), dest, key;
      for (const entry of header) {
        if (!utils$1.isArray(entry)) {
          throw new TypeError("Object iterator must return a key-value pair");
        }
        key = entry[0];
        if (utils$1.hasOwnProp(obj, key)) {
          dest = obj[key];
          obj[key] = utils$1.isArray(dest) ? [...dest, entry[1]] : [dest, entry[1]];
        } else {
          obj[key] = entry[1];
        }
      }
      setHeaders(obj, valueOrRewrite);
    } else {
      header != null && setHeader(valueOrRewrite, header, rewrite);
    }
    return this;
  }
  get(header, parser) {
    header = normalizeHeader(header);
    if (header) {
      const key = utils$1.findKey(this, header);
      if (key) {
        const value = this[key];
        if (!parser) {
          return value;
        }
        if (parser === true) {
          return parseTokens(value);
        }
        if (utils$1.isFunction(parser)) {
          return parser.call(this, value, key);
        }
        if (utils$1.isRegExp(parser)) {
          return parser.exec(value);
        }
        throw new TypeError("parser must be boolean|regexp|function");
      }
    }
  }
  has(header, matcher) {
    header = normalizeHeader(header);
    if (header) {
      const key = utils$1.findKey(this, header);
      return !!(key && this[key] !== void 0 && (!matcher || matchHeaderValue(this, this[key], key, matcher)));
    }
    return false;
  }
  delete(header, matcher) {
    const self2 = this;
    let deleted = false;
    function deleteHeader(_header) {
      _header = normalizeHeader(_header);
      if (_header) {
        const key = utils$1.findKey(self2, _header);
        if (key && (!matcher || matchHeaderValue(self2, self2[key], key, matcher))) {
          delete self2[key];
          deleted = true;
        }
      }
    }
    if (utils$1.isArray(header)) {
      header.forEach(deleteHeader);
    } else {
      deleteHeader(header);
    }
    return deleted;
  }
  clear(matcher) {
    const keys = Object.keys(this);
    let i = keys.length;
    let deleted = false;
    while (i--) {
      const key = keys[i];
      if (!matcher || matchHeaderValue(this, this[key], key, matcher, true)) {
        delete this[key];
        deleted = true;
      }
    }
    return deleted;
  }
  normalize(format) {
    const self2 = this;
    const headers = {};
    utils$1.forEach(this, (value, header) => {
      const key = utils$1.findKey(headers, header);
      if (key) {
        self2[key] = normalizeValue(value);
        delete self2[header];
        return;
      }
      const normalized = format ? formatHeader(header) : String(header).trim();
      if (normalized !== header) {
        delete self2[header];
      }
      self2[normalized] = normalizeValue(value);
      headers[normalized] = true;
    });
    return this;
  }
  concat(...targets) {
    return this.constructor.concat(this, ...targets);
  }
  toJSON(asStrings) {
    const obj = /* @__PURE__ */ Object.create(null);
    utils$1.forEach(this, (value, header) => {
      value != null && value !== false && (obj[header] = asStrings && utils$1.isArray(value) ? value.join(", ") : value);
    });
    return obj;
  }
  [Symbol.iterator]() {
    return Object.entries(this.toJSON())[Symbol.iterator]();
  }
  toString() {
    return Object.entries(this.toJSON()).map(([header, value]) => header + ": " + value).join("\n");
  }
  getSetCookie() {
    const value = this.get("set-cookie");
    return utils$1.isArray(value) ? value : value == null || value === false ? [] : [value];
  }
  get [Symbol.toStringTag]() {
    return "AxiosHeaders";
  }
  static from(thing) {
    return thing instanceof this ? thing : new this(thing);
  }
  static parseParameters(value) {
    return parseParameters(value);
  }
  static concat(first, ...targets) {
    const computed = new this(first);
    targets.forEach((target) => computed.set(target));
    return computed;
  }
  static accessor(header) {
    const internals = this[$internals] = this[$internals] = {
      accessors: {}
    };
    const accessors = internals.accessors;
    const prototype2 = this.prototype;
    function defineAccessor(_header) {
      const lHeader = normalizeHeader(_header);
      if (!accessors[lHeader]) {
        buildAccessors(prototype2, _header);
        accessors[lHeader] = true;
      }
    }
    utils$1.isArray(header) ? header.forEach(defineAccessor) : defineAccessor(header);
    return this;
  }
};
AxiosHeaders$1.accessor([
  "Content-Type",
  "Content-Length",
  "Accept",
  "Accept-Encoding",
  "User-Agent",
  "Authorization"
]);
utils$1.reduceDescriptors(AxiosHeaders$1.prototype, ({ value }, key) => {
  let mapped = key[0].toUpperCase() + key.slice(1);
  return {
    get: () => value,
    set(headerValue) {
      this[mapped] = headerValue;
    }
  };
});
utils$1.freezeMethods(AxiosHeaders$1);
const REDACTED = "[REDACTED ****]";
function hasOwnOrPrototypeToJSON(source) {
  if (utils$1.hasOwnProp(source, "toJSON")) {
    return true;
  }
  let prototype2 = Object.getPrototypeOf(source);
  while (prototype2 && prototype2 !== Object.prototype) {
    if (utils$1.hasOwnProp(prototype2, "toJSON")) {
      return true;
    }
    prototype2 = Object.getPrototypeOf(prototype2);
  }
  return false;
}
function redactConfig(config, redactKeys) {
  const lowerKeys = new Set(redactKeys.map((k) => String(k).toLowerCase()));
  const seen = [];
  const visit = (source) => {
    if (source === null || typeof source !== "object") return source;
    if (utils$1.isBuffer(source)) return source;
    if (seen.indexOf(source) !== -1) return void 0;
    if (source instanceof AxiosHeaders$1) {
      source = source.toJSON();
    }
    seen.push(source);
    let result;
    if (utils$1.isArray(source)) {
      result = [];
      source.forEach((v, i) => {
        const reducedValue = visit(v);
        if (!utils$1.isUndefined(reducedValue)) {
          result[i] = reducedValue;
        }
      });
    } else {
      if (!utils$1.isPlainObject(source) && hasOwnOrPrototypeToJSON(source)) {
        seen.pop();
        return source;
      }
      result = /* @__PURE__ */ Object.create(null);
      for (const [key, value] of Object.entries(source)) {
        const reducedValue = lowerKeys.has(key.toLowerCase()) ? REDACTED : visit(value);
        if (!utils$1.isUndefined(reducedValue)) {
          result[key] = reducedValue;
        }
      }
    }
    seen.pop();
    return result;
  };
  return visit(config);
}
function stringifySafely$1(value) {
  try {
    return String(value);
  } catch (err) {
    return "";
  }
}
function aggregateErrorMessage(error) {
  const message = error.errors.map((entry) => {
    try {
      return entry && entry.message ? stringifySafely$1(entry.message) : stringifySafely$1(entry);
    } catch (err) {
      return "";
    }
  }).filter(Boolean).join("; ");
  return message || error.name || "AggregateError";
}
let AxiosError$1 = class AxiosError extends Error {
  static from(error, code, config, request, response, customProps) {
    let message = error.message;
    if (!message && utils$1.isArray(error.errors) && error.errors.length) {
      message = aggregateErrorMessage(error);
    }
    const axiosError = new AxiosError(message, code || error.code, config, request, response);
    Object.defineProperty(axiosError, "cause", {
      __proto__: null,
      value: error,
      writable: true,
      enumerable: false,
      configurable: true
    });
    axiosError.name = error.name;
    if (error.status != null && axiosError.status == null) {
      axiosError.status = error.status;
    }
    customProps && Object.assign(axiosError, customProps);
    return axiosError;
  }
  /**
   * Create an Error with the specified message, config, error code, request and response.
   *
   * @param {string} message The error message.
   * @param {string} [code] The error code (for example, 'ECONNABORTED').
   * @param {Object} [config] The config.
   * @param {Object} [request] The request.
   * @param {Object} [response] The response.
   *
   * @returns {Error} The created error.
   */
  constructor(message, code, config, request, response) {
    super(message);
    Object.defineProperty(this, "message", {
      // Null-proto descriptor so a polluted Object.prototype.get cannot turn
      // this data descriptor into an accessor descriptor on the way in.
      __proto__: null,
      value: message,
      enumerable: true,
      writable: true,
      configurable: true
    });
    this.name = "AxiosError";
    this.isAxiosError = true;
    code && (this.code = code);
    config && (this.config = config);
    request && (this.request = request);
    if (response) {
      this.response = response;
      this.status = response.status;
    }
  }
  toJSON() {
    const config = this.config;
    const redactKeys = config && utils$1.hasOwnProp(config, "redact") ? config.redact : void 0;
    const serializedConfig = utils$1.isArray(redactKeys) && redactKeys.length > 0 ? redactConfig(config, redactKeys) : utils$1.toJSONObject(config);
    return {
      // Standard
      message: this.message,
      name: this.name,
      // Microsoft
      description: this.description,
      number: this.number,
      // Mozilla
      fileName: this.fileName,
      lineNumber: this.lineNumber,
      columnNumber: this.columnNumber,
      stack: this.stack,
      // Axios
      config: serializedConfig,
      code: this.code,
      status: this.status
    };
  }
};
AxiosError$1.ERR_BAD_OPTION_VALUE = "ERR_BAD_OPTION_VALUE";
AxiosError$1.ERR_BAD_OPTION = "ERR_BAD_OPTION";
AxiosError$1.ECONNABORTED = "ECONNABORTED";
AxiosError$1.ETIMEDOUT = "ETIMEDOUT";
AxiosError$1.ECONNREFUSED = "ECONNREFUSED";
AxiosError$1.ERR_NETWORK = "ERR_NETWORK";
AxiosError$1.ERR_FR_TOO_MANY_REDIRECTS = "ERR_FR_TOO_MANY_REDIRECTS";
AxiosError$1.ERR_DEPRECATED = "ERR_DEPRECATED";
AxiosError$1.ERR_BAD_RESPONSE = "ERR_BAD_RESPONSE";
AxiosError$1.ERR_BAD_REQUEST = "ERR_BAD_REQUEST";
AxiosError$1.ERR_CANCELED = "ERR_CANCELED";
AxiosError$1.ERR_NOT_SUPPORT = "ERR_NOT_SUPPORT";
AxiosError$1.ERR_INVALID_URL = "ERR_INVALID_URL";
AxiosError$1.ERR_FORM_DATA_DEPTH_EXCEEDED = "ERR_FORM_DATA_DEPTH_EXCEEDED";
function getDefaultExportFromCjs(x) {
  return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var delayed_stream;
var hasRequiredDelayed_stream;
function requireDelayed_stream() {
  if (hasRequiredDelayed_stream) return delayed_stream;
  hasRequiredDelayed_stream = 1;
  var Stream = stream.Stream;
  var util = require$$1;
  delayed_stream = DelayedStream;
  function DelayedStream() {
    this.source = null;
    this.dataSize = 0;
    this.maxDataSize = 1024 * 1024;
    this.pauseStream = true;
    this._maxDataSizeExceeded = false;
    this._released = false;
    this._bufferedEvents = [];
  }
  util.inherits(DelayedStream, Stream);
  DelayedStream.create = function(source, options) {
    var delayedStream = new this();
    options = options || {};
    for (var option in options) {
      delayedStream[option] = options[option];
    }
    delayedStream.source = source;
    var realEmit = source.emit;
    source.emit = function() {
      delayedStream._handleEmit(arguments);
      return realEmit.apply(source, arguments);
    };
    source.on("error", function() {
    });
    if (delayedStream.pauseStream) {
      source.pause();
    }
    return delayedStream;
  };
  Object.defineProperty(DelayedStream.prototype, "readable", {
    configurable: true,
    enumerable: true,
    get: function() {
      return this.source.readable;
    }
  });
  DelayedStream.prototype.setEncoding = function() {
    return this.source.setEncoding.apply(this.source, arguments);
  };
  DelayedStream.prototype.resume = function() {
    if (!this._released) {
      this.release();
    }
    this.source.resume();
  };
  DelayedStream.prototype.pause = function() {
    this.source.pause();
  };
  DelayedStream.prototype.release = function() {
    this._released = true;
    this._bufferedEvents.forEach(function(args) {
      this.emit.apply(this, args);
    }.bind(this));
    this._bufferedEvents = [];
  };
  DelayedStream.prototype.pipe = function() {
    var r = Stream.prototype.pipe.apply(this, arguments);
    this.resume();
    return r;
  };
  DelayedStream.prototype._handleEmit = function(args) {
    if (this._released) {
      this.emit.apply(this, args);
      return;
    }
    if (args[0] === "data") {
      this.dataSize += args[1].length;
      this._checkIfMaxDataSizeExceeded();
    }
    this._bufferedEvents.push(args);
  };
  DelayedStream.prototype._checkIfMaxDataSizeExceeded = function() {
    if (this._maxDataSizeExceeded) {
      return;
    }
    if (this.dataSize <= this.maxDataSize) {
      return;
    }
    this._maxDataSizeExceeded = true;
    var message = "DelayedStream#maxDataSize of " + this.maxDataSize + " bytes exceeded.";
    this.emit("error", new Error(message));
  };
  return delayed_stream;
}
var combined_stream;
var hasRequiredCombined_stream;
function requireCombined_stream() {
  if (hasRequiredCombined_stream) return combined_stream;
  hasRequiredCombined_stream = 1;
  var util = require$$1;
  var Stream = stream.Stream;
  var DelayedStream = requireDelayed_stream();
  combined_stream = CombinedStream;
  function CombinedStream() {
    this.writable = false;
    this.readable = true;
    this.dataSize = 0;
    this.maxDataSize = 2 * 1024 * 1024;
    this.pauseStreams = true;
    this._released = false;
    this._streams = [];
    this._currentStream = null;
    this._insideLoop = false;
    this._pendingNext = false;
  }
  util.inherits(CombinedStream, Stream);
  CombinedStream.create = function(options) {
    var combinedStream = new this();
    options = options || {};
    for (var option in options) {
      combinedStream[option] = options[option];
    }
    return combinedStream;
  };
  CombinedStream.isStreamLike = function(stream2) {
    return typeof stream2 !== "function" && typeof stream2 !== "string" && typeof stream2 !== "boolean" && typeof stream2 !== "number" && !Buffer.isBuffer(stream2);
  };
  CombinedStream.prototype.append = function(stream2) {
    var isStreamLike = CombinedStream.isStreamLike(stream2);
    if (isStreamLike) {
      if (!(stream2 instanceof DelayedStream)) {
        var newStream = DelayedStream.create(stream2, {
          maxDataSize: Infinity,
          pauseStream: this.pauseStreams
        });
        stream2.on("data", this._checkDataSize.bind(this));
        stream2 = newStream;
      }
      this._handleErrors(stream2);
      if (this.pauseStreams) {
        stream2.pause();
      }
    }
    this._streams.push(stream2);
    return this;
  };
  CombinedStream.prototype.pipe = function(dest, options) {
    Stream.prototype.pipe.call(this, dest, options);
    this.resume();
    return dest;
  };
  CombinedStream.prototype._getNext = function() {
    this._currentStream = null;
    if (this._insideLoop) {
      this._pendingNext = true;
      return;
    }
    this._insideLoop = true;
    try {
      do {
        this._pendingNext = false;
        this._realGetNext();
      } while (this._pendingNext);
    } finally {
      this._insideLoop = false;
    }
  };
  CombinedStream.prototype._realGetNext = function() {
    var stream2 = this._streams.shift();
    if (typeof stream2 == "undefined") {
      this.end();
      return;
    }
    if (typeof stream2 !== "function") {
      this._pipeNext(stream2);
      return;
    }
    var getStream = stream2;
    getStream(function(stream3) {
      var isStreamLike = CombinedStream.isStreamLike(stream3);
      if (isStreamLike) {
        stream3.on("data", this._checkDataSize.bind(this));
        this._handleErrors(stream3);
      }
      this._pipeNext(stream3);
    }.bind(this));
  };
  CombinedStream.prototype._pipeNext = function(stream2) {
    this._currentStream = stream2;
    var isStreamLike = CombinedStream.isStreamLike(stream2);
    if (isStreamLike) {
      stream2.on("end", this._getNext.bind(this));
      stream2.pipe(this, { end: false });
      return;
    }
    var value = stream2;
    this.write(value);
    this._getNext();
  };
  CombinedStream.prototype._handleErrors = function(stream2) {
    var self2 = this;
    stream2.on("error", function(err) {
      self2._emitError(err);
    });
  };
  CombinedStream.prototype.write = function(data) {
    this.emit("data", data);
  };
  CombinedStream.prototype.pause = function() {
    if (!this.pauseStreams) {
      return;
    }
    if (this.pauseStreams && this._currentStream && typeof this._currentStream.pause == "function") this._currentStream.pause();
    this.emit("pause");
  };
  CombinedStream.prototype.resume = function() {
    if (!this._released) {
      this._released = true;
      this.writable = true;
      this._getNext();
    }
    if (this.pauseStreams && this._currentStream && typeof this._currentStream.resume == "function") this._currentStream.resume();
    this.emit("resume");
  };
  CombinedStream.prototype.end = function() {
    this._reset();
    this.emit("end");
  };
  CombinedStream.prototype.destroy = function() {
    this._reset();
    this.emit("close");
  };
  CombinedStream.prototype._reset = function() {
    this.writable = false;
    this._streams = [];
    this._currentStream = null;
  };
  CombinedStream.prototype._checkDataSize = function() {
    this._updateDataSize();
    if (this.dataSize <= this.maxDataSize) {
      return;
    }
    var message = "DelayedStream#maxDataSize of " + this.maxDataSize + " bytes exceeded.";
    this._emitError(new Error(message));
  };
  CombinedStream.prototype._updateDataSize = function() {
    this.dataSize = 0;
    var self2 = this;
    this._streams.forEach(function(stream2) {
      if (!stream2.dataSize) {
        return;
      }
      self2.dataSize += stream2.dataSize;
    });
    if (this._currentStream && this._currentStream.dataSize) {
      this.dataSize += this._currentStream.dataSize;
    }
  };
  CombinedStream.prototype._emitError = function(err) {
    this._reset();
    this.emit("error", err);
  };
  return combined_stream;
}
var mimeTypes = {};
const require$$0 = {
  "application/1d-interleaved-parityfec": { "source": "iana" },
  "application/3gpdash-qoe-report+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/3gpp-ims+xml": { "source": "iana", "compressible": true },
  "application/3gpphal+json": { "source": "iana", "compressible": true },
  "application/3gpphalforms+json": { "source": "iana", "compressible": true },
  "application/a2l": { "source": "iana" },
  "application/ace+cbor": { "source": "iana" },
  "application/activemessage": { "source": "iana" },
  "application/activity+json": { "source": "iana", "compressible": true },
  "application/alto-costmap+json": { "source": "iana", "compressible": true },
  "application/alto-costmapfilter+json": { "source": "iana", "compressible": true },
  "application/alto-directory+json": { "source": "iana", "compressible": true },
  "application/alto-endpointcost+json": { "source": "iana", "compressible": true },
  "application/alto-endpointcostparams+json": { "source": "iana", "compressible": true },
  "application/alto-endpointprop+json": { "source": "iana", "compressible": true },
  "application/alto-endpointpropparams+json": { "source": "iana", "compressible": true },
  "application/alto-error+json": { "source": "iana", "compressible": true },
  "application/alto-networkmap+json": { "source": "iana", "compressible": true },
  "application/alto-networkmapfilter+json": { "source": "iana", "compressible": true },
  "application/alto-updatestreamcontrol+json": { "source": "iana", "compressible": true },
  "application/alto-updatestreamparams+json": { "source": "iana", "compressible": true },
  "application/aml": { "source": "iana" },
  "application/andrew-inset": { "source": "iana", "extensions": ["ez"] },
  "application/applefile": { "source": "iana" },
  "application/applixware": { "source": "apache", "extensions": ["aw"] },
  "application/at+jwt": { "source": "iana" },
  "application/atf": { "source": "iana" },
  "application/atfx": { "source": "iana" },
  "application/atom+xml": { "source": "iana", "compressible": true, "extensions": ["atom"] },
  "application/atomcat+xml": { "source": "iana", "compressible": true, "extensions": ["atomcat"] },
  "application/atomdeleted+xml": { "source": "iana", "compressible": true, "extensions": ["atomdeleted"] },
  "application/atomicmail": { "source": "iana" },
  "application/atomsvc+xml": { "source": "iana", "compressible": true, "extensions": ["atomsvc"] },
  "application/atsc-dwd+xml": { "source": "iana", "compressible": true, "extensions": ["dwd"] },
  "application/atsc-dynamic-event-message": { "source": "iana" },
  "application/atsc-held+xml": { "source": "iana", "compressible": true, "extensions": ["held"] },
  "application/atsc-rdt+json": { "source": "iana", "compressible": true },
  "application/atsc-rsat+xml": { "source": "iana", "compressible": true, "extensions": ["rsat"] },
  "application/atxml": { "source": "iana" },
  "application/auth-policy+xml": { "source": "iana", "compressible": true },
  "application/bacnet-xdd+zip": { "source": "iana", "compressible": false },
  "application/batch-smtp": { "source": "iana" },
  "application/bdoc": { "compressible": false, "extensions": ["bdoc"] },
  "application/beep+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/calendar+json": { "source": "iana", "compressible": true },
  "application/calendar+xml": { "source": "iana", "compressible": true, "extensions": ["xcs"] },
  "application/call-completion": { "source": "iana" },
  "application/cals-1840": { "source": "iana" },
  "application/captive+json": { "source": "iana", "compressible": true },
  "application/cbor": { "source": "iana" },
  "application/cbor-seq": { "source": "iana" },
  "application/cccex": { "source": "iana" },
  "application/ccmp+xml": { "source": "iana", "compressible": true },
  "application/ccxml+xml": { "source": "iana", "compressible": true, "extensions": ["ccxml"] },
  "application/cdfx+xml": { "source": "iana", "compressible": true, "extensions": ["cdfx"] },
  "application/cdmi-capability": { "source": "iana", "extensions": ["cdmia"] },
  "application/cdmi-container": { "source": "iana", "extensions": ["cdmic"] },
  "application/cdmi-domain": { "source": "iana", "extensions": ["cdmid"] },
  "application/cdmi-object": { "source": "iana", "extensions": ["cdmio"] },
  "application/cdmi-queue": { "source": "iana", "extensions": ["cdmiq"] },
  "application/cdni": { "source": "iana" },
  "application/cea": { "source": "iana" },
  "application/cea-2018+xml": { "source": "iana", "compressible": true },
  "application/cellml+xml": { "source": "iana", "compressible": true },
  "application/cfw": { "source": "iana" },
  "application/city+json": { "source": "iana", "compressible": true },
  "application/clr": { "source": "iana" },
  "application/clue+xml": { "source": "iana", "compressible": true },
  "application/clue_info+xml": { "source": "iana", "compressible": true },
  "application/cms": { "source": "iana" },
  "application/cnrp+xml": { "source": "iana", "compressible": true },
  "application/coap-group+json": { "source": "iana", "compressible": true },
  "application/coap-payload": { "source": "iana" },
  "application/commonground": { "source": "iana" },
  "application/conference-info+xml": { "source": "iana", "compressible": true },
  "application/cose": { "source": "iana" },
  "application/cose-key": { "source": "iana" },
  "application/cose-key-set": { "source": "iana" },
  "application/cpl+xml": { "source": "iana", "compressible": true, "extensions": ["cpl"] },
  "application/csrattrs": { "source": "iana" },
  "application/csta+xml": { "source": "iana", "compressible": true },
  "application/cstadata+xml": { "source": "iana", "compressible": true },
  "application/csvm+json": { "source": "iana", "compressible": true },
  "application/cu-seeme": { "source": "apache", "extensions": ["cu"] },
  "application/cwt": { "source": "iana" },
  "application/cybercash": { "source": "iana" },
  "application/dart": { "compressible": true },
  "application/dash+xml": { "source": "iana", "compressible": true, "extensions": ["mpd"] },
  "application/dash-patch+xml": { "source": "iana", "compressible": true, "extensions": ["mpp"] },
  "application/dashdelta": { "source": "iana" },
  "application/davmount+xml": { "source": "iana", "compressible": true, "extensions": ["davmount"] },
  "application/dca-rft": { "source": "iana" },
  "application/dcd": { "source": "iana" },
  "application/dec-dx": { "source": "iana" },
  "application/dialog-info+xml": { "source": "iana", "compressible": true },
  "application/dicom": { "source": "iana" },
  "application/dicom+json": { "source": "iana", "compressible": true },
  "application/dicom+xml": { "source": "iana", "compressible": true },
  "application/dii": { "source": "iana" },
  "application/dit": { "source": "iana" },
  "application/dns": { "source": "iana" },
  "application/dns+json": { "source": "iana", "compressible": true },
  "application/dns-message": { "source": "iana" },
  "application/docbook+xml": { "source": "apache", "compressible": true, "extensions": ["dbk"] },
  "application/dots+cbor": { "source": "iana" },
  "application/dskpp+xml": { "source": "iana", "compressible": true },
  "application/dssc+der": { "source": "iana", "extensions": ["dssc"] },
  "application/dssc+xml": { "source": "iana", "compressible": true, "extensions": ["xdssc"] },
  "application/dvcs": { "source": "iana" },
  "application/ecmascript": { "source": "iana", "compressible": true, "extensions": ["es", "ecma"] },
  "application/edi-consent": { "source": "iana" },
  "application/edi-x12": { "source": "iana", "compressible": false },
  "application/edifact": { "source": "iana", "compressible": false },
  "application/efi": { "source": "iana" },
  "application/elm+json": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/elm+xml": { "source": "iana", "compressible": true },
  "application/emergencycalldata.cap+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/emergencycalldata.comment+xml": { "source": "iana", "compressible": true },
  "application/emergencycalldata.control+xml": { "source": "iana", "compressible": true },
  "application/emergencycalldata.deviceinfo+xml": { "source": "iana", "compressible": true },
  "application/emergencycalldata.ecall.msd": { "source": "iana" },
  "application/emergencycalldata.providerinfo+xml": { "source": "iana", "compressible": true },
  "application/emergencycalldata.serviceinfo+xml": { "source": "iana", "compressible": true },
  "application/emergencycalldata.subscriberinfo+xml": { "source": "iana", "compressible": true },
  "application/emergencycalldata.veds+xml": { "source": "iana", "compressible": true },
  "application/emma+xml": { "source": "iana", "compressible": true, "extensions": ["emma"] },
  "application/emotionml+xml": { "source": "iana", "compressible": true, "extensions": ["emotionml"] },
  "application/encaprtp": { "source": "iana" },
  "application/epp+xml": { "source": "iana", "compressible": true },
  "application/epub+zip": { "source": "iana", "compressible": false, "extensions": ["epub"] },
  "application/eshop": { "source": "iana" },
  "application/exi": { "source": "iana", "extensions": ["exi"] },
  "application/expect-ct-report+json": { "source": "iana", "compressible": true },
  "application/express": { "source": "iana", "extensions": ["exp"] },
  "application/fastinfoset": { "source": "iana" },
  "application/fastsoap": { "source": "iana" },
  "application/fdt+xml": { "source": "iana", "compressible": true, "extensions": ["fdt"] },
  "application/fhir+json": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/fhir+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/fido.trusted-apps+json": { "compressible": true },
  "application/fits": { "source": "iana" },
  "application/flexfec": { "source": "iana" },
  "application/font-sfnt": { "source": "iana" },
  "application/font-tdpfr": { "source": "iana", "extensions": ["pfr"] },
  "application/font-woff": { "source": "iana", "compressible": false },
  "application/framework-attributes+xml": { "source": "iana", "compressible": true },
  "application/geo+json": { "source": "iana", "compressible": true, "extensions": ["geojson"] },
  "application/geo+json-seq": { "source": "iana" },
  "application/geopackage+sqlite3": { "source": "iana" },
  "application/geoxacml+xml": { "source": "iana", "compressible": true },
  "application/gltf-buffer": { "source": "iana" },
  "application/gml+xml": { "source": "iana", "compressible": true, "extensions": ["gml"] },
  "application/gpx+xml": { "source": "apache", "compressible": true, "extensions": ["gpx"] },
  "application/gxf": { "source": "apache", "extensions": ["gxf"] },
  "application/gzip": { "source": "iana", "compressible": false, "extensions": ["gz"] },
  "application/h224": { "source": "iana" },
  "application/held+xml": { "source": "iana", "compressible": true },
  "application/hjson": { "extensions": ["hjson"] },
  "application/http": { "source": "iana" },
  "application/hyperstudio": { "source": "iana", "extensions": ["stk"] },
  "application/ibe-key-request+xml": { "source": "iana", "compressible": true },
  "application/ibe-pkg-reply+xml": { "source": "iana", "compressible": true },
  "application/ibe-pp-data": { "source": "iana" },
  "application/iges": { "source": "iana" },
  "application/im-iscomposing+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/index": { "source": "iana" },
  "application/index.cmd": { "source": "iana" },
  "application/index.obj": { "source": "iana" },
  "application/index.response": { "source": "iana" },
  "application/index.vnd": { "source": "iana" },
  "application/inkml+xml": { "source": "iana", "compressible": true, "extensions": ["ink", "inkml"] },
  "application/iotp": { "source": "iana" },
  "application/ipfix": { "source": "iana", "extensions": ["ipfix"] },
  "application/ipp": { "source": "iana" },
  "application/isup": { "source": "iana" },
  "application/its+xml": { "source": "iana", "compressible": true, "extensions": ["its"] },
  "application/java-archive": { "source": "apache", "compressible": false, "extensions": ["jar", "war", "ear"] },
  "application/java-serialized-object": { "source": "apache", "compressible": false, "extensions": ["ser"] },
  "application/java-vm": { "source": "apache", "compressible": false, "extensions": ["class"] },
  "application/javascript": { "source": "iana", "charset": "UTF-8", "compressible": true, "extensions": ["js", "mjs"] },
  "application/jf2feed+json": { "source": "iana", "compressible": true },
  "application/jose": { "source": "iana" },
  "application/jose+json": { "source": "iana", "compressible": true },
  "application/jrd+json": { "source": "iana", "compressible": true },
  "application/jscalendar+json": { "source": "iana", "compressible": true },
  "application/json": { "source": "iana", "charset": "UTF-8", "compressible": true, "extensions": ["json", "map"] },
  "application/json-patch+json": { "source": "iana", "compressible": true },
  "application/json-seq": { "source": "iana" },
  "application/json5": { "extensions": ["json5"] },
  "application/jsonml+json": { "source": "apache", "compressible": true, "extensions": ["jsonml"] },
  "application/jwk+json": { "source": "iana", "compressible": true },
  "application/jwk-set+json": { "source": "iana", "compressible": true },
  "application/jwt": { "source": "iana" },
  "application/kpml-request+xml": { "source": "iana", "compressible": true },
  "application/kpml-response+xml": { "source": "iana", "compressible": true },
  "application/ld+json": { "source": "iana", "compressible": true, "extensions": ["jsonld"] },
  "application/lgr+xml": { "source": "iana", "compressible": true, "extensions": ["lgr"] },
  "application/link-format": { "source": "iana" },
  "application/load-control+xml": { "source": "iana", "compressible": true },
  "application/lost+xml": { "source": "iana", "compressible": true, "extensions": ["lostxml"] },
  "application/lostsync+xml": { "source": "iana", "compressible": true },
  "application/lpf+zip": { "source": "iana", "compressible": false },
  "application/lxf": { "source": "iana" },
  "application/mac-binhex40": { "source": "iana", "extensions": ["hqx"] },
  "application/mac-compactpro": { "source": "apache", "extensions": ["cpt"] },
  "application/macwriteii": { "source": "iana" },
  "application/mads+xml": { "source": "iana", "compressible": true, "extensions": ["mads"] },
  "application/manifest+json": { "source": "iana", "charset": "UTF-8", "compressible": true, "extensions": ["webmanifest"] },
  "application/marc": { "source": "iana", "extensions": ["mrc"] },
  "application/marcxml+xml": { "source": "iana", "compressible": true, "extensions": ["mrcx"] },
  "application/mathematica": { "source": "iana", "extensions": ["ma", "nb", "mb"] },
  "application/mathml+xml": { "source": "iana", "compressible": true, "extensions": ["mathml"] },
  "application/mathml-content+xml": { "source": "iana", "compressible": true },
  "application/mathml-presentation+xml": { "source": "iana", "compressible": true },
  "application/mbms-associated-procedure-description+xml": { "source": "iana", "compressible": true },
  "application/mbms-deregister+xml": { "source": "iana", "compressible": true },
  "application/mbms-envelope+xml": { "source": "iana", "compressible": true },
  "application/mbms-msk+xml": { "source": "iana", "compressible": true },
  "application/mbms-msk-response+xml": { "source": "iana", "compressible": true },
  "application/mbms-protection-description+xml": { "source": "iana", "compressible": true },
  "application/mbms-reception-report+xml": { "source": "iana", "compressible": true },
  "application/mbms-register+xml": { "source": "iana", "compressible": true },
  "application/mbms-register-response+xml": { "source": "iana", "compressible": true },
  "application/mbms-schedule+xml": { "source": "iana", "compressible": true },
  "application/mbms-user-service-description+xml": { "source": "iana", "compressible": true },
  "application/mbox": { "source": "iana", "extensions": ["mbox"] },
  "application/media-policy-dataset+xml": { "source": "iana", "compressible": true, "extensions": ["mpf"] },
  "application/media_control+xml": { "source": "iana", "compressible": true },
  "application/mediaservercontrol+xml": { "source": "iana", "compressible": true, "extensions": ["mscml"] },
  "application/merge-patch+json": { "source": "iana", "compressible": true },
  "application/metalink+xml": { "source": "apache", "compressible": true, "extensions": ["metalink"] },
  "application/metalink4+xml": { "source": "iana", "compressible": true, "extensions": ["meta4"] },
  "application/mets+xml": { "source": "iana", "compressible": true, "extensions": ["mets"] },
  "application/mf4": { "source": "iana" },
  "application/mikey": { "source": "iana" },
  "application/mipc": { "source": "iana" },
  "application/missing-blocks+cbor-seq": { "source": "iana" },
  "application/mmt-aei+xml": { "source": "iana", "compressible": true, "extensions": ["maei"] },
  "application/mmt-usd+xml": { "source": "iana", "compressible": true, "extensions": ["musd"] },
  "application/mods+xml": { "source": "iana", "compressible": true, "extensions": ["mods"] },
  "application/moss-keys": { "source": "iana" },
  "application/moss-signature": { "source": "iana" },
  "application/mosskey-data": { "source": "iana" },
  "application/mosskey-request": { "source": "iana" },
  "application/mp21": { "source": "iana", "extensions": ["m21", "mp21"] },
  "application/mp4": { "source": "iana", "extensions": ["mp4s", "m4p"] },
  "application/mpeg4-generic": { "source": "iana" },
  "application/mpeg4-iod": { "source": "iana" },
  "application/mpeg4-iod-xmt": { "source": "iana" },
  "application/mrb-consumer+xml": { "source": "iana", "compressible": true },
  "application/mrb-publish+xml": { "source": "iana", "compressible": true },
  "application/msc-ivr+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/msc-mixer+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/msword": { "source": "iana", "compressible": false, "extensions": ["doc", "dot"] },
  "application/mud+json": { "source": "iana", "compressible": true },
  "application/multipart-core": { "source": "iana" },
  "application/mxf": { "source": "iana", "extensions": ["mxf"] },
  "application/n-quads": { "source": "iana", "extensions": ["nq"] },
  "application/n-triples": { "source": "iana", "extensions": ["nt"] },
  "application/nasdata": { "source": "iana" },
  "application/news-checkgroups": { "source": "iana", "charset": "US-ASCII" },
  "application/news-groupinfo": { "source": "iana", "charset": "US-ASCII" },
  "application/news-transmission": { "source": "iana" },
  "application/nlsml+xml": { "source": "iana", "compressible": true },
  "application/node": { "source": "iana", "extensions": ["cjs"] },
  "application/nss": { "source": "iana" },
  "application/oauth-authz-req+jwt": { "source": "iana" },
  "application/oblivious-dns-message": { "source": "iana" },
  "application/ocsp-request": { "source": "iana" },
  "application/ocsp-response": { "source": "iana" },
  "application/octet-stream": { "source": "iana", "compressible": false, "extensions": ["bin", "dms", "lrf", "mar", "so", "dist", "distz", "pkg", "bpk", "dump", "elc", "deploy", "exe", "dll", "deb", "dmg", "iso", "img", "msi", "msp", "msm", "buffer"] },
  "application/oda": { "source": "iana", "extensions": ["oda"] },
  "application/odm+xml": { "source": "iana", "compressible": true },
  "application/odx": { "source": "iana" },
  "application/oebps-package+xml": { "source": "iana", "compressible": true, "extensions": ["opf"] },
  "application/ogg": { "source": "iana", "compressible": false, "extensions": ["ogx"] },
  "application/omdoc+xml": { "source": "apache", "compressible": true, "extensions": ["omdoc"] },
  "application/onenote": { "source": "apache", "extensions": ["onetoc", "onetoc2", "onetmp", "onepkg"] },
  "application/opc-nodeset+xml": { "source": "iana", "compressible": true },
  "application/oscore": { "source": "iana" },
  "application/oxps": { "source": "iana", "extensions": ["oxps"] },
  "application/p21": { "source": "iana" },
  "application/p21+zip": { "source": "iana", "compressible": false },
  "application/p2p-overlay+xml": { "source": "iana", "compressible": true, "extensions": ["relo"] },
  "application/parityfec": { "source": "iana" },
  "application/passport": { "source": "iana" },
  "application/patch-ops-error+xml": { "source": "iana", "compressible": true, "extensions": ["xer"] },
  "application/pdf": { "source": "iana", "compressible": false, "extensions": ["pdf"] },
  "application/pdx": { "source": "iana" },
  "application/pem-certificate-chain": { "source": "iana" },
  "application/pgp-encrypted": { "source": "iana", "compressible": false, "extensions": ["pgp"] },
  "application/pgp-keys": { "source": "iana", "extensions": ["asc"] },
  "application/pgp-signature": { "source": "iana", "extensions": ["asc", "sig"] },
  "application/pics-rules": { "source": "apache", "extensions": ["prf"] },
  "application/pidf+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/pidf-diff+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/pkcs10": { "source": "iana", "extensions": ["p10"] },
  "application/pkcs12": { "source": "iana" },
  "application/pkcs7-mime": { "source": "iana", "extensions": ["p7m", "p7c"] },
  "application/pkcs7-signature": { "source": "iana", "extensions": ["p7s"] },
  "application/pkcs8": { "source": "iana", "extensions": ["p8"] },
  "application/pkcs8-encrypted": { "source": "iana" },
  "application/pkix-attr-cert": { "source": "iana", "extensions": ["ac"] },
  "application/pkix-cert": { "source": "iana", "extensions": ["cer"] },
  "application/pkix-crl": { "source": "iana", "extensions": ["crl"] },
  "application/pkix-pkipath": { "source": "iana", "extensions": ["pkipath"] },
  "application/pkixcmp": { "source": "iana", "extensions": ["pki"] },
  "application/pls+xml": { "source": "iana", "compressible": true, "extensions": ["pls"] },
  "application/poc-settings+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/postscript": { "source": "iana", "compressible": true, "extensions": ["ai", "eps", "ps"] },
  "application/ppsp-tracker+json": { "source": "iana", "compressible": true },
  "application/problem+json": { "source": "iana", "compressible": true },
  "application/problem+xml": { "source": "iana", "compressible": true },
  "application/provenance+xml": { "source": "iana", "compressible": true, "extensions": ["provx"] },
  "application/prs.alvestrand.titrax-sheet": { "source": "iana" },
  "application/prs.cww": { "source": "iana", "extensions": ["cww"] },
  "application/prs.cyn": { "source": "iana", "charset": "7-BIT" },
  "application/prs.hpub+zip": { "source": "iana", "compressible": false },
  "application/prs.nprend": { "source": "iana" },
  "application/prs.plucker": { "source": "iana" },
  "application/prs.rdf-xml-crypt": { "source": "iana" },
  "application/prs.xsf+xml": { "source": "iana", "compressible": true },
  "application/pskc+xml": { "source": "iana", "compressible": true, "extensions": ["pskcxml"] },
  "application/pvd+json": { "source": "iana", "compressible": true },
  "application/qsig": { "source": "iana" },
  "application/raml+yaml": { "compressible": true, "extensions": ["raml"] },
  "application/raptorfec": { "source": "iana" },
  "application/rdap+json": { "source": "iana", "compressible": true },
  "application/rdf+xml": { "source": "iana", "compressible": true, "extensions": ["rdf", "owl"] },
  "application/reginfo+xml": { "source": "iana", "compressible": true, "extensions": ["rif"] },
  "application/relax-ng-compact-syntax": { "source": "iana", "extensions": ["rnc"] },
  "application/remote-printing": { "source": "iana" },
  "application/reputon+json": { "source": "iana", "compressible": true },
  "application/resource-lists+xml": { "source": "iana", "compressible": true, "extensions": ["rl"] },
  "application/resource-lists-diff+xml": { "source": "iana", "compressible": true, "extensions": ["rld"] },
  "application/rfc+xml": { "source": "iana", "compressible": true },
  "application/riscos": { "source": "iana" },
  "application/rlmi+xml": { "source": "iana", "compressible": true },
  "application/rls-services+xml": { "source": "iana", "compressible": true, "extensions": ["rs"] },
  "application/route-apd+xml": { "source": "iana", "compressible": true, "extensions": ["rapd"] },
  "application/route-s-tsid+xml": { "source": "iana", "compressible": true, "extensions": ["sls"] },
  "application/route-usd+xml": { "source": "iana", "compressible": true, "extensions": ["rusd"] },
  "application/rpki-ghostbusters": { "source": "iana", "extensions": ["gbr"] },
  "application/rpki-manifest": { "source": "iana", "extensions": ["mft"] },
  "application/rpki-publication": { "source": "iana" },
  "application/rpki-roa": { "source": "iana", "extensions": ["roa"] },
  "application/rpki-updown": { "source": "iana" },
  "application/rsd+xml": { "source": "apache", "compressible": true, "extensions": ["rsd"] },
  "application/rss+xml": { "source": "apache", "compressible": true, "extensions": ["rss"] },
  "application/rtf": { "source": "iana", "compressible": true, "extensions": ["rtf"] },
  "application/rtploopback": { "source": "iana" },
  "application/rtx": { "source": "iana" },
  "application/samlassertion+xml": { "source": "iana", "compressible": true },
  "application/samlmetadata+xml": { "source": "iana", "compressible": true },
  "application/sarif+json": { "source": "iana", "compressible": true },
  "application/sarif-external-properties+json": { "source": "iana", "compressible": true },
  "application/sbe": { "source": "iana" },
  "application/sbml+xml": { "source": "iana", "compressible": true, "extensions": ["sbml"] },
  "application/scaip+xml": { "source": "iana", "compressible": true },
  "application/scim+json": { "source": "iana", "compressible": true },
  "application/scvp-cv-request": { "source": "iana", "extensions": ["scq"] },
  "application/scvp-cv-response": { "source": "iana", "extensions": ["scs"] },
  "application/scvp-vp-request": { "source": "iana", "extensions": ["spq"] },
  "application/scvp-vp-response": { "source": "iana", "extensions": ["spp"] },
  "application/sdp": { "source": "iana", "extensions": ["sdp"] },
  "application/secevent+jwt": { "source": "iana" },
  "application/senml+cbor": { "source": "iana" },
  "application/senml+json": { "source": "iana", "compressible": true },
  "application/senml+xml": { "source": "iana", "compressible": true, "extensions": ["senmlx"] },
  "application/senml-etch+cbor": { "source": "iana" },
  "application/senml-etch+json": { "source": "iana", "compressible": true },
  "application/senml-exi": { "source": "iana" },
  "application/sensml+cbor": { "source": "iana" },
  "application/sensml+json": { "source": "iana", "compressible": true },
  "application/sensml+xml": { "source": "iana", "compressible": true, "extensions": ["sensmlx"] },
  "application/sensml-exi": { "source": "iana" },
  "application/sep+xml": { "source": "iana", "compressible": true },
  "application/sep-exi": { "source": "iana" },
  "application/session-info": { "source": "iana" },
  "application/set-payment": { "source": "iana" },
  "application/set-payment-initiation": { "source": "iana", "extensions": ["setpay"] },
  "application/set-registration": { "source": "iana" },
  "application/set-registration-initiation": { "source": "iana", "extensions": ["setreg"] },
  "application/sgml": { "source": "iana" },
  "application/sgml-open-catalog": { "source": "iana" },
  "application/shf+xml": { "source": "iana", "compressible": true, "extensions": ["shf"] },
  "application/sieve": { "source": "iana", "extensions": ["siv", "sieve"] },
  "application/simple-filter+xml": { "source": "iana", "compressible": true },
  "application/simple-message-summary": { "source": "iana" },
  "application/simplesymbolcontainer": { "source": "iana" },
  "application/sipc": { "source": "iana" },
  "application/slate": { "source": "iana" },
  "application/smil": { "source": "iana" },
  "application/smil+xml": { "source": "iana", "compressible": true, "extensions": ["smi", "smil"] },
  "application/smpte336m": { "source": "iana" },
  "application/soap+fastinfoset": { "source": "iana" },
  "application/soap+xml": { "source": "iana", "compressible": true },
  "application/sparql-query": { "source": "iana", "extensions": ["rq"] },
  "application/sparql-results+xml": { "source": "iana", "compressible": true, "extensions": ["srx"] },
  "application/spdx+json": { "source": "iana", "compressible": true },
  "application/spirits-event+xml": { "source": "iana", "compressible": true },
  "application/sql": { "source": "iana" },
  "application/srgs": { "source": "iana", "extensions": ["gram"] },
  "application/srgs+xml": { "source": "iana", "compressible": true, "extensions": ["grxml"] },
  "application/sru+xml": { "source": "iana", "compressible": true, "extensions": ["sru"] },
  "application/ssdl+xml": { "source": "apache", "compressible": true, "extensions": ["ssdl"] },
  "application/ssml+xml": { "source": "iana", "compressible": true, "extensions": ["ssml"] },
  "application/stix+json": { "source": "iana", "compressible": true },
  "application/swid+xml": { "source": "iana", "compressible": true, "extensions": ["swidtag"] },
  "application/tamp-apex-update": { "source": "iana" },
  "application/tamp-apex-update-confirm": { "source": "iana" },
  "application/tamp-community-update": { "source": "iana" },
  "application/tamp-community-update-confirm": { "source": "iana" },
  "application/tamp-error": { "source": "iana" },
  "application/tamp-sequence-adjust": { "source": "iana" },
  "application/tamp-sequence-adjust-confirm": { "source": "iana" },
  "application/tamp-status-query": { "source": "iana" },
  "application/tamp-status-response": { "source": "iana" },
  "application/tamp-update": { "source": "iana" },
  "application/tamp-update-confirm": { "source": "iana" },
  "application/tar": { "compressible": true },
  "application/taxii+json": { "source": "iana", "compressible": true },
  "application/td+json": { "source": "iana", "compressible": true },
  "application/tei+xml": { "source": "iana", "compressible": true, "extensions": ["tei", "teicorpus"] },
  "application/tetra_isi": { "source": "iana" },
  "application/thraud+xml": { "source": "iana", "compressible": true, "extensions": ["tfi"] },
  "application/timestamp-query": { "source": "iana" },
  "application/timestamp-reply": { "source": "iana" },
  "application/timestamped-data": { "source": "iana", "extensions": ["tsd"] },
  "application/tlsrpt+gzip": { "source": "iana" },
  "application/tlsrpt+json": { "source": "iana", "compressible": true },
  "application/tnauthlist": { "source": "iana" },
  "application/token-introspection+jwt": { "source": "iana" },
  "application/toml": { "compressible": true, "extensions": ["toml"] },
  "application/trickle-ice-sdpfrag": { "source": "iana" },
  "application/trig": { "source": "iana", "extensions": ["trig"] },
  "application/ttml+xml": { "source": "iana", "compressible": true, "extensions": ["ttml"] },
  "application/tve-trigger": { "source": "iana" },
  "application/tzif": { "source": "iana" },
  "application/tzif-leap": { "source": "iana" },
  "application/ubjson": { "compressible": false, "extensions": ["ubj"] },
  "application/ulpfec": { "source": "iana" },
  "application/urc-grpsheet+xml": { "source": "iana", "compressible": true },
  "application/urc-ressheet+xml": { "source": "iana", "compressible": true, "extensions": ["rsheet"] },
  "application/urc-targetdesc+xml": { "source": "iana", "compressible": true, "extensions": ["td"] },
  "application/urc-uisocketdesc+xml": { "source": "iana", "compressible": true },
  "application/vcard+json": { "source": "iana", "compressible": true },
  "application/vcard+xml": { "source": "iana", "compressible": true },
  "application/vemmi": { "source": "iana" },
  "application/vividence.scriptfile": { "source": "apache" },
  "application/vnd.1000minds.decision-model+xml": { "source": "iana", "compressible": true, "extensions": ["1km"] },
  "application/vnd.3gpp-prose+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp-prose-pc3ch+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp-v2x-local-service-information": { "source": "iana" },
  "application/vnd.3gpp.5gnas": { "source": "iana" },
  "application/vnd.3gpp.access-transfer-events+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.bsf+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.gmop+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.gtpc": { "source": "iana" },
  "application/vnd.3gpp.interworking-data": { "source": "iana" },
  "application/vnd.3gpp.lpp": { "source": "iana" },
  "application/vnd.3gpp.mc-signalling-ear": { "source": "iana" },
  "application/vnd.3gpp.mcdata-affiliation-command+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcdata-info+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcdata-payload": { "source": "iana" },
  "application/vnd.3gpp.mcdata-service-config+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcdata-signalling": { "source": "iana" },
  "application/vnd.3gpp.mcdata-ue-config+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcdata-user-profile+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcptt-affiliation-command+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcptt-floor-request+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcptt-info+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcptt-location-info+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcptt-mbms-usage-info+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcptt-service-config+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcptt-signed+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcptt-ue-config+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcptt-ue-init-config+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcptt-user-profile+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcvideo-affiliation-command+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcvideo-affiliation-info+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcvideo-info+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcvideo-location-info+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcvideo-mbms-usage-info+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcvideo-service-config+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcvideo-transmission-request+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcvideo-ue-config+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mcvideo-user-profile+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.mid-call+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.ngap": { "source": "iana" },
  "application/vnd.3gpp.pfcp": { "source": "iana" },
  "application/vnd.3gpp.pic-bw-large": { "source": "iana", "extensions": ["plb"] },
  "application/vnd.3gpp.pic-bw-small": { "source": "iana", "extensions": ["psb"] },
  "application/vnd.3gpp.pic-bw-var": { "source": "iana", "extensions": ["pvb"] },
  "application/vnd.3gpp.s1ap": { "source": "iana" },
  "application/vnd.3gpp.sms": { "source": "iana" },
  "application/vnd.3gpp.sms+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.srvcc-ext+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.srvcc-info+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.state-and-event-info+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp.ussd+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp2.bcmcsinfo+xml": { "source": "iana", "compressible": true },
  "application/vnd.3gpp2.sms": { "source": "iana" },
  "application/vnd.3gpp2.tcap": { "source": "iana", "extensions": ["tcap"] },
  "application/vnd.3lightssoftware.imagescal": { "source": "iana" },
  "application/vnd.3m.post-it-notes": { "source": "iana", "extensions": ["pwn"] },
  "application/vnd.accpac.simply.aso": { "source": "iana", "extensions": ["aso"] },
  "application/vnd.accpac.simply.imp": { "source": "iana", "extensions": ["imp"] },
  "application/vnd.acucobol": { "source": "iana", "extensions": ["acu"] },
  "application/vnd.acucorp": { "source": "iana", "extensions": ["atc", "acutc"] },
  "application/vnd.adobe.air-application-installer-package+zip": { "source": "apache", "compressible": false, "extensions": ["air"] },
  "application/vnd.adobe.flash.movie": { "source": "iana" },
  "application/vnd.adobe.formscentral.fcdt": { "source": "iana", "extensions": ["fcdt"] },
  "application/vnd.adobe.fxp": { "source": "iana", "extensions": ["fxp", "fxpl"] },
  "application/vnd.adobe.partial-upload": { "source": "iana" },
  "application/vnd.adobe.xdp+xml": { "source": "iana", "compressible": true, "extensions": ["xdp"] },
  "application/vnd.adobe.xfdf": { "source": "iana", "extensions": ["xfdf"] },
  "application/vnd.aether.imp": { "source": "iana" },
  "application/vnd.afpc.afplinedata": { "source": "iana" },
  "application/vnd.afpc.afplinedata-pagedef": { "source": "iana" },
  "application/vnd.afpc.cmoca-cmresource": { "source": "iana" },
  "application/vnd.afpc.foca-charset": { "source": "iana" },
  "application/vnd.afpc.foca-codedfont": { "source": "iana" },
  "application/vnd.afpc.foca-codepage": { "source": "iana" },
  "application/vnd.afpc.modca": { "source": "iana" },
  "application/vnd.afpc.modca-cmtable": { "source": "iana" },
  "application/vnd.afpc.modca-formdef": { "source": "iana" },
  "application/vnd.afpc.modca-mediummap": { "source": "iana" },
  "application/vnd.afpc.modca-objectcontainer": { "source": "iana" },
  "application/vnd.afpc.modca-overlay": { "source": "iana" },
  "application/vnd.afpc.modca-pagesegment": { "source": "iana" },
  "application/vnd.age": { "source": "iana", "extensions": ["age"] },
  "application/vnd.ah-barcode": { "source": "iana" },
  "application/vnd.ahead.space": { "source": "iana", "extensions": ["ahead"] },
  "application/vnd.airzip.filesecure.azf": { "source": "iana", "extensions": ["azf"] },
  "application/vnd.airzip.filesecure.azs": { "source": "iana", "extensions": ["azs"] },
  "application/vnd.amadeus+json": { "source": "iana", "compressible": true },
  "application/vnd.amazon.ebook": { "source": "apache", "extensions": ["azw"] },
  "application/vnd.amazon.mobi8-ebook": { "source": "iana" },
  "application/vnd.americandynamics.acc": { "source": "iana", "extensions": ["acc"] },
  "application/vnd.amiga.ami": { "source": "iana", "extensions": ["ami"] },
  "application/vnd.amundsen.maze+xml": { "source": "iana", "compressible": true },
  "application/vnd.android.ota": { "source": "iana" },
  "application/vnd.android.package-archive": { "source": "apache", "compressible": false, "extensions": ["apk"] },
  "application/vnd.anki": { "source": "iana" },
  "application/vnd.anser-web-certificate-issue-initiation": { "source": "iana", "extensions": ["cii"] },
  "application/vnd.anser-web-funds-transfer-initiation": { "source": "apache", "extensions": ["fti"] },
  "application/vnd.antix.game-component": { "source": "iana", "extensions": ["atx"] },
  "application/vnd.apache.arrow.file": { "source": "iana" },
  "application/vnd.apache.arrow.stream": { "source": "iana" },
  "application/vnd.apache.thrift.binary": { "source": "iana" },
  "application/vnd.apache.thrift.compact": { "source": "iana" },
  "application/vnd.apache.thrift.json": { "source": "iana" },
  "application/vnd.api+json": { "source": "iana", "compressible": true },
  "application/vnd.aplextor.warrp+json": { "source": "iana", "compressible": true },
  "application/vnd.apothekende.reservation+json": { "source": "iana", "compressible": true },
  "application/vnd.apple.installer+xml": { "source": "iana", "compressible": true, "extensions": ["mpkg"] },
  "application/vnd.apple.keynote": { "source": "iana", "extensions": ["key"] },
  "application/vnd.apple.mpegurl": { "source": "iana", "extensions": ["m3u8"] },
  "application/vnd.apple.numbers": { "source": "iana", "extensions": ["numbers"] },
  "application/vnd.apple.pages": { "source": "iana", "extensions": ["pages"] },
  "application/vnd.apple.pkpass": { "compressible": false, "extensions": ["pkpass"] },
  "application/vnd.arastra.swi": { "source": "iana" },
  "application/vnd.aristanetworks.swi": { "source": "iana", "extensions": ["swi"] },
  "application/vnd.artisan+json": { "source": "iana", "compressible": true },
  "application/vnd.artsquare": { "source": "iana" },
  "application/vnd.astraea-software.iota": { "source": "iana", "extensions": ["iota"] },
  "application/vnd.audiograph": { "source": "iana", "extensions": ["aep"] },
  "application/vnd.autopackage": { "source": "iana" },
  "application/vnd.avalon+json": { "source": "iana", "compressible": true },
  "application/vnd.avistar+xml": { "source": "iana", "compressible": true },
  "application/vnd.balsamiq.bmml+xml": { "source": "iana", "compressible": true, "extensions": ["bmml"] },
  "application/vnd.balsamiq.bmpr": { "source": "iana" },
  "application/vnd.banana-accounting": { "source": "iana" },
  "application/vnd.bbf.usp.error": { "source": "iana" },
  "application/vnd.bbf.usp.msg": { "source": "iana" },
  "application/vnd.bbf.usp.msg+json": { "source": "iana", "compressible": true },
  "application/vnd.bekitzur-stech+json": { "source": "iana", "compressible": true },
  "application/vnd.bint.med-content": { "source": "iana" },
  "application/vnd.biopax.rdf+xml": { "source": "iana", "compressible": true },
  "application/vnd.blink-idb-value-wrapper": { "source": "iana" },
  "application/vnd.blueice.multipass": { "source": "iana", "extensions": ["mpm"] },
  "application/vnd.bluetooth.ep.oob": { "source": "iana" },
  "application/vnd.bluetooth.le.oob": { "source": "iana" },
  "application/vnd.bmi": { "source": "iana", "extensions": ["bmi"] },
  "application/vnd.bpf": { "source": "iana" },
  "application/vnd.bpf3": { "source": "iana" },
  "application/vnd.businessobjects": { "source": "iana", "extensions": ["rep"] },
  "application/vnd.byu.uapi+json": { "source": "iana", "compressible": true },
  "application/vnd.cab-jscript": { "source": "iana" },
  "application/vnd.canon-cpdl": { "source": "iana" },
  "application/vnd.canon-lips": { "source": "iana" },
  "application/vnd.capasystems-pg+json": { "source": "iana", "compressible": true },
  "application/vnd.cendio.thinlinc.clientconf": { "source": "iana" },
  "application/vnd.century-systems.tcp_stream": { "source": "iana" },
  "application/vnd.chemdraw+xml": { "source": "iana", "compressible": true, "extensions": ["cdxml"] },
  "application/vnd.chess-pgn": { "source": "iana" },
  "application/vnd.chipnuts.karaoke-mmd": { "source": "iana", "extensions": ["mmd"] },
  "application/vnd.ciedi": { "source": "iana" },
  "application/vnd.cinderella": { "source": "iana", "extensions": ["cdy"] },
  "application/vnd.cirpack.isdn-ext": { "source": "iana" },
  "application/vnd.citationstyles.style+xml": { "source": "iana", "compressible": true, "extensions": ["csl"] },
  "application/vnd.claymore": { "source": "iana", "extensions": ["cla"] },
  "application/vnd.cloanto.rp9": { "source": "iana", "extensions": ["rp9"] },
  "application/vnd.clonk.c4group": { "source": "iana", "extensions": ["c4g", "c4d", "c4f", "c4p", "c4u"] },
  "application/vnd.cluetrust.cartomobile-config": { "source": "iana", "extensions": ["c11amc"] },
  "application/vnd.cluetrust.cartomobile-config-pkg": { "source": "iana", "extensions": ["c11amz"] },
  "application/vnd.coffeescript": { "source": "iana" },
  "application/vnd.collabio.xodocuments.document": { "source": "iana" },
  "application/vnd.collabio.xodocuments.document-template": { "source": "iana" },
  "application/vnd.collabio.xodocuments.presentation": { "source": "iana" },
  "application/vnd.collabio.xodocuments.presentation-template": { "source": "iana" },
  "application/vnd.collabio.xodocuments.spreadsheet": { "source": "iana" },
  "application/vnd.collabio.xodocuments.spreadsheet-template": { "source": "iana" },
  "application/vnd.collection+json": { "source": "iana", "compressible": true },
  "application/vnd.collection.doc+json": { "source": "iana", "compressible": true },
  "application/vnd.collection.next+json": { "source": "iana", "compressible": true },
  "application/vnd.comicbook+zip": { "source": "iana", "compressible": false },
  "application/vnd.comicbook-rar": { "source": "iana" },
  "application/vnd.commerce-battelle": { "source": "iana" },
  "application/vnd.commonspace": { "source": "iana", "extensions": ["csp"] },
  "application/vnd.contact.cmsg": { "source": "iana", "extensions": ["cdbcmsg"] },
  "application/vnd.coreos.ignition+json": { "source": "iana", "compressible": true },
  "application/vnd.cosmocaller": { "source": "iana", "extensions": ["cmc"] },
  "application/vnd.crick.clicker": { "source": "iana", "extensions": ["clkx"] },
  "application/vnd.crick.clicker.keyboard": { "source": "iana", "extensions": ["clkk"] },
  "application/vnd.crick.clicker.palette": { "source": "iana", "extensions": ["clkp"] },
  "application/vnd.crick.clicker.template": { "source": "iana", "extensions": ["clkt"] },
  "application/vnd.crick.clicker.wordbank": { "source": "iana", "extensions": ["clkw"] },
  "application/vnd.criticaltools.wbs+xml": { "source": "iana", "compressible": true, "extensions": ["wbs"] },
  "application/vnd.cryptii.pipe+json": { "source": "iana", "compressible": true },
  "application/vnd.crypto-shade-file": { "source": "iana" },
  "application/vnd.cryptomator.encrypted": { "source": "iana" },
  "application/vnd.cryptomator.vault": { "source": "iana" },
  "application/vnd.ctc-posml": { "source": "iana", "extensions": ["pml"] },
  "application/vnd.ctct.ws+xml": { "source": "iana", "compressible": true },
  "application/vnd.cups-pdf": { "source": "iana" },
  "application/vnd.cups-postscript": { "source": "iana" },
  "application/vnd.cups-ppd": { "source": "iana", "extensions": ["ppd"] },
  "application/vnd.cups-raster": { "source": "iana" },
  "application/vnd.cups-raw": { "source": "iana" },
  "application/vnd.curl": { "source": "iana" },
  "application/vnd.curl.car": { "source": "apache", "extensions": ["car"] },
  "application/vnd.curl.pcurl": { "source": "apache", "extensions": ["pcurl"] },
  "application/vnd.cyan.dean.root+xml": { "source": "iana", "compressible": true },
  "application/vnd.cybank": { "source": "iana" },
  "application/vnd.cyclonedx+json": { "source": "iana", "compressible": true },
  "application/vnd.cyclonedx+xml": { "source": "iana", "compressible": true },
  "application/vnd.d2l.coursepackage1p0+zip": { "source": "iana", "compressible": false },
  "application/vnd.d3m-dataset": { "source": "iana" },
  "application/vnd.d3m-problem": { "source": "iana" },
  "application/vnd.dart": { "source": "iana", "compressible": true, "extensions": ["dart"] },
  "application/vnd.data-vision.rdz": { "source": "iana", "extensions": ["rdz"] },
  "application/vnd.datapackage+json": { "source": "iana", "compressible": true },
  "application/vnd.dataresource+json": { "source": "iana", "compressible": true },
  "application/vnd.dbf": { "source": "iana", "extensions": ["dbf"] },
  "application/vnd.debian.binary-package": { "source": "iana" },
  "application/vnd.dece.data": { "source": "iana", "extensions": ["uvf", "uvvf", "uvd", "uvvd"] },
  "application/vnd.dece.ttml+xml": { "source": "iana", "compressible": true, "extensions": ["uvt", "uvvt"] },
  "application/vnd.dece.unspecified": { "source": "iana", "extensions": ["uvx", "uvvx"] },
  "application/vnd.dece.zip": { "source": "iana", "extensions": ["uvz", "uvvz"] },
  "application/vnd.denovo.fcselayout-link": { "source": "iana", "extensions": ["fe_launch"] },
  "application/vnd.desmume.movie": { "source": "iana" },
  "application/vnd.dir-bi.plate-dl-nosuffix": { "source": "iana" },
  "application/vnd.dm.delegation+xml": { "source": "iana", "compressible": true },
  "application/vnd.dna": { "source": "iana", "extensions": ["dna"] },
  "application/vnd.document+json": { "source": "iana", "compressible": true },
  "application/vnd.dolby.mlp": { "source": "apache", "extensions": ["mlp"] },
  "application/vnd.dolby.mobile.1": { "source": "iana" },
  "application/vnd.dolby.mobile.2": { "source": "iana" },
  "application/vnd.doremir.scorecloud-binary-document": { "source": "iana" },
  "application/vnd.dpgraph": { "source": "iana", "extensions": ["dpg"] },
  "application/vnd.dreamfactory": { "source": "iana", "extensions": ["dfac"] },
  "application/vnd.drive+json": { "source": "iana", "compressible": true },
  "application/vnd.ds-keypoint": { "source": "apache", "extensions": ["kpxx"] },
  "application/vnd.dtg.local": { "source": "iana" },
  "application/vnd.dtg.local.flash": { "source": "iana" },
  "application/vnd.dtg.local.html": { "source": "iana" },
  "application/vnd.dvb.ait": { "source": "iana", "extensions": ["ait"] },
  "application/vnd.dvb.dvbisl+xml": { "source": "iana", "compressible": true },
  "application/vnd.dvb.dvbj": { "source": "iana" },
  "application/vnd.dvb.esgcontainer": { "source": "iana" },
  "application/vnd.dvb.ipdcdftnotifaccess": { "source": "iana" },
  "application/vnd.dvb.ipdcesgaccess": { "source": "iana" },
  "application/vnd.dvb.ipdcesgaccess2": { "source": "iana" },
  "application/vnd.dvb.ipdcesgpdd": { "source": "iana" },
  "application/vnd.dvb.ipdcroaming": { "source": "iana" },
  "application/vnd.dvb.iptv.alfec-base": { "source": "iana" },
  "application/vnd.dvb.iptv.alfec-enhancement": { "source": "iana" },
  "application/vnd.dvb.notif-aggregate-root+xml": { "source": "iana", "compressible": true },
  "application/vnd.dvb.notif-container+xml": { "source": "iana", "compressible": true },
  "application/vnd.dvb.notif-generic+xml": { "source": "iana", "compressible": true },
  "application/vnd.dvb.notif-ia-msglist+xml": { "source": "iana", "compressible": true },
  "application/vnd.dvb.notif-ia-registration-request+xml": { "source": "iana", "compressible": true },
  "application/vnd.dvb.notif-ia-registration-response+xml": { "source": "iana", "compressible": true },
  "application/vnd.dvb.notif-init+xml": { "source": "iana", "compressible": true },
  "application/vnd.dvb.pfr": { "source": "iana" },
  "application/vnd.dvb.service": { "source": "iana", "extensions": ["svc"] },
  "application/vnd.dxr": { "source": "iana" },
  "application/vnd.dynageo": { "source": "iana", "extensions": ["geo"] },
  "application/vnd.dzr": { "source": "iana" },
  "application/vnd.easykaraoke.cdgdownload": { "source": "iana" },
  "application/vnd.ecdis-update": { "source": "iana" },
  "application/vnd.ecip.rlp": { "source": "iana" },
  "application/vnd.eclipse.ditto+json": { "source": "iana", "compressible": true },
  "application/vnd.ecowin.chart": { "source": "iana", "extensions": ["mag"] },
  "application/vnd.ecowin.filerequest": { "source": "iana" },
  "application/vnd.ecowin.fileupdate": { "source": "iana" },
  "application/vnd.ecowin.series": { "source": "iana" },
  "application/vnd.ecowin.seriesrequest": { "source": "iana" },
  "application/vnd.ecowin.seriesupdate": { "source": "iana" },
  "application/vnd.efi.img": { "source": "iana" },
  "application/vnd.efi.iso": { "source": "iana" },
  "application/vnd.emclient.accessrequest+xml": { "source": "iana", "compressible": true },
  "application/vnd.enliven": { "source": "iana", "extensions": ["nml"] },
  "application/vnd.enphase.envoy": { "source": "iana" },
  "application/vnd.eprints.data+xml": { "source": "iana", "compressible": true },
  "application/vnd.epson.esf": { "source": "iana", "extensions": ["esf"] },
  "application/vnd.epson.msf": { "source": "iana", "extensions": ["msf"] },
  "application/vnd.epson.quickanime": { "source": "iana", "extensions": ["qam"] },
  "application/vnd.epson.salt": { "source": "iana", "extensions": ["slt"] },
  "application/vnd.epson.ssf": { "source": "iana", "extensions": ["ssf"] },
  "application/vnd.ericsson.quickcall": { "source": "iana" },
  "application/vnd.espass-espass+zip": { "source": "iana", "compressible": false },
  "application/vnd.eszigno3+xml": { "source": "iana", "compressible": true, "extensions": ["es3", "et3"] },
  "application/vnd.etsi.aoc+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.asic-e+zip": { "source": "iana", "compressible": false },
  "application/vnd.etsi.asic-s+zip": { "source": "iana", "compressible": false },
  "application/vnd.etsi.cug+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.iptvcommand+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.iptvdiscovery+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.iptvprofile+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.iptvsad-bc+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.iptvsad-cod+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.iptvsad-npvr+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.iptvservice+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.iptvsync+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.iptvueprofile+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.mcid+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.mheg5": { "source": "iana" },
  "application/vnd.etsi.overload-control-policy-dataset+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.pstn+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.sci+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.simservs+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.timestamp-token": { "source": "iana" },
  "application/vnd.etsi.tsl+xml": { "source": "iana", "compressible": true },
  "application/vnd.etsi.tsl.der": { "source": "iana" },
  "application/vnd.eu.kasparian.car+json": { "source": "iana", "compressible": true },
  "application/vnd.eudora.data": { "source": "iana" },
  "application/vnd.evolv.ecig.profile": { "source": "iana" },
  "application/vnd.evolv.ecig.settings": { "source": "iana" },
  "application/vnd.evolv.ecig.theme": { "source": "iana" },
  "application/vnd.exstream-empower+zip": { "source": "iana", "compressible": false },
  "application/vnd.exstream-package": { "source": "iana" },
  "application/vnd.ezpix-album": { "source": "iana", "extensions": ["ez2"] },
  "application/vnd.ezpix-package": { "source": "iana", "extensions": ["ez3"] },
  "application/vnd.f-secure.mobile": { "source": "iana" },
  "application/vnd.familysearch.gedcom+zip": { "source": "iana", "compressible": false },
  "application/vnd.fastcopy-disk-image": { "source": "iana" },
  "application/vnd.fdf": { "source": "iana", "extensions": ["fdf"] },
  "application/vnd.fdsn.mseed": { "source": "iana", "extensions": ["mseed"] },
  "application/vnd.fdsn.seed": { "source": "iana", "extensions": ["seed", "dataless"] },
  "application/vnd.ffsns": { "source": "iana" },
  "application/vnd.ficlab.flb+zip": { "source": "iana", "compressible": false },
  "application/vnd.filmit.zfc": { "source": "iana" },
  "application/vnd.fints": { "source": "iana" },
  "application/vnd.firemonkeys.cloudcell": { "source": "iana" },
  "application/vnd.flographit": { "source": "iana", "extensions": ["gph"] },
  "application/vnd.fluxtime.clip": { "source": "iana", "extensions": ["ftc"] },
  "application/vnd.font-fontforge-sfd": { "source": "iana" },
  "application/vnd.framemaker": { "source": "iana", "extensions": ["fm", "frame", "maker", "book"] },
  "application/vnd.frogans.fnc": { "source": "iana", "extensions": ["fnc"] },
  "application/vnd.frogans.ltf": { "source": "iana", "extensions": ["ltf"] },
  "application/vnd.fsc.weblaunch": { "source": "iana", "extensions": ["fsc"] },
  "application/vnd.fujifilm.fb.docuworks": { "source": "iana" },
  "application/vnd.fujifilm.fb.docuworks.binder": { "source": "iana" },
  "application/vnd.fujifilm.fb.docuworks.container": { "source": "iana" },
  "application/vnd.fujifilm.fb.jfi+xml": { "source": "iana", "compressible": true },
  "application/vnd.fujitsu.oasys": { "source": "iana", "extensions": ["oas"] },
  "application/vnd.fujitsu.oasys2": { "source": "iana", "extensions": ["oa2"] },
  "application/vnd.fujitsu.oasys3": { "source": "iana", "extensions": ["oa3"] },
  "application/vnd.fujitsu.oasysgp": { "source": "iana", "extensions": ["fg5"] },
  "application/vnd.fujitsu.oasysprs": { "source": "iana", "extensions": ["bh2"] },
  "application/vnd.fujixerox.art-ex": { "source": "iana" },
  "application/vnd.fujixerox.art4": { "source": "iana" },
  "application/vnd.fujixerox.ddd": { "source": "iana", "extensions": ["ddd"] },
  "application/vnd.fujixerox.docuworks": { "source": "iana", "extensions": ["xdw"] },
  "application/vnd.fujixerox.docuworks.binder": { "source": "iana", "extensions": ["xbd"] },
  "application/vnd.fujixerox.docuworks.container": { "source": "iana" },
  "application/vnd.fujixerox.hbpl": { "source": "iana" },
  "application/vnd.fut-misnet": { "source": "iana" },
  "application/vnd.futoin+cbor": { "source": "iana" },
  "application/vnd.futoin+json": { "source": "iana", "compressible": true },
  "application/vnd.fuzzysheet": { "source": "iana", "extensions": ["fzs"] },
  "application/vnd.genomatix.tuxedo": { "source": "iana", "extensions": ["txd"] },
  "application/vnd.gentics.grd+json": { "source": "iana", "compressible": true },
  "application/vnd.geo+json": { "source": "iana", "compressible": true },
  "application/vnd.geocube+xml": { "source": "iana", "compressible": true },
  "application/vnd.geogebra.file": { "source": "iana", "extensions": ["ggb"] },
  "application/vnd.geogebra.slides": { "source": "iana" },
  "application/vnd.geogebra.tool": { "source": "iana", "extensions": ["ggt"] },
  "application/vnd.geometry-explorer": { "source": "iana", "extensions": ["gex", "gre"] },
  "application/vnd.geonext": { "source": "iana", "extensions": ["gxt"] },
  "application/vnd.geoplan": { "source": "iana", "extensions": ["g2w"] },
  "application/vnd.geospace": { "source": "iana", "extensions": ["g3w"] },
  "application/vnd.gerber": { "source": "iana" },
  "application/vnd.globalplatform.card-content-mgt": { "source": "iana" },
  "application/vnd.globalplatform.card-content-mgt-response": { "source": "iana" },
  "application/vnd.gmx": { "source": "iana", "extensions": ["gmx"] },
  "application/vnd.google-apps.document": { "compressible": false, "extensions": ["gdoc"] },
  "application/vnd.google-apps.presentation": { "compressible": false, "extensions": ["gslides"] },
  "application/vnd.google-apps.spreadsheet": { "compressible": false, "extensions": ["gsheet"] },
  "application/vnd.google-earth.kml+xml": { "source": "iana", "compressible": true, "extensions": ["kml"] },
  "application/vnd.google-earth.kmz": { "source": "iana", "compressible": false, "extensions": ["kmz"] },
  "application/vnd.gov.sk.e-form+xml": { "source": "iana", "compressible": true },
  "application/vnd.gov.sk.e-form+zip": { "source": "iana", "compressible": false },
  "application/vnd.gov.sk.xmldatacontainer+xml": { "source": "iana", "compressible": true },
  "application/vnd.grafeq": { "source": "iana", "extensions": ["gqf", "gqs"] },
  "application/vnd.gridmp": { "source": "iana" },
  "application/vnd.groove-account": { "source": "iana", "extensions": ["gac"] },
  "application/vnd.groove-help": { "source": "iana", "extensions": ["ghf"] },
  "application/vnd.groove-identity-message": { "source": "iana", "extensions": ["gim"] },
  "application/vnd.groove-injector": { "source": "iana", "extensions": ["grv"] },
  "application/vnd.groove-tool-message": { "source": "iana", "extensions": ["gtm"] },
  "application/vnd.groove-tool-template": { "source": "iana", "extensions": ["tpl"] },
  "application/vnd.groove-vcard": { "source": "iana", "extensions": ["vcg"] },
  "application/vnd.hal+json": { "source": "iana", "compressible": true },
  "application/vnd.hal+xml": { "source": "iana", "compressible": true, "extensions": ["hal"] },
  "application/vnd.handheld-entertainment+xml": { "source": "iana", "compressible": true, "extensions": ["zmm"] },
  "application/vnd.hbci": { "source": "iana", "extensions": ["hbci"] },
  "application/vnd.hc+json": { "source": "iana", "compressible": true },
  "application/vnd.hcl-bireports": { "source": "iana" },
  "application/vnd.hdt": { "source": "iana" },
  "application/vnd.heroku+json": { "source": "iana", "compressible": true },
  "application/vnd.hhe.lesson-player": { "source": "iana", "extensions": ["les"] },
  "application/vnd.hl7cda+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/vnd.hl7v2+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/vnd.hp-hpgl": { "source": "iana", "extensions": ["hpgl"] },
  "application/vnd.hp-hpid": { "source": "iana", "extensions": ["hpid"] },
  "application/vnd.hp-hps": { "source": "iana", "extensions": ["hps"] },
  "application/vnd.hp-jlyt": { "source": "iana", "extensions": ["jlt"] },
  "application/vnd.hp-pcl": { "source": "iana", "extensions": ["pcl"] },
  "application/vnd.hp-pclxl": { "source": "iana", "extensions": ["pclxl"] },
  "application/vnd.httphone": { "source": "iana" },
  "application/vnd.hydrostatix.sof-data": { "source": "iana", "extensions": ["sfd-hdstx"] },
  "application/vnd.hyper+json": { "source": "iana", "compressible": true },
  "application/vnd.hyper-item+json": { "source": "iana", "compressible": true },
  "application/vnd.hyperdrive+json": { "source": "iana", "compressible": true },
  "application/vnd.hzn-3d-crossword": { "source": "iana" },
  "application/vnd.ibm.afplinedata": { "source": "iana" },
  "application/vnd.ibm.electronic-media": { "source": "iana" },
  "application/vnd.ibm.minipay": { "source": "iana", "extensions": ["mpy"] },
  "application/vnd.ibm.modcap": { "source": "iana", "extensions": ["afp", "listafp", "list3820"] },
  "application/vnd.ibm.rights-management": { "source": "iana", "extensions": ["irm"] },
  "application/vnd.ibm.secure-container": { "source": "iana", "extensions": ["sc"] },
  "application/vnd.iccprofile": { "source": "iana", "extensions": ["icc", "icm"] },
  "application/vnd.ieee.1905": { "source": "iana" },
  "application/vnd.igloader": { "source": "iana", "extensions": ["igl"] },
  "application/vnd.imagemeter.folder+zip": { "source": "iana", "compressible": false },
  "application/vnd.imagemeter.image+zip": { "source": "iana", "compressible": false },
  "application/vnd.immervision-ivp": { "source": "iana", "extensions": ["ivp"] },
  "application/vnd.immervision-ivu": { "source": "iana", "extensions": ["ivu"] },
  "application/vnd.ims.imsccv1p1": { "source": "iana" },
  "application/vnd.ims.imsccv1p2": { "source": "iana" },
  "application/vnd.ims.imsccv1p3": { "source": "iana" },
  "application/vnd.ims.lis.v2.result+json": { "source": "iana", "compressible": true },
  "application/vnd.ims.lti.v2.toolconsumerprofile+json": { "source": "iana", "compressible": true },
  "application/vnd.ims.lti.v2.toolproxy+json": { "source": "iana", "compressible": true },
  "application/vnd.ims.lti.v2.toolproxy.id+json": { "source": "iana", "compressible": true },
  "application/vnd.ims.lti.v2.toolsettings+json": { "source": "iana", "compressible": true },
  "application/vnd.ims.lti.v2.toolsettings.simple+json": { "source": "iana", "compressible": true },
  "application/vnd.informedcontrol.rms+xml": { "source": "iana", "compressible": true },
  "application/vnd.informix-visionary": { "source": "iana" },
  "application/vnd.infotech.project": { "source": "iana" },
  "application/vnd.infotech.project+xml": { "source": "iana", "compressible": true },
  "application/vnd.innopath.wamp.notification": { "source": "iana" },
  "application/vnd.insors.igm": { "source": "iana", "extensions": ["igm"] },
  "application/vnd.intercon.formnet": { "source": "iana", "extensions": ["xpw", "xpx"] },
  "application/vnd.intergeo": { "source": "iana", "extensions": ["i2g"] },
  "application/vnd.intertrust.digibox": { "source": "iana" },
  "application/vnd.intertrust.nncp": { "source": "iana" },
  "application/vnd.intu.qbo": { "source": "iana", "extensions": ["qbo"] },
  "application/vnd.intu.qfx": { "source": "iana", "extensions": ["qfx"] },
  "application/vnd.iptc.g2.catalogitem+xml": { "source": "iana", "compressible": true },
  "application/vnd.iptc.g2.conceptitem+xml": { "source": "iana", "compressible": true },
  "application/vnd.iptc.g2.knowledgeitem+xml": { "source": "iana", "compressible": true },
  "application/vnd.iptc.g2.newsitem+xml": { "source": "iana", "compressible": true },
  "application/vnd.iptc.g2.newsmessage+xml": { "source": "iana", "compressible": true },
  "application/vnd.iptc.g2.packageitem+xml": { "source": "iana", "compressible": true },
  "application/vnd.iptc.g2.planningitem+xml": { "source": "iana", "compressible": true },
  "application/vnd.ipunplugged.rcprofile": { "source": "iana", "extensions": ["rcprofile"] },
  "application/vnd.irepository.package+xml": { "source": "iana", "compressible": true, "extensions": ["irp"] },
  "application/vnd.is-xpr": { "source": "iana", "extensions": ["xpr"] },
  "application/vnd.isac.fcs": { "source": "iana", "extensions": ["fcs"] },
  "application/vnd.iso11783-10+zip": { "source": "iana", "compressible": false },
  "application/vnd.jam": { "source": "iana", "extensions": ["jam"] },
  "application/vnd.japannet-directory-service": { "source": "iana" },
  "application/vnd.japannet-jpnstore-wakeup": { "source": "iana" },
  "application/vnd.japannet-payment-wakeup": { "source": "iana" },
  "application/vnd.japannet-registration": { "source": "iana" },
  "application/vnd.japannet-registration-wakeup": { "source": "iana" },
  "application/vnd.japannet-setstore-wakeup": { "source": "iana" },
  "application/vnd.japannet-verification": { "source": "iana" },
  "application/vnd.japannet-verification-wakeup": { "source": "iana" },
  "application/vnd.jcp.javame.midlet-rms": { "source": "iana", "extensions": ["rms"] },
  "application/vnd.jisp": { "source": "iana", "extensions": ["jisp"] },
  "application/vnd.joost.joda-archive": { "source": "iana", "extensions": ["joda"] },
  "application/vnd.jsk.isdn-ngn": { "source": "iana" },
  "application/vnd.kahootz": { "source": "iana", "extensions": ["ktz", "ktr"] },
  "application/vnd.kde.karbon": { "source": "iana", "extensions": ["karbon"] },
  "application/vnd.kde.kchart": { "source": "iana", "extensions": ["chrt"] },
  "application/vnd.kde.kformula": { "source": "iana", "extensions": ["kfo"] },
  "application/vnd.kde.kivio": { "source": "iana", "extensions": ["flw"] },
  "application/vnd.kde.kontour": { "source": "iana", "extensions": ["kon"] },
  "application/vnd.kde.kpresenter": { "source": "iana", "extensions": ["kpr", "kpt"] },
  "application/vnd.kde.kspread": { "source": "iana", "extensions": ["ksp"] },
  "application/vnd.kde.kword": { "source": "iana", "extensions": ["kwd", "kwt"] },
  "application/vnd.kenameaapp": { "source": "iana", "extensions": ["htke"] },
  "application/vnd.kidspiration": { "source": "iana", "extensions": ["kia"] },
  "application/vnd.kinar": { "source": "iana", "extensions": ["kne", "knp"] },
  "application/vnd.koan": { "source": "iana", "extensions": ["skp", "skd", "skt", "skm"] },
  "application/vnd.kodak-descriptor": { "source": "iana", "extensions": ["sse"] },
  "application/vnd.las": { "source": "iana" },
  "application/vnd.las.las+json": { "source": "iana", "compressible": true },
  "application/vnd.las.las+xml": { "source": "iana", "compressible": true, "extensions": ["lasxml"] },
  "application/vnd.laszip": { "source": "iana" },
  "application/vnd.leap+json": { "source": "iana", "compressible": true },
  "application/vnd.liberty-request+xml": { "source": "iana", "compressible": true },
  "application/vnd.llamagraphics.life-balance.desktop": { "source": "iana", "extensions": ["lbd"] },
  "application/vnd.llamagraphics.life-balance.exchange+xml": { "source": "iana", "compressible": true, "extensions": ["lbe"] },
  "application/vnd.logipipe.circuit+zip": { "source": "iana", "compressible": false },
  "application/vnd.loom": { "source": "iana" },
  "application/vnd.lotus-1-2-3": { "source": "iana", "extensions": ["123"] },
  "application/vnd.lotus-approach": { "source": "iana", "extensions": ["apr"] },
  "application/vnd.lotus-freelance": { "source": "iana", "extensions": ["pre"] },
  "application/vnd.lotus-notes": { "source": "iana", "extensions": ["nsf"] },
  "application/vnd.lotus-organizer": { "source": "iana", "extensions": ["org"] },
  "application/vnd.lotus-screencam": { "source": "iana", "extensions": ["scm"] },
  "application/vnd.lotus-wordpro": { "source": "iana", "extensions": ["lwp"] },
  "application/vnd.macports.portpkg": { "source": "iana", "extensions": ["portpkg"] },
  "application/vnd.mapbox-vector-tile": { "source": "iana", "extensions": ["mvt"] },
  "application/vnd.marlin.drm.actiontoken+xml": { "source": "iana", "compressible": true },
  "application/vnd.marlin.drm.conftoken+xml": { "source": "iana", "compressible": true },
  "application/vnd.marlin.drm.license+xml": { "source": "iana", "compressible": true },
  "application/vnd.marlin.drm.mdcf": { "source": "iana" },
  "application/vnd.mason+json": { "source": "iana", "compressible": true },
  "application/vnd.maxar.archive.3tz+zip": { "source": "iana", "compressible": false },
  "application/vnd.maxmind.maxmind-db": { "source": "iana" },
  "application/vnd.mcd": { "source": "iana", "extensions": ["mcd"] },
  "application/vnd.medcalcdata": { "source": "iana", "extensions": ["mc1"] },
  "application/vnd.mediastation.cdkey": { "source": "iana", "extensions": ["cdkey"] },
  "application/vnd.meridian-slingshot": { "source": "iana" },
  "application/vnd.mfer": { "source": "iana", "extensions": ["mwf"] },
  "application/vnd.mfmp": { "source": "iana", "extensions": ["mfm"] },
  "application/vnd.micro+json": { "source": "iana", "compressible": true },
  "application/vnd.micrografx.flo": { "source": "iana", "extensions": ["flo"] },
  "application/vnd.micrografx.igx": { "source": "iana", "extensions": ["igx"] },
  "application/vnd.microsoft.portable-executable": { "source": "iana" },
  "application/vnd.microsoft.windows.thumbnail-cache": { "source": "iana" },
  "application/vnd.miele+json": { "source": "iana", "compressible": true },
  "application/vnd.mif": { "source": "iana", "extensions": ["mif"] },
  "application/vnd.minisoft-hp3000-save": { "source": "iana" },
  "application/vnd.mitsubishi.misty-guard.trustweb": { "source": "iana" },
  "application/vnd.mobius.daf": { "source": "iana", "extensions": ["daf"] },
  "application/vnd.mobius.dis": { "source": "iana", "extensions": ["dis"] },
  "application/vnd.mobius.mbk": { "source": "iana", "extensions": ["mbk"] },
  "application/vnd.mobius.mqy": { "source": "iana", "extensions": ["mqy"] },
  "application/vnd.mobius.msl": { "source": "iana", "extensions": ["msl"] },
  "application/vnd.mobius.plc": { "source": "iana", "extensions": ["plc"] },
  "application/vnd.mobius.txf": { "source": "iana", "extensions": ["txf"] },
  "application/vnd.mophun.application": { "source": "iana", "extensions": ["mpn"] },
  "application/vnd.mophun.certificate": { "source": "iana", "extensions": ["mpc"] },
  "application/vnd.motorola.flexsuite": { "source": "iana" },
  "application/vnd.motorola.flexsuite.adsi": { "source": "iana" },
  "application/vnd.motorola.flexsuite.fis": { "source": "iana" },
  "application/vnd.motorola.flexsuite.gotap": { "source": "iana" },
  "application/vnd.motorola.flexsuite.kmr": { "source": "iana" },
  "application/vnd.motorola.flexsuite.ttc": { "source": "iana" },
  "application/vnd.motorola.flexsuite.wem": { "source": "iana" },
  "application/vnd.motorola.iprm": { "source": "iana" },
  "application/vnd.mozilla.xul+xml": { "source": "iana", "compressible": true, "extensions": ["xul"] },
  "application/vnd.ms-3mfdocument": { "source": "iana" },
  "application/vnd.ms-artgalry": { "source": "iana", "extensions": ["cil"] },
  "application/vnd.ms-asf": { "source": "iana" },
  "application/vnd.ms-cab-compressed": { "source": "iana", "extensions": ["cab"] },
  "application/vnd.ms-color.iccprofile": { "source": "apache" },
  "application/vnd.ms-excel": { "source": "iana", "compressible": false, "extensions": ["xls", "xlm", "xla", "xlc", "xlt", "xlw"] },
  "application/vnd.ms-excel.addin.macroenabled.12": { "source": "iana", "extensions": ["xlam"] },
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": { "source": "iana", "extensions": ["xlsb"] },
  "application/vnd.ms-excel.sheet.macroenabled.12": { "source": "iana", "extensions": ["xlsm"] },
  "application/vnd.ms-excel.template.macroenabled.12": { "source": "iana", "extensions": ["xltm"] },
  "application/vnd.ms-fontobject": { "source": "iana", "compressible": true, "extensions": ["eot"] },
  "application/vnd.ms-htmlhelp": { "source": "iana", "extensions": ["chm"] },
  "application/vnd.ms-ims": { "source": "iana", "extensions": ["ims"] },
  "application/vnd.ms-lrm": { "source": "iana", "extensions": ["lrm"] },
  "application/vnd.ms-office.activex+xml": { "source": "iana", "compressible": true },
  "application/vnd.ms-officetheme": { "source": "iana", "extensions": ["thmx"] },
  "application/vnd.ms-opentype": { "source": "apache", "compressible": true },
  "application/vnd.ms-outlook": { "compressible": false, "extensions": ["msg"] },
  "application/vnd.ms-package.obfuscated-opentype": { "source": "apache" },
  "application/vnd.ms-pki.seccat": { "source": "apache", "extensions": ["cat"] },
  "application/vnd.ms-pki.stl": { "source": "apache", "extensions": ["stl"] },
  "application/vnd.ms-playready.initiator+xml": { "source": "iana", "compressible": true },
  "application/vnd.ms-powerpoint": { "source": "iana", "compressible": false, "extensions": ["ppt", "pps", "pot"] },
  "application/vnd.ms-powerpoint.addin.macroenabled.12": { "source": "iana", "extensions": ["ppam"] },
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": { "source": "iana", "extensions": ["pptm"] },
  "application/vnd.ms-powerpoint.slide.macroenabled.12": { "source": "iana", "extensions": ["sldm"] },
  "application/vnd.ms-powerpoint.slideshow.macroenabled.12": { "source": "iana", "extensions": ["ppsm"] },
  "application/vnd.ms-powerpoint.template.macroenabled.12": { "source": "iana", "extensions": ["potm"] },
  "application/vnd.ms-printdevicecapabilities+xml": { "source": "iana", "compressible": true },
  "application/vnd.ms-printing.printticket+xml": { "source": "apache", "compressible": true },
  "application/vnd.ms-printschematicket+xml": { "source": "iana", "compressible": true },
  "application/vnd.ms-project": { "source": "iana", "extensions": ["mpp", "mpt"] },
  "application/vnd.ms-tnef": { "source": "iana" },
  "application/vnd.ms-windows.devicepairing": { "source": "iana" },
  "application/vnd.ms-windows.nwprinting.oob": { "source": "iana" },
  "application/vnd.ms-windows.printerpairing": { "source": "iana" },
  "application/vnd.ms-windows.wsd.oob": { "source": "iana" },
  "application/vnd.ms-wmdrm.lic-chlg-req": { "source": "iana" },
  "application/vnd.ms-wmdrm.lic-resp": { "source": "iana" },
  "application/vnd.ms-wmdrm.meter-chlg-req": { "source": "iana" },
  "application/vnd.ms-wmdrm.meter-resp": { "source": "iana" },
  "application/vnd.ms-word.document.macroenabled.12": { "source": "iana", "extensions": ["docm"] },
  "application/vnd.ms-word.template.macroenabled.12": { "source": "iana", "extensions": ["dotm"] },
  "application/vnd.ms-works": { "source": "iana", "extensions": ["wps", "wks", "wcm", "wdb"] },
  "application/vnd.ms-wpl": { "source": "iana", "extensions": ["wpl"] },
  "application/vnd.ms-xpsdocument": { "source": "iana", "compressible": false, "extensions": ["xps"] },
  "application/vnd.msa-disk-image": { "source": "iana" },
  "application/vnd.mseq": { "source": "iana", "extensions": ["mseq"] },
  "application/vnd.msign": { "source": "iana" },
  "application/vnd.multiad.creator": { "source": "iana" },
  "application/vnd.multiad.creator.cif": { "source": "iana" },
  "application/vnd.music-niff": { "source": "iana" },
  "application/vnd.musician": { "source": "iana", "extensions": ["mus"] },
  "application/vnd.muvee.style": { "source": "iana", "extensions": ["msty"] },
  "application/vnd.mynfc": { "source": "iana", "extensions": ["taglet"] },
  "application/vnd.nacamar.ybrid+json": { "source": "iana", "compressible": true },
  "application/vnd.ncd.control": { "source": "iana" },
  "application/vnd.ncd.reference": { "source": "iana" },
  "application/vnd.nearst.inv+json": { "source": "iana", "compressible": true },
  "application/vnd.nebumind.line": { "source": "iana" },
  "application/vnd.nervana": { "source": "iana" },
  "application/vnd.netfpx": { "source": "iana" },
  "application/vnd.neurolanguage.nlu": { "source": "iana", "extensions": ["nlu"] },
  "application/vnd.nimn": { "source": "iana" },
  "application/vnd.nintendo.nitro.rom": { "source": "iana" },
  "application/vnd.nintendo.snes.rom": { "source": "iana" },
  "application/vnd.nitf": { "source": "iana", "extensions": ["ntf", "nitf"] },
  "application/vnd.noblenet-directory": { "source": "iana", "extensions": ["nnd"] },
  "application/vnd.noblenet-sealer": { "source": "iana", "extensions": ["nns"] },
  "application/vnd.noblenet-web": { "source": "iana", "extensions": ["nnw"] },
  "application/vnd.nokia.catalogs": { "source": "iana" },
  "application/vnd.nokia.conml+wbxml": { "source": "iana" },
  "application/vnd.nokia.conml+xml": { "source": "iana", "compressible": true },
  "application/vnd.nokia.iptv.config+xml": { "source": "iana", "compressible": true },
  "application/vnd.nokia.isds-radio-presets": { "source": "iana" },
  "application/vnd.nokia.landmark+wbxml": { "source": "iana" },
  "application/vnd.nokia.landmark+xml": { "source": "iana", "compressible": true },
  "application/vnd.nokia.landmarkcollection+xml": { "source": "iana", "compressible": true },
  "application/vnd.nokia.n-gage.ac+xml": { "source": "iana", "compressible": true, "extensions": ["ac"] },
  "application/vnd.nokia.n-gage.data": { "source": "iana", "extensions": ["ngdat"] },
  "application/vnd.nokia.n-gage.symbian.install": { "source": "iana", "extensions": ["n-gage"] },
  "application/vnd.nokia.ncd": { "source": "iana" },
  "application/vnd.nokia.pcd+wbxml": { "source": "iana" },
  "application/vnd.nokia.pcd+xml": { "source": "iana", "compressible": true },
  "application/vnd.nokia.radio-preset": { "source": "iana", "extensions": ["rpst"] },
  "application/vnd.nokia.radio-presets": { "source": "iana", "extensions": ["rpss"] },
  "application/vnd.novadigm.edm": { "source": "iana", "extensions": ["edm"] },
  "application/vnd.novadigm.edx": { "source": "iana", "extensions": ["edx"] },
  "application/vnd.novadigm.ext": { "source": "iana", "extensions": ["ext"] },
  "application/vnd.ntt-local.content-share": { "source": "iana" },
  "application/vnd.ntt-local.file-transfer": { "source": "iana" },
  "application/vnd.ntt-local.ogw_remote-access": { "source": "iana" },
  "application/vnd.ntt-local.sip-ta_remote": { "source": "iana" },
  "application/vnd.ntt-local.sip-ta_tcp_stream": { "source": "iana" },
  "application/vnd.oasis.opendocument.chart": { "source": "iana", "extensions": ["odc"] },
  "application/vnd.oasis.opendocument.chart-template": { "source": "iana", "extensions": ["otc"] },
  "application/vnd.oasis.opendocument.database": { "source": "iana", "extensions": ["odb"] },
  "application/vnd.oasis.opendocument.formula": { "source": "iana", "extensions": ["odf"] },
  "application/vnd.oasis.opendocument.formula-template": { "source": "iana", "extensions": ["odft"] },
  "application/vnd.oasis.opendocument.graphics": { "source": "iana", "compressible": false, "extensions": ["odg"] },
  "application/vnd.oasis.opendocument.graphics-template": { "source": "iana", "extensions": ["otg"] },
  "application/vnd.oasis.opendocument.image": { "source": "iana", "extensions": ["odi"] },
  "application/vnd.oasis.opendocument.image-template": { "source": "iana", "extensions": ["oti"] },
  "application/vnd.oasis.opendocument.presentation": { "source": "iana", "compressible": false, "extensions": ["odp"] },
  "application/vnd.oasis.opendocument.presentation-template": { "source": "iana", "extensions": ["otp"] },
  "application/vnd.oasis.opendocument.spreadsheet": { "source": "iana", "compressible": false, "extensions": ["ods"] },
  "application/vnd.oasis.opendocument.spreadsheet-template": { "source": "iana", "extensions": ["ots"] },
  "application/vnd.oasis.opendocument.text": { "source": "iana", "compressible": false, "extensions": ["odt"] },
  "application/vnd.oasis.opendocument.text-master": { "source": "iana", "extensions": ["odm"] },
  "application/vnd.oasis.opendocument.text-template": { "source": "iana", "extensions": ["ott"] },
  "application/vnd.oasis.opendocument.text-web": { "source": "iana", "extensions": ["oth"] },
  "application/vnd.obn": { "source": "iana" },
  "application/vnd.ocf+cbor": { "source": "iana" },
  "application/vnd.oci.image.manifest.v1+json": { "source": "iana", "compressible": true },
  "application/vnd.oftn.l10n+json": { "source": "iana", "compressible": true },
  "application/vnd.oipf.contentaccessdownload+xml": { "source": "iana", "compressible": true },
  "application/vnd.oipf.contentaccessstreaming+xml": { "source": "iana", "compressible": true },
  "application/vnd.oipf.cspg-hexbinary": { "source": "iana" },
  "application/vnd.oipf.dae.svg+xml": { "source": "iana", "compressible": true },
  "application/vnd.oipf.dae.xhtml+xml": { "source": "iana", "compressible": true },
  "application/vnd.oipf.mippvcontrolmessage+xml": { "source": "iana", "compressible": true },
  "application/vnd.oipf.pae.gem": { "source": "iana" },
  "application/vnd.oipf.spdiscovery+xml": { "source": "iana", "compressible": true },
  "application/vnd.oipf.spdlist+xml": { "source": "iana", "compressible": true },
  "application/vnd.oipf.ueprofile+xml": { "source": "iana", "compressible": true },
  "application/vnd.oipf.userprofile+xml": { "source": "iana", "compressible": true },
  "application/vnd.olpc-sugar": { "source": "iana", "extensions": ["xo"] },
  "application/vnd.oma-scws-config": { "source": "iana" },
  "application/vnd.oma-scws-http-request": { "source": "iana" },
  "application/vnd.oma-scws-http-response": { "source": "iana" },
  "application/vnd.oma.bcast.associated-procedure-parameter+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.bcast.drm-trigger+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.bcast.imd+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.bcast.ltkm": { "source": "iana" },
  "application/vnd.oma.bcast.notification+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.bcast.provisioningtrigger": { "source": "iana" },
  "application/vnd.oma.bcast.sgboot": { "source": "iana" },
  "application/vnd.oma.bcast.sgdd+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.bcast.sgdu": { "source": "iana" },
  "application/vnd.oma.bcast.simple-symbol-container": { "source": "iana" },
  "application/vnd.oma.bcast.smartcard-trigger+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.bcast.sprov+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.bcast.stkm": { "source": "iana" },
  "application/vnd.oma.cab-address-book+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.cab-feature-handler+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.cab-pcc+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.cab-subs-invite+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.cab-user-prefs+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.dcd": { "source": "iana" },
  "application/vnd.oma.dcdc": { "source": "iana" },
  "application/vnd.oma.dd2+xml": { "source": "iana", "compressible": true, "extensions": ["dd2"] },
  "application/vnd.oma.drm.risd+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.group-usage-list+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.lwm2m+cbor": { "source": "iana" },
  "application/vnd.oma.lwm2m+json": { "source": "iana", "compressible": true },
  "application/vnd.oma.lwm2m+tlv": { "source": "iana" },
  "application/vnd.oma.pal+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.poc.detailed-progress-report+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.poc.final-report+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.poc.groups+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.poc.invocation-descriptor+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.poc.optimized-progress-report+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.push": { "source": "iana" },
  "application/vnd.oma.scidm.messages+xml": { "source": "iana", "compressible": true },
  "application/vnd.oma.xcap-directory+xml": { "source": "iana", "compressible": true },
  "application/vnd.omads-email+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/vnd.omads-file+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/vnd.omads-folder+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/vnd.omaloc-supl-init": { "source": "iana" },
  "application/vnd.onepager": { "source": "iana" },
  "application/vnd.onepagertamp": { "source": "iana" },
  "application/vnd.onepagertamx": { "source": "iana" },
  "application/vnd.onepagertat": { "source": "iana" },
  "application/vnd.onepagertatp": { "source": "iana" },
  "application/vnd.onepagertatx": { "source": "iana" },
  "application/vnd.openblox.game+xml": { "source": "iana", "compressible": true, "extensions": ["obgx"] },
  "application/vnd.openblox.game-binary": { "source": "iana" },
  "application/vnd.openeye.oeb": { "source": "iana" },
  "application/vnd.openofficeorg.extension": { "source": "apache", "extensions": ["oxt"] },
  "application/vnd.openstreetmap.data+xml": { "source": "iana", "compressible": true, "extensions": ["osm"] },
  "application/vnd.opentimestamps.ots": { "source": "iana" },
  "application/vnd.openxmlformats-officedocument.custom-properties+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.customxmlproperties+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.drawing+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.drawingml.chart+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.drawingml.diagramcolors+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.drawingml.diagramdata+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.drawingml.diagramlayout+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.drawingml.diagramstyle+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.extended-properties+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.commentauthors+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.comments+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.handoutmaster+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.notesmaster+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.notesslide+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { "source": "iana", "compressible": false, "extensions": ["pptx"] },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.presprops+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.slide": { "source": "iana", "extensions": ["sldx"] },
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.slidelayout+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.slidemaster+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow": { "source": "iana", "extensions": ["ppsx"] },
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.slideupdateinfo+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.tablestyles+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.tags+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.template": { "source": "iana", "extensions": ["potx"] },
  "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.presentationml.viewprops+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.calcchain+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.externallink+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotcachedefinition+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotcacherecords+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivottable+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.querytable+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.revisionheaders+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.revisionlog+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedstrings+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { "source": "iana", "compressible": false, "extensions": ["xlsx"] },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetmetadata+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.tablesinglecells+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template": { "source": "iana", "extensions": ["xltx"] },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.usernames+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.volatiledependencies+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.theme+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.themeoverride+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.vmldrawing": { "source": "iana" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { "source": "iana", "compressible": false, "extensions": ["docx"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.glossary+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.fonttable+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template": { "source": "iana", "extensions": ["dotx"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.websettings+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-package.core-properties+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml": { "source": "iana", "compressible": true },
  "application/vnd.openxmlformats-package.relationships+xml": { "source": "iana", "compressible": true },
  "application/vnd.oracle.resource+json": { "source": "iana", "compressible": true },
  "application/vnd.orange.indata": { "source": "iana" },
  "application/vnd.osa.netdeploy": { "source": "iana" },
  "application/vnd.osgeo.mapguide.package": { "source": "iana", "extensions": ["mgp"] },
  "application/vnd.osgi.bundle": { "source": "iana" },
  "application/vnd.osgi.dp": { "source": "iana", "extensions": ["dp"] },
  "application/vnd.osgi.subsystem": { "source": "iana", "extensions": ["esa"] },
  "application/vnd.otps.ct-kip+xml": { "source": "iana", "compressible": true },
  "application/vnd.oxli.countgraph": { "source": "iana" },
  "application/vnd.pagerduty+json": { "source": "iana", "compressible": true },
  "application/vnd.palm": { "source": "iana", "extensions": ["pdb", "pqa", "oprc"] },
  "application/vnd.panoply": { "source": "iana" },
  "application/vnd.paos.xml": { "source": "iana" },
  "application/vnd.patentdive": { "source": "iana" },
  "application/vnd.patientecommsdoc": { "source": "iana" },
  "application/vnd.pawaafile": { "source": "iana", "extensions": ["paw"] },
  "application/vnd.pcos": { "source": "iana" },
  "application/vnd.pg.format": { "source": "iana", "extensions": ["str"] },
  "application/vnd.pg.osasli": { "source": "iana", "extensions": ["ei6"] },
  "application/vnd.piaccess.application-licence": { "source": "iana" },
  "application/vnd.picsel": { "source": "iana", "extensions": ["efif"] },
  "application/vnd.pmi.widget": { "source": "iana", "extensions": ["wg"] },
  "application/vnd.poc.group-advertisement+xml": { "source": "iana", "compressible": true },
  "application/vnd.pocketlearn": { "source": "iana", "extensions": ["plf"] },
  "application/vnd.powerbuilder6": { "source": "iana", "extensions": ["pbd"] },
  "application/vnd.powerbuilder6-s": { "source": "iana" },
  "application/vnd.powerbuilder7": { "source": "iana" },
  "application/vnd.powerbuilder7-s": { "source": "iana" },
  "application/vnd.powerbuilder75": { "source": "iana" },
  "application/vnd.powerbuilder75-s": { "source": "iana" },
  "application/vnd.preminet": { "source": "iana" },
  "application/vnd.previewsystems.box": { "source": "iana", "extensions": ["box"] },
  "application/vnd.proteus.magazine": { "source": "iana", "extensions": ["mgz"] },
  "application/vnd.psfs": { "source": "iana" },
  "application/vnd.publishare-delta-tree": { "source": "iana", "extensions": ["qps"] },
  "application/vnd.pvi.ptid1": { "source": "iana", "extensions": ["ptid"] },
  "application/vnd.pwg-multiplexed": { "source": "iana" },
  "application/vnd.pwg-xhtml-print+xml": { "source": "iana", "compressible": true },
  "application/vnd.qualcomm.brew-app-res": { "source": "iana" },
  "application/vnd.quarantainenet": { "source": "iana" },
  "application/vnd.quark.quarkxpress": { "source": "iana", "extensions": ["qxd", "qxt", "qwd", "qwt", "qxl", "qxb"] },
  "application/vnd.quobject-quoxdocument": { "source": "iana" },
  "application/vnd.radisys.moml+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-audit+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-audit-conf+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-audit-conn+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-audit-dialog+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-audit-stream+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-conf+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-dialog+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-dialog-base+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-dialog-fax-detect+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-dialog-fax-sendrecv+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-dialog-group+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-dialog-speech+xml": { "source": "iana", "compressible": true },
  "application/vnd.radisys.msml-dialog-transform+xml": { "source": "iana", "compressible": true },
  "application/vnd.rainstor.data": { "source": "iana" },
  "application/vnd.rapid": { "source": "iana" },
  "application/vnd.rar": { "source": "iana", "extensions": ["rar"] },
  "application/vnd.realvnc.bed": { "source": "iana", "extensions": ["bed"] },
  "application/vnd.recordare.musicxml": { "source": "iana", "extensions": ["mxl"] },
  "application/vnd.recordare.musicxml+xml": { "source": "iana", "compressible": true, "extensions": ["musicxml"] },
  "application/vnd.renlearn.rlprint": { "source": "iana" },
  "application/vnd.resilient.logic": { "source": "iana" },
  "application/vnd.restful+json": { "source": "iana", "compressible": true },
  "application/vnd.rig.cryptonote": { "source": "iana", "extensions": ["cryptonote"] },
  "application/vnd.rim.cod": { "source": "apache", "extensions": ["cod"] },
  "application/vnd.rn-realmedia": { "source": "apache", "extensions": ["rm"] },
  "application/vnd.rn-realmedia-vbr": { "source": "apache", "extensions": ["rmvb"] },
  "application/vnd.route66.link66+xml": { "source": "iana", "compressible": true, "extensions": ["link66"] },
  "application/vnd.rs-274x": { "source": "iana" },
  "application/vnd.ruckus.download": { "source": "iana" },
  "application/vnd.s3sms": { "source": "iana" },
  "application/vnd.sailingtracker.track": { "source": "iana", "extensions": ["st"] },
  "application/vnd.sar": { "source": "iana" },
  "application/vnd.sbm.cid": { "source": "iana" },
  "application/vnd.sbm.mid2": { "source": "iana" },
  "application/vnd.scribus": { "source": "iana" },
  "application/vnd.sealed.3df": { "source": "iana" },
  "application/vnd.sealed.csf": { "source": "iana" },
  "application/vnd.sealed.doc": { "source": "iana" },
  "application/vnd.sealed.eml": { "source": "iana" },
  "application/vnd.sealed.mht": { "source": "iana" },
  "application/vnd.sealed.net": { "source": "iana" },
  "application/vnd.sealed.ppt": { "source": "iana" },
  "application/vnd.sealed.tiff": { "source": "iana" },
  "application/vnd.sealed.xls": { "source": "iana" },
  "application/vnd.sealedmedia.softseal.html": { "source": "iana" },
  "application/vnd.sealedmedia.softseal.pdf": { "source": "iana" },
  "application/vnd.seemail": { "source": "iana", "extensions": ["see"] },
  "application/vnd.seis+json": { "source": "iana", "compressible": true },
  "application/vnd.sema": { "source": "iana", "extensions": ["sema"] },
  "application/vnd.semd": { "source": "iana", "extensions": ["semd"] },
  "application/vnd.semf": { "source": "iana", "extensions": ["semf"] },
  "application/vnd.shade-save-file": { "source": "iana" },
  "application/vnd.shana.informed.formdata": { "source": "iana", "extensions": ["ifm"] },
  "application/vnd.shana.informed.formtemplate": { "source": "iana", "extensions": ["itp"] },
  "application/vnd.shana.informed.interchange": { "source": "iana", "extensions": ["iif"] },
  "application/vnd.shana.informed.package": { "source": "iana", "extensions": ["ipk"] },
  "application/vnd.shootproof+json": { "source": "iana", "compressible": true },
  "application/vnd.shopkick+json": { "source": "iana", "compressible": true },
  "application/vnd.shp": { "source": "iana" },
  "application/vnd.shx": { "source": "iana" },
  "application/vnd.sigrok.session": { "source": "iana" },
  "application/vnd.simtech-mindmapper": { "source": "iana", "extensions": ["twd", "twds"] },
  "application/vnd.siren+json": { "source": "iana", "compressible": true },
  "application/vnd.smaf": { "source": "iana", "extensions": ["mmf"] },
  "application/vnd.smart.notebook": { "source": "iana" },
  "application/vnd.smart.teacher": { "source": "iana", "extensions": ["teacher"] },
  "application/vnd.snesdev-page-table": { "source": "iana" },
  "application/vnd.software602.filler.form+xml": { "source": "iana", "compressible": true, "extensions": ["fo"] },
  "application/vnd.software602.filler.form-xml-zip": { "source": "iana" },
  "application/vnd.solent.sdkm+xml": { "source": "iana", "compressible": true, "extensions": ["sdkm", "sdkd"] },
  "application/vnd.spotfire.dxp": { "source": "iana", "extensions": ["dxp"] },
  "application/vnd.spotfire.sfs": { "source": "iana", "extensions": ["sfs"] },
  "application/vnd.sqlite3": { "source": "iana" },
  "application/vnd.sss-cod": { "source": "iana" },
  "application/vnd.sss-dtf": { "source": "iana" },
  "application/vnd.sss-ntf": { "source": "iana" },
  "application/vnd.stardivision.calc": { "source": "apache", "extensions": ["sdc"] },
  "application/vnd.stardivision.draw": { "source": "apache", "extensions": ["sda"] },
  "application/vnd.stardivision.impress": { "source": "apache", "extensions": ["sdd"] },
  "application/vnd.stardivision.math": { "source": "apache", "extensions": ["smf"] },
  "application/vnd.stardivision.writer": { "source": "apache", "extensions": ["sdw", "vor"] },
  "application/vnd.stardivision.writer-global": { "source": "apache", "extensions": ["sgl"] },
  "application/vnd.stepmania.package": { "source": "iana", "extensions": ["smzip"] },
  "application/vnd.stepmania.stepchart": { "source": "iana", "extensions": ["sm"] },
  "application/vnd.street-stream": { "source": "iana" },
  "application/vnd.sun.wadl+xml": { "source": "iana", "compressible": true, "extensions": ["wadl"] },
  "application/vnd.sun.xml.calc": { "source": "apache", "extensions": ["sxc"] },
  "application/vnd.sun.xml.calc.template": { "source": "apache", "extensions": ["stc"] },
  "application/vnd.sun.xml.draw": { "source": "apache", "extensions": ["sxd"] },
  "application/vnd.sun.xml.draw.template": { "source": "apache", "extensions": ["std"] },
  "application/vnd.sun.xml.impress": { "source": "apache", "extensions": ["sxi"] },
  "application/vnd.sun.xml.impress.template": { "source": "apache", "extensions": ["sti"] },
  "application/vnd.sun.xml.math": { "source": "apache", "extensions": ["sxm"] },
  "application/vnd.sun.xml.writer": { "source": "apache", "extensions": ["sxw"] },
  "application/vnd.sun.xml.writer.global": { "source": "apache", "extensions": ["sxg"] },
  "application/vnd.sun.xml.writer.template": { "source": "apache", "extensions": ["stw"] },
  "application/vnd.sus-calendar": { "source": "iana", "extensions": ["sus", "susp"] },
  "application/vnd.svd": { "source": "iana", "extensions": ["svd"] },
  "application/vnd.swiftview-ics": { "source": "iana" },
  "application/vnd.sycle+xml": { "source": "iana", "compressible": true },
  "application/vnd.syft+json": { "source": "iana", "compressible": true },
  "application/vnd.symbian.install": { "source": "apache", "extensions": ["sis", "sisx"] },
  "application/vnd.syncml+xml": { "source": "iana", "charset": "UTF-8", "compressible": true, "extensions": ["xsm"] },
  "application/vnd.syncml.dm+wbxml": { "source": "iana", "charset": "UTF-8", "extensions": ["bdm"] },
  "application/vnd.syncml.dm+xml": { "source": "iana", "charset": "UTF-8", "compressible": true, "extensions": ["xdm"] },
  "application/vnd.syncml.dm.notification": { "source": "iana" },
  "application/vnd.syncml.dmddf+wbxml": { "source": "iana" },
  "application/vnd.syncml.dmddf+xml": { "source": "iana", "charset": "UTF-8", "compressible": true, "extensions": ["ddf"] },
  "application/vnd.syncml.dmtnds+wbxml": { "source": "iana" },
  "application/vnd.syncml.dmtnds+xml": { "source": "iana", "charset": "UTF-8", "compressible": true },
  "application/vnd.syncml.ds.notification": { "source": "iana" },
  "application/vnd.tableschema+json": { "source": "iana", "compressible": true },
  "application/vnd.tao.intent-module-archive": { "source": "iana", "extensions": ["tao"] },
  "application/vnd.tcpdump.pcap": { "source": "iana", "extensions": ["pcap", "cap", "dmp"] },
  "application/vnd.think-cell.ppttc+json": { "source": "iana", "compressible": true },
  "application/vnd.tmd.mediaflex.api+xml": { "source": "iana", "compressible": true },
  "application/vnd.tml": { "source": "iana" },
  "application/vnd.tmobile-livetv": { "source": "iana", "extensions": ["tmo"] },
  "application/vnd.tri.onesource": { "source": "iana" },
  "application/vnd.trid.tpt": { "source": "iana", "extensions": ["tpt"] },
  "application/vnd.triscape.mxs": { "source": "iana", "extensions": ["mxs"] },
  "application/vnd.trueapp": { "source": "iana", "extensions": ["tra"] },
  "application/vnd.truedoc": { "source": "iana" },
  "application/vnd.ubisoft.webplayer": { "source": "iana" },
  "application/vnd.ufdl": { "source": "iana", "extensions": ["ufd", "ufdl"] },
  "application/vnd.uiq.theme": { "source": "iana", "extensions": ["utz"] },
  "application/vnd.umajin": { "source": "iana", "extensions": ["umj"] },
  "application/vnd.unity": { "source": "iana", "extensions": ["unityweb"] },
  "application/vnd.uoml+xml": { "source": "iana", "compressible": true, "extensions": ["uoml"] },
  "application/vnd.uplanet.alert": { "source": "iana" },
  "application/vnd.uplanet.alert-wbxml": { "source": "iana" },
  "application/vnd.uplanet.bearer-choice": { "source": "iana" },
  "application/vnd.uplanet.bearer-choice-wbxml": { "source": "iana" },
  "application/vnd.uplanet.cacheop": { "source": "iana" },
  "application/vnd.uplanet.cacheop-wbxml": { "source": "iana" },
  "application/vnd.uplanet.channel": { "source": "iana" },
  "application/vnd.uplanet.channel-wbxml": { "source": "iana" },
  "application/vnd.uplanet.list": { "source": "iana" },
  "application/vnd.uplanet.list-wbxml": { "source": "iana" },
  "application/vnd.uplanet.listcmd": { "source": "iana" },
  "application/vnd.uplanet.listcmd-wbxml": { "source": "iana" },
  "application/vnd.uplanet.signal": { "source": "iana" },
  "application/vnd.uri-map": { "source": "iana" },
  "application/vnd.valve.source.material": { "source": "iana" },
  "application/vnd.vcx": { "source": "iana", "extensions": ["vcx"] },
  "application/vnd.vd-study": { "source": "iana" },
  "application/vnd.vectorworks": { "source": "iana" },
  "application/vnd.vel+json": { "source": "iana", "compressible": true },
  "application/vnd.verimatrix.vcas": { "source": "iana" },
  "application/vnd.veritone.aion+json": { "source": "iana", "compressible": true },
  "application/vnd.veryant.thin": { "source": "iana" },
  "application/vnd.ves.encrypted": { "source": "iana" },
  "application/vnd.vidsoft.vidconference": { "source": "iana" },
  "application/vnd.visio": { "source": "iana", "extensions": ["vsd", "vst", "vss", "vsw"] },
  "application/vnd.visionary": { "source": "iana", "extensions": ["vis"] },
  "application/vnd.vividence.scriptfile": { "source": "iana" },
  "application/vnd.vsf": { "source": "iana", "extensions": ["vsf"] },
  "application/vnd.wap.sic": { "source": "iana" },
  "application/vnd.wap.slc": { "source": "iana" },
  "application/vnd.wap.wbxml": { "source": "iana", "charset": "UTF-8", "extensions": ["wbxml"] },
  "application/vnd.wap.wmlc": { "source": "iana", "extensions": ["wmlc"] },
  "application/vnd.wap.wmlscriptc": { "source": "iana", "extensions": ["wmlsc"] },
  "application/vnd.webturbo": { "source": "iana", "extensions": ["wtb"] },
  "application/vnd.wfa.dpp": { "source": "iana" },
  "application/vnd.wfa.p2p": { "source": "iana" },
  "application/vnd.wfa.wsc": { "source": "iana" },
  "application/vnd.windows.devicepairing": { "source": "iana" },
  "application/vnd.wmc": { "source": "iana" },
  "application/vnd.wmf.bootstrap": { "source": "iana" },
  "application/vnd.wolfram.mathematica": { "source": "iana" },
  "application/vnd.wolfram.mathematica.package": { "source": "iana" },
  "application/vnd.wolfram.player": { "source": "iana", "extensions": ["nbp"] },
  "application/vnd.wordperfect": { "source": "iana", "extensions": ["wpd"] },
  "application/vnd.wqd": { "source": "iana", "extensions": ["wqd"] },
  "application/vnd.wrq-hp3000-labelled": { "source": "iana" },
  "application/vnd.wt.stf": { "source": "iana", "extensions": ["stf"] },
  "application/vnd.wv.csp+wbxml": { "source": "iana" },
  "application/vnd.wv.csp+xml": { "source": "iana", "compressible": true },
  "application/vnd.wv.ssp+xml": { "source": "iana", "compressible": true },
  "application/vnd.xacml+json": { "source": "iana", "compressible": true },
  "application/vnd.xara": { "source": "iana", "extensions": ["xar"] },
  "application/vnd.xfdl": { "source": "iana", "extensions": ["xfdl"] },
  "application/vnd.xfdl.webform": { "source": "iana" },
  "application/vnd.xmi+xml": { "source": "iana", "compressible": true },
  "application/vnd.xmpie.cpkg": { "source": "iana" },
  "application/vnd.xmpie.dpkg": { "source": "iana" },
  "application/vnd.xmpie.plan": { "source": "iana" },
  "application/vnd.xmpie.ppkg": { "source": "iana" },
  "application/vnd.xmpie.xlim": { "source": "iana" },
  "application/vnd.yamaha.hv-dic": { "source": "iana", "extensions": ["hvd"] },
  "application/vnd.yamaha.hv-script": { "source": "iana", "extensions": ["hvs"] },
  "application/vnd.yamaha.hv-voice": { "source": "iana", "extensions": ["hvp"] },
  "application/vnd.yamaha.openscoreformat": { "source": "iana", "extensions": ["osf"] },
  "application/vnd.yamaha.openscoreformat.osfpvg+xml": { "source": "iana", "compressible": true, "extensions": ["osfpvg"] },
  "application/vnd.yamaha.remote-setup": { "source": "iana" },
  "application/vnd.yamaha.smaf-audio": { "source": "iana", "extensions": ["saf"] },
  "application/vnd.yamaha.smaf-phrase": { "source": "iana", "extensions": ["spf"] },
  "application/vnd.yamaha.through-ngn": { "source": "iana" },
  "application/vnd.yamaha.tunnel-udpencap": { "source": "iana" },
  "application/vnd.yaoweme": { "source": "iana" },
  "application/vnd.yellowriver-custom-menu": { "source": "iana", "extensions": ["cmp"] },
  "application/vnd.youtube.yt": { "source": "iana" },
  "application/vnd.zul": { "source": "iana", "extensions": ["zir", "zirz"] },
  "application/vnd.zzazz.deck+xml": { "source": "iana", "compressible": true, "extensions": ["zaz"] },
  "application/voicexml+xml": { "source": "iana", "compressible": true, "extensions": ["vxml"] },
  "application/voucher-cms+json": { "source": "iana", "compressible": true },
  "application/vq-rtcpxr": { "source": "iana" },
  "application/wasm": { "source": "iana", "compressible": true, "extensions": ["wasm"] },
  "application/watcherinfo+xml": { "source": "iana", "compressible": true, "extensions": ["wif"] },
  "application/webpush-options+json": { "source": "iana", "compressible": true },
  "application/whoispp-query": { "source": "iana" },
  "application/whoispp-response": { "source": "iana" },
  "application/widget": { "source": "iana", "extensions": ["wgt"] },
  "application/winhlp": { "source": "apache", "extensions": ["hlp"] },
  "application/wita": { "source": "iana" },
  "application/wordperfect5.1": { "source": "iana" },
  "application/wsdl+xml": { "source": "iana", "compressible": true, "extensions": ["wsdl"] },
  "application/wspolicy+xml": { "source": "iana", "compressible": true, "extensions": ["wspolicy"] },
  "application/x-7z-compressed": { "source": "apache", "compressible": false, "extensions": ["7z"] },
  "application/x-abiword": { "source": "apache", "extensions": ["abw"] },
  "application/x-ace-compressed": { "source": "apache", "extensions": ["ace"] },
  "application/x-amf": { "source": "apache" },
  "application/x-apple-diskimage": { "source": "apache", "extensions": ["dmg"] },
  "application/x-arj": { "compressible": false, "extensions": ["arj"] },
  "application/x-authorware-bin": { "source": "apache", "extensions": ["aab", "x32", "u32", "vox"] },
  "application/x-authorware-map": { "source": "apache", "extensions": ["aam"] },
  "application/x-authorware-seg": { "source": "apache", "extensions": ["aas"] },
  "application/x-bcpio": { "source": "apache", "extensions": ["bcpio"] },
  "application/x-bdoc": { "compressible": false, "extensions": ["bdoc"] },
  "application/x-bittorrent": { "source": "apache", "extensions": ["torrent"] },
  "application/x-blorb": { "source": "apache", "extensions": ["blb", "blorb"] },
  "application/x-bzip": { "source": "apache", "compressible": false, "extensions": ["bz"] },
  "application/x-bzip2": { "source": "apache", "compressible": false, "extensions": ["bz2", "boz"] },
  "application/x-cbr": { "source": "apache", "extensions": ["cbr", "cba", "cbt", "cbz", "cb7"] },
  "application/x-cdlink": { "source": "apache", "extensions": ["vcd"] },
  "application/x-cfs-compressed": { "source": "apache", "extensions": ["cfs"] },
  "application/x-chat": { "source": "apache", "extensions": ["chat"] },
  "application/x-chess-pgn": { "source": "apache", "extensions": ["pgn"] },
  "application/x-chrome-extension": { "extensions": ["crx"] },
  "application/x-cocoa": { "source": "nginx", "extensions": ["cco"] },
  "application/x-compress": { "source": "apache" },
  "application/x-conference": { "source": "apache", "extensions": ["nsc"] },
  "application/x-cpio": { "source": "apache", "extensions": ["cpio"] },
  "application/x-csh": { "source": "apache", "extensions": ["csh"] },
  "application/x-deb": { "compressible": false },
  "application/x-debian-package": { "source": "apache", "extensions": ["deb", "udeb"] },
  "application/x-dgc-compressed": { "source": "apache", "extensions": ["dgc"] },
  "application/x-director": { "source": "apache", "extensions": ["dir", "dcr", "dxr", "cst", "cct", "cxt", "w3d", "fgd", "swa"] },
  "application/x-doom": { "source": "apache", "extensions": ["wad"] },
  "application/x-dtbncx+xml": { "source": "apache", "compressible": true, "extensions": ["ncx"] },
  "application/x-dtbook+xml": { "source": "apache", "compressible": true, "extensions": ["dtb"] },
  "application/x-dtbresource+xml": { "source": "apache", "compressible": true, "extensions": ["res"] },
  "application/x-dvi": { "source": "apache", "compressible": false, "extensions": ["dvi"] },
  "application/x-envoy": { "source": "apache", "extensions": ["evy"] },
  "application/x-eva": { "source": "apache", "extensions": ["eva"] },
  "application/x-font-bdf": { "source": "apache", "extensions": ["bdf"] },
  "application/x-font-dos": { "source": "apache" },
  "application/x-font-framemaker": { "source": "apache" },
  "application/x-font-ghostscript": { "source": "apache", "extensions": ["gsf"] },
  "application/x-font-libgrx": { "source": "apache" },
  "application/x-font-linux-psf": { "source": "apache", "extensions": ["psf"] },
  "application/x-font-pcf": { "source": "apache", "extensions": ["pcf"] },
  "application/x-font-snf": { "source": "apache", "extensions": ["snf"] },
  "application/x-font-speedo": { "source": "apache" },
  "application/x-font-sunos-news": { "source": "apache" },
  "application/x-font-type1": { "source": "apache", "extensions": ["pfa", "pfb", "pfm", "afm"] },
  "application/x-font-vfont": { "source": "apache" },
  "application/x-freearc": { "source": "apache", "extensions": ["arc"] },
  "application/x-futuresplash": { "source": "apache", "extensions": ["spl"] },
  "application/x-gca-compressed": { "source": "apache", "extensions": ["gca"] },
  "application/x-glulx": { "source": "apache", "extensions": ["ulx"] },
  "application/x-gnumeric": { "source": "apache", "extensions": ["gnumeric"] },
  "application/x-gramps-xml": { "source": "apache", "extensions": ["gramps"] },
  "application/x-gtar": { "source": "apache", "extensions": ["gtar"] },
  "application/x-gzip": { "source": "apache" },
  "application/x-hdf": { "source": "apache", "extensions": ["hdf"] },
  "application/x-httpd-php": { "compressible": true, "extensions": ["php"] },
  "application/x-install-instructions": { "source": "apache", "extensions": ["install"] },
  "application/x-iso9660-image": { "source": "apache", "extensions": ["iso"] },
  "application/x-iwork-keynote-sffkey": { "extensions": ["key"] },
  "application/x-iwork-numbers-sffnumbers": { "extensions": ["numbers"] },
  "application/x-iwork-pages-sffpages": { "extensions": ["pages"] },
  "application/x-java-archive-diff": { "source": "nginx", "extensions": ["jardiff"] },
  "application/x-java-jnlp-file": { "source": "apache", "compressible": false, "extensions": ["jnlp"] },
  "application/x-javascript": { "compressible": true },
  "application/x-keepass2": { "extensions": ["kdbx"] },
  "application/x-latex": { "source": "apache", "compressible": false, "extensions": ["latex"] },
  "application/x-lua-bytecode": { "extensions": ["luac"] },
  "application/x-lzh-compressed": { "source": "apache", "extensions": ["lzh", "lha"] },
  "application/x-makeself": { "source": "nginx", "extensions": ["run"] },
  "application/x-mie": { "source": "apache", "extensions": ["mie"] },
  "application/x-mobipocket-ebook": { "source": "apache", "extensions": ["prc", "mobi"] },
  "application/x-mpegurl": { "compressible": false },
  "application/x-ms-application": { "source": "apache", "extensions": ["application"] },
  "application/x-ms-shortcut": { "source": "apache", "extensions": ["lnk"] },
  "application/x-ms-wmd": { "source": "apache", "extensions": ["wmd"] },
  "application/x-ms-wmz": { "source": "apache", "extensions": ["wmz"] },
  "application/x-ms-xbap": { "source": "apache", "extensions": ["xbap"] },
  "application/x-msaccess": { "source": "apache", "extensions": ["mdb"] },
  "application/x-msbinder": { "source": "apache", "extensions": ["obd"] },
  "application/x-mscardfile": { "source": "apache", "extensions": ["crd"] },
  "application/x-msclip": { "source": "apache", "extensions": ["clp"] },
  "application/x-msdos-program": { "extensions": ["exe"] },
  "application/x-msdownload": { "source": "apache", "extensions": ["exe", "dll", "com", "bat", "msi"] },
  "application/x-msmediaview": { "source": "apache", "extensions": ["mvb", "m13", "m14"] },
  "application/x-msmetafile": { "source": "apache", "extensions": ["wmf", "wmz", "emf", "emz"] },
  "application/x-msmoney": { "source": "apache", "extensions": ["mny"] },
  "application/x-mspublisher": { "source": "apache", "extensions": ["pub"] },
  "application/x-msschedule": { "source": "apache", "extensions": ["scd"] },
  "application/x-msterminal": { "source": "apache", "extensions": ["trm"] },
  "application/x-mswrite": { "source": "apache", "extensions": ["wri"] },
  "application/x-netcdf": { "source": "apache", "extensions": ["nc", "cdf"] },
  "application/x-ns-proxy-autoconfig": { "compressible": true, "extensions": ["pac"] },
  "application/x-nzb": { "source": "apache", "extensions": ["nzb"] },
  "application/x-perl": { "source": "nginx", "extensions": ["pl", "pm"] },
  "application/x-pilot": { "source": "nginx", "extensions": ["prc", "pdb"] },
  "application/x-pkcs12": { "source": "apache", "compressible": false, "extensions": ["p12", "pfx"] },
  "application/x-pkcs7-certificates": { "source": "apache", "extensions": ["p7b", "spc"] },
  "application/x-pkcs7-certreqresp": { "source": "apache", "extensions": ["p7r"] },
  "application/x-pki-message": { "source": "iana" },
  "application/x-rar-compressed": { "source": "apache", "compressible": false, "extensions": ["rar"] },
  "application/x-redhat-package-manager": { "source": "nginx", "extensions": ["rpm"] },
  "application/x-research-info-systems": { "source": "apache", "extensions": ["ris"] },
  "application/x-sea": { "source": "nginx", "extensions": ["sea"] },
  "application/x-sh": { "source": "apache", "compressible": true, "extensions": ["sh"] },
  "application/x-shar": { "source": "apache", "extensions": ["shar"] },
  "application/x-shockwave-flash": { "source": "apache", "compressible": false, "extensions": ["swf"] },
  "application/x-silverlight-app": { "source": "apache", "extensions": ["xap"] },
  "application/x-sql": { "source": "apache", "extensions": ["sql"] },
  "application/x-stuffit": { "source": "apache", "compressible": false, "extensions": ["sit"] },
  "application/x-stuffitx": { "source": "apache", "extensions": ["sitx"] },
  "application/x-subrip": { "source": "apache", "extensions": ["srt"] },
  "application/x-sv4cpio": { "source": "apache", "extensions": ["sv4cpio"] },
  "application/x-sv4crc": { "source": "apache", "extensions": ["sv4crc"] },
  "application/x-t3vm-image": { "source": "apache", "extensions": ["t3"] },
  "application/x-tads": { "source": "apache", "extensions": ["gam"] },
  "application/x-tar": { "source": "apache", "compressible": true, "extensions": ["tar"] },
  "application/x-tcl": { "source": "apache", "extensions": ["tcl", "tk"] },
  "application/x-tex": { "source": "apache", "extensions": ["tex"] },
  "application/x-tex-tfm": { "source": "apache", "extensions": ["tfm"] },
  "application/x-texinfo": { "source": "apache", "extensions": ["texinfo", "texi"] },
  "application/x-tgif": { "source": "apache", "extensions": ["obj"] },
  "application/x-ustar": { "source": "apache", "extensions": ["ustar"] },
  "application/x-virtualbox-hdd": { "compressible": true, "extensions": ["hdd"] },
  "application/x-virtualbox-ova": { "compressible": true, "extensions": ["ova"] },
  "application/x-virtualbox-ovf": { "compressible": true, "extensions": ["ovf"] },
  "application/x-virtualbox-vbox": { "compressible": true, "extensions": ["vbox"] },
  "application/x-virtualbox-vbox-extpack": { "compressible": false, "extensions": ["vbox-extpack"] },
  "application/x-virtualbox-vdi": { "compressible": true, "extensions": ["vdi"] },
  "application/x-virtualbox-vhd": { "compressible": true, "extensions": ["vhd"] },
  "application/x-virtualbox-vmdk": { "compressible": true, "extensions": ["vmdk"] },
  "application/x-wais-source": { "source": "apache", "extensions": ["src"] },
  "application/x-web-app-manifest+json": { "compressible": true, "extensions": ["webapp"] },
  "application/x-www-form-urlencoded": { "source": "iana", "compressible": true },
  "application/x-x509-ca-cert": { "source": "iana", "extensions": ["der", "crt", "pem"] },
  "application/x-x509-ca-ra-cert": { "source": "iana" },
  "application/x-x509-next-ca-cert": { "source": "iana" },
  "application/x-xfig": { "source": "apache", "extensions": ["fig"] },
  "application/x-xliff+xml": { "source": "apache", "compressible": true, "extensions": ["xlf"] },
  "application/x-xpinstall": { "source": "apache", "compressible": false, "extensions": ["xpi"] },
  "application/x-xz": { "source": "apache", "extensions": ["xz"] },
  "application/x-zmachine": { "source": "apache", "extensions": ["z1", "z2", "z3", "z4", "z5", "z6", "z7", "z8"] },
  "application/x400-bp": { "source": "iana" },
  "application/xacml+xml": { "source": "iana", "compressible": true },
  "application/xaml+xml": { "source": "apache", "compressible": true, "extensions": ["xaml"] },
  "application/xcap-att+xml": { "source": "iana", "compressible": true, "extensions": ["xav"] },
  "application/xcap-caps+xml": { "source": "iana", "compressible": true, "extensions": ["xca"] },
  "application/xcap-diff+xml": { "source": "iana", "compressible": true, "extensions": ["xdf"] },
  "application/xcap-el+xml": { "source": "iana", "compressible": true, "extensions": ["xel"] },
  "application/xcap-error+xml": { "source": "iana", "compressible": true },
  "application/xcap-ns+xml": { "source": "iana", "compressible": true, "extensions": ["xns"] },
  "application/xcon-conference-info+xml": { "source": "iana", "compressible": true },
  "application/xcon-conference-info-diff+xml": { "source": "iana", "compressible": true },
  "application/xenc+xml": { "source": "iana", "compressible": true, "extensions": ["xenc"] },
  "application/xhtml+xml": { "source": "iana", "compressible": true, "extensions": ["xhtml", "xht"] },
  "application/xhtml-voice+xml": { "source": "apache", "compressible": true },
  "application/xliff+xml": { "source": "iana", "compressible": true, "extensions": ["xlf"] },
  "application/xml": { "source": "iana", "compressible": true, "extensions": ["xml", "xsl", "xsd", "rng"] },
  "application/xml-dtd": { "source": "iana", "compressible": true, "extensions": ["dtd"] },
  "application/xml-external-parsed-entity": { "source": "iana" },
  "application/xml-patch+xml": { "source": "iana", "compressible": true },
  "application/xmpp+xml": { "source": "iana", "compressible": true },
  "application/xop+xml": { "source": "iana", "compressible": true, "extensions": ["xop"] },
  "application/xproc+xml": { "source": "apache", "compressible": true, "extensions": ["xpl"] },
  "application/xslt+xml": { "source": "iana", "compressible": true, "extensions": ["xsl", "xslt"] },
  "application/xspf+xml": { "source": "apache", "compressible": true, "extensions": ["xspf"] },
  "application/xv+xml": { "source": "iana", "compressible": true, "extensions": ["mxml", "xhvml", "xvml", "xvm"] },
  "application/yang": { "source": "iana", "extensions": ["yang"] },
  "application/yang-data+json": { "source": "iana", "compressible": true },
  "application/yang-data+xml": { "source": "iana", "compressible": true },
  "application/yang-patch+json": { "source": "iana", "compressible": true },
  "application/yang-patch+xml": { "source": "iana", "compressible": true },
  "application/yin+xml": { "source": "iana", "compressible": true, "extensions": ["yin"] },
  "application/zip": { "source": "iana", "compressible": false, "extensions": ["zip"] },
  "application/zlib": { "source": "iana" },
  "application/zstd": { "source": "iana" },
  "audio/1d-interleaved-parityfec": { "source": "iana" },
  "audio/32kadpcm": { "source": "iana" },
  "audio/3gpp": { "source": "iana", "compressible": false, "extensions": ["3gpp"] },
  "audio/3gpp2": { "source": "iana" },
  "audio/aac": { "source": "iana" },
  "audio/ac3": { "source": "iana" },
  "audio/adpcm": { "source": "apache", "extensions": ["adp"] },
  "audio/amr": { "source": "iana", "extensions": ["amr"] },
  "audio/amr-wb": { "source": "iana" },
  "audio/amr-wb+": { "source": "iana" },
  "audio/aptx": { "source": "iana" },
  "audio/asc": { "source": "iana" },
  "audio/atrac-advanced-lossless": { "source": "iana" },
  "audio/atrac-x": { "source": "iana" },
  "audio/atrac3": { "source": "iana" },
  "audio/basic": { "source": "iana", "compressible": false, "extensions": ["au", "snd"] },
  "audio/bv16": { "source": "iana" },
  "audio/bv32": { "source": "iana" },
  "audio/clearmode": { "source": "iana" },
  "audio/cn": { "source": "iana" },
  "audio/dat12": { "source": "iana" },
  "audio/dls": { "source": "iana" },
  "audio/dsr-es201108": { "source": "iana" },
  "audio/dsr-es202050": { "source": "iana" },
  "audio/dsr-es202211": { "source": "iana" },
  "audio/dsr-es202212": { "source": "iana" },
  "audio/dv": { "source": "iana" },
  "audio/dvi4": { "source": "iana" },
  "audio/eac3": { "source": "iana" },
  "audio/encaprtp": { "source": "iana" },
  "audio/evrc": { "source": "iana" },
  "audio/evrc-qcp": { "source": "iana" },
  "audio/evrc0": { "source": "iana" },
  "audio/evrc1": { "source": "iana" },
  "audio/evrcb": { "source": "iana" },
  "audio/evrcb0": { "source": "iana" },
  "audio/evrcb1": { "source": "iana" },
  "audio/evrcnw": { "source": "iana" },
  "audio/evrcnw0": { "source": "iana" },
  "audio/evrcnw1": { "source": "iana" },
  "audio/evrcwb": { "source": "iana" },
  "audio/evrcwb0": { "source": "iana" },
  "audio/evrcwb1": { "source": "iana" },
  "audio/evs": { "source": "iana" },
  "audio/flexfec": { "source": "iana" },
  "audio/fwdred": { "source": "iana" },
  "audio/g711-0": { "source": "iana" },
  "audio/g719": { "source": "iana" },
  "audio/g722": { "source": "iana" },
  "audio/g7221": { "source": "iana" },
  "audio/g723": { "source": "iana" },
  "audio/g726-16": { "source": "iana" },
  "audio/g726-24": { "source": "iana" },
  "audio/g726-32": { "source": "iana" },
  "audio/g726-40": { "source": "iana" },
  "audio/g728": { "source": "iana" },
  "audio/g729": { "source": "iana" },
  "audio/g7291": { "source": "iana" },
  "audio/g729d": { "source": "iana" },
  "audio/g729e": { "source": "iana" },
  "audio/gsm": { "source": "iana" },
  "audio/gsm-efr": { "source": "iana" },
  "audio/gsm-hr-08": { "source": "iana" },
  "audio/ilbc": { "source": "iana" },
  "audio/ip-mr_v2.5": { "source": "iana" },
  "audio/isac": { "source": "apache" },
  "audio/l16": { "source": "iana" },
  "audio/l20": { "source": "iana" },
  "audio/l24": { "source": "iana", "compressible": false },
  "audio/l8": { "source": "iana" },
  "audio/lpc": { "source": "iana" },
  "audio/melp": { "source": "iana" },
  "audio/melp1200": { "source": "iana" },
  "audio/melp2400": { "source": "iana" },
  "audio/melp600": { "source": "iana" },
  "audio/mhas": { "source": "iana" },
  "audio/midi": { "source": "apache", "extensions": ["mid", "midi", "kar", "rmi"] },
  "audio/mobile-xmf": { "source": "iana", "extensions": ["mxmf"] },
  "audio/mp3": { "compressible": false, "extensions": ["mp3"] },
  "audio/mp4": { "source": "iana", "compressible": false, "extensions": ["m4a", "mp4a"] },
  "audio/mp4a-latm": { "source": "iana" },
  "audio/mpa": { "source": "iana" },
  "audio/mpa-robust": { "source": "iana" },
  "audio/mpeg": { "source": "iana", "compressible": false, "extensions": ["mpga", "mp2", "mp2a", "mp3", "m2a", "m3a"] },
  "audio/mpeg4-generic": { "source": "iana" },
  "audio/musepack": { "source": "apache" },
  "audio/ogg": { "source": "iana", "compressible": false, "extensions": ["oga", "ogg", "spx", "opus"] },
  "audio/opus": { "source": "iana" },
  "audio/parityfec": { "source": "iana" },
  "audio/pcma": { "source": "iana" },
  "audio/pcma-wb": { "source": "iana" },
  "audio/pcmu": { "source": "iana" },
  "audio/pcmu-wb": { "source": "iana" },
  "audio/prs.sid": { "source": "iana" },
  "audio/qcelp": { "source": "iana" },
  "audio/raptorfec": { "source": "iana" },
  "audio/red": { "source": "iana" },
  "audio/rtp-enc-aescm128": { "source": "iana" },
  "audio/rtp-midi": { "source": "iana" },
  "audio/rtploopback": { "source": "iana" },
  "audio/rtx": { "source": "iana" },
  "audio/s3m": { "source": "apache", "extensions": ["s3m"] },
  "audio/scip": { "source": "iana" },
  "audio/silk": { "source": "apache", "extensions": ["sil"] },
  "audio/smv": { "source": "iana" },
  "audio/smv-qcp": { "source": "iana" },
  "audio/smv0": { "source": "iana" },
  "audio/sofa": { "source": "iana" },
  "audio/sp-midi": { "source": "iana" },
  "audio/speex": { "source": "iana" },
  "audio/t140c": { "source": "iana" },
  "audio/t38": { "source": "iana" },
  "audio/telephone-event": { "source": "iana" },
  "audio/tetra_acelp": { "source": "iana" },
  "audio/tetra_acelp_bb": { "source": "iana" },
  "audio/tone": { "source": "iana" },
  "audio/tsvcis": { "source": "iana" },
  "audio/uemclip": { "source": "iana" },
  "audio/ulpfec": { "source": "iana" },
  "audio/usac": { "source": "iana" },
  "audio/vdvi": { "source": "iana" },
  "audio/vmr-wb": { "source": "iana" },
  "audio/vnd.3gpp.iufp": { "source": "iana" },
  "audio/vnd.4sb": { "source": "iana" },
  "audio/vnd.audiokoz": { "source": "iana" },
  "audio/vnd.celp": { "source": "iana" },
  "audio/vnd.cisco.nse": { "source": "iana" },
  "audio/vnd.cmles.radio-events": { "source": "iana" },
  "audio/vnd.cns.anp1": { "source": "iana" },
  "audio/vnd.cns.inf1": { "source": "iana" },
  "audio/vnd.dece.audio": { "source": "iana", "extensions": ["uva", "uvva"] },
  "audio/vnd.digital-winds": { "source": "iana", "extensions": ["eol"] },
  "audio/vnd.dlna.adts": { "source": "iana" },
  "audio/vnd.dolby.heaac.1": { "source": "iana" },
  "audio/vnd.dolby.heaac.2": { "source": "iana" },
  "audio/vnd.dolby.mlp": { "source": "iana" },
  "audio/vnd.dolby.mps": { "source": "iana" },
  "audio/vnd.dolby.pl2": { "source": "iana" },
  "audio/vnd.dolby.pl2x": { "source": "iana" },
  "audio/vnd.dolby.pl2z": { "source": "iana" },
  "audio/vnd.dolby.pulse.1": { "source": "iana" },
  "audio/vnd.dra": { "source": "iana", "extensions": ["dra"] },
  "audio/vnd.dts": { "source": "iana", "extensions": ["dts"] },
  "audio/vnd.dts.hd": { "source": "iana", "extensions": ["dtshd"] },
  "audio/vnd.dts.uhd": { "source": "iana" },
  "audio/vnd.dvb.file": { "source": "iana" },
  "audio/vnd.everad.plj": { "source": "iana" },
  "audio/vnd.hns.audio": { "source": "iana" },
  "audio/vnd.lucent.voice": { "source": "iana", "extensions": ["lvp"] },
  "audio/vnd.ms-playready.media.pya": { "source": "iana", "extensions": ["pya"] },
  "audio/vnd.nokia.mobile-xmf": { "source": "iana" },
  "audio/vnd.nortel.vbk": { "source": "iana" },
  "audio/vnd.nuera.ecelp4800": { "source": "iana", "extensions": ["ecelp4800"] },
  "audio/vnd.nuera.ecelp7470": { "source": "iana", "extensions": ["ecelp7470"] },
  "audio/vnd.nuera.ecelp9600": { "source": "iana", "extensions": ["ecelp9600"] },
  "audio/vnd.octel.sbc": { "source": "iana" },
  "audio/vnd.presonus.multitrack": { "source": "iana" },
  "audio/vnd.qcelp": { "source": "iana" },
  "audio/vnd.rhetorex.32kadpcm": { "source": "iana" },
  "audio/vnd.rip": { "source": "iana", "extensions": ["rip"] },
  "audio/vnd.rn-realaudio": { "compressible": false },
  "audio/vnd.sealedmedia.softseal.mpeg": { "source": "iana" },
  "audio/vnd.vmx.cvsd": { "source": "iana" },
  "audio/vnd.wave": { "compressible": false },
  "audio/vorbis": { "source": "iana", "compressible": false },
  "audio/vorbis-config": { "source": "iana" },
  "audio/wav": { "compressible": false, "extensions": ["wav"] },
  "audio/wave": { "compressible": false, "extensions": ["wav"] },
  "audio/webm": { "source": "apache", "compressible": false, "extensions": ["weba"] },
  "audio/x-aac": { "source": "apache", "compressible": false, "extensions": ["aac"] },
  "audio/x-aiff": { "source": "apache", "extensions": ["aif", "aiff", "aifc"] },
  "audio/x-caf": { "source": "apache", "compressible": false, "extensions": ["caf"] },
  "audio/x-flac": { "source": "apache", "extensions": ["flac"] },
  "audio/x-m4a": { "source": "nginx", "extensions": ["m4a"] },
  "audio/x-matroska": { "source": "apache", "extensions": ["mka"] },
  "audio/x-mpegurl": { "source": "apache", "extensions": ["m3u"] },
  "audio/x-ms-wax": { "source": "apache", "extensions": ["wax"] },
  "audio/x-ms-wma": { "source": "apache", "extensions": ["wma"] },
  "audio/x-pn-realaudio": { "source": "apache", "extensions": ["ram", "ra"] },
  "audio/x-pn-realaudio-plugin": { "source": "apache", "extensions": ["rmp"] },
  "audio/x-realaudio": { "source": "nginx", "extensions": ["ra"] },
  "audio/x-tta": { "source": "apache" },
  "audio/x-wav": { "source": "apache", "extensions": ["wav"] },
  "audio/xm": { "source": "apache", "extensions": ["xm"] },
  "chemical/x-cdx": { "source": "apache", "extensions": ["cdx"] },
  "chemical/x-cif": { "source": "apache", "extensions": ["cif"] },
  "chemical/x-cmdf": { "source": "apache", "extensions": ["cmdf"] },
  "chemical/x-cml": { "source": "apache", "extensions": ["cml"] },
  "chemical/x-csml": { "source": "apache", "extensions": ["csml"] },
  "chemical/x-pdb": { "source": "apache" },
  "chemical/x-xyz": { "source": "apache", "extensions": ["xyz"] },
  "font/collection": { "source": "iana", "extensions": ["ttc"] },
  "font/otf": { "source": "iana", "compressible": true, "extensions": ["otf"] },
  "font/sfnt": { "source": "iana" },
  "font/ttf": { "source": "iana", "compressible": true, "extensions": ["ttf"] },
  "font/woff": { "source": "iana", "extensions": ["woff"] },
  "font/woff2": { "source": "iana", "extensions": ["woff2"] },
  "image/aces": { "source": "iana", "extensions": ["exr"] },
  "image/apng": { "compressible": false, "extensions": ["apng"] },
  "image/avci": { "source": "iana", "extensions": ["avci"] },
  "image/avcs": { "source": "iana", "extensions": ["avcs"] },
  "image/avif": { "source": "iana", "compressible": false, "extensions": ["avif"] },
  "image/bmp": { "source": "iana", "compressible": true, "extensions": ["bmp"] },
  "image/cgm": { "source": "iana", "extensions": ["cgm"] },
  "image/dicom-rle": { "source": "iana", "extensions": ["drle"] },
  "image/emf": { "source": "iana", "extensions": ["emf"] },
  "image/fits": { "source": "iana", "extensions": ["fits"] },
  "image/g3fax": { "source": "iana", "extensions": ["g3"] },
  "image/gif": { "source": "iana", "compressible": false, "extensions": ["gif"] },
  "image/heic": { "source": "iana", "extensions": ["heic"] },
  "image/heic-sequence": { "source": "iana", "extensions": ["heics"] },
  "image/heif": { "source": "iana", "extensions": ["heif"] },
  "image/heif-sequence": { "source": "iana", "extensions": ["heifs"] },
  "image/hej2k": { "source": "iana", "extensions": ["hej2"] },
  "image/hsj2": { "source": "iana", "extensions": ["hsj2"] },
  "image/ief": { "source": "iana", "extensions": ["ief"] },
  "image/jls": { "source": "iana", "extensions": ["jls"] },
  "image/jp2": { "source": "iana", "compressible": false, "extensions": ["jp2", "jpg2"] },
  "image/jpeg": { "source": "iana", "compressible": false, "extensions": ["jpeg", "jpg", "jpe"] },
  "image/jph": { "source": "iana", "extensions": ["jph"] },
  "image/jphc": { "source": "iana", "extensions": ["jhc"] },
  "image/jpm": { "source": "iana", "compressible": false, "extensions": ["jpm"] },
  "image/jpx": { "source": "iana", "compressible": false, "extensions": ["jpx", "jpf"] },
  "image/jxr": { "source": "iana", "extensions": ["jxr"] },
  "image/jxra": { "source": "iana", "extensions": ["jxra"] },
  "image/jxrs": { "source": "iana", "extensions": ["jxrs"] },
  "image/jxs": { "source": "iana", "extensions": ["jxs"] },
  "image/jxsc": { "source": "iana", "extensions": ["jxsc"] },
  "image/jxsi": { "source": "iana", "extensions": ["jxsi"] },
  "image/jxss": { "source": "iana", "extensions": ["jxss"] },
  "image/ktx": { "source": "iana", "extensions": ["ktx"] },
  "image/ktx2": { "source": "iana", "extensions": ["ktx2"] },
  "image/naplps": { "source": "iana" },
  "image/pjpeg": { "compressible": false },
  "image/png": { "source": "iana", "compressible": false, "extensions": ["png"] },
  "image/prs.btif": { "source": "iana", "extensions": ["btif"] },
  "image/prs.pti": { "source": "iana", "extensions": ["pti"] },
  "image/pwg-raster": { "source": "iana" },
  "image/sgi": { "source": "apache", "extensions": ["sgi"] },
  "image/svg+xml": { "source": "iana", "compressible": true, "extensions": ["svg", "svgz"] },
  "image/t38": { "source": "iana", "extensions": ["t38"] },
  "image/tiff": { "source": "iana", "compressible": false, "extensions": ["tif", "tiff"] },
  "image/tiff-fx": { "source": "iana", "extensions": ["tfx"] },
  "image/vnd.adobe.photoshop": { "source": "iana", "compressible": true, "extensions": ["psd"] },
  "image/vnd.airzip.accelerator.azv": { "source": "iana", "extensions": ["azv"] },
  "image/vnd.cns.inf2": { "source": "iana" },
  "image/vnd.dece.graphic": { "source": "iana", "extensions": ["uvi", "uvvi", "uvg", "uvvg"] },
  "image/vnd.djvu": { "source": "iana", "extensions": ["djvu", "djv"] },
  "image/vnd.dvb.subtitle": { "source": "iana", "extensions": ["sub"] },
  "image/vnd.dwg": { "source": "iana", "extensions": ["dwg"] },
  "image/vnd.dxf": { "source": "iana", "extensions": ["dxf"] },
  "image/vnd.fastbidsheet": { "source": "iana", "extensions": ["fbs"] },
  "image/vnd.fpx": { "source": "iana", "extensions": ["fpx"] },
  "image/vnd.fst": { "source": "iana", "extensions": ["fst"] },
  "image/vnd.fujixerox.edmics-mmr": { "source": "iana", "extensions": ["mmr"] },
  "image/vnd.fujixerox.edmics-rlc": { "source": "iana", "extensions": ["rlc"] },
  "image/vnd.globalgraphics.pgb": { "source": "iana" },
  "image/vnd.microsoft.icon": { "source": "iana", "compressible": true, "extensions": ["ico"] },
  "image/vnd.mix": { "source": "iana" },
  "image/vnd.mozilla.apng": { "source": "iana" },
  "image/vnd.ms-dds": { "compressible": true, "extensions": ["dds"] },
  "image/vnd.ms-modi": { "source": "iana", "extensions": ["mdi"] },
  "image/vnd.ms-photo": { "source": "apache", "extensions": ["wdp"] },
  "image/vnd.net-fpx": { "source": "iana", "extensions": ["npx"] },
  "image/vnd.pco.b16": { "source": "iana", "extensions": ["b16"] },
  "image/vnd.radiance": { "source": "iana" },
  "image/vnd.sealed.png": { "source": "iana" },
  "image/vnd.sealedmedia.softseal.gif": { "source": "iana" },
  "image/vnd.sealedmedia.softseal.jpg": { "source": "iana" },
  "image/vnd.svf": { "source": "iana" },
  "image/vnd.tencent.tap": { "source": "iana", "extensions": ["tap"] },
  "image/vnd.valve.source.texture": { "source": "iana", "extensions": ["vtf"] },
  "image/vnd.wap.wbmp": { "source": "iana", "extensions": ["wbmp"] },
  "image/vnd.xiff": { "source": "iana", "extensions": ["xif"] },
  "image/vnd.zbrush.pcx": { "source": "iana", "extensions": ["pcx"] },
  "image/webp": { "source": "apache", "extensions": ["webp"] },
  "image/wmf": { "source": "iana", "extensions": ["wmf"] },
  "image/x-3ds": { "source": "apache", "extensions": ["3ds"] },
  "image/x-cmu-raster": { "source": "apache", "extensions": ["ras"] },
  "image/x-cmx": { "source": "apache", "extensions": ["cmx"] },
  "image/x-freehand": { "source": "apache", "extensions": ["fh", "fhc", "fh4", "fh5", "fh7"] },
  "image/x-icon": { "source": "apache", "compressible": true, "extensions": ["ico"] },
  "image/x-jng": { "source": "nginx", "extensions": ["jng"] },
  "image/x-mrsid-image": { "source": "apache", "extensions": ["sid"] },
  "image/x-ms-bmp": { "source": "nginx", "compressible": true, "extensions": ["bmp"] },
  "image/x-pcx": { "source": "apache", "extensions": ["pcx"] },
  "image/x-pict": { "source": "apache", "extensions": ["pic", "pct"] },
  "image/x-portable-anymap": { "source": "apache", "extensions": ["pnm"] },
  "image/x-portable-bitmap": { "source": "apache", "extensions": ["pbm"] },
  "image/x-portable-graymap": { "source": "apache", "extensions": ["pgm"] },
  "image/x-portable-pixmap": { "source": "apache", "extensions": ["ppm"] },
  "image/x-rgb": { "source": "apache", "extensions": ["rgb"] },
  "image/x-tga": { "source": "apache", "extensions": ["tga"] },
  "image/x-xbitmap": { "source": "apache", "extensions": ["xbm"] },
  "image/x-xcf": { "compressible": false },
  "image/x-xpixmap": { "source": "apache", "extensions": ["xpm"] },
  "image/x-xwindowdump": { "source": "apache", "extensions": ["xwd"] },
  "message/cpim": { "source": "iana" },
  "message/delivery-status": { "source": "iana" },
  "message/disposition-notification": { "source": "iana", "extensions": ["disposition-notification"] },
  "message/external-body": { "source": "iana" },
  "message/feedback-report": { "source": "iana" },
  "message/global": { "source": "iana", "extensions": ["u8msg"] },
  "message/global-delivery-status": { "source": "iana", "extensions": ["u8dsn"] },
  "message/global-disposition-notification": { "source": "iana", "extensions": ["u8mdn"] },
  "message/global-headers": { "source": "iana", "extensions": ["u8hdr"] },
  "message/http": { "source": "iana", "compressible": false },
  "message/imdn+xml": { "source": "iana", "compressible": true },
  "message/news": { "source": "iana" },
  "message/partial": { "source": "iana", "compressible": false },
  "message/rfc822": { "source": "iana", "compressible": true, "extensions": ["eml", "mime"] },
  "message/s-http": { "source": "iana" },
  "message/sip": { "source": "iana" },
  "message/sipfrag": { "source": "iana" },
  "message/tracking-status": { "source": "iana" },
  "message/vnd.si.simp": { "source": "iana" },
  "message/vnd.wfa.wsc": { "source": "iana", "extensions": ["wsc"] },
  "model/3mf": { "source": "iana", "extensions": ["3mf"] },
  "model/e57": { "source": "iana" },
  "model/gltf+json": { "source": "iana", "compressible": true, "extensions": ["gltf"] },
  "model/gltf-binary": { "source": "iana", "compressible": true, "extensions": ["glb"] },
  "model/iges": { "source": "iana", "compressible": false, "extensions": ["igs", "iges"] },
  "model/mesh": { "source": "iana", "compressible": false, "extensions": ["msh", "mesh", "silo"] },
  "model/mtl": { "source": "iana", "extensions": ["mtl"] },
  "model/obj": { "source": "iana", "extensions": ["obj"] },
  "model/step": { "source": "iana" },
  "model/step+xml": { "source": "iana", "compressible": true, "extensions": ["stpx"] },
  "model/step+zip": { "source": "iana", "compressible": false, "extensions": ["stpz"] },
  "model/step-xml+zip": { "source": "iana", "compressible": false, "extensions": ["stpxz"] },
  "model/stl": { "source": "iana", "extensions": ["stl"] },
  "model/vnd.collada+xml": { "source": "iana", "compressible": true, "extensions": ["dae"] },
  "model/vnd.dwf": { "source": "iana", "extensions": ["dwf"] },
  "model/vnd.flatland.3dml": { "source": "iana" },
  "model/vnd.gdl": { "source": "iana", "extensions": ["gdl"] },
  "model/vnd.gs-gdl": { "source": "apache" },
  "model/vnd.gs.gdl": { "source": "iana" },
  "model/vnd.gtw": { "source": "iana", "extensions": ["gtw"] },
  "model/vnd.moml+xml": { "source": "iana", "compressible": true },
  "model/vnd.mts": { "source": "iana", "extensions": ["mts"] },
  "model/vnd.opengex": { "source": "iana", "extensions": ["ogex"] },
  "model/vnd.parasolid.transmit.binary": { "source": "iana", "extensions": ["x_b"] },
  "model/vnd.parasolid.transmit.text": { "source": "iana", "extensions": ["x_t"] },
  "model/vnd.pytha.pyox": { "source": "iana" },
  "model/vnd.rosette.annotated-data-model": { "source": "iana" },
  "model/vnd.sap.vds": { "source": "iana", "extensions": ["vds"] },
  "model/vnd.usdz+zip": { "source": "iana", "compressible": false, "extensions": ["usdz"] },
  "model/vnd.valve.source.compiled-map": { "source": "iana", "extensions": ["bsp"] },
  "model/vnd.vtu": { "source": "iana", "extensions": ["vtu"] },
  "model/vrml": { "source": "iana", "compressible": false, "extensions": ["wrl", "vrml"] },
  "model/x3d+binary": { "source": "apache", "compressible": false, "extensions": ["x3db", "x3dbz"] },
  "model/x3d+fastinfoset": { "source": "iana", "extensions": ["x3db"] },
  "model/x3d+vrml": { "source": "apache", "compressible": false, "extensions": ["x3dv", "x3dvz"] },
  "model/x3d+xml": { "source": "iana", "compressible": true, "extensions": ["x3d", "x3dz"] },
  "model/x3d-vrml": { "source": "iana", "extensions": ["x3dv"] },
  "multipart/alternative": { "source": "iana", "compressible": false },
  "multipart/appledouble": { "source": "iana" },
  "multipart/byteranges": { "source": "iana" },
  "multipart/digest": { "source": "iana" },
  "multipart/encrypted": { "source": "iana", "compressible": false },
  "multipart/form-data": { "source": "iana", "compressible": false },
  "multipart/header-set": { "source": "iana" },
  "multipart/mixed": { "source": "iana" },
  "multipart/multilingual": { "source": "iana" },
  "multipart/parallel": { "source": "iana" },
  "multipart/related": { "source": "iana", "compressible": false },
  "multipart/report": { "source": "iana" },
  "multipart/signed": { "source": "iana", "compressible": false },
  "multipart/vnd.bint.med-plus": { "source": "iana" },
  "multipart/voice-message": { "source": "iana" },
  "multipart/x-mixed-replace": { "source": "iana" },
  "text/1d-interleaved-parityfec": { "source": "iana" },
  "text/cache-manifest": { "source": "iana", "compressible": true, "extensions": ["appcache", "manifest"] },
  "text/calendar": { "source": "iana", "extensions": ["ics", "ifb"] },
  "text/calender": { "compressible": true },
  "text/cmd": { "compressible": true },
  "text/coffeescript": { "extensions": ["coffee", "litcoffee"] },
  "text/cql": { "source": "iana" },
  "text/cql-expression": { "source": "iana" },
  "text/cql-identifier": { "source": "iana" },
  "text/css": { "source": "iana", "charset": "UTF-8", "compressible": true, "extensions": ["css"] },
  "text/csv": { "source": "iana", "compressible": true, "extensions": ["csv"] },
  "text/csv-schema": { "source": "iana" },
  "text/directory": { "source": "iana" },
  "text/dns": { "source": "iana" },
  "text/ecmascript": { "source": "iana" },
  "text/encaprtp": { "source": "iana" },
  "text/enriched": { "source": "iana" },
  "text/fhirpath": { "source": "iana" },
  "text/flexfec": { "source": "iana" },
  "text/fwdred": { "source": "iana" },
  "text/gff3": { "source": "iana" },
  "text/grammar-ref-list": { "source": "iana" },
  "text/html": { "source": "iana", "compressible": true, "extensions": ["html", "htm", "shtml"] },
  "text/jade": { "extensions": ["jade"] },
  "text/javascript": { "source": "iana", "compressible": true },
  "text/jcr-cnd": { "source": "iana" },
  "text/jsx": { "compressible": true, "extensions": ["jsx"] },
  "text/less": { "compressible": true, "extensions": ["less"] },
  "text/markdown": { "source": "iana", "compressible": true, "extensions": ["markdown", "md"] },
  "text/mathml": { "source": "nginx", "extensions": ["mml"] },
  "text/mdx": { "compressible": true, "extensions": ["mdx"] },
  "text/mizar": { "source": "iana" },
  "text/n3": { "source": "iana", "charset": "UTF-8", "compressible": true, "extensions": ["n3"] },
  "text/parameters": { "source": "iana", "charset": "UTF-8" },
  "text/parityfec": { "source": "iana" },
  "text/plain": { "source": "iana", "compressible": true, "extensions": ["txt", "text", "conf", "def", "list", "log", "in", "ini"] },
  "text/provenance-notation": { "source": "iana", "charset": "UTF-8" },
  "text/prs.fallenstein.rst": { "source": "iana" },
  "text/prs.lines.tag": { "source": "iana", "extensions": ["dsc"] },
  "text/prs.prop.logic": { "source": "iana" },
  "text/raptorfec": { "source": "iana" },
  "text/red": { "source": "iana" },
  "text/rfc822-headers": { "source": "iana" },
  "text/richtext": { "source": "iana", "compressible": true, "extensions": ["rtx"] },
  "text/rtf": { "source": "iana", "compressible": true, "extensions": ["rtf"] },
  "text/rtp-enc-aescm128": { "source": "iana" },
  "text/rtploopback": { "source": "iana" },
  "text/rtx": { "source": "iana" },
  "text/sgml": { "source": "iana", "extensions": ["sgml", "sgm"] },
  "text/shaclc": { "source": "iana" },
  "text/shex": { "source": "iana", "extensions": ["shex"] },
  "text/slim": { "extensions": ["slim", "slm"] },
  "text/spdx": { "source": "iana", "extensions": ["spdx"] },
  "text/strings": { "source": "iana" },
  "text/stylus": { "extensions": ["stylus", "styl"] },
  "text/t140": { "source": "iana" },
  "text/tab-separated-values": { "source": "iana", "compressible": true, "extensions": ["tsv"] },
  "text/troff": { "source": "iana", "extensions": ["t", "tr", "roff", "man", "me", "ms"] },
  "text/turtle": { "source": "iana", "charset": "UTF-8", "extensions": ["ttl"] },
  "text/ulpfec": { "source": "iana" },
  "text/uri-list": { "source": "iana", "compressible": true, "extensions": ["uri", "uris", "urls"] },
  "text/vcard": { "source": "iana", "compressible": true, "extensions": ["vcard"] },
  "text/vnd.a": { "source": "iana" },
  "text/vnd.abc": { "source": "iana" },
  "text/vnd.ascii-art": { "source": "iana" },
  "text/vnd.curl": { "source": "iana", "extensions": ["curl"] },
  "text/vnd.curl.dcurl": { "source": "apache", "extensions": ["dcurl"] },
  "text/vnd.curl.mcurl": { "source": "apache", "extensions": ["mcurl"] },
  "text/vnd.curl.scurl": { "source": "apache", "extensions": ["scurl"] },
  "text/vnd.debian.copyright": { "source": "iana", "charset": "UTF-8" },
  "text/vnd.dmclientscript": { "source": "iana" },
  "text/vnd.dvb.subtitle": { "source": "iana", "extensions": ["sub"] },
  "text/vnd.esmertec.theme-descriptor": { "source": "iana", "charset": "UTF-8" },
  "text/vnd.familysearch.gedcom": { "source": "iana", "extensions": ["ged"] },
  "text/vnd.ficlab.flt": { "source": "iana" },
  "text/vnd.fly": { "source": "iana", "extensions": ["fly"] },
  "text/vnd.fmi.flexstor": { "source": "iana", "extensions": ["flx"] },
  "text/vnd.gml": { "source": "iana" },
  "text/vnd.graphviz": { "source": "iana", "extensions": ["gv"] },
  "text/vnd.hans": { "source": "iana" },
  "text/vnd.hgl": { "source": "iana" },
  "text/vnd.in3d.3dml": { "source": "iana", "extensions": ["3dml"] },
  "text/vnd.in3d.spot": { "source": "iana", "extensions": ["spot"] },
  "text/vnd.iptc.newsml": { "source": "iana" },
  "text/vnd.iptc.nitf": { "source": "iana" },
  "text/vnd.latex-z": { "source": "iana" },
  "text/vnd.motorola.reflex": { "source": "iana" },
  "text/vnd.ms-mediapackage": { "source": "iana" },
  "text/vnd.net2phone.commcenter.command": { "source": "iana" },
  "text/vnd.radisys.msml-basic-layout": { "source": "iana" },
  "text/vnd.senx.warpscript": { "source": "iana" },
  "text/vnd.si.uricatalogue": { "source": "iana" },
  "text/vnd.sosi": { "source": "iana" },
  "text/vnd.sun.j2me.app-descriptor": { "source": "iana", "charset": "UTF-8", "extensions": ["jad"] },
  "text/vnd.trolltech.linguist": { "source": "iana", "charset": "UTF-8" },
  "text/vnd.wap.si": { "source": "iana" },
  "text/vnd.wap.sl": { "source": "iana" },
  "text/vnd.wap.wml": { "source": "iana", "extensions": ["wml"] },
  "text/vnd.wap.wmlscript": { "source": "iana", "extensions": ["wmls"] },
  "text/vtt": { "source": "iana", "charset": "UTF-8", "compressible": true, "extensions": ["vtt"] },
  "text/x-asm": { "source": "apache", "extensions": ["s", "asm"] },
  "text/x-c": { "source": "apache", "extensions": ["c", "cc", "cxx", "cpp", "h", "hh", "dic"] },
  "text/x-component": { "source": "nginx", "extensions": ["htc"] },
  "text/x-fortran": { "source": "apache", "extensions": ["f", "for", "f77", "f90"] },
  "text/x-gwt-rpc": { "compressible": true },
  "text/x-handlebars-template": { "extensions": ["hbs"] },
  "text/x-java-source": { "source": "apache", "extensions": ["java"] },
  "text/x-jquery-tmpl": { "compressible": true },
  "text/x-lua": { "extensions": ["lua"] },
  "text/x-markdown": { "compressible": true, "extensions": ["mkd"] },
  "text/x-nfo": { "source": "apache", "extensions": ["nfo"] },
  "text/x-opml": { "source": "apache", "extensions": ["opml"] },
  "text/x-org": { "compressible": true, "extensions": ["org"] },
  "text/x-pascal": { "source": "apache", "extensions": ["p", "pas"] },
  "text/x-processing": { "compressible": true, "extensions": ["pde"] },
  "text/x-sass": { "extensions": ["sass"] },
  "text/x-scss": { "extensions": ["scss"] },
  "text/x-setext": { "source": "apache", "extensions": ["etx"] },
  "text/x-sfv": { "source": "apache", "extensions": ["sfv"] },
  "text/x-suse-ymp": { "compressible": true, "extensions": ["ymp"] },
  "text/x-uuencode": { "source": "apache", "extensions": ["uu"] },
  "text/x-vcalendar": { "source": "apache", "extensions": ["vcs"] },
  "text/x-vcard": { "source": "apache", "extensions": ["vcf"] },
  "text/xml": { "source": "iana", "compressible": true, "extensions": ["xml"] },
  "text/xml-external-parsed-entity": { "source": "iana" },
  "text/yaml": { "compressible": true, "extensions": ["yaml", "yml"] },
  "video/1d-interleaved-parityfec": { "source": "iana" },
  "video/3gpp": { "source": "iana", "extensions": ["3gp", "3gpp"] },
  "video/3gpp-tt": { "source": "iana" },
  "video/3gpp2": { "source": "iana", "extensions": ["3g2"] },
  "video/av1": { "source": "iana" },
  "video/bmpeg": { "source": "iana" },
  "video/bt656": { "source": "iana" },
  "video/celb": { "source": "iana" },
  "video/dv": { "source": "iana" },
  "video/encaprtp": { "source": "iana" },
  "video/ffv1": { "source": "iana" },
  "video/flexfec": { "source": "iana" },
  "video/h261": { "source": "iana", "extensions": ["h261"] },
  "video/h263": { "source": "iana", "extensions": ["h263"] },
  "video/h263-1998": { "source": "iana" },
  "video/h263-2000": { "source": "iana" },
  "video/h264": { "source": "iana", "extensions": ["h264"] },
  "video/h264-rcdo": { "source": "iana" },
  "video/h264-svc": { "source": "iana" },
  "video/h265": { "source": "iana" },
  "video/iso.segment": { "source": "iana", "extensions": ["m4s"] },
  "video/jpeg": { "source": "iana", "extensions": ["jpgv"] },
  "video/jpeg2000": { "source": "iana" },
  "video/jpm": { "source": "apache", "extensions": ["jpm", "jpgm"] },
  "video/jxsv": { "source": "iana" },
  "video/mj2": { "source": "iana", "extensions": ["mj2", "mjp2"] },
  "video/mp1s": { "source": "iana" },
  "video/mp2p": { "source": "iana" },
  "video/mp2t": { "source": "iana", "extensions": ["ts"] },
  "video/mp4": { "source": "iana", "compressible": false, "extensions": ["mp4", "mp4v", "mpg4"] },
  "video/mp4v-es": { "source": "iana" },
  "video/mpeg": { "source": "iana", "compressible": false, "extensions": ["mpeg", "mpg", "mpe", "m1v", "m2v"] },
  "video/mpeg4-generic": { "source": "iana" },
  "video/mpv": { "source": "iana" },
  "video/nv": { "source": "iana" },
  "video/ogg": { "source": "iana", "compressible": false, "extensions": ["ogv"] },
  "video/parityfec": { "source": "iana" },
  "video/pointer": { "source": "iana" },
  "video/quicktime": { "source": "iana", "compressible": false, "extensions": ["qt", "mov"] },
  "video/raptorfec": { "source": "iana" },
  "video/raw": { "source": "iana" },
  "video/rtp-enc-aescm128": { "source": "iana" },
  "video/rtploopback": { "source": "iana" },
  "video/rtx": { "source": "iana" },
  "video/scip": { "source": "iana" },
  "video/smpte291": { "source": "iana" },
  "video/smpte292m": { "source": "iana" },
  "video/ulpfec": { "source": "iana" },
  "video/vc1": { "source": "iana" },
  "video/vc2": { "source": "iana" },
  "video/vnd.cctv": { "source": "iana" },
  "video/vnd.dece.hd": { "source": "iana", "extensions": ["uvh", "uvvh"] },
  "video/vnd.dece.mobile": { "source": "iana", "extensions": ["uvm", "uvvm"] },
  "video/vnd.dece.mp4": { "source": "iana" },
  "video/vnd.dece.pd": { "source": "iana", "extensions": ["uvp", "uvvp"] },
  "video/vnd.dece.sd": { "source": "iana", "extensions": ["uvs", "uvvs"] },
  "video/vnd.dece.video": { "source": "iana", "extensions": ["uvv", "uvvv"] },
  "video/vnd.directv.mpeg": { "source": "iana" },
  "video/vnd.directv.mpeg-tts": { "source": "iana" },
  "video/vnd.dlna.mpeg-tts": { "source": "iana" },
  "video/vnd.dvb.file": { "source": "iana", "extensions": ["dvb"] },
  "video/vnd.fvt": { "source": "iana", "extensions": ["fvt"] },
  "video/vnd.hns.video": { "source": "iana" },
  "video/vnd.iptvforum.1dparityfec-1010": { "source": "iana" },
  "video/vnd.iptvforum.1dparityfec-2005": { "source": "iana" },
  "video/vnd.iptvforum.2dparityfec-1010": { "source": "iana" },
  "video/vnd.iptvforum.2dparityfec-2005": { "source": "iana" },
  "video/vnd.iptvforum.ttsavc": { "source": "iana" },
  "video/vnd.iptvforum.ttsmpeg2": { "source": "iana" },
  "video/vnd.motorola.video": { "source": "iana" },
  "video/vnd.motorola.videop": { "source": "iana" },
  "video/vnd.mpegurl": { "source": "iana", "extensions": ["mxu", "m4u"] },
  "video/vnd.ms-playready.media.pyv": { "source": "iana", "extensions": ["pyv"] },
  "video/vnd.nokia.interleaved-multimedia": { "source": "iana" },
  "video/vnd.nokia.mp4vr": { "source": "iana" },
  "video/vnd.nokia.videovoip": { "source": "iana" },
  "video/vnd.objectvideo": { "source": "iana" },
  "video/vnd.radgamettools.bink": { "source": "iana" },
  "video/vnd.radgamettools.smacker": { "source": "iana" },
  "video/vnd.sealed.mpeg1": { "source": "iana" },
  "video/vnd.sealed.mpeg4": { "source": "iana" },
  "video/vnd.sealed.swf": { "source": "iana" },
  "video/vnd.sealedmedia.softseal.mov": { "source": "iana" },
  "video/vnd.uvvu.mp4": { "source": "iana", "extensions": ["uvu", "uvvu"] },
  "video/vnd.vivo": { "source": "iana", "extensions": ["viv"] },
  "video/vnd.youtube.yt": { "source": "iana" },
  "video/vp8": { "source": "iana" },
  "video/vp9": { "source": "iana" },
  "video/webm": { "source": "apache", "compressible": false, "extensions": ["webm"] },
  "video/x-f4v": { "source": "apache", "extensions": ["f4v"] },
  "video/x-fli": { "source": "apache", "extensions": ["fli"] },
  "video/x-flv": { "source": "apache", "compressible": false, "extensions": ["flv"] },
  "video/x-m4v": { "source": "apache", "extensions": ["m4v"] },
  "video/x-matroska": { "source": "apache", "compressible": false, "extensions": ["mkv", "mk3d", "mks"] },
  "video/x-mng": { "source": "apache", "extensions": ["mng"] },
  "video/x-ms-asf": { "source": "apache", "extensions": ["asf", "asx"] },
  "video/x-ms-vob": { "source": "apache", "extensions": ["vob"] },
  "video/x-ms-wm": { "source": "apache", "extensions": ["wm"] },
  "video/x-ms-wmv": { "source": "apache", "compressible": false, "extensions": ["wmv"] },
  "video/x-ms-wmx": { "source": "apache", "extensions": ["wmx"] },
  "video/x-ms-wvx": { "source": "apache", "extensions": ["wvx"] },
  "video/x-msvideo": { "source": "apache", "extensions": ["avi"] },
  "video/x-sgi-movie": { "source": "apache", "extensions": ["movie"] },
  "video/x-smv": { "source": "apache", "extensions": ["smv"] },
  "x-conference/x-cooltalk": { "source": "apache", "extensions": ["ice"] },
  "x-shader/x-fragment": { "compressible": true },
  "x-shader/x-vertex": { "compressible": true }
};
/*!
 * mime-db
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2015-2022 Douglas Christopher Wilson
 * MIT Licensed
 */
var mimeDb;
var hasRequiredMimeDb;
function requireMimeDb() {
  if (hasRequiredMimeDb) return mimeDb;
  hasRequiredMimeDb = 1;
  mimeDb = require$$0;
  return mimeDb;
}
/*!
 * mime-types
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2015 Douglas Christopher Wilson
 * MIT Licensed
 */
var hasRequiredMimeTypes;
function requireMimeTypes() {
  if (hasRequiredMimeTypes) return mimeTypes;
  hasRequiredMimeTypes = 1;
  (function(exports) {
    var db = requireMimeDb();
    var extname2 = require$$1$1.extname;
    var EXTRACT_TYPE_REGEXP = /^\s*([^;\s]*)(?:;|\s|$)/;
    var TEXT_TYPE_REGEXP = /^text\//i;
    exports.charset = charset;
    exports.charsets = { lookup: charset };
    exports.contentType = contentType;
    exports.extension = extension;
    exports.extensions = /* @__PURE__ */ Object.create(null);
    exports.lookup = lookup;
    exports.types = /* @__PURE__ */ Object.create(null);
    populateMaps(exports.extensions, exports.types);
    function charset(type2) {
      if (!type2 || typeof type2 !== "string") {
        return false;
      }
      var match = EXTRACT_TYPE_REGEXP.exec(type2);
      var mime = match && db[match[1].toLowerCase()];
      if (mime && mime.charset) {
        return mime.charset;
      }
      if (match && TEXT_TYPE_REGEXP.test(match[1])) {
        return "UTF-8";
      }
      return false;
    }
    function contentType(str) {
      if (!str || typeof str !== "string") {
        return false;
      }
      var mime = str.indexOf("/") === -1 ? exports.lookup(str) : str;
      if (!mime) {
        return false;
      }
      if (mime.indexOf("charset") === -1) {
        var charset2 = exports.charset(mime);
        if (charset2) mime += "; charset=" + charset2.toLowerCase();
      }
      return mime;
    }
    function extension(type2) {
      if (!type2 || typeof type2 !== "string") {
        return false;
      }
      var match = EXTRACT_TYPE_REGEXP.exec(type2);
      var exts = match && exports.extensions[match[1].toLowerCase()];
      if (!exts || !exts.length) {
        return false;
      }
      return exts[0];
    }
    function lookup(path) {
      if (!path || typeof path !== "string") {
        return false;
      }
      var extension2 = extname2("x." + path).toLowerCase().substr(1);
      if (!extension2) {
        return false;
      }
      return exports.types[extension2] || false;
    }
    function populateMaps(extensions, types) {
      var preference = ["nginx", "apache", void 0, "iana"];
      Object.keys(db).forEach(function forEachMimeType(type2) {
        var mime = db[type2];
        var exts = mime.extensions;
        if (!exts || !exts.length) {
          return;
        }
        extensions[type2] = exts;
        for (var i = 0; i < exts.length; i++) {
          var extension2 = exts[i];
          if (types[extension2]) {
            var from = preference.indexOf(db[types[extension2]].source);
            var to = preference.indexOf(mime.source);
            if (types[extension2] !== "application/octet-stream" && (from > to || from === to && types[extension2].substr(0, 12) === "application/")) {
              continue;
            }
          }
          types[extension2] = type2;
        }
      });
    }
  })(mimeTypes);
  return mimeTypes;
}
var defer_1;
var hasRequiredDefer;
function requireDefer() {
  if (hasRequiredDefer) return defer_1;
  hasRequiredDefer = 1;
  defer_1 = defer;
  function defer(fn) {
    var nextTick = typeof setImmediate == "function" ? setImmediate : typeof process == "object" && typeof process.nextTick == "function" ? process.nextTick : null;
    if (nextTick) {
      nextTick(fn);
    } else {
      setTimeout(fn, 0);
    }
  }
  return defer_1;
}
var async_1;
var hasRequiredAsync;
function requireAsync() {
  if (hasRequiredAsync) return async_1;
  hasRequiredAsync = 1;
  var defer = requireDefer();
  async_1 = async;
  function async(callback) {
    var isAsync = false;
    defer(function() {
      isAsync = true;
    });
    return function async_callback(err, result) {
      if (isAsync) {
        callback(err, result);
      } else {
        defer(function nextTick_callback() {
          callback(err, result);
        });
      }
    };
  }
  return async_1;
}
var abort_1;
var hasRequiredAbort;
function requireAbort() {
  if (hasRequiredAbort) return abort_1;
  hasRequiredAbort = 1;
  abort_1 = abort;
  function abort(state) {
    Object.keys(state.jobs).forEach(clean.bind(state));
    state.jobs = {};
  }
  function clean(key) {
    if (typeof this.jobs[key] == "function") {
      this.jobs[key]();
    }
  }
  return abort_1;
}
var iterate_1;
var hasRequiredIterate;
function requireIterate() {
  if (hasRequiredIterate) return iterate_1;
  hasRequiredIterate = 1;
  var async = requireAsync(), abort = requireAbort();
  iterate_1 = iterate;
  function iterate(list, iterator2, state, callback) {
    var key = state["keyedList"] ? state["keyedList"][state.index] : state.index;
    state.jobs[key] = runJob(iterator2, key, list[key], function(error, output) {
      if (!(key in state.jobs)) {
        return;
      }
      delete state.jobs[key];
      if (error) {
        abort(state);
      } else {
        state.results[key] = output;
      }
      callback(error, state.results);
    });
  }
  function runJob(iterator2, key, item, callback) {
    var aborter;
    if (iterator2.length == 2) {
      aborter = iterator2(item, async(callback));
    } else {
      aborter = iterator2(item, key, async(callback));
    }
    return aborter;
  }
  return iterate_1;
}
var state_1;
var hasRequiredState;
function requireState() {
  if (hasRequiredState) return state_1;
  hasRequiredState = 1;
  state_1 = state;
  function state(list, sortMethod) {
    var isNamedList = !Array.isArray(list), initState = {
      index: 0,
      keyedList: isNamedList || sortMethod ? Object.keys(list) : null,
      jobs: {},
      results: isNamedList ? {} : [],
      size: isNamedList ? Object.keys(list).length : list.length
    };
    if (sortMethod) {
      initState.keyedList.sort(isNamedList ? sortMethod : function(a, b) {
        return sortMethod(list[a], list[b]);
      });
    }
    return initState;
  }
  return state_1;
}
var terminator_1;
var hasRequiredTerminator;
function requireTerminator() {
  if (hasRequiredTerminator) return terminator_1;
  hasRequiredTerminator = 1;
  var abort = requireAbort(), async = requireAsync();
  terminator_1 = terminator;
  function terminator(callback) {
    if (!Object.keys(this.jobs).length) {
      return;
    }
    this.index = this.size;
    abort(this);
    async(callback)(null, this.results);
  }
  return terminator_1;
}
var parallel_1;
var hasRequiredParallel;
function requireParallel() {
  if (hasRequiredParallel) return parallel_1;
  hasRequiredParallel = 1;
  var iterate = requireIterate(), initState = requireState(), terminator = requireTerminator();
  parallel_1 = parallel;
  function parallel(list, iterator2, callback) {
    var state = initState(list);
    while (state.index < (state["keyedList"] || list).length) {
      iterate(list, iterator2, state, function(error, result) {
        if (error) {
          callback(error, result);
          return;
        }
        if (Object.keys(state.jobs).length === 0) {
          callback(null, state.results);
          return;
        }
      });
      state.index++;
    }
    return terminator.bind(state, callback);
  }
  return parallel_1;
}
var serialOrdered = { exports: {} };
var hasRequiredSerialOrdered;
function requireSerialOrdered() {
  if (hasRequiredSerialOrdered) return serialOrdered.exports;
  hasRequiredSerialOrdered = 1;
  var iterate = requireIterate(), initState = requireState(), terminator = requireTerminator();
  serialOrdered.exports = serialOrdered$1;
  serialOrdered.exports.ascending = ascending;
  serialOrdered.exports.descending = descending;
  function serialOrdered$1(list, iterator2, sortMethod, callback) {
    var state = initState(list, sortMethod);
    iterate(list, iterator2, state, function iteratorHandler(error, result) {
      if (error) {
        callback(error, result);
        return;
      }
      state.index++;
      if (state.index < (state["keyedList"] || list).length) {
        iterate(list, iterator2, state, iteratorHandler);
        return;
      }
      callback(null, state.results);
    });
    return terminator.bind(state, callback);
  }
  function ascending(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function descending(a, b) {
    return -1 * ascending(a, b);
  }
  return serialOrdered.exports;
}
var serial_1;
var hasRequiredSerial;
function requireSerial() {
  if (hasRequiredSerial) return serial_1;
  hasRequiredSerial = 1;
  var serialOrdered2 = requireSerialOrdered();
  serial_1 = serial;
  function serial(list, iterator2, callback) {
    return serialOrdered2(list, iterator2, null, callback);
  }
  return serial_1;
}
var asynckit;
var hasRequiredAsynckit;
function requireAsynckit() {
  if (hasRequiredAsynckit) return asynckit;
  hasRequiredAsynckit = 1;
  asynckit = {
    parallel: requireParallel(),
    serial: requireSerial(),
    serialOrdered: requireSerialOrdered()
  };
  return asynckit;
}
var esObjectAtoms;
var hasRequiredEsObjectAtoms;
function requireEsObjectAtoms() {
  if (hasRequiredEsObjectAtoms) return esObjectAtoms;
  hasRequiredEsObjectAtoms = 1;
  esObjectAtoms = Object;
  return esObjectAtoms;
}
var esErrors;
var hasRequiredEsErrors;
function requireEsErrors() {
  if (hasRequiredEsErrors) return esErrors;
  hasRequiredEsErrors = 1;
  esErrors = Error;
  return esErrors;
}
var _eval;
var hasRequired_eval;
function require_eval() {
  if (hasRequired_eval) return _eval;
  hasRequired_eval = 1;
  _eval = EvalError;
  return _eval;
}
var range;
var hasRequiredRange;
function requireRange() {
  if (hasRequiredRange) return range;
  hasRequiredRange = 1;
  range = RangeError;
  return range;
}
var ref;
var hasRequiredRef;
function requireRef() {
  if (hasRequiredRef) return ref;
  hasRequiredRef = 1;
  ref = ReferenceError;
  return ref;
}
var syntax;
var hasRequiredSyntax;
function requireSyntax() {
  if (hasRequiredSyntax) return syntax;
  hasRequiredSyntax = 1;
  syntax = SyntaxError;
  return syntax;
}
var type;
var hasRequiredType;
function requireType() {
  if (hasRequiredType) return type;
  hasRequiredType = 1;
  type = TypeError;
  return type;
}
var uri;
var hasRequiredUri;
function requireUri() {
  if (hasRequiredUri) return uri;
  hasRequiredUri = 1;
  uri = URIError;
  return uri;
}
var abs;
var hasRequiredAbs;
function requireAbs() {
  if (hasRequiredAbs) return abs;
  hasRequiredAbs = 1;
  abs = Math.abs;
  return abs;
}
var floor;
var hasRequiredFloor;
function requireFloor() {
  if (hasRequiredFloor) return floor;
  hasRequiredFloor = 1;
  floor = Math.floor;
  return floor;
}
var max;
var hasRequiredMax;
function requireMax() {
  if (hasRequiredMax) return max;
  hasRequiredMax = 1;
  max = Math.max;
  return max;
}
var min;
var hasRequiredMin;
function requireMin() {
  if (hasRequiredMin) return min;
  hasRequiredMin = 1;
  min = Math.min;
  return min;
}
var pow;
var hasRequiredPow;
function requirePow() {
  if (hasRequiredPow) return pow;
  hasRequiredPow = 1;
  pow = Math.pow;
  return pow;
}
var round;
var hasRequiredRound;
function requireRound() {
  if (hasRequiredRound) return round;
  hasRequiredRound = 1;
  round = Math.round;
  return round;
}
var _isNaN;
var hasRequired_isNaN;
function require_isNaN() {
  if (hasRequired_isNaN) return _isNaN;
  hasRequired_isNaN = 1;
  _isNaN = Number.isNaN || function isNaN2(a) {
    return a !== a;
  };
  return _isNaN;
}
var sign;
var hasRequiredSign;
function requireSign() {
  if (hasRequiredSign) return sign;
  hasRequiredSign = 1;
  var $isNaN = /* @__PURE__ */ require_isNaN();
  sign = function sign2(number) {
    if ($isNaN(number) || number === 0) {
      return number;
    }
    return number < 0 ? -1 : 1;
  };
  return sign;
}
var gOPD;
var hasRequiredGOPD;
function requireGOPD() {
  if (hasRequiredGOPD) return gOPD;
  hasRequiredGOPD = 1;
  gOPD = Object.getOwnPropertyDescriptor;
  return gOPD;
}
var gopd;
var hasRequiredGopd;
function requireGopd() {
  if (hasRequiredGopd) return gopd;
  hasRequiredGopd = 1;
  var $gOPD = /* @__PURE__ */ requireGOPD();
  if ($gOPD) {
    try {
      $gOPD([], "length");
    } catch (e) {
      $gOPD = null;
    }
  }
  gopd = $gOPD;
  return gopd;
}
var esDefineProperty;
var hasRequiredEsDefineProperty;
function requireEsDefineProperty() {
  if (hasRequiredEsDefineProperty) return esDefineProperty;
  hasRequiredEsDefineProperty = 1;
  var $defineProperty = Object.defineProperty || false;
  if ($defineProperty) {
    try {
      $defineProperty({}, "a", { value: 1 });
    } catch (e) {
      $defineProperty = false;
    }
  }
  esDefineProperty = $defineProperty;
  return esDefineProperty;
}
var shams$1;
var hasRequiredShams$1;
function requireShams$1() {
  if (hasRequiredShams$1) return shams$1;
  hasRequiredShams$1 = 1;
  shams$1 = function hasSymbols2() {
    if (typeof Symbol !== "function" || typeof Object.getOwnPropertySymbols !== "function") {
      return false;
    }
    if (typeof Symbol.iterator === "symbol") {
      return true;
    }
    var obj = {};
    var sym = Symbol("test");
    var symObj = Object(sym);
    if (typeof sym === "string") {
      return false;
    }
    if (Object.prototype.toString.call(sym) !== "[object Symbol]") {
      return false;
    }
    if (Object.prototype.toString.call(symObj) !== "[object Symbol]") {
      return false;
    }
    var symVal = 42;
    obj[sym] = symVal;
    for (var _ in obj) {
      return false;
    }
    if (typeof Object.keys === "function" && Object.keys(obj).length !== 0) {
      return false;
    }
    if (typeof Object.getOwnPropertyNames === "function" && Object.getOwnPropertyNames(obj).length !== 0) {
      return false;
    }
    var syms = Object.getOwnPropertySymbols(obj);
    if (syms.length !== 1 || syms[0] !== sym) {
      return false;
    }
    if (!Object.prototype.propertyIsEnumerable.call(obj, sym)) {
      return false;
    }
    if (typeof Object.getOwnPropertyDescriptor === "function") {
      var descriptor = (
        /** @type {PropertyDescriptor} */
        Object.getOwnPropertyDescriptor(obj, sym)
      );
      if (descriptor.value !== symVal || descriptor.enumerable !== true) {
        return false;
      }
    }
    return true;
  };
  return shams$1;
}
var hasSymbols;
var hasRequiredHasSymbols;
function requireHasSymbols() {
  if (hasRequiredHasSymbols) return hasSymbols;
  hasRequiredHasSymbols = 1;
  var origSymbol = typeof Symbol !== "undefined" && Symbol;
  var hasSymbolSham = requireShams$1();
  hasSymbols = function hasNativeSymbols() {
    if (typeof origSymbol !== "function") {
      return false;
    }
    if (typeof Symbol !== "function") {
      return false;
    }
    if (typeof origSymbol("foo") !== "symbol") {
      return false;
    }
    if (typeof Symbol("bar") !== "symbol") {
      return false;
    }
    return hasSymbolSham();
  };
  return hasSymbols;
}
var Reflect_getPrototypeOf;
var hasRequiredReflect_getPrototypeOf;
function requireReflect_getPrototypeOf() {
  if (hasRequiredReflect_getPrototypeOf) return Reflect_getPrototypeOf;
  hasRequiredReflect_getPrototypeOf = 1;
  Reflect_getPrototypeOf = typeof Reflect !== "undefined" && Reflect.getPrototypeOf || null;
  return Reflect_getPrototypeOf;
}
var Object_getPrototypeOf;
var hasRequiredObject_getPrototypeOf;
function requireObject_getPrototypeOf() {
  if (hasRequiredObject_getPrototypeOf) return Object_getPrototypeOf;
  hasRequiredObject_getPrototypeOf = 1;
  var $Object = /* @__PURE__ */ requireEsObjectAtoms();
  Object_getPrototypeOf = $Object.getPrototypeOf || null;
  return Object_getPrototypeOf;
}
var implementation;
var hasRequiredImplementation;
function requireImplementation() {
  if (hasRequiredImplementation) return implementation;
  hasRequiredImplementation = 1;
  var ERROR_MESSAGE = "Function.prototype.bind called on incompatible ";
  var toStr = Object.prototype.toString;
  var max2 = Math.max;
  var funcType = "[object Function]";
  var concatty = function concatty2(a, b) {
    var arr = [];
    for (var i = 0; i < a.length; i += 1) {
      arr[i] = a[i];
    }
    for (var j = 0; j < b.length; j += 1) {
      arr[j + a.length] = b[j];
    }
    return arr;
  };
  var slicy = function slicy2(arrLike, offset) {
    var arr = [];
    for (var i = offset, j = 0; i < arrLike.length; i += 1, j += 1) {
      arr[j] = arrLike[i];
    }
    return arr;
  };
  var joiny = function(arr, joiner) {
    var str = "";
    for (var i = 0; i < arr.length; i += 1) {
      str += arr[i];
      if (i + 1 < arr.length) {
        str += joiner;
      }
    }
    return str;
  };
  implementation = function bind2(that) {
    var target = this;
    if (typeof target !== "function" || toStr.apply(target) !== funcType) {
      throw new TypeError(ERROR_MESSAGE + target);
    }
    var args = slicy(arguments, 1);
    var bound;
    var binder = function() {
      if (this instanceof bound) {
        var result = target.apply(
          this,
          concatty(args, arguments)
        );
        if (Object(result) === result) {
          return result;
        }
        return this;
      }
      return target.apply(
        that,
        concatty(args, arguments)
      );
    };
    var boundLength = max2(0, target.length - args.length);
    var boundArgs = [];
    for (var i = 0; i < boundLength; i++) {
      boundArgs[i] = "$" + i;
    }
    bound = Function("binder", "return function (" + joiny(boundArgs, ",") + "){ return binder.apply(this,arguments); }")(binder);
    if (target.prototype) {
      var Empty = function Empty2() {
      };
      Empty.prototype = target.prototype;
      bound.prototype = new Empty();
      Empty.prototype = null;
    }
    return bound;
  };
  return implementation;
}
var functionBind;
var hasRequiredFunctionBind;
function requireFunctionBind() {
  if (hasRequiredFunctionBind) return functionBind;
  hasRequiredFunctionBind = 1;
  var implementation2 = requireImplementation();
  functionBind = Function.prototype.bind || implementation2;
  return functionBind;
}
var functionCall;
var hasRequiredFunctionCall;
function requireFunctionCall() {
  if (hasRequiredFunctionCall) return functionCall;
  hasRequiredFunctionCall = 1;
  functionCall = Function.prototype.call;
  return functionCall;
}
var functionApply;
var hasRequiredFunctionApply;
function requireFunctionApply() {
  if (hasRequiredFunctionApply) return functionApply;
  hasRequiredFunctionApply = 1;
  functionApply = Function.prototype.apply;
  return functionApply;
}
var reflectApply;
var hasRequiredReflectApply;
function requireReflectApply() {
  if (hasRequiredReflectApply) return reflectApply;
  hasRequiredReflectApply = 1;
  reflectApply = typeof Reflect !== "undefined" && Reflect && Reflect.apply;
  return reflectApply;
}
var actualApply;
var hasRequiredActualApply;
function requireActualApply() {
  if (hasRequiredActualApply) return actualApply;
  hasRequiredActualApply = 1;
  var bind2 = requireFunctionBind();
  var $apply = requireFunctionApply();
  var $call = requireFunctionCall();
  var $reflectApply = requireReflectApply();
  actualApply = $reflectApply || bind2.call($call, $apply);
  return actualApply;
}
var callBindApplyHelpers;
var hasRequiredCallBindApplyHelpers;
function requireCallBindApplyHelpers() {
  if (hasRequiredCallBindApplyHelpers) return callBindApplyHelpers;
  hasRequiredCallBindApplyHelpers = 1;
  var bind2 = requireFunctionBind();
  var $TypeError = /* @__PURE__ */ requireType();
  var $call = requireFunctionCall();
  var $actualApply = requireActualApply();
  callBindApplyHelpers = function callBindBasic(args) {
    if (args.length < 1 || typeof args[0] !== "function") {
      throw new $TypeError("a function is required");
    }
    return $actualApply(bind2, $call, args);
  };
  return callBindApplyHelpers;
}
var get;
var hasRequiredGet;
function requireGet() {
  if (hasRequiredGet) return get;
  hasRequiredGet = 1;
  var callBind = requireCallBindApplyHelpers();
  var gOPD2 = /* @__PURE__ */ requireGopd();
  var hasProtoAccessor;
  try {
    hasProtoAccessor = /** @type {{ __proto__?: typeof Array.prototype }} */
    [].__proto__ === Array.prototype;
  } catch (e) {
    if (!e || typeof e !== "object" || !("code" in e) || e.code !== "ERR_PROTO_ACCESS") {
      throw e;
    }
  }
  var desc = !!hasProtoAccessor && gOPD2 && gOPD2(
    Object.prototype,
    /** @type {keyof typeof Object.prototype} */
    "__proto__"
  );
  var $Object = Object;
  var $getPrototypeOf = $Object.getPrototypeOf;
  get = desc && typeof desc.get === "function" ? callBind([desc.get]) : typeof $getPrototypeOf === "function" ? (
    /** @type {import('./get')} */
    function getDunder(value) {
      return $getPrototypeOf(value == null ? value : $Object(value));
    }
  ) : false;
  return get;
}
var getProto;
var hasRequiredGetProto;
function requireGetProto() {
  if (hasRequiredGetProto) return getProto;
  hasRequiredGetProto = 1;
  var reflectGetProto = requireReflect_getPrototypeOf();
  var originalGetProto = requireObject_getPrototypeOf();
  var getDunderProto = /* @__PURE__ */ requireGet();
  getProto = reflectGetProto ? function getProto2(O) {
    return reflectGetProto(O);
  } : originalGetProto ? function getProto2(O) {
    if (!O || typeof O !== "object" && typeof O !== "function") {
      throw new TypeError("getProto: not an object");
    }
    return originalGetProto(O);
  } : getDunderProto ? function getProto2(O) {
    return getDunderProto(O);
  } : null;
  return getProto;
}
var hasown;
var hasRequiredHasown;
function requireHasown() {
  if (hasRequiredHasown) return hasown;
  hasRequiredHasown = 1;
  var call = Function.prototype.call;
  var $hasOwn = Object.prototype.hasOwnProperty;
  var bind2 = requireFunctionBind();
  hasown = bind2.call(call, $hasOwn);
  return hasown;
}
var getIntrinsic;
var hasRequiredGetIntrinsic;
function requireGetIntrinsic() {
  if (hasRequiredGetIntrinsic) return getIntrinsic;
  hasRequiredGetIntrinsic = 1;
  var undefined$1;
  var $Object = /* @__PURE__ */ requireEsObjectAtoms();
  var $Error = /* @__PURE__ */ requireEsErrors();
  var $EvalError = /* @__PURE__ */ require_eval();
  var $RangeError = /* @__PURE__ */ requireRange();
  var $ReferenceError = /* @__PURE__ */ requireRef();
  var $SyntaxError = /* @__PURE__ */ requireSyntax();
  var $TypeError = /* @__PURE__ */ requireType();
  var $URIError = /* @__PURE__ */ requireUri();
  var abs2 = /* @__PURE__ */ requireAbs();
  var floor2 = /* @__PURE__ */ requireFloor();
  var max2 = /* @__PURE__ */ requireMax();
  var min2 = /* @__PURE__ */ requireMin();
  var pow2 = /* @__PURE__ */ requirePow();
  var round2 = /* @__PURE__ */ requireRound();
  var sign2 = /* @__PURE__ */ requireSign();
  var $Function = Function;
  var getEvalledConstructor = function(expressionSyntax) {
    try {
      return $Function('"use strict"; return (' + expressionSyntax + ").constructor;")();
    } catch (e) {
    }
  };
  var $gOPD = /* @__PURE__ */ requireGopd();
  var $defineProperty = /* @__PURE__ */ requireEsDefineProperty();
  var throwTypeError = function() {
    throw new $TypeError();
  };
  var ThrowTypeError = $gOPD ? function() {
    try {
      arguments.callee;
      return throwTypeError;
    } catch (calleeThrows) {
      try {
        return $gOPD(arguments, "callee").get;
      } catch (gOPDthrows) {
        return throwTypeError;
      }
    }
  }() : throwTypeError;
  var hasSymbols2 = requireHasSymbols()();
  var getProto2 = requireGetProto();
  var $ObjectGPO = requireObject_getPrototypeOf();
  var $ReflectGPO = requireReflect_getPrototypeOf();
  var $apply = requireFunctionApply();
  var $call = requireFunctionCall();
  var needsEval = {};
  var TypedArray = typeof Uint8Array === "undefined" || !getProto2 ? undefined$1 : getProto2(Uint8Array);
  var INTRINSICS = {
    __proto__: null,
    "%AggregateError%": typeof AggregateError === "undefined" ? undefined$1 : AggregateError,
    "%Array%": Array,
    "%ArrayBuffer%": typeof ArrayBuffer === "undefined" ? undefined$1 : ArrayBuffer,
    "%ArrayIteratorPrototype%": hasSymbols2 && getProto2 ? getProto2([][Symbol.iterator]()) : undefined$1,
    "%AsyncFromSyncIteratorPrototype%": undefined$1,
    "%AsyncFunction%": needsEval,
    "%AsyncGenerator%": needsEval,
    "%AsyncGeneratorFunction%": needsEval,
    "%AsyncIteratorPrototype%": needsEval,
    "%Atomics%": typeof Atomics === "undefined" ? undefined$1 : Atomics,
    "%BigInt%": typeof BigInt === "undefined" ? undefined$1 : BigInt,
    "%BigInt64Array%": typeof BigInt64Array === "undefined" ? undefined$1 : BigInt64Array,
    "%BigUint64Array%": typeof BigUint64Array === "undefined" ? undefined$1 : BigUint64Array,
    "%Boolean%": Boolean,
    "%DataView%": typeof DataView === "undefined" ? undefined$1 : DataView,
    "%Date%": Date,
    "%decodeURI%": decodeURI,
    "%decodeURIComponent%": decodeURIComponent,
    "%encodeURI%": encodeURI,
    "%encodeURIComponent%": encodeURIComponent,
    "%Error%": $Error,
    "%eval%": eval,
    // eslint-disable-line no-eval
    "%EvalError%": $EvalError,
    "%Float16Array%": typeof Float16Array === "undefined" ? undefined$1 : Float16Array,
    "%Float32Array%": typeof Float32Array === "undefined" ? undefined$1 : Float32Array,
    "%Float64Array%": typeof Float64Array === "undefined" ? undefined$1 : Float64Array,
    "%FinalizationRegistry%": typeof FinalizationRegistry === "undefined" ? undefined$1 : FinalizationRegistry,
    "%Function%": $Function,
    "%GeneratorFunction%": needsEval,
    "%Int8Array%": typeof Int8Array === "undefined" ? undefined$1 : Int8Array,
    "%Int16Array%": typeof Int16Array === "undefined" ? undefined$1 : Int16Array,
    "%Int32Array%": typeof Int32Array === "undefined" ? undefined$1 : Int32Array,
    "%isFinite%": isFinite,
    "%isNaN%": isNaN,
    "%IteratorPrototype%": hasSymbols2 && getProto2 ? getProto2(getProto2([][Symbol.iterator]())) : undefined$1,
    "%JSON%": typeof JSON === "object" ? JSON : undefined$1,
    "%Map%": typeof Map === "undefined" ? undefined$1 : Map,
    "%MapIteratorPrototype%": typeof Map === "undefined" || !hasSymbols2 || !getProto2 ? undefined$1 : getProto2((/* @__PURE__ */ new Map())[Symbol.iterator]()),
    "%Math%": Math,
    "%Number%": Number,
    "%Object%": $Object,
    "%Object.getOwnPropertyDescriptor%": $gOPD,
    "%parseFloat%": parseFloat,
    "%parseInt%": parseInt,
    "%Promise%": typeof Promise === "undefined" ? undefined$1 : Promise,
    "%Proxy%": typeof Proxy === "undefined" ? undefined$1 : Proxy,
    "%RangeError%": $RangeError,
    "%ReferenceError%": $ReferenceError,
    "%Reflect%": typeof Reflect === "undefined" ? undefined$1 : Reflect,
    "%RegExp%": RegExp,
    "%Set%": typeof Set === "undefined" ? undefined$1 : Set,
    "%SetIteratorPrototype%": typeof Set === "undefined" || !hasSymbols2 || !getProto2 ? undefined$1 : getProto2((/* @__PURE__ */ new Set())[Symbol.iterator]()),
    "%SharedArrayBuffer%": typeof SharedArrayBuffer === "undefined" ? undefined$1 : SharedArrayBuffer,
    "%String%": String,
    "%StringIteratorPrototype%": hasSymbols2 && getProto2 ? getProto2(""[Symbol.iterator]()) : undefined$1,
    "%Symbol%": hasSymbols2 ? Symbol : undefined$1,
    "%SyntaxError%": $SyntaxError,
    "%ThrowTypeError%": ThrowTypeError,
    "%TypedArray%": TypedArray,
    "%TypeError%": $TypeError,
    "%Uint8Array%": typeof Uint8Array === "undefined" ? undefined$1 : Uint8Array,
    "%Uint8ClampedArray%": typeof Uint8ClampedArray === "undefined" ? undefined$1 : Uint8ClampedArray,
    "%Uint16Array%": typeof Uint16Array === "undefined" ? undefined$1 : Uint16Array,
    "%Uint32Array%": typeof Uint32Array === "undefined" ? undefined$1 : Uint32Array,
    "%URIError%": $URIError,
    "%WeakMap%": typeof WeakMap === "undefined" ? undefined$1 : WeakMap,
    "%WeakRef%": typeof WeakRef === "undefined" ? undefined$1 : WeakRef,
    "%WeakSet%": typeof WeakSet === "undefined" ? undefined$1 : WeakSet,
    "%Function.prototype.call%": $call,
    "%Function.prototype.apply%": $apply,
    "%Object.defineProperty%": $defineProperty,
    "%Object.getPrototypeOf%": $ObjectGPO,
    "%Math.abs%": abs2,
    "%Math.floor%": floor2,
    "%Math.max%": max2,
    "%Math.min%": min2,
    "%Math.pow%": pow2,
    "%Math.round%": round2,
    "%Math.sign%": sign2,
    "%Reflect.getPrototypeOf%": $ReflectGPO
  };
  if (getProto2) {
    try {
      null.error;
    } catch (e) {
      var errorProto = getProto2(getProto2(e));
      INTRINSICS["%Error.prototype%"] = errorProto;
    }
  }
  var doEval = function doEval2(name) {
    var value;
    if (name === "%AsyncFunction%") {
      value = getEvalledConstructor("async function () {}");
    } else if (name === "%GeneratorFunction%") {
      value = getEvalledConstructor("function* () {}");
    } else if (name === "%AsyncGeneratorFunction%") {
      value = getEvalledConstructor("async function* () {}");
    } else if (name === "%AsyncGenerator%") {
      var fn = doEval2("%AsyncGeneratorFunction%");
      if (fn) {
        value = fn.prototype;
      }
    } else if (name === "%AsyncIteratorPrototype%") {
      var gen = doEval2("%AsyncGenerator%");
      if (gen && getProto2) {
        value = getProto2(gen.prototype);
      }
    }
    INTRINSICS[name] = value;
    return value;
  };
  var LEGACY_ALIASES = {
    __proto__: null,
    "%ArrayBufferPrototype%": ["ArrayBuffer", "prototype"],
    "%ArrayPrototype%": ["Array", "prototype"],
    "%ArrayProto_entries%": ["Array", "prototype", "entries"],
    "%ArrayProto_forEach%": ["Array", "prototype", "forEach"],
    "%ArrayProto_keys%": ["Array", "prototype", "keys"],
    "%ArrayProto_values%": ["Array", "prototype", "values"],
    "%AsyncFunctionPrototype%": ["AsyncFunction", "prototype"],
    "%AsyncGenerator%": ["AsyncGeneratorFunction", "prototype"],
    "%AsyncGeneratorPrototype%": ["AsyncGeneratorFunction", "prototype", "prototype"],
    "%BooleanPrototype%": ["Boolean", "prototype"],
    "%DataViewPrototype%": ["DataView", "prototype"],
    "%DatePrototype%": ["Date", "prototype"],
    "%ErrorPrototype%": ["Error", "prototype"],
    "%EvalErrorPrototype%": ["EvalError", "prototype"],
    "%Float32ArrayPrototype%": ["Float32Array", "prototype"],
    "%Float64ArrayPrototype%": ["Float64Array", "prototype"],
    "%FunctionPrototype%": ["Function", "prototype"],
    "%Generator%": ["GeneratorFunction", "prototype"],
    "%GeneratorPrototype%": ["GeneratorFunction", "prototype", "prototype"],
    "%Int8ArrayPrototype%": ["Int8Array", "prototype"],
    "%Int16ArrayPrototype%": ["Int16Array", "prototype"],
    "%Int32ArrayPrototype%": ["Int32Array", "prototype"],
    "%JSONParse%": ["JSON", "parse"],
    "%JSONStringify%": ["JSON", "stringify"],
    "%MapPrototype%": ["Map", "prototype"],
    "%NumberPrototype%": ["Number", "prototype"],
    "%ObjectPrototype%": ["Object", "prototype"],
    "%ObjProto_toString%": ["Object", "prototype", "toString"],
    "%ObjProto_valueOf%": ["Object", "prototype", "valueOf"],
    "%PromisePrototype%": ["Promise", "prototype"],
    "%PromiseProto_then%": ["Promise", "prototype", "then"],
    "%Promise_all%": ["Promise", "all"],
    "%Promise_reject%": ["Promise", "reject"],
    "%Promise_resolve%": ["Promise", "resolve"],
    "%RangeErrorPrototype%": ["RangeError", "prototype"],
    "%ReferenceErrorPrototype%": ["ReferenceError", "prototype"],
    "%RegExpPrototype%": ["RegExp", "prototype"],
    "%SetPrototype%": ["Set", "prototype"],
    "%SharedArrayBufferPrototype%": ["SharedArrayBuffer", "prototype"],
    "%StringPrototype%": ["String", "prototype"],
    "%SymbolPrototype%": ["Symbol", "prototype"],
    "%SyntaxErrorPrototype%": ["SyntaxError", "prototype"],
    "%TypedArrayPrototype%": ["TypedArray", "prototype"],
    "%TypeErrorPrototype%": ["TypeError", "prototype"],
    "%Uint8ArrayPrototype%": ["Uint8Array", "prototype"],
    "%Uint8ClampedArrayPrototype%": ["Uint8ClampedArray", "prototype"],
    "%Uint16ArrayPrototype%": ["Uint16Array", "prototype"],
    "%Uint32ArrayPrototype%": ["Uint32Array", "prototype"],
    "%URIErrorPrototype%": ["URIError", "prototype"],
    "%WeakMapPrototype%": ["WeakMap", "prototype"],
    "%WeakSetPrototype%": ["WeakSet", "prototype"]
  };
  var bind2 = requireFunctionBind();
  var hasOwn = /* @__PURE__ */ requireHasown();
  var $concat = bind2.call($call, Array.prototype.concat);
  var $spliceApply = bind2.call($apply, Array.prototype.splice);
  var $replace = bind2.call($call, String.prototype.replace);
  var $strSlice = bind2.call($call, String.prototype.slice);
  var $exec = bind2.call($call, RegExp.prototype.exec);
  var rePropName = /[^%.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|%$))/g;
  var reEscapeChar = /\\(\\)?/g;
  var stringToPath = function stringToPath2(string) {
    var first = $strSlice(string, 0, 1);
    var last = $strSlice(string, -1);
    if (first === "%" && last !== "%") {
      throw new $SyntaxError("invalid intrinsic syntax, expected closing `%`");
    } else if (last === "%" && first !== "%") {
      throw new $SyntaxError("invalid intrinsic syntax, expected opening `%`");
    }
    var result = [];
    $replace(string, rePropName, function(match, number, quote, subString) {
      result[result.length] = quote ? $replace(subString, reEscapeChar, "$1") : number || match;
    });
    return result;
  };
  var getBaseIntrinsic = function getBaseIntrinsic2(name, allowMissing) {
    var intrinsicName = name;
    var alias;
    if (hasOwn(LEGACY_ALIASES, intrinsicName)) {
      alias = LEGACY_ALIASES[intrinsicName];
      intrinsicName = "%" + alias[0] + "%";
    }
    if (hasOwn(INTRINSICS, intrinsicName)) {
      var value = INTRINSICS[intrinsicName];
      if (value === needsEval) {
        value = doEval(intrinsicName);
      }
      if (typeof value === "undefined" && !allowMissing) {
        throw new $TypeError("intrinsic " + name + " exists, but is not available. Please file an issue!");
      }
      return {
        alias,
        name: intrinsicName,
        value
      };
    }
    throw new $SyntaxError("intrinsic " + name + " does not exist!");
  };
  getIntrinsic = function GetIntrinsic(name, allowMissing) {
    if (typeof name !== "string" || name.length === 0) {
      throw new $TypeError("intrinsic name must be a non-empty string");
    }
    if (arguments.length > 1 && typeof allowMissing !== "boolean") {
      throw new $TypeError('"allowMissing" argument must be a boolean');
    }
    if ($exec(/^%?[^%]*%?$/, name) === null) {
      throw new $SyntaxError("`%` may not be present anywhere but at the beginning and end of the intrinsic name");
    }
    var parts = stringToPath(name);
    var intrinsicBaseName = parts.length > 0 ? parts[0] : "";
    var intrinsic = getBaseIntrinsic("%" + intrinsicBaseName + "%", allowMissing);
    var intrinsicRealName = intrinsic.name;
    var value = intrinsic.value;
    var skipFurtherCaching = false;
    var alias = intrinsic.alias;
    if (alias) {
      intrinsicBaseName = alias[0];
      $spliceApply(parts, $concat([0, 1], alias));
    }
    for (var i = 1, isOwn = true; i < parts.length; i += 1) {
      var part = parts[i];
      var first = $strSlice(part, 0, 1);
      var last = $strSlice(part, -1);
      if ((first === '"' || first === "'" || first === "`" || (last === '"' || last === "'" || last === "`")) && first !== last) {
        throw new $SyntaxError("property names with quotes must have matching quotes");
      }
      if (part === "constructor" || !isOwn) {
        skipFurtherCaching = true;
      }
      intrinsicBaseName += "." + part;
      intrinsicRealName = "%" + intrinsicBaseName + "%";
      if (hasOwn(INTRINSICS, intrinsicRealName)) {
        value = INTRINSICS[intrinsicRealName];
      } else if (value != null) {
        if (!(part in value)) {
          if (!allowMissing) {
            throw new $TypeError("base intrinsic for " + name + " exists, but the property is not available.");
          }
          return void undefined$1;
        }
        if ($gOPD && i + 1 >= parts.length) {
          var desc = $gOPD(value, part);
          isOwn = !!desc;
          if (isOwn && "get" in desc && !("originalValue" in desc.get)) {
            value = desc.get;
          } else {
            value = value[part];
          }
        } else {
          isOwn = hasOwn(value, part);
          value = value[part];
        }
        if (isOwn && !skipFurtherCaching) {
          INTRINSICS[intrinsicRealName] = value;
        }
      }
    }
    return value;
  };
  return getIntrinsic;
}
var shams;
var hasRequiredShams;
function requireShams() {
  if (hasRequiredShams) return shams;
  hasRequiredShams = 1;
  var hasSymbols2 = requireShams$1();
  shams = function hasToStringTagShams() {
    return hasSymbols2() && !!Symbol.toStringTag;
  };
  return shams;
}
var esSetTostringtag;
var hasRequiredEsSetTostringtag;
function requireEsSetTostringtag() {
  if (hasRequiredEsSetTostringtag) return esSetTostringtag;
  hasRequiredEsSetTostringtag = 1;
  var GetIntrinsic = /* @__PURE__ */ requireGetIntrinsic();
  var $defineProperty = GetIntrinsic("%Object.defineProperty%", true);
  var hasToStringTag = requireShams()();
  var hasOwn = /* @__PURE__ */ requireHasown();
  var $TypeError = /* @__PURE__ */ requireType();
  var toStringTag2 = hasToStringTag ? Symbol.toStringTag : null;
  esSetTostringtag = function setToStringTag(object, value) {
    var overrideIfSet = arguments.length > 2 && !!arguments[2] && arguments[2].force;
    var nonConfigurable = arguments.length > 2 && !!arguments[2] && arguments[2].nonConfigurable;
    if (typeof overrideIfSet !== "undefined" && typeof overrideIfSet !== "boolean" || typeof nonConfigurable !== "undefined" && typeof nonConfigurable !== "boolean") {
      throw new $TypeError("if provided, the `overrideIfSet` and `nonConfigurable` options must be booleans");
    }
    if (toStringTag2 && (overrideIfSet || !hasOwn(object, toStringTag2))) {
      if ($defineProperty) {
        $defineProperty(object, toStringTag2, {
          configurable: !nonConfigurable,
          enumerable: false,
          value,
          writable: false
        });
      } else {
        object[toStringTag2] = value;
      }
    }
  };
  return esSetTostringtag;
}
var populate;
var hasRequiredPopulate;
function requirePopulate() {
  if (hasRequiredPopulate) return populate;
  hasRequiredPopulate = 1;
  populate = function(dst, src2) {
    Object.keys(src2).forEach(function(prop) {
      dst[prop] = dst[prop] || src2[prop];
    });
    return dst;
  };
  return populate;
}
var form_data;
var hasRequiredForm_data;
function requireForm_data() {
  if (hasRequiredForm_data) return form_data;
  hasRequiredForm_data = 1;
  var CombinedStream = requireCombined_stream();
  var util = require$$1;
  var path = require$$1$1;
  var http3 = http$a;
  var https$1 = https;
  var parseUrl2 = require$$5.parse;
  var fs = require$$6;
  var Stream = stream.Stream;
  var crypto = require$$8;
  var mime = requireMimeTypes();
  var asynckit2 = requireAsynckit();
  var setToStringTag = /* @__PURE__ */ requireEsSetTostringtag();
  var hasOwn = /* @__PURE__ */ requireHasown();
  var populate2 = requirePopulate();
  function escapeHeaderParam(str) {
    return String(str).replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
  }
  function FormData2(options) {
    if (!(this instanceof FormData2)) {
      return new FormData2(options);
    }
    this._overheadLength = 0;
    this._valueLength = 0;
    this._valuesToMeasure = [];
    CombinedStream.call(this);
    options = options || {};
    for (var option in options) {
      this[option] = options[option];
    }
  }
  util.inherits(FormData2, CombinedStream);
  FormData2.LINE_BREAK = "\r\n";
  FormData2.DEFAULT_CONTENT_TYPE = "application/octet-stream";
  FormData2.prototype.append = function(field, value, options) {
    options = options || {};
    if (typeof options === "string") {
      options = { filename: options };
    }
    var append2 = CombinedStream.prototype.append.bind(this);
    if (typeof value === "number" || value == null) {
      value = String(value);
    }
    if (Array.isArray(value)) {
      this._error(new Error("Arrays are not supported."));
      return;
    }
    var header = this._multiPartHeader(field, value, options);
    var footer = this._multiPartFooter();
    append2(header);
    append2(value);
    append2(footer);
    this._trackLength(header, value, options);
  };
  FormData2.prototype._trackLength = function(header, value, options) {
    var valueLength = 0;
    if (options.knownLength != null) {
      valueLength += Number(options.knownLength);
    } else if (Buffer.isBuffer(value)) {
      valueLength = value.length;
    } else if (typeof value === "string") {
      valueLength = Buffer.byteLength(value);
    }
    this._valueLength += valueLength;
    this._overheadLength += Buffer.byteLength(header) + FormData2.LINE_BREAK.length;
    if (!value || !value.path && !(value.readable && hasOwn(value, "httpVersion")) && !(value instanceof Stream)) {
      return;
    }
    if (!options.knownLength) {
      this._valuesToMeasure.push(value);
    }
  };
  FormData2.prototype._lengthRetriever = function(value, callback) {
    if (hasOwn(value, "fd")) {
      if (value.end != void 0 && value.end != Infinity && value.start != void 0) {
        callback(null, value.end + 1 - (value.start ? value.start : 0));
      } else {
        fs.stat(value.path, function(err, stat2) {
          if (err) {
            callback(err);
            return;
          }
          var fileSize = stat2.size - (value.start ? value.start : 0);
          callback(null, fileSize);
        });
      }
    } else if (hasOwn(value, "httpVersion")) {
      callback(null, Number(value.headers["content-length"]));
    } else if (hasOwn(value, "httpModule")) {
      value.on("response", function(response) {
        value.pause();
        callback(null, Number(response.headers["content-length"]));
      });
      value.resume();
    } else {
      callback("Unknown stream");
    }
  };
  FormData2.prototype._multiPartHeader = function(field, value, options) {
    if (typeof options.header === "string") {
      return options.header;
    }
    var contentDisposition = this._getContentDisposition(value, options);
    var contentType = this._getContentType(value, options);
    var contents = "";
    var headers = {
      // add custom disposition as third element or keep it two elements if not
      "Content-Disposition": ["form-data", 'name="' + escapeHeaderParam(field) + '"'].concat(contentDisposition || []),
      // if no content type. allow it to be empty array
      "Content-Type": [].concat(contentType || [])
    };
    if (typeof options.header === "object") {
      populate2(headers, options.header);
    }
    var header;
    for (var prop in headers) {
      if (hasOwn(headers, prop)) {
        header = headers[prop];
        if (header == null) {
          continue;
        }
        if (!Array.isArray(header)) {
          header = [header];
        }
        if (header.length) {
          contents += prop + ": " + header.join("; ") + FormData2.LINE_BREAK;
        }
      }
    }
    return "--" + this.getBoundary() + FormData2.LINE_BREAK + contents + FormData2.LINE_BREAK;
  };
  FormData2.prototype._getContentDisposition = function(value, options) {
    var filename;
    if (typeof options.filepath === "string") {
      filename = path.normalize(options.filepath).replace(/\\/g, "/");
    } else if (options.filename || value && (value.name || value.path)) {
      filename = path.basename(options.filename || value && (value.name || value.path));
    } else if (value && value.readable && hasOwn(value, "httpVersion")) {
      filename = path.basename(value.client._httpMessage.path || "");
    }
    if (filename) {
      return 'filename="' + escapeHeaderParam(filename) + '"';
    }
  };
  FormData2.prototype._getContentType = function(value, options) {
    var contentType = options.contentType;
    if (!contentType && value && value.name) {
      contentType = mime.lookup(value.name);
    }
    if (!contentType && value && value.path) {
      contentType = mime.lookup(value.path);
    }
    if (!contentType && value && value.readable && hasOwn(value, "httpVersion")) {
      contentType = value.headers["content-type"];
    }
    if (!contentType && (options.filepath || options.filename)) {
      contentType = mime.lookup(options.filepath || options.filename);
    }
    if (!contentType && value && typeof value === "object") {
      contentType = FormData2.DEFAULT_CONTENT_TYPE;
    }
    return contentType;
  };
  FormData2.prototype._multiPartFooter = function() {
    return function(next) {
      var footer = FormData2.LINE_BREAK;
      var lastPart = this._streams.length === 0;
      if (lastPart) {
        footer += this._lastBoundary();
      }
      next(footer);
    }.bind(this);
  };
  FormData2.prototype._lastBoundary = function() {
    return "--" + this.getBoundary() + "--" + FormData2.LINE_BREAK;
  };
  FormData2.prototype.getHeaders = function(userHeaders) {
    var header;
    var formHeaders = {
      "content-type": "multipart/form-data; boundary=" + this.getBoundary()
    };
    for (header in userHeaders) {
      if (hasOwn(userHeaders, header)) {
        formHeaders[header.toLowerCase()] = userHeaders[header];
      }
    }
    return formHeaders;
  };
  FormData2.prototype.setBoundary = function(boundary) {
    if (typeof boundary !== "string") {
      throw new TypeError("FormData boundary must be a string");
    }
    this._boundary = boundary;
  };
  FormData2.prototype.getBoundary = function() {
    if (!this._boundary) {
      this._generateBoundary();
    }
    return this._boundary;
  };
  FormData2.prototype.getBuffer = function() {
    var dataBuffer = new Buffer.alloc(0);
    var boundary = this.getBoundary();
    for (var i = 0, len = this._streams.length; i < len; i++) {
      if (typeof this._streams[i] !== "function") {
        if (Buffer.isBuffer(this._streams[i])) {
          dataBuffer = Buffer.concat([dataBuffer, this._streams[i]]);
        } else {
          dataBuffer = Buffer.concat([dataBuffer, Buffer.from(this._streams[i])]);
        }
        if (typeof this._streams[i] !== "string" || this._streams[i].substring(2, boundary.length + 2) !== boundary) {
          dataBuffer = Buffer.concat([dataBuffer, Buffer.from(FormData2.LINE_BREAK)]);
        }
      }
    }
    return Buffer.concat([dataBuffer, Buffer.from(this._lastBoundary())]);
  };
  FormData2.prototype._generateBoundary = function() {
    this._boundary = "--------------------------" + crypto.randomBytes(12).toString("hex");
  };
  FormData2.prototype.getLengthSync = function() {
    var knownLength = this._overheadLength + this._valueLength;
    if (this._streams.length) {
      knownLength += this._lastBoundary().length;
    }
    if (!this.hasKnownLength()) {
      this._error(new Error("Cannot calculate proper length in synchronous way."));
    }
    return knownLength;
  };
  FormData2.prototype.hasKnownLength = function() {
    var hasKnownLength = true;
    if (this._valuesToMeasure.length) {
      hasKnownLength = false;
    }
    return hasKnownLength;
  };
  FormData2.prototype.getLength = function(cb) {
    var knownLength = this._overheadLength + this._valueLength;
    if (this._streams.length) {
      knownLength += this._lastBoundary().length;
    }
    if (!this._valuesToMeasure.length) {
      process.nextTick(cb.bind(this, null, knownLength));
      return;
    }
    asynckit2.parallel(this._valuesToMeasure, this._lengthRetriever, function(err, values) {
      if (err) {
        cb(err);
        return;
      }
      values.forEach(function(length) {
        knownLength += length;
      });
      cb(null, knownLength);
    });
  };
  FormData2.prototype.submit = function(params, cb) {
    var request;
    var options;
    var defaults2 = { method: "post" };
    if (typeof params === "string") {
      params = parseUrl2(params);
      options = populate2({
        port: params.port,
        path: params.pathname,
        host: params.hostname,
        protocol: params.protocol
      }, defaults2);
    } else {
      options = populate2(params, defaults2);
      if (!options.port) {
        options.port = options.protocol === "https:" ? 443 : 80;
      }
    }
    options.headers = this.getHeaders(params.headers);
    if (options.protocol === "https:") {
      request = https$1.request(options);
    } else {
      request = http3.request(options);
    }
    this.getLength(function(err, length) {
      if (err && err !== "Unknown stream") {
        this._error(err);
        return;
      }
      if (length) {
        request.setHeader("Content-Length", length);
      }
      this.pipe(request);
      if (cb) {
        var onResponse;
        var callback = function(error, responce) {
          request.removeListener("error", callback);
          request.removeListener("response", onResponse);
          return cb.call(this, error, responce);
        };
        onResponse = callback.bind(this, null);
        request.on("error", callback);
        request.on("response", onResponse);
      }
    }.bind(this));
    return request;
  };
  FormData2.prototype._error = function(err) {
    if (!this.error) {
      this.error = err;
      this.pause();
      this.emit("error", err);
    }
  };
  FormData2.prototype.toString = function() {
    return "[object FormData]";
  };
  setToStringTag(FormData2.prototype, "FormData");
  form_data = FormData2;
  return form_data;
}
var form_dataExports = requireForm_data();
const FormData$1 = /* @__PURE__ */ getDefaultExportFromCjs(form_dataExports);
const PlatformBuffer = {
  isBufferAvailable() {
    return typeof Buffer !== "undefined";
  },
  from(value) {
    return Buffer.from(value);
  }
};
const DEFAULT_FORM_DATA_MAX_DEPTH = 100;
function isVisitable(thing) {
  return utils$1.isPlainObject(thing) || utils$1.isArray(thing);
}
function removeBrackets(key) {
  return utils$1.endsWith(key, "[]") ? key.slice(0, -2) : key;
}
function renderKey(path, key, dots) {
  if (!path) return key;
  return path.concat(key).map(function each(token, i) {
    token = removeBrackets(token);
    return !dots && i ? "[" + token + "]" : token;
  }).join(dots ? "." : "");
}
function isFlatArray(arr) {
  return utils$1.isArray(arr) && !arr.some(isVisitable);
}
const predicates = utils$1.toFlatObject(utils$1, {}, null, function filter(prop) {
  return /^is[A-Z]/.test(prop);
});
function toFormData$1(obj, formData, options) {
  if (!utils$1.isObject(obj)) {
    throw new TypeError("target must be an object");
  }
  formData = formData || new (FormData$1 || FormData)();
  options = utils$1.toFlatObject(
    options,
    {
      metaTokens: true,
      dots: false,
      indexes: false
    },
    false,
    function defined(option, source) {
      return !utils$1.isUndefined(source[option]);
    }
  );
  const metaTokens = options.metaTokens;
  const visitor = options.visitor || defaultVisitor;
  const dots = options.dots;
  const indexes = options.indexes;
  const _Blob = options.Blob || typeof Blob !== "undefined" && Blob;
  const maxDepth = options.maxDepth === void 0 ? DEFAULT_FORM_DATA_MAX_DEPTH : options.maxDepth;
  const useBlob = _Blob && utils$1.isSpecCompliantForm(formData);
  const stack = [];
  if (!utils$1.isFunction(visitor)) {
    throw new TypeError("visitor must be a function");
  }
  function convertValue(value) {
    if (value === null) return "";
    if (utils$1.isDate(value)) {
      return value.toISOString();
    }
    if (utils$1.isBoolean(value)) {
      return value.toString();
    }
    if (!useBlob && utils$1.isBlob(value)) {
      throw new AxiosError$1("Blob is not supported. Use a Buffer instead.");
    }
    if (utils$1.isArrayBuffer(value) || utils$1.isTypedArray(value)) {
      if (useBlob && typeof _Blob === "function") {
        return new _Blob([value]);
      }
      if (PlatformBuffer && PlatformBuffer.isBufferAvailable()) {
        return PlatformBuffer.from(value);
      }
      throw new AxiosError$1("Blob is not supported. Use a Buffer instead.", AxiosError$1.ERR_NOT_SUPPORT);
    }
    return value;
  }
  function throwIfMaxDepthExceeded(depth) {
    if (depth > maxDepth) {
      throw new AxiosError$1(
        "Object is too deeply nested (" + depth + " levels). Max depth: " + maxDepth,
        AxiosError$1.ERR_FORM_DATA_DEPTH_EXCEEDED
      );
    }
  }
  function stringifyWithDepthLimit(value, depth) {
    if (maxDepth === Infinity) {
      return JSON.stringify(value);
    }
    const ancestors = [];
    return JSON.stringify(value, function limitDepth(_key, currentValue) {
      if (!utils$1.isObject(currentValue)) {
        return currentValue;
      }
      while (ancestors.length && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop();
      }
      ancestors.push(currentValue);
      throwIfMaxDepthExceeded(depth + ancestors.length - 1);
      return currentValue;
    });
  }
  function defaultVisitor(value, key, path) {
    let arr = value;
    if (utils$1.isReactNative(formData) && utils$1.isReactNativeBlob(value)) {
      formData.append(renderKey(path, key, dots), convertValue(value));
      return false;
    }
    if (value && !path && typeof value === "object") {
      if (utils$1.endsWith(key, "{}")) {
        key = metaTokens ? key : key.slice(0, -2);
        value = stringifyWithDepthLimit(value, 1);
      } else if (utils$1.isArray(value) && isFlatArray(value) || (utils$1.isFileList(value) || utils$1.endsWith(key, "[]")) && (arr = utils$1.toArray(value))) {
        key = removeBrackets(key);
        arr.forEach(function each(el, index) {
          !(utils$1.isUndefined(el) || el === null) && formData.append(
            // eslint-disable-next-line no-nested-ternary
            indexes === true ? renderKey([key], index, dots) : indexes === null ? key : key + "[]",
            convertValue(el)
          );
        });
        return false;
      }
    }
    if (isVisitable(value)) {
      return true;
    }
    formData.append(renderKey(path, key, dots), convertValue(value));
    return false;
  }
  const exposedHelpers = Object.assign(predicates, {
    defaultVisitor,
    convertValue,
    isVisitable
  });
  function build(value, path, depth = 0) {
    if (utils$1.isUndefined(value)) return;
    throwIfMaxDepthExceeded(depth);
    if (stack.indexOf(value) !== -1) {
      throw new Error("Circular reference detected in " + path.join("."));
    }
    stack.push(value);
    utils$1.forEach(value, function each(el, key) {
      const result = !(utils$1.isUndefined(el) || el === null) && visitor.call(formData, el, utils$1.isString(key) ? key.trim() : key, path, exposedHelpers);
      if (result === true) {
        build(el, path ? path.concat(key) : [key], depth + 1);
      }
    });
    stack.pop();
  }
  if (!utils$1.isObject(obj)) {
    throw new TypeError("data must be an object");
  }
  build(obj);
  return formData;
}
function encode$1(str) {
  const charMap = {
    "!": "%21",
    "'": "%27",
    "(": "%28",
    ")": "%29",
    "~": "%7E",
    "%20": "+"
  };
  return encodeURIComponent(str).replace(/[!'()~]|%20/g, function replacer(match) {
    return charMap[match];
  });
}
function AxiosURLSearchParams(params, options) {
  this._pairs = [];
  params && toFormData$1(params, this, options);
}
const prototype = AxiosURLSearchParams.prototype;
prototype.append = function append(name, value) {
  this._pairs.push([name, value]);
};
prototype.toString = function toString2(encoder) {
  const _encode = encoder ? (value) => encoder.call(this, value, encode$1) : encode$1;
  return this._pairs.map(function each(pair) {
    return _encode(pair[0]) + "=" + _encode(pair[1]);
  }, "").join("&");
};
function encode(val) {
  return encodeURIComponent(val).replace(/%3A/gi, ":").replace(/%24/g, "$").replace(/%2C/gi, ",").replace(/%20/g, "+");
}
function buildURL(url, params, options) {
  if (!params) {
    return url;
  }
  url = url || "";
  const _options = utils$1.isFunction(options) ? {
    serialize: options
  } : options;
  const _encode = utils$1.getSafeProp(_options, "encode") || encode;
  const serializeFn = utils$1.getSafeProp(_options, "serialize");
  let serializedParams;
  if (serializeFn) {
    serializedParams = serializeFn(params, _options);
  } else {
    serializedParams = utils$1.isURLSearchParams(params) ? params.toString() : new AxiosURLSearchParams(params, _options).toString(_encode);
  }
  if (serializedParams) {
    const hashmarkIndex = url.indexOf("#");
    if (hashmarkIndex !== -1) {
      url = url.slice(0, hashmarkIndex);
    }
    url += (url.indexOf("?") === -1 ? "?" : "&") + serializedParams;
  }
  return url;
}
class InterceptorManager {
  constructor() {
    this.handlers = [];
  }
  /**
   * Add a new interceptor to the stack
   *
   * @param {Function} fulfilled The function to handle `then` for a `Promise`
   * @param {Function} rejected The function to handle `reject` for a `Promise`
   * @param {Object} options The options for the interceptor, synchronous and runWhen
   *
   * @return {Number} An ID used to remove interceptor later
   */
  use(fulfilled, rejected, options) {
    this.handlers.push({
      fulfilled,
      rejected,
      synchronous: options ? options.synchronous : false,
      runWhen: options ? options.runWhen : null
    });
    return this.handlers.length - 1;
  }
  /**
   * Remove an interceptor from the stack
   *
   * @param {Number} id The ID that was returned by `use`
   *
   * @returns {void}
   */
  eject(id) {
    if (this.handlers[id]) {
      this.handlers[id] = null;
    }
  }
  /**
   * Clear all interceptors from the stack
   *
   * @returns {void}
   */
  clear() {
    if (this.handlers) {
      this.handlers = [];
    }
  }
  /**
   * Iterate over all the registered interceptors
   *
   * This method is particularly useful for skipping over any
   * interceptors that may have become `null` calling `eject`.
   *
   * @param {Function} fn The function to call for each interceptor
   *
   * @returns {void}
   */
  forEach(fn) {
    utils$1.forEach(this.handlers, function forEachHandler(h) {
      if (h !== null) {
        fn(h);
      }
    });
  }
}
const transitionalDefaults = {
  silentJSONParsing: true,
  forcedJSONParsing: true,
  clarifyTimeoutError: false,
  legacyInterceptorReqResOrdering: true,
  advertiseZstdAcceptEncoding: false,
  validateStatusUndefinedResolves: true
};
const URLSearchParams$1 = require$$5.URLSearchParams;
const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const DIGIT = "0123456789";
const ALPHABET = {
  DIGIT,
  ALPHA,
  ALPHA_DIGIT: ALPHA + ALPHA.toUpperCase() + DIGIT
};
const generateString = (size = 16, alphabet = ALPHABET.ALPHA_DIGIT) => {
  let str = "";
  const { length } = alphabet;
  const randomValues = new Uint32Array(size);
  require$$8.randomFillSync(randomValues);
  for (let i = 0; i < size; i++) {
    str += alphabet[randomValues[i] % length];
  }
  return str;
};
const platform$1 = {
  isNode: true,
  classes: {
    URLSearchParams: URLSearchParams$1,
    FormData: FormData$1,
    Blob: typeof Blob !== "undefined" && Blob || null
  },
  ALPHABET,
  generateString,
  protocols: ["http", "https", "file", "data"]
};
const hasBrowserEnv = typeof window !== "undefined" && typeof document !== "undefined";
const _navigator = typeof navigator === "object" && navigator || void 0;
const hasStandardBrowserEnv = hasBrowserEnv && (!_navigator || ["ReactNative", "NativeScript", "NS"].indexOf(_navigator.product) < 0);
const hasStandardBrowserWebWorkerEnv = (() => {
  return typeof WorkerGlobalScope !== "undefined" && // eslint-disable-next-line no-undef
  self instanceof WorkerGlobalScope && typeof self.importScripts === "function";
})();
const origin = hasBrowserEnv && window.location.href || "http://localhost";
const utils = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  hasBrowserEnv,
  hasStandardBrowserEnv,
  hasStandardBrowserWebWorkerEnv,
  navigator: _navigator,
  origin
}, Symbol.toStringTag, { value: "Module" }));
const platform = {
  ...utils,
  ...platform$1
};
function toURLEncodedForm(data, options) {
  return toFormData$1(data, new platform.classes.URLSearchParams(), {
    visitor: function(value, key, path, helpers) {
      if (platform.isNode && utils$1.isBuffer(value)) {
        this.append(key, value.toString("base64"));
        return false;
      }
      return helpers.defaultVisitor.apply(this, arguments);
    },
    ...options
  });
}
const MAX_DEPTH = DEFAULT_FORM_DATA_MAX_DEPTH;
function throwIfDepthExceeded(index) {
  if (index > MAX_DEPTH) {
    throw new AxiosError$1(
      "FormData field is too deeply nested (" + index + " levels). Max depth: " + MAX_DEPTH,
      AxiosError$1.ERR_FORM_DATA_DEPTH_EXCEEDED
    );
  }
}
function parsePropPath(name) {
  const path = [];
  const pattern = /[^.[\]]+|\[([^.[\]]*)]/g;
  let match;
  while ((match = pattern.exec(name)) !== null) {
    throwIfDepthExceeded(path.length);
    path.push(match[0] === "[]" ? "" : match[1] || match[0]);
  }
  return path;
}
function arrayToObject(arr) {
  const obj = {};
  const keys = Object.keys(arr);
  let i;
  const len = keys.length;
  let key;
  for (i = 0; i < len; i++) {
    key = keys[i];
    obj[key] = arr[key];
  }
  return obj;
}
function formDataToJSON(formData) {
  function buildPath(path, value, target, index) {
    throwIfDepthExceeded(index);
    let name = path[index++];
    if (name === "__proto__") return true;
    const isNumericKey = Number.isFinite(+name);
    const isLast = index >= path.length;
    name = !name && utils$1.isArray(target) ? target.length : name;
    if (isLast) {
      if (utils$1.hasOwnProp(target, name)) {
        target[name] = utils$1.isArray(target[name]) ? target[name].concat(value) : [target[name], value];
      } else {
        target[name] = value;
      }
      return !isNumericKey;
    }
    if (!utils$1.hasOwnProp(target, name) || !utils$1.isObject(target[name])) {
      target[name] = [];
    }
    const result = buildPath(path, value, target[name], index);
    if (result && utils$1.isArray(target[name])) {
      target[name] = arrayToObject(target[name]);
    }
    return !isNumericKey;
  }
  if (utils$1.isFormData(formData) && utils$1.isFunction(formData.entries)) {
    const obj = {};
    utils$1.forEachEntry(formData, (name, value) => {
      buildPath(parsePropPath(name), value, obj, 0);
    });
    return obj;
  }
  return null;
}
const own = (obj, key) => obj != null && utils$1.hasOwnProp(obj, key) ? obj[key] : void 0;
function stringifySafely(rawValue, parser, encoder) {
  if (utils$1.isString(rawValue)) {
    try {
      (parser || JSON.parse)(rawValue);
      return utils$1.trim(rawValue);
    } catch (e) {
      if (e.name !== "SyntaxError") {
        throw e;
      }
    }
  }
  return (encoder || JSON.stringify)(rawValue);
}
const defaults = {
  transitional: transitionalDefaults,
  adapter: ["xhr", "http", "fetch"],
  transformRequest: [
    function transformRequest(data, headers) {
      const contentType = headers.getContentType() || "";
      const hasJSONContentType = contentType.indexOf("application/json") > -1;
      const isObjectPayload = utils$1.isObject(data);
      if (isObjectPayload && utils$1.isHTMLForm(data)) {
        data = new FormData(data);
      }
      const isFormData2 = utils$1.isFormData(data);
      if (isFormData2) {
        return hasJSONContentType ? JSON.stringify(formDataToJSON(data)) : data;
      }
      if (utils$1.isArrayBuffer(data) || utils$1.isBuffer(data) || utils$1.isStream(data) || utils$1.isFile(data) || utils$1.isBlob(data) || utils$1.isReadableStream(data)) {
        return data;
      }
      if (utils$1.isArrayBufferView(data)) {
        return data.buffer;
      }
      if (utils$1.isURLSearchParams(data)) {
        headers.setContentType("application/x-www-form-urlencoded;charset=utf-8", false);
        return data.toString();
      }
      let isFileList2;
      if (isObjectPayload) {
        const formSerializer = own(this, "formSerializer");
        if (contentType.indexOf("application/x-www-form-urlencoded") > -1) {
          return toURLEncodedForm(data, formSerializer).toString();
        }
        if ((isFileList2 = utils$1.isFileList(data)) || contentType.indexOf("multipart/form-data") > -1) {
          const env2 = own(this, "env");
          const _FormData = env2 && env2.FormData;
          return toFormData$1(
            isFileList2 ? { "files[]": data } : data,
            _FormData && new _FormData(),
            formSerializer
          );
        }
      }
      if (isObjectPayload || hasJSONContentType) {
        headers.setContentType("application/json", false);
        return stringifySafely(data);
      }
      return data;
    }
  ],
  transformResponse: [
    function transformResponse(data) {
      const transitional2 = own(this, "transitional") || defaults.transitional;
      const forcedJSONParsing = transitional2 && transitional2.forcedJSONParsing;
      const responseType = own(this, "responseType");
      const JSONRequested = responseType === "json";
      if (utils$1.isResponse(data) || utils$1.isReadableStream(data)) {
        return data;
      }
      if (data && utils$1.isString(data) && (forcedJSONParsing && !responseType || JSONRequested)) {
        const silentJSONParsing = transitional2 && transitional2.silentJSONParsing;
        const strictJSONParsing = !silentJSONParsing && JSONRequested;
        try {
          return JSON.parse(data, own(this, "parseReviver"));
        } catch (e) {
          if (strictJSONParsing) {
            if (e.name === "SyntaxError") {
              throw AxiosError$1.from(e, AxiosError$1.ERR_BAD_RESPONSE, this, null, own(this, "response"));
            }
            throw e;
          }
        }
      }
      return data;
    }
  ],
  /**
   * A timeout in milliseconds to abort a request. If set to 0 (default) a
   * timeout is not created.
   */
  timeout: 0,
  xsrfCookieName: "XSRF-TOKEN",
  xsrfHeaderName: "X-XSRF-TOKEN",
  maxContentLength: -1,
  maxBodyLength: -1,
  env: {
    FormData: platform.classes.FormData,
    Blob: platform.classes.Blob
  },
  validateStatus: function validateStatus(status) {
    return status >= 200 && status < 300;
  },
  headers: {
    common: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": void 0
    }
  }
};
utils$1.forEach(["delete", "get", "head", "post", "put", "patch", "query"], (method) => {
  defaults.headers[method] = {};
});
function transformData(fns, response) {
  const config = this || defaults;
  const context = response || config;
  const headers = AxiosHeaders$1.from(context.headers);
  let data = context.data;
  utils$1.forEach(fns, function transform(fn) {
    data = fn.call(config, data, headers.normalize(), response ? response.status : void 0);
  });
  headers.normalize();
  return data;
}
function isCancel$1(value) {
  return !!(value && value.__CANCEL__);
}
let CanceledError$1 = class CanceledError extends AxiosError$1 {
  /**
   * A `CanceledError` is an object that is thrown when an operation is canceled.
   *
   * @param {string=} message The message.
   * @param {Object=} config The config.
   * @param {Object=} request The request.
   *
   * @returns {CanceledError} The created error.
   */
  constructor(message, config, request) {
    super(message == null ? "canceled" : message, AxiosError$1.ERR_CANCELED, config, request);
    this.name = "CanceledError";
    this.__CANCEL__ = true;
  }
};
function settle(resolve2, reject, response) {
  const validateStatus2 = response.config.validateStatus;
  if (!response.status || !validateStatus2 || validateStatus2(response.status)) {
    resolve2(response);
  } else {
    reject(new AxiosError$1(
      "Request failed with status code " + response.status,
      response.status >= 400 && response.status < 500 ? AxiosError$1.ERR_BAD_REQUEST : AxiosError$1.ERR_BAD_RESPONSE,
      response.config,
      response.request,
      response
    ));
  }
}
function isAbsoluteURL(url) {
  if (typeof url !== "string") {
    return false;
  }
  return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url);
}
function combineURLs(baseURL, relativeURL) {
  if (!relativeURL) {
    return baseURL;
  }
  let end = baseURL.length;
  while (end > 0 && baseURL.charCodeAt(end - 1) === 47) {
    end--;
  }
  return baseURL.slice(0, end) + "/" + relativeURL.replace(/^\/+/, "");
}
const malformedHttpProtocol = /^https?:(?!\/\/)/i;
const httpProtocolControlCharacters = /[\t\n\r]/g;
function stripLeadingC0ControlOrSpace(url) {
  let i = 0;
  while (i < url.length && url.charCodeAt(i) <= 32) {
    i++;
  }
  return url.slice(i);
}
function normalizeURLForProtocolCheck(url) {
  return stripLeadingC0ControlOrSpace(url).replace(httpProtocolControlCharacters, "");
}
function redactFragment(fragment) {
  if (!fragment) {
    return fragment;
  }
  return fragment.replace(/(^|&)([^=&]*=)?[^&]+/g, (match, separator, parameterName = "") => {
    return `${separator}${parameterName}${REDACTED}`;
  });
}
function redactSensitiveURLParts(url) {
  const redactedURL = url.replace(/^(https?:\/{0,2})[^/?#]*@/i, `$1${REDACTED}@`);
  const fragmentIndex = redactedURL.indexOf("#");
  const urlWithoutFragment = fragmentIndex === -1 ? redactedURL : redactedURL.slice(0, fragmentIndex);
  const redactedURLWithoutFragment = urlWithoutFragment.replace(
    /([?&][^=&#]*=)[^&#]*/g,
    `$1${REDACTED}`
  );
  if (fragmentIndex === -1) {
    return redactedURLWithoutFragment;
  }
  return `${redactedURLWithoutFragment}#${redactFragment(redactedURL.slice(fragmentIndex + 1))}`;
}
function assertValidHttpProtocolURL(url, config) {
  if (typeof url === "string") {
    const normalizedURL = normalizeURLForProtocolCheck(url);
    if (malformedHttpProtocol.test(normalizedURL)) {
      throw new AxiosError$1(
        `Invalid URL ${JSON.stringify(redactSensitiveURLParts(normalizedURL))}: missing "//" after protocol`,
        AxiosError$1.ERR_INVALID_URL,
        config
      );
    }
  }
}
function buildFullPath(baseURL, requestedURL, allowAbsoluteUrls, config) {
  assertValidHttpProtocolURL(requestedURL, config);
  let isRelativeUrl = !isAbsoluteURL(requestedURL);
  if (baseURL && (isRelativeUrl || allowAbsoluteUrls === false)) {
    assertValidHttpProtocolURL(baseURL, config);
    return combineURLs(baseURL, requestedURL);
  }
  return requestedURL;
}
var DEFAULT_PORTS$1 = {
  ftp: 21,
  gopher: 70,
  http: 80,
  https: 443,
  ws: 80,
  wss: 443
};
function parseUrl(urlString) {
  try {
    return new URL(urlString);
  } catch {
    return null;
  }
}
function getProxyForUrl(url) {
  var parsedUrl = (typeof url === "string" ? parseUrl(url) : url) || {};
  var proto = parsedUrl.protocol;
  var hostname2 = parsedUrl.host;
  var port = parsedUrl.port;
  if (typeof hostname2 !== "string" || !hostname2 || typeof proto !== "string") {
    return "";
  }
  proto = proto.split(":", 1)[0];
  hostname2 = hostname2.replace(/:\d*$/, "");
  port = parseInt(port) || DEFAULT_PORTS$1[proto] || 0;
  if (!shouldProxy(hostname2, port)) {
    return "";
  }
  var proxy = getEnv(proto + "_proxy") || getEnv("all_proxy");
  if (proxy && proxy.indexOf("://") === -1) {
    proxy = proto + "://" + proxy;
  }
  return proxy;
}
function shouldProxy(hostname2, port) {
  var NO_PROXY = getEnv("no_proxy").toLowerCase();
  if (!NO_PROXY) {
    return true;
  }
  if (NO_PROXY === "*") {
    return false;
  }
  return NO_PROXY.split(/[,\s]/).every(function(proxy) {
    if (!proxy) {
      return true;
    }
    var parsedProxy = proxy.match(/^(.+):(\d+)$/);
    var parsedProxyHostname = parsedProxy ? parsedProxy[1] : proxy;
    var parsedProxyPort = parsedProxy ? parseInt(parsedProxy[2]) : 0;
    if (parsedProxyPort && parsedProxyPort !== port) {
      return true;
    }
    if (!/^[.*]/.test(parsedProxyHostname)) {
      return hostname2 !== parsedProxyHostname;
    }
    if (parsedProxyHostname.charAt(0) === "*") {
      parsedProxyHostname = parsedProxyHostname.slice(1);
    }
    return !hostname2.endsWith(parsedProxyHostname);
  });
}
function getEnv(key) {
  return process.env[key.toLowerCase()] || process.env[key.toUpperCase()] || "";
}
var agent = {};
var src$1 = { exports: {} };
var browser = { exports: {} };
var ms;
var hasRequiredMs;
function requireMs() {
  if (hasRequiredMs) return ms;
  hasRequiredMs = 1;
  var s = 1e3;
  var m = s * 60;
  var h = m * 60;
  var d = h * 24;
  var w = d * 7;
  var y = d * 365.25;
  ms = function(val, options) {
    options = options || {};
    var type2 = typeof val;
    if (type2 === "string" && val.length > 0) {
      return parse(val);
    } else if (type2 === "number" && isFinite(val)) {
      return options.long ? fmtLong(val) : fmtShort(val);
    }
    throw new Error(
      "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
    );
  };
  function parse(str) {
    str = String(str);
    if (str.length > 100) {
      return;
    }
    var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
      str
    );
    if (!match) {
      return;
    }
    var n = parseFloat(match[1]);
    var type2 = (match[2] || "ms").toLowerCase();
    switch (type2) {
      case "years":
      case "year":
      case "yrs":
      case "yr":
      case "y":
        return n * y;
      case "weeks":
      case "week":
      case "w":
        return n * w;
      case "days":
      case "day":
      case "d":
        return n * d;
      case "hours":
      case "hour":
      case "hrs":
      case "hr":
      case "h":
        return n * h;
      case "minutes":
      case "minute":
      case "mins":
      case "min":
      case "m":
        return n * m;
      case "seconds":
      case "second":
      case "secs":
      case "sec":
      case "s":
        return n * s;
      case "milliseconds":
      case "millisecond":
      case "msecs":
      case "msec":
      case "ms":
        return n;
      default:
        return void 0;
    }
  }
  function fmtShort(ms2) {
    var msAbs = Math.abs(ms2);
    if (msAbs >= d) {
      return Math.round(ms2 / d) + "d";
    }
    if (msAbs >= h) {
      return Math.round(ms2 / h) + "h";
    }
    if (msAbs >= m) {
      return Math.round(ms2 / m) + "m";
    }
    if (msAbs >= s) {
      return Math.round(ms2 / s) + "s";
    }
    return ms2 + "ms";
  }
  function fmtLong(ms2) {
    var msAbs = Math.abs(ms2);
    if (msAbs >= d) {
      return plural(ms2, msAbs, d, "day");
    }
    if (msAbs >= h) {
      return plural(ms2, msAbs, h, "hour");
    }
    if (msAbs >= m) {
      return plural(ms2, msAbs, m, "minute");
    }
    if (msAbs >= s) {
      return plural(ms2, msAbs, s, "second");
    }
    return ms2 + " ms";
  }
  function plural(ms2, msAbs, n, name) {
    var isPlural = msAbs >= n * 1.5;
    return Math.round(ms2 / n) + " " + name + (isPlural ? "s" : "");
  }
  return ms;
}
var common;
var hasRequiredCommon;
function requireCommon() {
  if (hasRequiredCommon) return common;
  hasRequiredCommon = 1;
  function setup(env2) {
    createDebug.debug = createDebug;
    createDebug.default = createDebug;
    createDebug.coerce = coerce;
    createDebug.disable = disable;
    createDebug.enable = enable;
    createDebug.enabled = enabled;
    createDebug.humanize = requireMs();
    createDebug.destroy = destroy;
    Object.keys(env2).forEach((key) => {
      createDebug[key] = env2[key];
    });
    createDebug.names = [];
    createDebug.skips = [];
    createDebug.formatters = {};
    function selectColor(namespace) {
      let hash2 = 0;
      for (let i = 0; i < namespace.length; i++) {
        hash2 = (hash2 << 5) - hash2 + namespace.charCodeAt(i);
        hash2 |= 0;
      }
      return createDebug.colors[Math.abs(hash2) % createDebug.colors.length];
    }
    createDebug.selectColor = selectColor;
    function createDebug(namespace) {
      let prevTime;
      let enableOverride = null;
      let namespacesCache;
      let enabledCache;
      function debug(...args) {
        if (!debug.enabled) {
          return;
        }
        const self2 = debug;
        const curr = Number(/* @__PURE__ */ new Date());
        const ms2 = curr - (prevTime || curr);
        self2.diff = ms2;
        self2.prev = prevTime;
        self2.curr = curr;
        prevTime = curr;
        args[0] = createDebug.coerce(args[0]);
        if (typeof args[0] !== "string") {
          args.unshift("%O");
        }
        let index = 0;
        args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format) => {
          if (match === "%%") {
            return "%";
          }
          index++;
          const formatter = createDebug.formatters[format];
          if (typeof formatter === "function") {
            const val = args[index];
            match = formatter.call(self2, val);
            args.splice(index, 1);
            index--;
          }
          return match;
        });
        createDebug.formatArgs.call(self2, args);
        const logFn = self2.log || createDebug.log;
        logFn.apply(self2, args);
      }
      debug.namespace = namespace;
      debug.useColors = createDebug.useColors();
      debug.color = createDebug.selectColor(namespace);
      debug.extend = extend2;
      debug.destroy = createDebug.destroy;
      Object.defineProperty(debug, "enabled", {
        enumerable: true,
        configurable: false,
        get: () => {
          if (enableOverride !== null) {
            return enableOverride;
          }
          if (namespacesCache !== createDebug.namespaces) {
            namespacesCache = createDebug.namespaces;
            enabledCache = createDebug.enabled(namespace);
          }
          return enabledCache;
        },
        set: (v) => {
          enableOverride = v;
        }
      });
      if (typeof createDebug.init === "function") {
        createDebug.init(debug);
      }
      return debug;
    }
    function extend2(namespace, delimiter) {
      const newDebug = createDebug(this.namespace + (typeof delimiter === "undefined" ? ":" : delimiter) + namespace);
      newDebug.log = this.log;
      return newDebug;
    }
    function enable(namespaces) {
      createDebug.save(namespaces);
      createDebug.namespaces = namespaces;
      createDebug.names = [];
      createDebug.skips = [];
      const split = (typeof namespaces === "string" ? namespaces : "").trim().replace(/\s+/g, ",").split(",").filter(Boolean);
      for (const ns of split) {
        if (ns[0] === "-") {
          createDebug.skips.push(ns.slice(1));
        } else {
          createDebug.names.push(ns);
        }
      }
    }
    function matchesTemplate(search, template) {
      let searchIndex = 0;
      let templateIndex = 0;
      let starIndex = -1;
      let matchIndex = 0;
      while (searchIndex < search.length) {
        if (templateIndex < template.length && (template[templateIndex] === search[searchIndex] || template[templateIndex] === "*")) {
          if (template[templateIndex] === "*") {
            starIndex = templateIndex;
            matchIndex = searchIndex;
            templateIndex++;
          } else {
            searchIndex++;
            templateIndex++;
          }
        } else if (starIndex !== -1) {
          templateIndex = starIndex + 1;
          matchIndex++;
          searchIndex = matchIndex;
        } else {
          return false;
        }
      }
      while (templateIndex < template.length && template[templateIndex] === "*") {
        templateIndex++;
      }
      return templateIndex === template.length;
    }
    function disable() {
      const namespaces = [
        ...createDebug.names,
        ...createDebug.skips.map((namespace) => "-" + namespace)
      ].join(",");
      createDebug.enable("");
      return namespaces;
    }
    function enabled(name) {
      for (const skip of createDebug.skips) {
        if (matchesTemplate(name, skip)) {
          return false;
        }
      }
      for (const ns of createDebug.names) {
        if (matchesTemplate(name, ns)) {
          return true;
        }
      }
      return false;
    }
    function coerce(val) {
      if (val instanceof Error) {
        return val.stack || val.message;
      }
      return val;
    }
    function destroy() {
      console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
    }
    createDebug.enable(createDebug.load());
    return createDebug;
  }
  common = setup;
  return common;
}
var hasRequiredBrowser;
function requireBrowser() {
  if (hasRequiredBrowser) return browser.exports;
  hasRequiredBrowser = 1;
  (function(module, exports) {
    exports.formatArgs = formatArgs;
    exports.save = save;
    exports.load = load;
    exports.useColors = useColors;
    exports.storage = localstorage();
    exports.destroy = /* @__PURE__ */ (() => {
      let warned = false;
      return () => {
        if (!warned) {
          warned = true;
          console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
        }
      };
    })();
    exports.colors = [
      "#0000CC",
      "#0000FF",
      "#0033CC",
      "#0033FF",
      "#0066CC",
      "#0066FF",
      "#0099CC",
      "#0099FF",
      "#00CC00",
      "#00CC33",
      "#00CC66",
      "#00CC99",
      "#00CCCC",
      "#00CCFF",
      "#3300CC",
      "#3300FF",
      "#3333CC",
      "#3333FF",
      "#3366CC",
      "#3366FF",
      "#3399CC",
      "#3399FF",
      "#33CC00",
      "#33CC33",
      "#33CC66",
      "#33CC99",
      "#33CCCC",
      "#33CCFF",
      "#6600CC",
      "#6600FF",
      "#6633CC",
      "#6633FF",
      "#66CC00",
      "#66CC33",
      "#9900CC",
      "#9900FF",
      "#9933CC",
      "#9933FF",
      "#99CC00",
      "#99CC33",
      "#CC0000",
      "#CC0033",
      "#CC0066",
      "#CC0099",
      "#CC00CC",
      "#CC00FF",
      "#CC3300",
      "#CC3333",
      "#CC3366",
      "#CC3399",
      "#CC33CC",
      "#CC33FF",
      "#CC6600",
      "#CC6633",
      "#CC9900",
      "#CC9933",
      "#CCCC00",
      "#CCCC33",
      "#FF0000",
      "#FF0033",
      "#FF0066",
      "#FF0099",
      "#FF00CC",
      "#FF00FF",
      "#FF3300",
      "#FF3333",
      "#FF3366",
      "#FF3399",
      "#FF33CC",
      "#FF33FF",
      "#FF6600",
      "#FF6633",
      "#FF9900",
      "#FF9933",
      "#FFCC00",
      "#FFCC33"
    ];
    function useColors() {
      if (typeof window !== "undefined" && window.process && (window.process.type === "renderer" || window.process.__nwjs)) {
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
        return false;
      }
      let m;
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // Is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // Is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && (m = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) && parseInt(m[1], 10) >= 31 || // Double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    function formatArgs(args) {
      args[0] = (this.useColors ? "%c" : "") + this.namespace + (this.useColors ? " %c" : " ") + args[0] + (this.useColors ? "%c " : " ") + "+" + module.exports.humanize(this.diff);
      if (!this.useColors) {
        return;
      }
      const c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      let index = 0;
      let lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, (match) => {
        if (match === "%%") {
          return;
        }
        index++;
        if (match === "%c") {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    exports.log = console.debug || console.log || (() => {
    });
    function save(namespaces) {
      try {
        if (namespaces) {
          exports.storage.setItem("debug", namespaces);
        } else {
          exports.storage.removeItem("debug");
        }
      } catch (error) {
      }
    }
    function load() {
      let r;
      try {
        r = exports.storage.getItem("debug") || exports.storage.getItem("DEBUG");
      } catch (error) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    function localstorage() {
      try {
        return localStorage;
      } catch (error) {
      }
    }
    module.exports = requireCommon()(exports);
    const { formatters } = module.exports;
    formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (error) {
        return "[UnexpectedJSONParseError]: " + error.message;
      }
    };
  })(browser, browser.exports);
  return browser.exports;
}
var node = { exports: {} };
var hasFlag;
var hasRequiredHasFlag;
function requireHasFlag() {
  if (hasRequiredHasFlag) return hasFlag;
  hasRequiredHasFlag = 1;
  hasFlag = (flag, argv = process.argv) => {
    const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
    const position = argv.indexOf(prefix + flag);
    const terminatorPosition = argv.indexOf("--");
    return position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);
  };
  return hasFlag;
}
var supportsColor_1;
var hasRequiredSupportsColor;
function requireSupportsColor() {
  if (hasRequiredSupportsColor) return supportsColor_1;
  hasRequiredSupportsColor = 1;
  const os = require$$0$1;
  const tty = require$$1$2;
  const hasFlag2 = requireHasFlag();
  const { env: env2 } = process;
  let flagForceColor;
  if (hasFlag2("no-color") || hasFlag2("no-colors") || hasFlag2("color=false") || hasFlag2("color=never")) {
    flagForceColor = 0;
  } else if (hasFlag2("color") || hasFlag2("colors") || hasFlag2("color=true") || hasFlag2("color=always")) {
    flagForceColor = 1;
  }
  function envForceColor() {
    if ("FORCE_COLOR" in env2) {
      if (env2.FORCE_COLOR === "true") {
        return 1;
      }
      if (env2.FORCE_COLOR === "false") {
        return 0;
      }
      return env2.FORCE_COLOR.length === 0 ? 1 : Math.min(Number.parseInt(env2.FORCE_COLOR, 10), 3);
    }
  }
  function translateLevel(level) {
    if (level === 0) {
      return false;
    }
    return {
      level,
      hasBasic: true,
      has256: level >= 2,
      has16m: level >= 3
    };
  }
  function supportsColor(haveStream, { streamIsTTY, sniffFlags = true } = {}) {
    const noFlagForceColor = envForceColor();
    if (noFlagForceColor !== void 0) {
      flagForceColor = noFlagForceColor;
    }
    const forceColor = sniffFlags ? flagForceColor : noFlagForceColor;
    if (forceColor === 0) {
      return 0;
    }
    if (sniffFlags) {
      if (hasFlag2("color=16m") || hasFlag2("color=full") || hasFlag2("color=truecolor")) {
        return 3;
      }
      if (hasFlag2("color=256")) {
        return 2;
      }
    }
    if (haveStream && !streamIsTTY && forceColor === void 0) {
      return 0;
    }
    const min2 = forceColor || 0;
    if (env2.TERM === "dumb") {
      return min2;
    }
    if (process.platform === "win32") {
      const osRelease = os.release().split(".");
      if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
        return Number(osRelease[2]) >= 14931 ? 3 : 2;
      }
      return 1;
    }
    if ("CI" in env2) {
      if (["TRAVIS", "CIRCLECI", "APPVEYOR", "GITLAB_CI", "GITHUB_ACTIONS", "BUILDKITE", "DRONE"].some((sign2) => sign2 in env2) || env2.CI_NAME === "codeship") {
        return 1;
      }
      return min2;
    }
    if ("TEAMCITY_VERSION" in env2) {
      return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env2.TEAMCITY_VERSION) ? 1 : 0;
    }
    if (env2.COLORTERM === "truecolor") {
      return 3;
    }
    if ("TERM_PROGRAM" in env2) {
      const version = Number.parseInt((env2.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
      switch (env2.TERM_PROGRAM) {
        case "iTerm.app":
          return version >= 3 ? 3 : 2;
        case "Apple_Terminal":
          return 2;
      }
    }
    if (/-256(color)?$/i.test(env2.TERM)) {
      return 2;
    }
    if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env2.TERM)) {
      return 1;
    }
    if ("COLORTERM" in env2) {
      return 1;
    }
    return min2;
  }
  function getSupportLevel(stream2, options = {}) {
    const level = supportsColor(stream2, {
      streamIsTTY: stream2 && stream2.isTTY,
      ...options
    });
    return translateLevel(level);
  }
  supportsColor_1 = {
    supportsColor: getSupportLevel,
    stdout: getSupportLevel({ isTTY: tty.isatty(1) }),
    stderr: getSupportLevel({ isTTY: tty.isatty(2) })
  };
  return supportsColor_1;
}
var hasRequiredNode;
function requireNode() {
  if (hasRequiredNode) return node.exports;
  hasRequiredNode = 1;
  (function(module, exports) {
    const tty = require$$1$2;
    const util = require$$1;
    exports.init = init;
    exports.log = log2;
    exports.formatArgs = formatArgs;
    exports.save = save;
    exports.load = load;
    exports.useColors = useColors;
    exports.destroy = util.deprecate(
      () => {
      },
      "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
    );
    exports.colors = [6, 2, 3, 4, 5, 1];
    try {
      const supportsColor = requireSupportsColor();
      if (supportsColor && (supportsColor.stderr || supportsColor).level >= 2) {
        exports.colors = [
          20,
          21,
          26,
          27,
          32,
          33,
          38,
          39,
          40,
          41,
          42,
          43,
          44,
          45,
          56,
          57,
          62,
          63,
          68,
          69,
          74,
          75,
          76,
          77,
          78,
          79,
          80,
          81,
          92,
          93,
          98,
          99,
          112,
          113,
          128,
          129,
          134,
          135,
          148,
          149,
          160,
          161,
          162,
          163,
          164,
          165,
          166,
          167,
          168,
          169,
          170,
          171,
          172,
          173,
          178,
          179,
          184,
          185,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          214,
          215,
          220,
          221
        ];
      }
    } catch (error) {
    }
    exports.inspectOpts = Object.keys(process.env).filter((key) => {
      return /^debug_/i.test(key);
    }).reduce((obj, key) => {
      const prop = key.substring(6).toLowerCase().replace(/_([a-z])/g, (_, k) => {
        return k.toUpperCase();
      });
      let val = process.env[key];
      if (/^(yes|on|true|enabled)$/i.test(val)) {
        val = true;
      } else if (/^(no|off|false|disabled)$/i.test(val)) {
        val = false;
      } else if (val === "null") {
        val = null;
      } else {
        val = Number(val);
      }
      obj[prop] = val;
      return obj;
    }, {});
    function useColors() {
      return "colors" in exports.inspectOpts ? Boolean(exports.inspectOpts.colors) : tty.isatty(process.stderr.fd);
    }
    function formatArgs(args) {
      const { namespace: name, useColors: useColors2 } = this;
      if (useColors2) {
        const c = this.color;
        const colorCode = "\x1B[3" + (c < 8 ? c : "8;5;" + c);
        const prefix = `  ${colorCode};1m${name} \x1B[0m`;
        args[0] = prefix + args[0].split("\n").join("\n" + prefix);
        args.push(colorCode + "m+" + module.exports.humanize(this.diff) + "\x1B[0m");
      } else {
        args[0] = getDate() + name + " " + args[0];
      }
    }
    function getDate() {
      if (exports.inspectOpts.hideDate) {
        return "";
      }
      return (/* @__PURE__ */ new Date()).toISOString() + " ";
    }
    function log2(...args) {
      return process.stderr.write(util.formatWithOptions(exports.inspectOpts, ...args) + "\n");
    }
    function save(namespaces) {
      if (namespaces) {
        process.env.DEBUG = namespaces;
      } else {
        delete process.env.DEBUG;
      }
    }
    function load() {
      return process.env.DEBUG;
    }
    function init(debug) {
      debug.inspectOpts = {};
      const keys = Object.keys(exports.inspectOpts);
      for (let i = 0; i < keys.length; i++) {
        debug.inspectOpts[keys[i]] = exports.inspectOpts[keys[i]];
      }
    }
    module.exports = requireCommon()(exports);
    const { formatters } = module.exports;
    formatters.o = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts).split("\n").map((str) => str.trim()).join(" ");
    };
    formatters.O = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts);
    };
  })(node, node.exports);
  return node.exports;
}
var hasRequiredSrc$1;
function requireSrc$1() {
  if (hasRequiredSrc$1) return src$1.exports;
  hasRequiredSrc$1 = 1;
  if (typeof process === "undefined" || process.type === "renderer" || process.browser === true || process.__nwjs) {
    src$1.exports = requireBrowser();
  } else {
    src$1.exports = requireNode();
  }
  return src$1.exports;
}
var promisify = {};
var hasRequiredPromisify;
function requirePromisify() {
  if (hasRequiredPromisify) return promisify;
  hasRequiredPromisify = 1;
  Object.defineProperty(promisify, "__esModule", { value: true });
  function promisify$1(fn) {
    return function(req, opts) {
      return new Promise((resolve2, reject) => {
        fn.call(this, req, opts, (err, rtn) => {
          if (err) {
            reject(err);
          } else {
            resolve2(rtn);
          }
        });
      });
    };
  }
  promisify.default = promisify$1;
  return promisify;
}
var src;
var hasRequiredSrc;
function requireSrc() {
  if (hasRequiredSrc) return src;
  hasRequiredSrc = 1;
  var __importDefault = src && src.__importDefault || function(mod) {
    return mod && mod.__esModule ? mod : { "default": mod };
  };
  const events_1 = require$$0$2;
  const debug_12 = __importDefault(requireSrc$1());
  const promisify_1 = __importDefault(requirePromisify());
  const debug = debug_12.default("agent-base");
  function isAgent(v) {
    return Boolean(v) && typeof v.addRequest === "function";
  }
  function isSecureEndpoint() {
    const { stack } = new Error();
    if (typeof stack !== "string")
      return false;
    return stack.split("\n").some((l) => l.indexOf("(https.js:") !== -1 || l.indexOf("node:https:") !== -1);
  }
  function createAgent(callback, opts) {
    return new createAgent.Agent(callback, opts);
  }
  (function(createAgent2) {
    class Agent extends events_1.EventEmitter {
      constructor(callback, _opts) {
        super();
        let opts = _opts;
        if (typeof callback === "function") {
          this.callback = callback;
        } else if (callback) {
          opts = callback;
        }
        this.timeout = null;
        if (opts && typeof opts.timeout === "number") {
          this.timeout = opts.timeout;
        }
        this.maxFreeSockets = 1;
        this.maxSockets = 1;
        this.maxTotalSockets = Infinity;
        this.sockets = {};
        this.freeSockets = {};
        this.requests = {};
        this.options = {};
      }
      get defaultPort() {
        if (typeof this.explicitDefaultPort === "number") {
          return this.explicitDefaultPort;
        }
        return isSecureEndpoint() ? 443 : 80;
      }
      set defaultPort(v) {
        this.explicitDefaultPort = v;
      }
      get protocol() {
        if (typeof this.explicitProtocol === "string") {
          return this.explicitProtocol;
        }
        return isSecureEndpoint() ? "https:" : "http:";
      }
      set protocol(v) {
        this.explicitProtocol = v;
      }
      callback(req, opts, fn) {
        throw new Error('"agent-base" has no default implementation, you must subclass and override `callback()`');
      }
      /**
       * Called by node-core's "_http_client.js" module when creating
       * a new HTTP request with this Agent instance.
       *
       * @api public
       */
      addRequest(req, _opts) {
        const opts = Object.assign({}, _opts);
        if (typeof opts.secureEndpoint !== "boolean") {
          opts.secureEndpoint = isSecureEndpoint();
        }
        if (opts.host == null) {
          opts.host = "localhost";
        }
        if (opts.port == null) {
          opts.port = opts.secureEndpoint ? 443 : 80;
        }
        if (opts.protocol == null) {
          opts.protocol = opts.secureEndpoint ? "https:" : "http:";
        }
        if (opts.host && opts.path) {
          delete opts.path;
        }
        delete opts.agent;
        delete opts.hostname;
        delete opts._defaultAgent;
        delete opts.defaultPort;
        delete opts.createConnection;
        req._last = true;
        req.shouldKeepAlive = false;
        let timedOut = false;
        let timeoutId = null;
        const timeoutMs = opts.timeout || this.timeout;
        const onerror = (err) => {
          if (req._hadError)
            return;
          req.emit("error", err);
          req._hadError = true;
        };
        const ontimeout = () => {
          timeoutId = null;
          timedOut = true;
          const err = new Error(`A "socket" was not created for HTTP request before ${timeoutMs}ms`);
          err.code = "ETIMEOUT";
          onerror(err);
        };
        const callbackError = (err) => {
          if (timedOut)
            return;
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          onerror(err);
        };
        const onsocket = (socket) => {
          if (timedOut)
            return;
          if (timeoutId != null) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          if (isAgent(socket)) {
            debug("Callback returned another Agent instance %o", socket.constructor.name);
            socket.addRequest(req, opts);
            return;
          }
          if (socket) {
            socket.once("free", () => {
              this.freeSocket(socket, opts);
            });
            req.onSocket(socket);
            return;
          }
          const err = new Error(`no Duplex stream was returned to agent-base for \`${req.method} ${req.path}\``);
          onerror(err);
        };
        if (typeof this.callback !== "function") {
          onerror(new Error("`callback` is not defined"));
          return;
        }
        if (!this.promisifiedCallback) {
          if (this.callback.length >= 3) {
            debug("Converting legacy callback function to promise");
            this.promisifiedCallback = promisify_1.default(this.callback);
          } else {
            this.promisifiedCallback = this.callback;
          }
        }
        if (typeof timeoutMs === "number" && timeoutMs > 0) {
          timeoutId = setTimeout(ontimeout, timeoutMs);
        }
        if ("port" in opts && typeof opts.port !== "number") {
          opts.port = Number(opts.port);
        }
        try {
          debug("Resolving socket for %o request: %o", opts.protocol, `${req.method} ${req.path}`);
          Promise.resolve(this.promisifiedCallback(req, opts)).then(onsocket, callbackError);
        } catch (err) {
          Promise.reject(err).catch(callbackError);
        }
      }
      freeSocket(socket, opts) {
        debug("Freeing socket %o %o", socket.constructor.name, opts);
        socket.destroy();
      }
      destroy() {
        debug("Destroying agent %o", this.constructor.name);
      }
    }
    createAgent2.Agent = Agent;
    createAgent2.prototype = createAgent2.Agent.prototype;
  })(createAgent || (createAgent = {}));
  src = createAgent;
  return src;
}
var parseProxyResponse = {};
var hasRequiredParseProxyResponse;
function requireParseProxyResponse() {
  if (hasRequiredParseProxyResponse) return parseProxyResponse;
  hasRequiredParseProxyResponse = 1;
  var __importDefault = parseProxyResponse && parseProxyResponse.__importDefault || function(mod) {
    return mod && mod.__esModule ? mod : { "default": mod };
  };
  Object.defineProperty(parseProxyResponse, "__esModule", { value: true });
  const debug_12 = __importDefault(requireSrc$1());
  const debug = debug_12.default("https-proxy-agent:parse-proxy-response");
  function parseProxyResponse$1(socket) {
    return new Promise((resolve2, reject) => {
      let buffersLength = 0;
      const buffers = [];
      function read() {
        const b = socket.read();
        if (b)
          ondata(b);
        else
          socket.once("readable", read);
      }
      function cleanup() {
        socket.removeListener("end", onend);
        socket.removeListener("error", onerror);
        socket.removeListener("close", onclose);
        socket.removeListener("readable", read);
      }
      function onclose(err) {
        debug("onclose had error %o", err);
      }
      function onend() {
        debug("onend");
      }
      function onerror(err) {
        cleanup();
        debug("onerror %o", err);
        reject(err);
      }
      function ondata(b) {
        buffers.push(b);
        buffersLength += b.length;
        const buffered = Buffer.concat(buffers, buffersLength);
        const endOfHeaders = buffered.indexOf("\r\n\r\n");
        if (endOfHeaders === -1) {
          debug("have not received end of HTTP headers yet...");
          read();
          return;
        }
        const firstLine = buffered.toString("ascii", 0, buffered.indexOf("\r\n"));
        const statusCode = +firstLine.split(" ")[1];
        debug("got proxy server response: %o", firstLine);
        resolve2({
          statusCode,
          buffered
        });
      }
      socket.on("error", onerror);
      socket.on("close", onclose);
      socket.on("end", onend);
      read();
    });
  }
  parseProxyResponse.default = parseProxyResponse$1;
  return parseProxyResponse;
}
var hasRequiredAgent;
function requireAgent() {
  if (hasRequiredAgent) return agent;
  hasRequiredAgent = 1;
  var __awaiter = agent && agent.__awaiter || function(thisArg, _arguments, P, generator) {
    function adopt(value) {
      return value instanceof P ? value : new P(function(resolve2) {
        resolve2(value);
      });
    }
    return new (P || (P = Promise))(function(resolve2, reject) {
      function fulfilled(value) {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      }
      function rejected(value) {
        try {
          step(generator["throw"](value));
        } catch (e) {
          reject(e);
        }
      }
      function step(result) {
        result.done ? resolve2(result.value) : adopt(result.value).then(fulfilled, rejected);
      }
      step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
  };
  var __importDefault = agent && agent.__importDefault || function(mod) {
    return mod && mod.__esModule ? mod : { "default": mod };
  };
  Object.defineProperty(agent, "__esModule", { value: true });
  const net_1 = __importDefault(require$$0$3);
  const tls_1 = __importDefault(require$$1$3);
  const url_1 = __importDefault(require$$5);
  const assert_1 = __importDefault(require$$3);
  const debug_12 = __importDefault(requireSrc$1());
  const agent_base_1 = requireSrc();
  const parse_proxy_response_1 = __importDefault(requireParseProxyResponse());
  const debug = debug_12.default("https-proxy-agent:agent");
  class HttpsProxyAgent2 extends agent_base_1.Agent {
    constructor(_opts) {
      let opts;
      if (typeof _opts === "string") {
        opts = url_1.default.parse(_opts);
      } else {
        opts = _opts;
      }
      if (!opts) {
        throw new Error("an HTTP(S) proxy server `host` and `port` must be specified!");
      }
      debug("creating new HttpsProxyAgent instance: %o", opts);
      super(opts);
      const proxy = Object.assign({}, opts);
      this.secureProxy = opts.secureProxy || isHTTPS(proxy.protocol);
      proxy.host = proxy.hostname || proxy.host;
      if (typeof proxy.port === "string") {
        proxy.port = parseInt(proxy.port, 10);
      }
      if (!proxy.port && proxy.host) {
        proxy.port = this.secureProxy ? 443 : 80;
      }
      if (this.secureProxy && !("ALPNProtocols" in proxy)) {
        proxy.ALPNProtocols = ["http 1.1"];
      }
      if (proxy.host && proxy.path) {
        delete proxy.path;
        delete proxy.pathname;
      }
      this.proxy = proxy;
    }
    /**
     * Called when the node-core HTTP client library is creating a
     * new HTTP request.
     *
     * @api protected
     */
    callback(req, opts) {
      return __awaiter(this, void 0, void 0, function* () {
        const { proxy, secureProxy } = this;
        let socket;
        if (secureProxy) {
          debug("Creating `tls.Socket`: %o", proxy);
          socket = tls_1.default.connect(proxy);
        } else {
          debug("Creating `net.Socket`: %o", proxy);
          socket = net_1.default.connect(proxy);
        }
        const headers = Object.assign({}, proxy.headers);
        const hostname2 = `${opts.host}:${opts.port}`;
        let payload = `CONNECT ${hostname2} HTTP/1.1\r
`;
        if (proxy.auth) {
          headers["Proxy-Authorization"] = `Basic ${Buffer.from(proxy.auth).toString("base64")}`;
        }
        let { host, port, secureEndpoint } = opts;
        if (!isDefaultPort(port, secureEndpoint)) {
          host += `:${port}`;
        }
        headers.Host = host;
        headers.Connection = "close";
        for (const name of Object.keys(headers)) {
          payload += `${name}: ${headers[name]}\r
`;
        }
        const proxyResponsePromise = parse_proxy_response_1.default(socket);
        socket.write(`${payload}\r
`);
        const { statusCode, buffered } = yield proxyResponsePromise;
        if (statusCode === 200) {
          req.once("socket", resume);
          if (opts.secureEndpoint) {
            debug("Upgrading socket connection to TLS");
            const servername = opts.servername || opts.host;
            return tls_1.default.connect(Object.assign(Object.assign({}, omit(opts, "host", "hostname", "path", "port")), {
              socket,
              servername
            }));
          }
          return socket;
        }
        socket.destroy();
        const fakeSocket = new net_1.default.Socket({ writable: false });
        fakeSocket.readable = true;
        req.once("socket", (s) => {
          debug("replaying proxy buffer for failed request");
          assert_1.default(s.listenerCount("data") > 0);
          s.push(buffered);
          s.push(null);
        });
        return fakeSocket;
      });
    }
  }
  agent.default = HttpsProxyAgent2;
  function resume(socket) {
    socket.resume();
  }
  function isDefaultPort(port, secure) {
    return Boolean(!secure && port === 80 || secure && port === 443);
  }
  function isHTTPS(protocol2) {
    return typeof protocol2 === "string" ? /^https:?$/i.test(protocol2) : false;
  }
  function omit(obj, ...keys) {
    const ret = {};
    let key;
    for (key in obj) {
      if (!keys.includes(key)) {
        ret[key] = obj[key];
      }
    }
    return ret;
  }
  return agent;
}
var dist;
var hasRequiredDist;
function requireDist() {
  if (hasRequiredDist) return dist;
  hasRequiredDist = 1;
  var __importDefault = dist && dist.__importDefault || function(mod) {
    return mod && mod.__esModule ? mod : { "default": mod };
  };
  const agent_1 = __importDefault(requireAgent());
  function createHttpsProxyAgent(opts) {
    return new agent_1.default(opts);
  }
  (function(createHttpsProxyAgent2) {
    createHttpsProxyAgent2.HttpsProxyAgent = agent_1.default;
    createHttpsProxyAgent2.prototype = agent_1.default.prototype;
  })(createHttpsProxyAgent || (createHttpsProxyAgent = {}));
  dist = createHttpsProxyAgent;
  return dist;
}
var distExports = requireDist();
const HttpsProxyAgent = /* @__PURE__ */ getDefaultExportFromCjs(distExports);
var followRedirects$1 = { exports: {} };
var debug_1;
var hasRequiredDebug;
function requireDebug() {
  if (hasRequiredDebug) return debug_1;
  hasRequiredDebug = 1;
  var debug;
  debug_1 = function() {
    if (!debug) {
      try {
        debug = requireSrc$1()("follow-redirects");
      } catch (error) {
      }
      if (typeof debug !== "function") {
        debug = function() {
        };
      }
    }
    debug.apply(null, arguments);
  };
  return debug_1;
}
var hasRequiredFollowRedirects;
function requireFollowRedirects() {
  if (hasRequiredFollowRedirects) return followRedirects$1.exports;
  hasRequiredFollowRedirects = 1;
  var url = require$$5;
  var URL2 = url.URL;
  var http3 = http$a;
  var https$1 = https;
  var Writable = stream.Writable;
  var assert = require$$3;
  var debug = requireDebug();
  (function detectUnsupportedEnvironment() {
    var looksLikeNode = typeof process !== "undefined";
    var looksLikeBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    var looksLikeV8 = isFunction2(Error.captureStackTrace);
    if (!looksLikeNode && (looksLikeBrowser || !looksLikeV8)) {
      console.warn("The follow-redirects package should be excluded from browser builds.");
    }
  })();
  var useNativeURL = false;
  try {
    assert(new URL2(""));
  } catch (error) {
    useNativeURL = error.code === "ERR_INVALID_URL";
  }
  var sensitiveHeaders = [
    "Authorization",
    "Proxy-Authorization",
    "Cookie"
  ];
  var preservedUrlFields = [
    "auth",
    "host",
    "hostname",
    "href",
    "path",
    "pathname",
    "port",
    "protocol",
    "query",
    "search",
    "hash"
  ];
  var events = ["abort", "aborted", "connect", "error", "socket", "timeout"];
  var eventHandlers = /* @__PURE__ */ Object.create(null);
  events.forEach(function(event) {
    eventHandlers[event] = function(arg1, arg2, arg3) {
      this._redirectable.emit(event, arg1, arg2, arg3);
    };
  });
  var InvalidUrlError = createErrorType(
    "ERR_INVALID_URL",
    "Invalid URL",
    TypeError
  );
  var RedirectionError = createErrorType(
    "ERR_FR_REDIRECTION_FAILURE",
    "Redirected request failed"
  );
  var TooManyRedirectsError = createErrorType(
    "ERR_FR_TOO_MANY_REDIRECTS",
    "Maximum number of redirects exceeded",
    RedirectionError
  );
  var MaxBodyLengthExceededError = createErrorType(
    "ERR_FR_MAX_BODY_LENGTH_EXCEEDED",
    "Request body larger than maxBodyLength limit"
  );
  var WriteAfterEndError = createErrorType(
    "ERR_STREAM_WRITE_AFTER_END",
    "write after end"
  );
  var destroy = Writable.prototype.destroy || noop2;
  function RedirectableRequest(options, responseCallback) {
    Writable.call(this);
    this._sanitizeOptions(options);
    this._options = options;
    this._ended = false;
    this._ending = false;
    this._redirectCount = 0;
    this._redirects = [];
    this._requestBodyLength = 0;
    this._requestBodyBuffers = [];
    if (responseCallback) {
      this.on("response", responseCallback);
    }
    var self2 = this;
    this._onNativeResponse = function(response) {
      try {
        self2._processResponse(response);
      } catch (cause) {
        self2.emit("error", cause instanceof RedirectionError ? cause : new RedirectionError({ cause }));
      }
    };
    this._headerFilter = new RegExp("^(?:" + sensitiveHeaders.concat(options.sensitiveHeaders).map(escapeRegex).join("|") + ")$", "i");
    this._performRequest();
  }
  RedirectableRequest.prototype = Object.create(Writable.prototype);
  RedirectableRequest.prototype.abort = function() {
    destroyRequest(this._currentRequest);
    this._currentRequest.abort();
    this.emit("abort");
  };
  RedirectableRequest.prototype.destroy = function(error) {
    destroyRequest(this._currentRequest, error);
    destroy.call(this, error);
    return this;
  };
  RedirectableRequest.prototype.write = function(data, encoding, callback) {
    if (this._ending) {
      throw new WriteAfterEndError();
    }
    if (!isString2(data) && !isBuffer2(data)) {
      throw new TypeError("data should be a string, Buffer or Uint8Array");
    }
    if (isFunction2(encoding)) {
      callback = encoding;
      encoding = null;
    }
    if (data.length === 0) {
      if (callback) {
        callback();
      }
      return;
    }
    if (this._requestBodyLength + data.length <= this._options.maxBodyLength) {
      this._requestBodyLength += data.length;
      this._requestBodyBuffers.push({ data, encoding });
      this._currentRequest.write(data, encoding, callback);
    } else {
      this.emit("error", new MaxBodyLengthExceededError());
      this.abort();
    }
  };
  RedirectableRequest.prototype.end = function(data, encoding, callback) {
    if (isFunction2(data)) {
      callback = data;
      data = encoding = null;
    } else if (isFunction2(encoding)) {
      callback = encoding;
      encoding = null;
    }
    if (!data) {
      this._ended = this._ending = true;
      this._currentRequest.end(null, null, callback);
    } else {
      var self2 = this;
      var currentRequest = this._currentRequest;
      this.write(data, encoding, function() {
        self2._ended = true;
        currentRequest.end(null, null, callback);
      });
      this._ending = true;
    }
  };
  RedirectableRequest.prototype.setHeader = function(name, value) {
    this._options.headers[name] = value;
    this._currentRequest.setHeader(name, value);
  };
  RedirectableRequest.prototype.removeHeader = function(name) {
    delete this._options.headers[name];
    this._currentRequest.removeHeader(name);
  };
  RedirectableRequest.prototype.setTimeout = function(msecs, callback) {
    var self2 = this;
    function destroyOnTimeout(socket) {
      socket.setTimeout(msecs);
      socket.removeListener("timeout", socket.destroy);
      socket.addListener("timeout", socket.destroy);
    }
    function startTimer(socket) {
      if (self2._timeout) {
        clearTimeout(self2._timeout);
      }
      self2._timeout = setTimeout(function() {
        self2.emit("timeout");
        clearTimer();
      }, msecs);
      destroyOnTimeout(socket);
    }
    function clearTimer() {
      if (self2._timeout) {
        clearTimeout(self2._timeout);
        self2._timeout = null;
      }
      self2.removeListener("abort", clearTimer);
      self2.removeListener("error", clearTimer);
      self2.removeListener("response", clearTimer);
      self2.removeListener("close", clearTimer);
      if (callback) {
        self2.removeListener("timeout", callback);
      }
      if (!self2.socket) {
        self2._currentRequest.removeListener("socket", startTimer);
      }
    }
    if (callback) {
      this.on("timeout", callback);
    }
    if (this.socket) {
      startTimer(this.socket);
    } else {
      this._currentRequest.once("socket", startTimer);
    }
    this.on("socket", destroyOnTimeout);
    this.on("abort", clearTimer);
    this.on("error", clearTimer);
    this.on("response", clearTimer);
    this.on("close", clearTimer);
    return this;
  };
  [
    "flushHeaders",
    "getHeader",
    "setNoDelay",
    "setSocketKeepAlive"
  ].forEach(function(method) {
    RedirectableRequest.prototype[method] = function(a, b) {
      return this._currentRequest[method](a, b);
    };
  });
  ["aborted", "connection", "socket"].forEach(function(property) {
    Object.defineProperty(RedirectableRequest.prototype, property, {
      get: function() {
        return this._currentRequest[property];
      }
    });
  });
  RedirectableRequest.prototype._sanitizeOptions = function(options) {
    if (!options.headers) {
      options.headers = {};
    }
    if (!isArray2(options.sensitiveHeaders)) {
      options.sensitiveHeaders = [];
    }
    if (options.host) {
      if (!options.hostname) {
        options.hostname = options.host;
      }
      delete options.host;
    }
    if (!options.pathname && options.path) {
      var searchPos = options.path.indexOf("?");
      if (searchPos < 0) {
        options.pathname = options.path;
      } else {
        options.pathname = options.path.substring(0, searchPos);
        options.search = options.path.substring(searchPos);
      }
    }
  };
  RedirectableRequest.prototype._performRequest = function() {
    var protocol2 = this._options.protocol;
    var nativeProtocol = this._options.nativeProtocols[protocol2];
    if (!nativeProtocol) {
      throw new TypeError("Unsupported protocol " + protocol2);
    }
    if (this._options.agents) {
      var scheme = protocol2.slice(0, -1);
      this._options.agent = this._options.agents[scheme];
    }
    var request = this._currentRequest = nativeProtocol.request(this._options, this._onNativeResponse);
    request._redirectable = this;
    for (var event of events) {
      request.on(event, eventHandlers[event]);
    }
    this._currentUrl = /^\//.test(this._options.path) ? url.format(this._options) : (
      // When making a request to a proxy, […]
      // a client MUST send the target URI in absolute-form […].
      this._options.path
    );
    if (this._isRedirect) {
      var i = 0;
      var self2 = this;
      var buffers = this._requestBodyBuffers;
      (function writeNext(error) {
        if (request === self2._currentRequest) {
          if (error) {
            self2.emit("error", error);
          } else if (i < buffers.length) {
            var buffer = buffers[i++];
            if (!request.finished) {
              request.write(buffer.data, buffer.encoding, writeNext);
            }
          } else if (self2._ended) {
            request.end();
          }
        }
      })();
    }
  };
  RedirectableRequest.prototype._processResponse = function(response) {
    var statusCode = response.statusCode;
    if (this._options.trackRedirects) {
      this._redirects.push({
        url: this._currentUrl,
        headers: response.headers,
        statusCode
      });
    }
    var location = response.headers.location;
    if (!location || this._options.followRedirects === false || statusCode < 300 || statusCode >= 400) {
      response.responseUrl = this._currentUrl;
      response.redirects = this._redirects;
      this.emit("response", response);
      this._requestBodyBuffers = [];
      return;
    }
    destroyRequest(this._currentRequest);
    response.destroy();
    if (++this._redirectCount > this._options.maxRedirects) {
      throw new TooManyRedirectsError();
    }
    var requestHeaders;
    var beforeRedirect = this._options.beforeRedirect;
    if (beforeRedirect) {
      requestHeaders = Object.assign({
        // The Host header was set by nativeProtocol.request
        Host: response.req.getHeader("host")
      }, this._options.headers);
    }
    var method = this._options.method;
    if ((statusCode === 301 || statusCode === 302) && this._options.method === "POST" || // RFC7231§6.4.4: The 303 (See Other) status code indicates that
    // the server is redirecting the user agent to a different resource […]
    // A user agent can perform a retrieval request targeting that URI
    // (a GET or HEAD request if using HTTP) […]
    statusCode === 303 && !/^(?:GET|HEAD)$/.test(this._options.method)) {
      this._options.method = "GET";
      this._requestBodyBuffers = [];
      removeMatchingHeaders(/^content-/i, this._options.headers);
    }
    var currentHostHeader = removeMatchingHeaders(/^host$/i, this._options.headers);
    var currentUrlParts = parseUrl2(this._currentUrl);
    var currentHost = currentHostHeader || currentUrlParts.host;
    var currentUrl = /^\w+:/.test(location) ? this._currentUrl : url.format(Object.assign(currentUrlParts, { host: currentHost }));
    var redirectUrl = resolveUrl(location, currentUrl);
    debug("redirecting to", redirectUrl.href);
    this._isRedirect = true;
    spreadUrlObject(redirectUrl, this._options);
    if (redirectUrl.protocol !== currentUrlParts.protocol && redirectUrl.protocol !== "https:" || redirectUrl.host !== currentHost && !isSubdomain(redirectUrl.host, currentHost)) {
      removeMatchingHeaders(this._headerFilter, this._options.headers);
    }
    if (isFunction2(beforeRedirect)) {
      var responseDetails = {
        headers: response.headers,
        statusCode
      };
      var requestDetails = {
        url: currentUrl,
        method,
        headers: requestHeaders
      };
      beforeRedirect(this._options, responseDetails, requestDetails);
      this._sanitizeOptions(this._options);
    }
    this._performRequest();
  };
  function wrap(protocols) {
    var exports = {
      maxRedirects: 21,
      maxBodyLength: 10 * 1024 * 1024
    };
    var nativeProtocols = {};
    Object.keys(protocols).forEach(function(scheme) {
      var protocol2 = scheme + ":";
      var nativeProtocol = nativeProtocols[protocol2] = protocols[scheme];
      var wrappedProtocol = exports[scheme] = Object.create(nativeProtocol);
      function request(input, options, callback) {
        if (isURL(input)) {
          input = spreadUrlObject(input);
        } else if (isString2(input)) {
          input = spreadUrlObject(parseUrl2(input));
        } else {
          callback = options;
          options = validateUrl(input);
          input = { protocol: protocol2 };
        }
        if (isFunction2(options)) {
          callback = options;
          options = null;
        }
        options = Object.assign({
          maxRedirects: exports.maxRedirects,
          maxBodyLength: exports.maxBodyLength
        }, input, options);
        options.nativeProtocols = nativeProtocols;
        if (!isString2(options.host) && !isString2(options.hostname)) {
          options.hostname = "::1";
        }
        assert.equal(options.protocol, protocol2, "protocol mismatch");
        debug("options", options);
        return new RedirectableRequest(options, callback);
      }
      function get2(input, options, callback) {
        var wrappedRequest = wrappedProtocol.request(input, options, callback);
        wrappedRequest.end();
        return wrappedRequest;
      }
      Object.defineProperties(wrappedProtocol, {
        request: { value: request, configurable: true, enumerable: true, writable: true },
        get: { value: get2, configurable: true, enumerable: true, writable: true }
      });
    });
    return exports;
  }
  function noop2() {
  }
  function parseUrl2(input) {
    var parsed;
    if (useNativeURL) {
      parsed = new URL2(input);
    } else {
      parsed = validateUrl(url.parse(input));
      if (!isString2(parsed.protocol)) {
        throw new InvalidUrlError({ input });
      }
    }
    return parsed;
  }
  function resolveUrl(relative2, base) {
    return useNativeURL ? new URL2(relative2, base) : parseUrl2(url.resolve(base, relative2));
  }
  function validateUrl(input) {
    if (/^\[/.test(input.hostname) && !/^\[[:0-9a-f]+\]$/i.test(input.hostname)) {
      throw new InvalidUrlError({ input: input.href || input });
    }
    if (/^\[/.test(input.host) && !/^\[[:0-9a-f]+\](:\d+)?$/i.test(input.host)) {
      throw new InvalidUrlError({ input: input.href || input });
    }
    return input;
  }
  function spreadUrlObject(urlObject, target) {
    var spread2 = target || {};
    for (var key of preservedUrlFields) {
      spread2[key] = urlObject[key];
    }
    if (spread2.hostname.startsWith("[")) {
      spread2.hostname = spread2.hostname.slice(1, -1);
    }
    if (spread2.port !== "") {
      spread2.port = Number(spread2.port);
    }
    spread2.path = spread2.search ? spread2.pathname + spread2.search : spread2.pathname;
    return spread2;
  }
  function removeMatchingHeaders(regex, headers) {
    var lastValue;
    for (var header in headers) {
      if (regex.test(header)) {
        lastValue = headers[header];
        delete headers[header];
      }
    }
    return lastValue === null || typeof lastValue === "undefined" ? void 0 : String(lastValue).trim();
  }
  function createErrorType(code, message, baseClass) {
    function CustomError(properties) {
      if (isFunction2(Error.captureStackTrace)) {
        Error.captureStackTrace(this, this.constructor);
      }
      Object.assign(this, properties || {});
      this.code = code;
      this.message = this.cause ? message + ": " + this.cause.message : message;
    }
    CustomError.prototype = new (baseClass || Error)();
    Object.defineProperties(CustomError.prototype, {
      constructor: {
        value: CustomError,
        enumerable: false
      },
      name: {
        value: "Error [" + code + "]",
        enumerable: false
      }
    });
    return CustomError;
  }
  function destroyRequest(request, error) {
    for (var event of events) {
      request.removeListener(event, eventHandlers[event]);
    }
    request.on("error", noop2);
    request.destroy(error);
  }
  function isSubdomain(subdomain, domain) {
    assert(isString2(subdomain) && isString2(domain));
    var dot = subdomain.length - domain.length - 1;
    return dot > 0 && subdomain[dot] === "." && subdomain.endsWith(domain);
  }
  function isArray2(value) {
    return value instanceof Array;
  }
  function isString2(value) {
    return typeof value === "string" || value instanceof String;
  }
  function isFunction2(value) {
    return typeof value === "function";
  }
  function isBuffer2(value) {
    return typeof value === "object" && "length" in value;
  }
  function isURL(value) {
    return URL2 && value instanceof URL2;
  }
  function escapeRegex(regex) {
    return regex.replace(/[\]\\/()*+?.$]/g, "\\$&");
  }
  followRedirects$1.exports = wrap({ http: http3, https: https$1 });
  followRedirects$1.exports.wrap = wrap;
  return followRedirects$1.exports;
}
var followRedirectsExports = requireFollowRedirects();
const followRedirects = /* @__PURE__ */ getDefaultExportFromCjs(followRedirectsExports);
const VERSION$1 = "1.19.0";
function parseProtocol(url) {
  const match = /^([-+\w]{1,25}):(?:\/\/)?/.exec(url);
  return match && match[1] || "";
}
const DATA_URL_PATTERN = /^([^,;]+\/[^,;]+)?((?:;[^,;=]+=[^,;]+)*)(;base64)?,([\s\S]*)$/;
function fromDataURI(uri2, asBlob, options) {
  const _Blob = options && options.Blob || platform.classes.Blob;
  const protocol2 = parseProtocol(uri2);
  if (asBlob === void 0 && _Blob) {
    asBlob = true;
  }
  if (protocol2 === "data") {
    uri2 = protocol2.length ? uri2.slice(protocol2.length + 1) : uri2;
    const match = DATA_URL_PATTERN.exec(uri2);
    if (!match) {
      throw new AxiosError$1("Invalid URL", AxiosError$1.ERR_INVALID_URL);
    }
    const type2 = match[1];
    const params = match[2];
    const encoding = match[3] ? "base64" : "utf8";
    const body = match[4];
    let mime = "";
    if (type2) {
      mime = params ? type2 + params : type2;
    } else if (params) {
      mime = "text/plain" + params;
    }
    const buffer = encoding === "base64" ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), encoding);
    if (asBlob) {
      if (!_Blob) {
        throw new AxiosError$1("Blob is not supported", AxiosError$1.ERR_NOT_SUPPORT);
      }
      return new _Blob([buffer], { type: mime });
    }
    return buffer;
  }
  throw new AxiosError$1("Unsupported protocol " + protocol2, AxiosError$1.ERR_NOT_SUPPORT);
}
const FORM_DATA_CONTENT_HEADERS = ["content-type", "content-length"];
function setFormDataHeaders(headers, formHeaders, policy) {
  if (policy !== "content-only") {
    headers.set(formHeaders);
    return;
  }
  Object.entries(formHeaders || {}).forEach(([key, val]) => {
    if (FORM_DATA_CONTENT_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, val);
    }
  });
}
const kInternals = Symbol("internals");
class AxiosTransformStream extends stream.Transform {
  constructor(options) {
    options = utils$1.toFlatObject(
      options,
      {
        maxRate: 0,
        chunkSize: 64 * 1024,
        minChunkSize: 100,
        timeWindow: 500,
        ticksRate: 2,
        samplesCount: 15
      },
      null,
      (prop, source) => {
        return !utils$1.isUndefined(source[prop]);
      }
    );
    super({
      readableHighWaterMark: options.chunkSize
    });
    const internals = this[kInternals] = {
      timeWindow: options.timeWindow,
      chunkSize: options.chunkSize,
      maxRate: options.maxRate,
      minChunkSize: options.minChunkSize,
      bytesSeen: 0,
      isCaptured: false,
      notifiedBytesLoaded: 0,
      ts: Date.now(),
      bytes: 0,
      onReadCallback: null
    };
    this.on("newListener", (event) => {
      if (event === "progress") {
        if (!internals.isCaptured) {
          internals.isCaptured = true;
        }
      }
    });
  }
  _read(size) {
    const internals = this[kInternals];
    if (internals.onReadCallback) {
      internals.onReadCallback();
    }
    return super._read(size);
  }
  _transform(chunk, encoding, callback) {
    const internals = this[kInternals];
    const maxRate = internals.maxRate;
    const readableHighWaterMark = this.readableHighWaterMark;
    const timeWindow = internals.timeWindow;
    const divider = 1e3 / timeWindow;
    const bytesThreshold = maxRate / divider;
    const minChunkSize = internals.minChunkSize !== false ? Math.max(internals.minChunkSize, bytesThreshold * 0.01) : 0;
    const pushChunk = (_chunk, _callback) => {
      const bytes = Buffer.byteLength(_chunk);
      internals.bytesSeen += bytes;
      internals.bytes += bytes;
      internals.isCaptured && this.emit("progress", internals.bytesSeen);
      if (this.push(_chunk)) {
        process.nextTick(_callback);
      } else {
        internals.onReadCallback = () => {
          internals.onReadCallback = null;
          process.nextTick(_callback);
        };
      }
    };
    const transformChunk = (_chunk, _callback) => {
      const chunkSize = Buffer.byteLength(_chunk);
      let chunkRemainder = null;
      let maxChunkSize = readableHighWaterMark;
      let bytesLeft;
      let passed = 0;
      if (maxRate) {
        const now = Date.now();
        if (!internals.ts || (passed = now - internals.ts) >= timeWindow) {
          internals.ts = now;
          bytesLeft = bytesThreshold - internals.bytes;
          internals.bytes = bytesLeft < 0 ? -bytesLeft : 0;
          passed = 0;
        }
        bytesLeft = bytesThreshold - internals.bytes;
      }
      if (maxRate) {
        if (bytesLeft <= 0) {
          return setTimeout(() => {
            _callback(null, _chunk);
          }, timeWindow - passed);
        }
        if (bytesLeft < maxChunkSize) {
          maxChunkSize = bytesLeft;
        }
      }
      if (maxChunkSize && chunkSize > maxChunkSize && chunkSize - maxChunkSize > minChunkSize) {
        chunkRemainder = _chunk.subarray(maxChunkSize);
        _chunk = _chunk.subarray(0, maxChunkSize);
      }
      pushChunk(
        _chunk,
        chunkRemainder ? () => {
          process.nextTick(_callback, null, chunkRemainder);
        } : _callback
      );
    };
    transformChunk(chunk, function transformNextChunk(err, _chunk) {
      if (err) {
        return callback(err);
      }
      if (_chunk) {
        transformChunk(_chunk, transformNextChunk);
      } else {
        callback(null);
      }
    });
  }
}
const { asyncIterator } = Symbol;
const readBlob = async function* (blob) {
  if (blob.stream) {
    yield* blob.stream();
  } else if (blob.arrayBuffer) {
    yield await blob.arrayBuffer();
  } else if (blob[asyncIterator]) {
    yield* blob[asyncIterator]();
  } else {
    yield blob;
  }
};
const BOUNDARY_ALPHABET = platform.ALPHABET.ALPHA_DIGIT + "-_";
const textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : new require$$1.TextEncoder();
const CRLF = "\r\n";
const CRLF_BYTES = textEncoder.encode(CRLF);
const CRLF_BYTES_COUNT = 2;
class FormDataPart {
  constructor(name, value) {
    const { escapeName } = this.constructor;
    const isStringValue = utils$1.isString(value);
    let headers = `Content-Disposition: form-data; name="${escapeName(name)}"${!isStringValue && value.name ? `; filename="${escapeName(value.name)}"` : ""}${CRLF}`;
    if (isStringValue) {
      value = textEncoder.encode(String(value).replace(/\r?\n|\r\n?/g, CRLF));
    } else {
      const safeType = String(value.type || "application/octet-stream").replace(/[\r\n]/g, "");
      headers += `Content-Type: ${safeType}${CRLF}`;
    }
    this.headers = textEncoder.encode(headers + CRLF);
    this.contentLength = isStringValue ? value.byteLength : value.size;
    this.size = this.headers.byteLength + this.contentLength + CRLF_BYTES_COUNT;
    this.name = name;
    this.value = value;
  }
  async *encode() {
    yield this.headers;
    const { value } = this;
    if (utils$1.isTypedArray(value)) {
      yield value;
    } else {
      yield* readBlob(value);
    }
    yield CRLF_BYTES;
  }
  static escapeName(name) {
    return String(name).replace(
      /[\r\n"]/g,
      (match) => ({
        "\r": "%0D",
        "\n": "%0A",
        '"': "%22"
      })[match]
    );
  }
}
const formDataToStream = (form, headersHandler, options) => {
  const {
    tag = "form-data-boundary",
    size = 25,
    boundary = tag + "-" + platform.generateString(size, BOUNDARY_ALPHABET)
  } = options || {};
  if (!utils$1.isFormData(form)) {
    throw new TypeError("FormData instance required");
  }
  if (boundary.length < 1 || boundary.length > 70) {
    throw new Error("boundary must be 1-70 characters long");
  }
  const boundaryBytes = textEncoder.encode("--" + boundary + CRLF);
  const footerBytes = textEncoder.encode("--" + boundary + "--" + CRLF);
  let contentLength = footerBytes.byteLength;
  const parts = Array.from(form.entries()).map(([name, value]) => {
    const part = new FormDataPart(name, value);
    contentLength += part.size;
    return part;
  });
  contentLength += boundaryBytes.byteLength * parts.length;
  contentLength = utils$1.toFiniteNumber(contentLength);
  const computedHeaders = {
    "Content-Type": `multipart/form-data; boundary=${boundary}`
  };
  if (Number.isFinite(contentLength)) {
    computedHeaders["Content-Length"] = contentLength;
  }
  headersHandler && headersHandler(computedHeaders);
  return Readable.from(
    async function* () {
      for (const part of parts) {
        yield boundaryBytes;
        yield* part.encode();
      }
      yield footerBytes;
    }()
  );
};
class ZlibHeaderTransformStream extends stream.Transform {
  __transform(chunk, encoding, callback) {
    this.push(chunk);
    callback();
  }
  _transform(chunk, encoding, callback) {
    if (chunk.length !== 0) {
      this._transform = this.__transform;
      if (chunk[0] !== 120) {
        const header = Buffer.alloc(2);
        header[0] = 120;
        header[1] = 156;
        this.push(header, encoding);
      }
    }
    this.__transform(chunk, encoding, callback);
  }
}
class Http2Sessions {
  constructor() {
    this.sessions = /* @__PURE__ */ Object.create(null);
  }
  getSession(authority, options) {
    options = Object.assign(
      {
        sessionTimeout: 1e3
      },
      options
    );
    let authoritySessions = this.sessions[authority];
    if (authoritySessions) {
      let len = authoritySessions.length;
      for (let i = 0; i < len; i++) {
        const [sessionHandle, sessionOptions] = authoritySessions[i];
        if (!sessionHandle.destroyed && !sessionHandle.closed && require$$1.isDeepStrictEqual(sessionOptions, options)) {
          return sessionHandle;
        }
      }
    }
    const session2 = http2.connect(authority, options);
    let removed;
    let timer;
    const removeSession = () => {
      if (removed) {
        return;
      }
      removed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      let entries = authoritySessions, len = entries.length, i = len;
      while (i--) {
        if (entries[i][0] === session2) {
          if (len === 1) {
            delete this.sessions[authority];
          } else {
            entries.splice(i, 1);
          }
          if (!session2.closed) {
            session2.close();
          }
          return;
        }
      }
    };
    const originalRequestFn = session2.request;
    const { sessionTimeout } = options;
    if (sessionTimeout != null) {
      let streamsCount = 0;
      session2.request = function() {
        const stream2 = originalRequestFn.apply(this, arguments);
        streamsCount++;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        stream2.once("close", () => {
          if (!--streamsCount) {
            timer = setTimeout(() => {
              timer = null;
              removeSession();
            }, sessionTimeout);
          }
        });
        return stream2;
      };
    }
    session2.once("close", removeSession);
    let entry = [session2, options];
    authoritySessions ? authoritySessions.push(entry) : authoritySessions = this.sessions[authority] = [entry];
    return session2;
  }
}
const callbackify = (fn, reducer) => {
  return utils$1.isAsyncFn(fn) ? function(...args) {
    const cb = args.pop();
    fn.apply(this, args).then((value) => {
      try {
        reducer ? cb(null, ...reducer(value)) : cb(null, value);
      } catch (err) {
        cb(err);
      }
    }, cb);
  } : fn;
};
const LOOPBACK_HOSTNAMES = /* @__PURE__ */ new Set(["localhost", "0.0.0.0"]);
const isIPv4Loopback = (host) => {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  if (parts[0] !== "127") return false;
  return parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
};
const parseIPv4Octet = (text2) => {
  if (/^0[xX][0-9a-fA-F]+$/.test(text2)) {
    const n = parseInt(text2.slice(2), 16);
    return Number.isFinite(n) ? n : null;
  }
  if (text2.length > 1 && /^0[0-7]+$/.test(text2)) {
    const n = parseInt(text2, 8);
    return Number.isFinite(n) ? n : null;
  }
  if (text2.length > 1 && /^0[0-9]+$/.test(text2)) {
    return null;
  }
  if (/^[0-9]+$/.test(text2)) {
    const n = parseInt(text2, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const normalizeIPAddress = (host) => {
  if (typeof host !== "string" || !host || host.indexOf(":") !== -1) {
    return host;
  }
  let h = host;
  if (h.charAt(0) === "[" && h.charAt(h.length - 1) === "]") {
    h = h.slice(1, -1);
  }
  h = h.replace(/\.+$/, "");
  if (!/^[0-9.xXa-fA-F]+$/.test(h)) return host;
  const parts = h.split(".");
  if (parts.some((p) => p === "")) return host;
  if (parts.length === 4) {
    const octets = parts.map(parseIPv4Octet);
    if (octets.some((n) => n === null || n < 0 || n > 255)) return host;
    return octets.join(".");
  }
  if (parts.length > 4) {
    return host;
  }
  if (parts.length === 1) return host;
  const literalOctets = parts.slice(0, -1);
  const tail = parts[parts.length - 1];
  const tailSlots = 4 - literalOctets.length;
  const tailValue = parseIPv4Octet(tail);
  if (tailValue === null) return host;
  const maxTail = (1 << 8 * tailSlots) - 1;
  if (tailValue < 0 || tailValue > maxTail) return host;
  const tailOctets = new Array(tailSlots).fill(0);
  for (let i = tailSlots - 1, v = tailValue; i >= 0; i--, v >>= 8) {
    tailOctets[i] = v & 255;
  }
  const literal = literalOctets.map(parseIPv4Octet);
  if (literal.some((n) => n === null || n < 0 || n > 255)) return host;
  return [...literal, ...tailOctets].join(".");
};
const isIPv6ZeroGroup = (group) => /^0{1,4}$/.test(group);
const isIPv6Unspecified = (host) => {
  if (host === "::") return true;
  const compressionIndex = host.indexOf("::");
  if (compressionIndex !== -1) {
    if (compressionIndex !== host.lastIndexOf("::")) return false;
    const left = host.slice(0, compressionIndex);
    const right = host.slice(compressionIndex + 2);
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const explicitGroups = leftGroups.length + rightGroups.length;
    return explicitGroups < 8 && leftGroups.every(isIPv6ZeroGroup) && rightGroups.every(isIPv6ZeroGroup);
  }
  const groups = host.split(":");
  return groups.length === 8 && groups.every(isIPv6ZeroGroup);
};
const isIPv6Loopback = (host) => {
  if (host === "::1") return true;
  const v4MappedDotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedDotted) return isIPv4Loopback(v4MappedDotted[1]);
  const v4MappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4MappedHex) {
    const high = parseInt(v4MappedHex[1], 16);
    return high >= 32512 && high <= 32767;
  }
  const groups = host.split(":");
  if (groups.length === 8) {
    for (let i = 0; i < 7; i++) {
      if (!/^0+$/.test(groups[i])) return false;
    }
    return /^0*1$/.test(groups[7]);
  }
  return false;
};
const isLoopback = (host) => {
  if (!host) return false;
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  if (isIPv4Loopback(host)) return true;
  if (isIPv6Unspecified(host)) return true;
  return isIPv6Loopback(host);
};
const DEFAULT_PORTS = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  ftp: 21
};
const parseNoProxyEntry = (entry) => {
  let entryHost = entry;
  let entryPort = 0;
  if (entryHost.charAt(0) === "[") {
    const bracketIndex = entryHost.indexOf("]");
    if (bracketIndex !== -1) {
      const host = entryHost.slice(1, bracketIndex);
      const rest = entryHost.slice(bracketIndex + 1);
      if (rest.charAt(0) === ":" && /^\d+$/.test(rest.slice(1))) {
        entryPort = Number.parseInt(rest.slice(1), 10);
      }
      return [host, entryPort];
    }
  }
  const firstColon = entryHost.indexOf(":");
  const lastColon = entryHost.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon && /^\d+$/.test(entryHost.slice(lastColon + 1))) {
    entryPort = Number.parseInt(entryHost.slice(lastColon + 1), 10);
    entryHost = entryHost.slice(0, lastColon);
  }
  return [entryHost, entryPort];
};
const IPV4_MAPPED_DOTTED_RE = /^(?:::|(?:0{1,4}:){1,4}:|(?:0{1,4}:){5})ffff:(\d+\.\d+\.\d+\.\d+)$/i;
const IPV4_MAPPED_HEX_RE = /^(?:::|(?:0{1,4}:){1,4}:|(?:0{1,4}:){5})ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
const unmapIPv4MappedIPv6 = (host) => {
  if (typeof host !== "string" || host.indexOf(":") === -1) return host;
  const dotted = host.match(IPV4_MAPPED_DOTTED_RE);
  if (dotted) return dotted[1];
  const hex = host.match(IPV4_MAPPED_HEX_RE);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return host;
};
const normalizeNoProxyHost = (hostname2) => {
  if (!hostname2) {
    return hostname2;
  }
  if (hostname2.charAt(0) === "[" && hostname2.charAt(hostname2.length - 1) === "]") {
    hostname2 = hostname2.slice(1, -1);
  }
  const trimmed = hostname2.replace(/\.+$/, "");
  const ipv4 = normalizeIPAddress(trimmed);
  if (ipv4 !== trimmed) {
    return ipv4;
  }
  return unmapIPv4MappedIPv6(trimmed);
};
function shouldBypassProxy(location) {
  let parsed;
  try {
    parsed = new URL(location);
  } catch (_err) {
    return false;
  }
  const noProxy = (process.env.no_proxy || process.env.NO_PROXY || "").toLowerCase();
  if (!noProxy) {
    return false;
  }
  if (noProxy === "*") {
    return true;
  }
  const port = Number.parseInt(parsed.port, 10) || DEFAULT_PORTS[parsed.protocol.split(":", 1)[0]] || 0;
  const hostname2 = normalizeNoProxyHost(parsed.hostname.toLowerCase());
  return noProxy.split(/[\s,]+/).some((entry) => {
    if (!entry) {
      return false;
    }
    if (entry === "*") {
      return true;
    }
    let [entryHost, entryPort] = parseNoProxyEntry(entry);
    entryHost = normalizeNoProxyHost(entryHost);
    if (!entryHost) {
      return false;
    }
    if (entryPort && entryPort !== port) {
      return false;
    }
    if (entryHost.charAt(0) === "*") {
      entryHost = entryHost.slice(1);
    }
    if (entryHost.charAt(0) === ".") {
      return hostname2.endsWith(entryHost);
    }
    return hostname2 === entryHost || isLoopback(hostname2) && isLoopback(entryHost);
  });
}
function speedometer(samplesCount, min2) {
  samplesCount = samplesCount || 10;
  const bytes = new Array(samplesCount);
  const timestamps = new Array(samplesCount);
  let head = 0;
  let tail = 0;
  let firstSampleTS;
  min2 = min2 !== void 0 ? min2 : 1e3;
  return function push(chunkLength) {
    const now = Date.now();
    const startedAt = timestamps[tail];
    if (!firstSampleTS) {
      firstSampleTS = now;
    }
    bytes[head] = chunkLength;
    timestamps[head] = now;
    let i = tail;
    let bytesCount = 0;
    while (i !== head) {
      bytesCount += bytes[i++];
      i = i % samplesCount;
    }
    head = (head + 1) % samplesCount;
    if (head === tail) {
      tail = (tail + 1) % samplesCount;
    }
    if (now - firstSampleTS < min2) {
      return;
    }
    const passed = startedAt && now - startedAt;
    return passed ? Math.round(bytesCount * 1e3 / passed) : void 0;
  };
}
function throttle(fn, freq) {
  let timestamp2 = 0;
  let threshold = 1e3 / freq;
  let lastArgs;
  let timer;
  const invoke = (args, now = Date.now()) => {
    timestamp2 = now;
    lastArgs = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fn(...args);
  };
  const throttled = (...args) => {
    const now = Date.now();
    const passed = now - timestamp2;
    if (passed >= threshold) {
      invoke(args, now);
    } else {
      lastArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          invoke(lastArgs);
        }, threshold - passed);
      }
    }
  };
  const flush = () => lastArgs && invoke(lastArgs);
  return [throttled, flush];
}
const progressEventReducer = (listener, isDownloadStream, freq = 3) => {
  let bytesNotified = 0;
  const _speedometer = speedometer(50, 250);
  return throttle((e) => {
    if (!e || typeof e.loaded !== "number") {
      return;
    }
    const rawLoaded = e.loaded;
    const total = e.lengthComputable ? e.total : void 0;
    const loaded = Math.max(0, total != null ? Math.min(rawLoaded, total) : rawLoaded);
    const progressBytes = Math.max(0, loaded - bytesNotified);
    const rate = _speedometer(progressBytes);
    bytesNotified = Math.max(bytesNotified, loaded);
    const data = {
      loaded,
      total,
      progress: total ? loaded / total : void 0,
      bytes: progressBytes,
      rate: rate ? rate : void 0,
      estimated: rate && total ? (total - loaded) / rate : void 0,
      event: e,
      lengthComputable: total != null,
      [isDownloadStream ? "download" : "upload"]: true
    };
    listener(data);
  }, freq);
};
const progressEventDecorator = (total, throttled) => {
  const lengthComputable = total != null;
  return [
    (loaded) => throttled[0]({
      lengthComputable,
      total,
      loaded
    }),
    throttled[1]
  ];
};
const asyncDecorator = (fn, scheduler = utils$1.asap) => (...args) => scheduler(() => fn(...args));
const isHexDigit = (charCode) => charCode >= 48 && charCode <= 57 || charCode >= 65 && charCode <= 70 || charCode >= 97 && charCode <= 102;
const isPercentEncodedByte = (str, i, len) => i + 2 < len && isHexDigit(str.charCodeAt(i + 1)) && isHexDigit(str.charCodeAt(i + 2));
const hexValue = (charCode) => charCode <= 57 ? charCode - 48 : (charCode & 223) - 55;
const isBase64Char = (charCode) => charCode >= 65 && charCode <= 90 || // A-Z
charCode >= 97 && charCode <= 122 || // a-z
charCode >= 48 && charCode <= 57 || // 0-9
charCode === 43 || // +
charCode === 47 || // /
charCode === 45 || // - (base64url)
charCode === 95;
const isBase64Whitespace = (charCode) => charCode === 9 || charCode === 10 || charCode === 12 || charCode === 13 || charCode === 32;
const base64Bytes = (significant) => {
  const groups = Math.floor(significant / 4);
  const remainder = significant % 4;
  return groups * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
};
const estimateBase64BufferAllocation = (body) => {
  const len = body.length;
  let padding = 0;
  if (len > 0 && body.charCodeAt(len - 1) === 61) {
    padding++;
    if (len > 1 && body.charCodeAt(len - 2) === 61) {
      padding++;
    }
  }
  return Math.floor((len - padding) * 3 / 4);
};
const estimatePercentDecodedBase64Bytes = (body) => {
  const len = body.length;
  let significant = 0;
  let padding = 0;
  let invalid = false;
  for (let i = 0; i < len; i++) {
    let code = body.charCodeAt(i);
    if (code === 37 && isPercentEncodedByte(body, i, len)) {
      code = hexValue(body.charCodeAt(i + 1)) * 16 + hexValue(body.charCodeAt(i + 2));
      i += 2;
    }
    if (isBase64Whitespace(code)) {
      continue;
    }
    if (code === 61) {
      padding++;
      continue;
    }
    if (!isBase64Char(code) || padding > 0) {
      invalid = true;
      continue;
    }
    significant++;
  }
  if (invalid || padding > 2 || padding > 0 && (significant + padding) % 4 !== 0 || significant % 4 === 1) {
    return estimateBase64BufferAllocation(body);
  }
  return base64Bytes(significant);
};
const estimateDataURLBytes = (url, estimateBase64) => {
  if (!url || typeof url !== "string") return 0;
  if (!url.startsWith("data:")) return 0;
  const comma = url.indexOf(",");
  if (comma < 0) return 0;
  const meta = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const isBase64 = /;base64/i.test(meta);
  if (isBase64) {
    return estimateBase64(body);
  }
  let bytes = 0;
  for (let i = 0, len = body.length; i < len; i++) {
    const c = body.charCodeAt(i);
    if (c === 37 && isPercentEncodedByte(body, i, len)) {
      bytes += 1;
      i += 2;
    } else if (c < 128) {
      bytes += 1;
    } else if (c < 2048) {
      bytes += 2;
    } else if (c >= 55296 && c <= 56319 && i + 1 < len) {
      const next = body.charCodeAt(i + 1);
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
};
function estimateDataURLDecodedBytes(url) {
  const fragmentIndex = typeof url === "string" ? url.indexOf("#") : -1;
  return estimateDataURLBytes(
    fragmentIndex === -1 ? url : url.slice(0, fragmentIndex),
    estimatePercentDecodedBase64Bytes
  );
}
function estimateDataURLBufferAllocation(url) {
  return estimateDataURLBytes(url, estimateBase64BufferAllocation);
}
const zlibOptions = {
  flush: zlib.constants.Z_SYNC_FLUSH,
  finishFlush: zlib.constants.Z_SYNC_FLUSH
};
const brotliOptions = {
  flush: zlib.constants.BROTLI_OPERATION_FLUSH,
  finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH
};
const zstdOptions = {
  flush: zlib.constants.ZSTD_e_flush,
  finishFlush: zlib.constants.ZSTD_e_flush
};
const isBrotliSupported = utils$1.isFunction(zlib.createBrotliDecompress);
const isZstdSupported = utils$1.isFunction(zlib.createZstdDecompress);
const ACCEPT_ENCODING = "gzip, compress, deflate" + (isBrotliSupported ? ", br" : "");
const ACCEPT_ENCODING_WITH_ZSTD = ACCEPT_ENCODING + (isZstdSupported ? ", zstd" : "");
const scheduleProgress = typeof process !== "undefined" && process.nextTick ? process.nextTick.bind(process) : utils$1.asap;
const { http: httpFollow, https: httpsFollow } = followRedirects;
const isHttps = /https:?/;
const kAxiosSocketListener = Symbol("axios.http.socketListener");
const kAxiosCurrentReq = Symbol("axios.http.currentReq");
const kAxiosInstalledTunnel = Symbol("axios.http.installedTunnel");
const tunnelingAgentCache = /* @__PURE__ */ new Map();
const tunnelingAgentCacheUser = /* @__PURE__ */ new WeakMap();
const NODE_NATIVE_ENV_PROXY_SUPPORT = {
  22: 21,
  24: 5
};
function isNodeNativeEnvProxySupported(nodeVersion = process.versions && process.versions.node) {
  if (!nodeVersion) {
    return false;
  }
  const [major, minor] = nodeVersion.split(".").map((part) => Number(part));
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return false;
  }
  if (major > 24) {
    return true;
  }
  return NODE_NATIVE_ENV_PROXY_SUPPORT[major] != null && minor >= NODE_NATIVE_ENV_PROXY_SUPPORT[major];
}
function isNodeEnvProxyEnabled(agent2, nodeVersion = process.versions && process.versions.node) {
  if (!isNodeNativeEnvProxySupported(nodeVersion)) {
    return false;
  }
  const agentOptions = agent2 && agent2.options;
  return Boolean(
    agentOptions && utils$1.hasOwnProp(agentOptions, "proxyEnv") && agentOptions.proxyEnv != null
  );
}
function getProxyEnvAgent(options, configHttpAgent, configHttpsAgent) {
  return isHttps.test(options.protocol) ? configHttpsAgent || https.globalAgent : configHttpAgent || http$a.globalAgent;
}
function getTunnelingAgent(agentOptions, userHttpsAgent) {
  const key = agentOptions.protocol + "//" + agentOptions.hostname + ":" + (agentOptions.port || "") + "#" + (agentOptions.auth || "");
  const cache = userHttpsAgent ? tunnelingAgentCacheUser.get(userHttpsAgent) || tunnelingAgentCacheUser.set(userHttpsAgent, /* @__PURE__ */ new Map()).get(userHttpsAgent) : tunnelingAgentCache;
  let agent2 = cache.get(key);
  if (agent2) return agent2;
  const merged = userHttpsAgent && userHttpsAgent.options ? { ...userHttpsAgent.options, ...agentOptions } : agentOptions;
  agent2 = new HttpsProxyAgent(merged);
  if (userHttpsAgent && userHttpsAgent.options) {
    const originTLSOptions = { ...userHttpsAgent.options };
    const callback = agent2.callback;
    agent2.callback = function axiosTunnelingAgentCallback(req, opts) {
      return callback.call(this, req, { ...originTLSOptions, ...opts });
    };
  }
  agent2[kAxiosInstalledTunnel] = true;
  cache.set(key, agent2);
  return agent2;
}
const supportedProtocols = platform.protocols.map((protocol2) => {
  return protocol2 + ":";
});
const decodeURIComponentSafe$1 = (value) => {
  if (!utils$1.isString(value)) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
};
const flushOnFinish = (stream2, [throttled, flush]) => {
  stream2.on("end", flush).on("error", flush);
  return throttled;
};
const http2Sessions = new Http2Sessions();
function dispatchBeforeRedirect(options, responseDetails, requestDetails) {
  if (options.beforeRedirects.proxy) {
    options.beforeRedirects.proxy(options);
  }
  if (options.beforeRedirects.auth) {
    options.beforeRedirects.auth(options);
  }
  if (options.beforeRedirects.sensitiveHeaders) {
    options.beforeRedirects.sensitiveHeaders(options, requestDetails);
  }
  if (options.beforeRedirects.config) {
    options.beforeRedirects.config(options, responseDetails, requestDetails);
  }
}
function stripMatchingHeaders(headers, sensitiveSet) {
  if (!headers) {
    return;
  }
  Object.keys(headers).forEach((header) => {
    if (sensitiveSet.has(header.toLowerCase())) {
      delete headers[header];
    }
  });
}
function isSameOriginRedirect(redirectOptions, requestDetails) {
  if (!requestDetails) {
    return false;
  }
  try {
    return new URL(requestDetails.url).origin === new URL(redirectOptions.href).origin;
  } catch (e) {
    return false;
  }
}
function setProxy(options, configProxy, location, isRedirect, configHttpsAgent, configHttpAgent) {
  let proxy = configProxy;
  const proxyEnvAgent = getProxyEnvAgent(options, configHttpAgent, configHttpsAgent);
  if (!proxy && proxy !== false && !isNodeEnvProxyEnabled(proxyEnvAgent)) {
    const proxyUrl = getProxyForUrl(location);
    if (proxyUrl) {
      if (!shouldBypassProxy(location)) {
        proxy = new URL(proxyUrl);
      }
    }
  }
  if (isRedirect && options.headers) {
    for (const name of Object.keys(options.headers)) {
      if (name.toLowerCase() === "proxy-authorization") {
        delete options.headers[name];
      }
    }
  }
  if (isRedirect && options.agent && options.agent[kAxiosInstalledTunnel]) {
    options.agent = void 0;
  }
  if (proxy) {
    const isProxyURL = proxy instanceof URL;
    const readProxyField = (key) => isProxyURL || utils$1.hasOwnProp(proxy, key) ? proxy[key] : void 0;
    const proxyUsername = readProxyField("username");
    const proxyPassword = readProxyField("password");
    let proxyAuth = utils$1.hasOwnProp(proxy, "auth") ? proxy.auth : void 0;
    if (proxyUsername) {
      proxyAuth = (proxyUsername || "") + ":" + (proxyPassword || "");
    }
    if (proxyAuth) {
      const authIsObject = typeof proxyAuth === "object";
      const authUsername = authIsObject && utils$1.hasOwnProp(proxyAuth, "username") ? proxyAuth.username : void 0;
      const authPassword = authIsObject && utils$1.hasOwnProp(proxyAuth, "password") ? proxyAuth.password : void 0;
      const validProxyAuth = Boolean(authUsername || authPassword);
      if (validProxyAuth) {
        proxyAuth = (authUsername || "") + ":" + (authPassword || "");
      } else if (authIsObject) {
        throw new AxiosError$1("Invalid proxy authorization", AxiosError$1.ERR_BAD_OPTION, { proxy });
      }
    }
    const targetIsHttps = isHttps.test(options.protocol);
    if (targetIsHttps) {
      if (!(configHttpsAgent instanceof HttpsProxyAgent)) {
        const proxyHost = readProxyField("hostname") || readProxyField("host");
        const proxyPort = readProxyField("port");
        const rawProxyProtocol = readProxyField("protocol");
        const normalizedProtocol = rawProxyProtocol ? rawProxyProtocol.includes(":") ? rawProxyProtocol : `${rawProxyProtocol}:` : "http:";
        const proxyHostForURL = proxyHost && proxyHost.includes(":") && !proxyHost.startsWith("[") ? `[${proxyHost}]` : proxyHost;
        const proxyURL = new URL(
          `${normalizedProtocol}//${proxyHostForURL}${proxyPort ? ":" + proxyPort : ""}`
        );
        const agentOptions = {
          protocol: proxyURL.protocol,
          hostname: proxyURL.hostname.replace(/^\[|\]$/g, ""),
          port: proxyURL.port,
          auth: proxyAuth && typeof proxyAuth === "string" ? proxyAuth : void 0
        };
        if (proxyURL.protocol === "https:") {
          agentOptions.ALPNProtocols = ["http/1.1"];
        }
        const tunnelingAgent = getTunnelingAgent(agentOptions, configHttpsAgent);
        options.agent = tunnelingAgent;
        if (options.agents) {
          options.agents.https = tunnelingAgent;
        }
      }
    } else {
      if (proxyAuth) {
        const base64 = Buffer.from(proxyAuth, "utf8").toString("base64");
        options.headers["Proxy-Authorization"] = "Basic " + base64;
      }
      let hasUserHostHeader = false;
      for (const name of Object.keys(options.headers)) {
        if (name.toLowerCase() === "host") {
          hasUserHostHeader = true;
          break;
        }
      }
      if (!hasUserHostHeader) {
        options.headers.host = options.hostname + (options.port ? ":" + options.port : "");
      }
      const proxyHost = readProxyField("hostname") || readProxyField("host");
      options.hostname = proxyHost;
      options.host = proxyHost;
      options.port = readProxyField("port");
      options.path = location;
      const proxyProtocol = readProxyField("protocol");
      if (proxyProtocol) {
        options.protocol = proxyProtocol.includes(":") ? proxyProtocol : `${proxyProtocol}:`;
      }
    }
  }
  options.beforeRedirects.proxy = function beforeRedirect(redirectOptions) {
    setProxy(
      redirectOptions,
      configProxy,
      redirectOptions.href,
      true,
      configHttpsAgent,
      configHttpAgent
    );
  };
}
const isHttpAdapterSupported = typeof process !== "undefined" && utils$1.kindOf(process) === "process";
const wrapAsync = (asyncExecutor) => {
  return new Promise((resolve2, reject) => {
    let onDone;
    let isDone;
    const done = (value, isRejected) => {
      if (isDone) return;
      isDone = true;
      onDone && onDone(value, isRejected);
    };
    const _resolve = (value) => {
      done(value);
      resolve2(value);
    };
    const _reject = (reason) => {
      done(reason, true);
      reject(reason);
    };
    asyncExecutor(_resolve, _reject, (onDoneHandler) => onDone = onDoneHandler).catch(_reject);
  });
};
const resolveFamily = ({ address, family }) => {
  if (!utils$1.isString(address)) {
    throw TypeError("address must be a string");
  }
  return {
    address,
    family: family || (address.indexOf(".") < 0 ? 6 : 4)
  };
};
const buildAddressEntry = (address, family) => resolveFamily(utils$1.isObject(address) ? address : { address, family });
const http2Transport = {
  request(options, cb) {
    const authority = options.protocol + "//" + options.hostname + ":" + (options.port || (options.protocol === "https:" ? 443 : 80));
    const { http2Options, headers } = options;
    const session2 = http2Sessions.getSession(authority, http2Options);
    const { HTTP2_HEADER_SCHEME, HTTP2_HEADER_METHOD, HTTP2_HEADER_PATH, HTTP2_HEADER_STATUS } = http2.constants;
    const http2Headers = {
      [HTTP2_HEADER_SCHEME]: options.protocol.replace(":", ""),
      [HTTP2_HEADER_METHOD]: options.method,
      [HTTP2_HEADER_PATH]: options.path
    };
    utils$1.forEach(headers, (header, name) => {
      name.charAt(0) !== ":" && (http2Headers[name] = header);
    });
    const req = session2.request(http2Headers);
    req.once("response", (responseHeaders) => {
      const response = req;
      responseHeaders = Object.assign({}, responseHeaders);
      const status = responseHeaders[HTTP2_HEADER_STATUS];
      delete responseHeaders[HTTP2_HEADER_STATUS];
      response.headers = responseHeaders;
      response.statusCode = +status;
      cb(response);
    });
    return req;
  }
};
const httpAdapter = isHttpAdapterSupported && function httpAdapter2(config) {
  return wrapAsync(async function dispatchHttpRequest(resolve2, reject, onDone) {
    const own2 = (key) => utils$1.getSafeProp(config, key);
    const transitional2 = own2("transitional") || transitionalDefaults;
    let data = own2("data");
    let lookup = own2("lookup");
    let family = own2("family");
    let httpVersion = own2("httpVersion");
    if (httpVersion === void 0) httpVersion = 1;
    let http2Options = own2("http2Options");
    const httpAgent = own2("httpAgent");
    const httpsAgent = own2("httpsAgent");
    const configProxy = own2("proxy");
    const responseType = own2("responseType");
    const responseEncoding = own2("responseEncoding");
    const socketPath = own2("socketPath");
    const method = own2("method").toUpperCase();
    const maxRedirects = own2("maxRedirects");
    const maxBodyLength = own2("maxBodyLength");
    const maxContentLength = own2("maxContentLength");
    const decompress = own2("decompress");
    let isDone;
    let rejected = false;
    let req;
    let connectPhaseTimer;
    httpVersion = +httpVersion;
    if (Number.isNaN(httpVersion)) {
      throw TypeError(`Invalid protocol version: '${config.httpVersion}' is not a number`);
    }
    if (httpVersion !== 1 && httpVersion !== 2) {
      throw TypeError(`Unsupported protocol version '${httpVersion}'`);
    }
    const isHttp2 = httpVersion === 2;
    if (lookup) {
      const _lookup = callbackify(lookup, (value) => utils$1.isArray(value) ? value : [value]);
      lookup = (hostname2, opt, cb) => {
        _lookup(hostname2, opt, (err, arg0, arg1) => {
          if (err) {
            return cb(err);
          }
          const addresses = utils$1.isArray(arg0) ? arg0.map((addr) => buildAddressEntry(addr)) : [buildAddressEntry(arg0, arg1)];
          opt.all ? cb(err, addresses) : cb(err, addresses[0].address, addresses[0].family);
        });
      };
    }
    const abortEmitter = new EventEmitter();
    function abort(reason) {
      try {
        abortEmitter.emit(
          "abort",
          !reason || reason.type ? new CanceledError$1(null, config, req) : reason
        );
      } catch (err) {
      }
    }
    function clearConnectPhaseTimer() {
      if (connectPhaseTimer) {
        clearTimeout(connectPhaseTimer);
        connectPhaseTimer = null;
      }
    }
    function createTimeoutError() {
      const configTimeout = own2("timeout");
      let timeoutErrorMessage = configTimeout ? "timeout of " + configTimeout + "ms exceeded" : "timeout exceeded";
      const configTimeoutErrorMessage = own2("timeoutErrorMessage");
      if (configTimeoutErrorMessage) {
        timeoutErrorMessage = configTimeoutErrorMessage;
      }
      return new AxiosError$1(
        timeoutErrorMessage,
        transitional2.clarifyTimeoutError ? AxiosError$1.ETIMEDOUT : AxiosError$1.ECONNABORTED,
        config,
        req
      );
    }
    abortEmitter.once("abort", reject);
    const onFinished = () => {
      clearConnectPhaseTimer();
      if (config.cancelToken) {
        config.cancelToken.unsubscribe(abort);
      }
      if (config.signal) {
        config.signal.removeEventListener("abort", abort);
      }
      abortEmitter.removeAllListeners();
    };
    if (config.cancelToken || config.signal) {
      config.cancelToken && config.cancelToken.subscribe(abort);
      if (config.signal) {
        config.signal.aborted ? abort() : config.signal.addEventListener("abort", abort);
      }
    }
    onDone((response, isRejected) => {
      isDone = true;
      clearConnectPhaseTimer();
      if (isRejected) {
        rejected = true;
        onFinished();
        return;
      }
      const { data: data2 } = response;
      if (data2 instanceof stream.Readable || data2 instanceof stream.Duplex) {
        const offListeners = stream.finished(data2, () => {
          offListeners();
          onFinished();
        });
      } else {
        onFinished();
      }
    });
    const fullPath = buildFullPath(own2("baseURL"), own2("url"), own2("allowAbsoluteUrls"), config);
    const urlBase = socketPath ? "http://localhost" : platform.hasBrowserEnv ? platform.origin : void 0;
    const parsed = new URL(fullPath, urlBase);
    const protocol2 = parsed.protocol || supportedProtocols[0];
    if (protocol2 === "data:") {
      if (maxContentLength > -1) {
        const dataUrl = String(own2("url") || fullPath || "");
        const estimated = estimateDataURLBufferAllocation(dataUrl);
        if (estimated > maxContentLength) {
          return reject(
            new AxiosError$1(
              "maxContentLength size of " + maxContentLength + " exceeded",
              AxiosError$1.ERR_BAD_RESPONSE,
              config
            )
          );
        }
      }
      let convertedData;
      if (method !== "GET") {
        return settle(resolve2, reject, {
          status: 405,
          statusText: "method not allowed",
          headers: {},
          config
        });
      }
      try {
        convertedData = fromDataURI(own2("url"), responseType === "blob", {
          Blob: config.env && config.env.Blob
        });
      } catch (err) {
        throw AxiosError$1.from(err, AxiosError$1.ERR_BAD_REQUEST, config);
      }
      if (responseType === "text") {
        convertedData = convertedData.toString(responseEncoding);
        if (!responseEncoding || responseEncoding === "utf8") {
          convertedData = utils$1.stripBOM(convertedData);
        }
      } else if (responseType === "stream") {
        convertedData = stream.Readable.from(convertedData);
      }
      return settle(resolve2, reject, {
        data: convertedData,
        status: 200,
        statusText: "OK",
        headers: new AxiosHeaders$1(),
        config
      });
    }
    if (supportedProtocols.indexOf(protocol2) === -1) {
      return reject(
        new AxiosError$1("Unsupported protocol " + protocol2, AxiosError$1.ERR_BAD_REQUEST, config)
      );
    }
    const headers = AxiosHeaders$1.from(config.headers).normalize();
    headers.set("User-Agent", "axios/" + VERSION$1, false);
    const { onUploadProgress, onDownloadProgress } = config;
    const maxRate = config.maxRate;
    let maxUploadRate = void 0;
    let maxDownloadRate = void 0;
    if (utils$1.isSpecCompliantForm(data)) {
      const userBoundary = headers.getContentType(/boundary=([-_\w\d]{10,70})/i);
      data = formDataToStream(
        data,
        (formHeaders) => {
          headers.set(formHeaders);
        },
        {
          tag: `axios-${VERSION$1}-boundary`,
          boundary: userBoundary && userBoundary[1] || void 0
        }
      );
    } else if (utils$1.isFormData(data) && utils$1.isFunction(data.getHeaders) && data.getHeaders !== Object.prototype.getHeaders) {
      setFormDataHeaders(headers, data.getHeaders(), own2("formDataHeaderPolicy"));
      if (!headers.hasContentLength()) {
        try {
          const knownLength = await require$$1.promisify(data.getLength).call(data);
          Number.isFinite(knownLength) && knownLength >= 0 && headers.setContentLength(knownLength);
        } catch (e) {
        }
      }
    } else if (utils$1.isBlob(data) || utils$1.isFile(data)) {
      data.size && headers.setContentType(data.type || "application/octet-stream");
      headers.setContentLength(data.size || 0);
      data = stream.Readable.from(readBlob(data));
    } else if (data && !utils$1.isStream(data)) {
      if (Buffer.isBuffer(data)) ;
      else if (utils$1.isArrayBuffer(data)) {
        data = Buffer.from(new Uint8Array(data));
      } else if (utils$1.isString(data)) {
        data = Buffer.from(data, "utf-8");
      } else {
        return reject(
          new AxiosError$1(
            "Data after transformation must be a string, an ArrayBuffer, a Buffer, or a Stream",
            AxiosError$1.ERR_BAD_REQUEST,
            config
          )
        );
      }
      headers.setContentLength(data.length, false);
      if (maxBodyLength > -1 && data.length > maxBodyLength) {
        return reject(
          new AxiosError$1(
            "Request body larger than maxBodyLength limit",
            AxiosError$1.ERR_BAD_REQUEST,
            config
          )
        );
      }
    }
    const contentLength = utils$1.toFiniteNumber(headers.getContentLength());
    if (utils$1.isArray(maxRate)) {
      maxUploadRate = maxRate[0];
      maxDownloadRate = maxRate[1];
    } else {
      maxUploadRate = maxDownloadRate = maxRate;
    }
    if (data && (onUploadProgress || maxUploadRate)) {
      if (!utils$1.isStream(data)) {
        data = stream.Readable.from(data, { objectMode: false });
      }
      data = stream.pipeline(
        [
          data,
          new AxiosTransformStream({
            maxRate: utils$1.toFiniteNumber(maxUploadRate)
          })
        ],
        utils$1.noop
      );
      onUploadProgress && data.on(
        "progress",
        flushOnFinish(
          data,
          progressEventDecorator(
            contentLength,
            progressEventReducer(asyncDecorator(onUploadProgress, scheduleProgress), false, 3)
          )
        )
      );
    }
    let auth = void 0;
    const configAuth = own2("auth");
    if (configAuth) {
      const username = utils$1.getSafeProp(configAuth, "username") || "";
      const password = utils$1.getSafeProp(configAuth, "password") || "";
      auth = username + ":" + password;
    }
    if (!auth && (parsed.username || parsed.password)) {
      const urlUsername = decodeURIComponentSafe$1(parsed.username);
      const urlPassword = decodeURIComponentSafe$1(parsed.password);
      auth = urlUsername + ":" + urlPassword;
    }
    auth && headers.delete("authorization");
    let path;
    try {
      path = buildURL(
        parsed.pathname + parsed.search,
        own2("params"),
        own2("paramsSerializer")
      ).replace(/^\?/, "");
    } catch (err) {
      return reject(
        AxiosError$1.from(err, AxiosError$1.ERR_BAD_REQUEST, config, null, null, {
          url: own2("url"),
          exists: true
        })
      );
    }
    headers.set(
      "Accept-Encoding",
      utils$1.hasOwnProp(transitional2, "advertiseZstdAcceptEncoding") && transitional2.advertiseZstdAcceptEncoding === true ? ACCEPT_ENCODING_WITH_ZSTD : ACCEPT_ENCODING,
      false
    );
    const options = Object.assign(/* @__PURE__ */ Object.create(null), {
      path,
      method,
      headers: toByteStringHeaderObject(headers),
      agents: { http: httpAgent, https: httpsAgent },
      auth,
      protocol: protocol2,
      family,
      beforeRedirect: dispatchBeforeRedirect,
      beforeRedirects: /* @__PURE__ */ Object.create(null),
      http2Options
    });
    !utils$1.isUndefined(lookup) && (options.lookup = lookup);
    if (socketPath) {
      if (typeof socketPath !== "string") {
        return reject(
          new AxiosError$1("socketPath must be a string", AxiosError$1.ERR_BAD_OPTION_VALUE, config)
        );
      }
      const allowedSocketPaths = own2("allowedSocketPaths");
      if (allowedSocketPaths != null) {
        const allowed = Array.isArray(allowedSocketPaths) ? allowedSocketPaths : [allowedSocketPaths];
        const resolvedSocket = resolve$1(socketPath);
        const isAllowed = allowed.some(
          (entry) => typeof entry === "string" && resolve$1(entry) === resolvedSocket
        );
        if (!isAllowed) {
          return reject(
            new AxiosError$1(
              `socketPath "${socketPath}" is not permitted by allowedSocketPaths`,
              AxiosError$1.ERR_BAD_OPTION_VALUE,
              config
            )
          );
        }
      }
      options.socketPath = socketPath;
    } else {
      options.hostname = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
      options.port = parsed.port;
      setProxy(
        options,
        configProxy,
        protocol2 + "//" + parsed.hostname + (parsed.port ? ":" + parsed.port : "") + options.path,
        false,
        httpsAgent,
        httpAgent
      );
    }
    let transport;
    let isNativeTransport = false;
    let transportEnforcesMaxBodyLength = false;
    const isHttpsRequest = isHttps.test(options.protocol);
    if (options.agent == null) {
      options.agent = isHttpsRequest ? httpsAgent : httpAgent;
    }
    if (isHttp2) {
      transport = http2Transport;
    } else {
      const configTransport = own2("transport");
      if (configTransport) {
        transport = configTransport;
      } else if (maxRedirects === 0) {
        transport = isHttpsRequest ? https : http$a;
        isNativeTransport = true;
      } else {
        transportEnforcesMaxBodyLength = true;
        options.sensitiveHeaders = [];
        if (maxRedirects) {
          options.maxRedirects = maxRedirects;
        }
        const configBeforeRedirect = own2("beforeRedirect");
        if (configBeforeRedirect) {
          options.beforeRedirects.config = configBeforeRedirect;
        }
        if (auth) {
          const requestOrigin = parsed.origin;
          const authToRestore = auth;
          options.beforeRedirects.auth = function beforeRedirectAuth(redirectOptions) {
            try {
              if (new URL(redirectOptions.href).origin === requestOrigin) {
                redirectOptions.auth = authToRestore;
              }
            } catch (e) {
            }
          };
        }
        const sensitiveHeaders = own2("sensitiveHeaders");
        if (sensitiveHeaders != null) {
          if (!utils$1.isArray(sensitiveHeaders)) {
            return reject(
              new AxiosError$1(
                "sensitiveHeaders must be an array of strings",
                AxiosError$1.ERR_BAD_OPTION_VALUE,
                config
              )
            );
          }
          const sensitiveSet = /* @__PURE__ */ new Set();
          for (const header of sensitiveHeaders) {
            if (!utils$1.isString(header)) {
              return reject(
                new AxiosError$1(
                  "sensitiveHeaders must be an array of strings",
                  AxiosError$1.ERR_BAD_OPTION_VALUE,
                  config
                )
              );
            }
            sensitiveSet.add(header.toLowerCase());
          }
          if (sensitiveSet.size) {
            options.sensitiveHeaders = Array.from(sensitiveSet);
            options.beforeRedirects.sensitiveHeaders = function beforeRedirectSensitiveHeaders(redirectOptions, requestDetails) {
              if (!isSameOriginRedirect(redirectOptions, requestDetails)) {
                stripMatchingHeaders(redirectOptions.headers, sensitiveSet);
              }
            };
          }
        }
        transport = isHttpsRequest ? httpsFollow : httpFollow;
      }
    }
    if (maxBodyLength > -1) {
      options.maxBodyLength = maxBodyLength;
    } else {
      options.maxBodyLength = Infinity;
    }
    options.insecureHTTPParser = Boolean(own2("insecureHTTPParser"));
    req = transport.request(options, function handleResponse(res) {
      clearConnectPhaseTimer();
      if (req.destroyed) return;
      const streams = [res];
      const responseLength = utils$1.toFiniteNumber(res.headers["content-length"]);
      if (onDownloadProgress || maxDownloadRate) {
        const transformStream = new AxiosTransformStream({
          maxRate: utils$1.toFiniteNumber(maxDownloadRate)
        });
        onDownloadProgress && transformStream.on(
          "progress",
          flushOnFinish(
            transformStream,
            progressEventDecorator(
              responseLength,
              progressEventReducer(asyncDecorator(onDownloadProgress, scheduleProgress), true, 3)
            )
          )
        );
        streams.push(transformStream);
      }
      let responseStream = res;
      const lastRequest = res.req || req;
      if (decompress !== false && res.headers["content-encoding"]) {
        if (method === "HEAD" || res.statusCode === 204) {
          delete res.headers["content-encoding"];
        }
        switch ((res.headers["content-encoding"] || "").toLowerCase()) {
          /*eslint default-case:0*/
          case "gzip":
          case "x-gzip":
          case "compress":
          case "x-compress":
            streams.push(zlib.createUnzip(zlibOptions));
            delete res.headers["content-encoding"];
            break;
          case "deflate":
            streams.push(new ZlibHeaderTransformStream());
            streams.push(zlib.createUnzip(zlibOptions));
            delete res.headers["content-encoding"];
            break;
          case "br":
            if (isBrotliSupported) {
              streams.push(zlib.createBrotliDecompress(brotliOptions));
              delete res.headers["content-encoding"];
            }
            break;
          case "zstd":
            if (isZstdSupported) {
              streams.push(zlib.createZstdDecompress(zstdOptions));
              delete res.headers["content-encoding"];
            }
            break;
        }
      }
      responseStream = streams.length > 1 ? stream.pipeline(streams, utils$1.noop) : streams[0];
      const response = {
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: new AxiosHeaders$1(res.headers),
        config,
        request: lastRequest
      };
      if (responseType === "stream") {
        if (maxContentLength > -1) {
          const limit = maxContentLength;
          const source = responseStream;
          async function* enforceMaxContentLength() {
            let totalResponseBytes = 0;
            for await (const chunk of source) {
              totalResponseBytes += chunk.length;
              if (totalResponseBytes > limit) {
                throw new AxiosError$1(
                  "maxContentLength size of " + limit + " exceeded",
                  AxiosError$1.ERR_BAD_RESPONSE,
                  config,
                  lastRequest
                );
              }
              yield chunk;
            }
          }
          responseStream = stream.Readable.from(enforceMaxContentLength(), {
            objectMode: false
          });
        }
        response.data = responseStream;
        settle(resolve2, reject, response);
      } else {
        const responseBuffer = [];
        let totalResponseBytes = 0;
        responseStream.on("data", function handleStreamData(chunk) {
          responseBuffer.push(chunk);
          totalResponseBytes += chunk.length;
          if (maxContentLength > -1 && totalResponseBytes > maxContentLength) {
            rejected = true;
            responseStream.destroy();
            abort(
              new AxiosError$1(
                "maxContentLength size of " + maxContentLength + " exceeded",
                AxiosError$1.ERR_BAD_RESPONSE,
                config,
                lastRequest
              )
            );
          }
        });
        responseStream.on("aborted", function handlerStreamAborted() {
          if (rejected) {
            return;
          }
          const err = new AxiosError$1(
            "stream has been aborted",
            AxiosError$1.ERR_BAD_RESPONSE,
            config,
            lastRequest,
            response
          );
          responseStream.destroy(err);
          reject(err);
        });
        responseStream.on("error", function handleStreamError(err) {
          if (rejected) return;
          reject(AxiosError$1.from(err, null, config, lastRequest, response));
        });
        responseStream.on("end", function handleStreamEnd() {
          try {
            let responseData = responseBuffer.length === 1 ? responseBuffer[0] : Buffer.concat(responseBuffer);
            if (responseType !== "arraybuffer") {
              responseData = responseData.toString(responseEncoding);
              if (!responseEncoding || responseEncoding === "utf8") {
                responseData = utils$1.stripBOM(responseData);
              }
            }
            response.data = responseData;
          } catch (err) {
            return reject(AxiosError$1.from(err, null, config, response.request, response));
          }
          settle(resolve2, reject, response);
        });
      }
      abortEmitter.once("abort", (err) => {
        if (!responseStream.destroyed) {
          responseStream.emit("error", err);
          responseStream.destroy();
        }
      });
    });
    abortEmitter.once("abort", (err) => {
      if (req.close) {
        req.close();
      } else {
        req.destroy(err);
      }
    });
    req.on("error", function handleRequestError(err) {
      reject(AxiosError$1.from(err, null, config, req));
    });
    const boundSockets = /* @__PURE__ */ new Set();
    req.on("socket", function handleRequestSocket(socket) {
      if (typeof socket.setKeepAlive === "function") {
        socket.setKeepAlive(true, 1e3 * 60);
      }
      if (!socket[kAxiosSocketListener]) {
        socket.on("error", function handleSocketError(err) {
          const current = socket[kAxiosCurrentReq];
          if (current && !current.destroyed) {
            current.destroy(err);
          }
        });
        socket[kAxiosSocketListener] = true;
      }
      socket[kAxiosCurrentReq] = req;
      boundSockets.add(socket);
    });
    req.once("close", function clearCurrentReq() {
      clearConnectPhaseTimer();
      for (const socket of boundSockets) {
        if (socket[kAxiosCurrentReq] === req) {
          socket[kAxiosCurrentReq] = null;
        }
      }
      boundSockets.clear();
    });
    if (own2("timeout")) {
      const timeout = parseInt(own2("timeout"), 10);
      if (Number.isNaN(timeout)) {
        abort(
          new AxiosError$1(
            "error trying to parse `config.timeout` to int",
            AxiosError$1.ERR_BAD_OPTION_VALUE,
            config,
            req
          )
        );
        return;
      }
      const handleTimeout = function handleTimeout2() {
        if (isDone) return;
        abort(createTimeoutError());
      };
      if (isNativeTransport && timeout > 0) {
        connectPhaseTimer = setTimeout(handleTimeout, timeout);
      }
      req.setTimeout(timeout, handleTimeout);
    } else {
      req.setTimeout(0);
    }
    if (utils$1.isStream(data)) {
      let ended = false;
      let errored = false;
      data.on("end", () => {
        ended = true;
      });
      data.once("error", (err) => {
        errored = true;
        req.destroy(err);
      });
      data.on("close", () => {
        if (!ended && !errored) {
          abort(new CanceledError$1("Request stream has been aborted", config, req));
        }
      });
      let uploadStream = data;
      if (maxBodyLength > -1 && !transportEnforcesMaxBodyLength) {
        const limit = maxBodyLength;
        let bytesSent = 0;
        uploadStream = stream.pipeline(
          [
            data,
            new stream.Transform({
              transform(chunk, _enc, cb) {
                bytesSent += chunk.length;
                if (bytesSent > limit) {
                  return cb(
                    new AxiosError$1(
                      "Request body larger than maxBodyLength limit",
                      AxiosError$1.ERR_BAD_REQUEST,
                      config,
                      req
                    )
                  );
                }
                cb(null, chunk);
              }
            })
          ],
          utils$1.noop
        );
        uploadStream.on("error", (err) => {
          if (!req.destroyed) req.destroy(err);
        });
      }
      uploadStream.pipe(req);
    } else {
      data && req.write(data);
      req.end();
    }
  });
};
const isURLSameOrigin = platform.hasStandardBrowserEnv ? /* @__PURE__ */ ((origin2, isMSIE) => (url) => {
  url = new URL(url, platform.origin);
  return origin2.protocol === url.protocol && origin2.host === url.host && (isMSIE || origin2.port === url.port);
})(
  new URL(platform.origin),
  platform.navigator && /(msie|trident)/i.test(platform.navigator.userAgent)
) : () => true;
const cookies = platform.hasStandardBrowserEnv ? (
  // Standard browser envs support document.cookie
  {
    write(name, value, expires, path, domain, secure, sameSite) {
      if (typeof document === "undefined") return;
      const cookie = [`${name}=${encodeURIComponent(value)}`];
      if (utils$1.isNumber(expires)) {
        cookie.push(`expires=${new Date(expires).toUTCString()}`);
      }
      if (utils$1.isString(path)) {
        cookie.push(`path=${path}`);
      }
      if (utils$1.isString(domain)) {
        cookie.push(`domain=${domain}`);
      }
      if (secure === true) {
        cookie.push("secure");
      }
      if (utils$1.isString(sameSite)) {
        cookie.push(`SameSite=${sameSite}`);
      }
      document.cookie = cookie.join("; ");
    },
    read(name) {
      if (typeof document === "undefined") return null;
      const cookies2 = document.cookie.split(";");
      for (let i = 0; i < cookies2.length; i++) {
        const cookie = cookies2[i].replace(/^\s+/, "");
        const eq = cookie.indexOf("=");
        if (eq !== -1 && cookie.slice(0, eq) === name) {
          try {
            return decodeURIComponent(cookie.slice(eq + 1));
          } catch (e) {
            return cookie.slice(eq + 1);
          }
        }
      }
      return null;
    },
    remove(name) {
      this.write(name, "", Date.now() - 864e5, "/");
    }
  }
) : (
  // Non-standard browser env (web workers, react-native) lack needed support.
  {
    write() {
    },
    read() {
      return null;
    },
    remove() {
    }
  }
);
const headersToObject = (thing) => thing instanceof AxiosHeaders$1 ? { ...thing } : thing;
const ownEnumerableKeys = (thing) => {
  if (Object.getOwnPropertySymbols && Object.getOwnPropertyDescriptor) {
    return Object.keys(thing).concat(
      Object.getOwnPropertySymbols(thing).filter(
        (symbol) => Object.getOwnPropertyDescriptor(thing, symbol).enumerable
      )
    );
  }
  return Object.keys(thing);
};
function mergeConfig$1(config1, config2) {
  config1 = config1 || {};
  config2 = config2 || {};
  const config = /* @__PURE__ */ Object.create(null);
  Object.defineProperty(config, "hasOwnProperty", {
    // Null-proto descriptor so a polluted Object.prototype.get cannot turn
    // this data descriptor into an accessor descriptor on the way in.
    __proto__: null,
    value: Object.prototype.hasOwnProperty,
    enumerable: false,
    writable: true,
    configurable: true
  });
  function getMergedValue(target, source, prop, caseless) {
    if (utils$1.isPlainObject(target) && utils$1.isPlainObject(source)) {
      return utils$1.merge.call({ caseless }, target, source);
    } else if (utils$1.isPlainObject(source)) {
      return utils$1.merge({}, source);
    } else if (utils$1.isArray(source)) {
      return source.slice();
    }
    return source;
  }
  function mergeDeepProperties(a, b, prop, caseless) {
    if (!utils$1.isUndefined(b)) {
      return getMergedValue(a, b, prop, caseless);
    } else if (!utils$1.isUndefined(a)) {
      return getMergedValue(void 0, a, prop, caseless);
    }
  }
  function valueFromConfig2(a, b) {
    if (!utils$1.isUndefined(b)) {
      return getMergedValue(void 0, b);
    }
  }
  function defaultToConfig2(a, b) {
    if (!utils$1.isUndefined(b)) {
      return getMergedValue(void 0, b);
    } else if (!utils$1.isUndefined(a)) {
      return getMergedValue(void 0, a);
    }
  }
  function getMergedTransitionalOption(prop) {
    const transitional2 = utils$1.hasOwnProp(config2, "transitional") ? config2.transitional : void 0;
    if (!utils$1.isUndefined(transitional2)) {
      if (utils$1.isPlainObject(transitional2)) {
        if (utils$1.hasOwnProp(transitional2, prop)) {
          return transitional2[prop];
        }
      } else {
        return void 0;
      }
    }
    const transitional1 = utils$1.hasOwnProp(config1, "transitional") ? config1.transitional : void 0;
    if (utils$1.isPlainObject(transitional1) && utils$1.hasOwnProp(transitional1, prop)) {
      return transitional1[prop];
    }
    return void 0;
  }
  function mergeDirectKeys(a, b, prop) {
    if (utils$1.hasOwnProp(config2, prop)) {
      return getMergedValue(a, b);
    } else if (utils$1.hasOwnProp(config1, prop)) {
      return getMergedValue(void 0, a);
    }
  }
  const mergeMap = {
    url: valueFromConfig2,
    method: valueFromConfig2,
    data: valueFromConfig2,
    baseURL: defaultToConfig2,
    transformRequest: defaultToConfig2,
    transformResponse: defaultToConfig2,
    paramsSerializer: defaultToConfig2,
    timeout: defaultToConfig2,
    timeoutMessage: defaultToConfig2,
    withCredentials: defaultToConfig2,
    withXSRFToken: defaultToConfig2,
    adapter: defaultToConfig2,
    responseType: defaultToConfig2,
    xsrfCookieName: defaultToConfig2,
    xsrfHeaderName: defaultToConfig2,
    onUploadProgress: defaultToConfig2,
    onDownloadProgress: defaultToConfig2,
    decompress: defaultToConfig2,
    maxContentLength: defaultToConfig2,
    maxBodyLength: defaultToConfig2,
    beforeRedirect: defaultToConfig2,
    transport: defaultToConfig2,
    httpAgent: defaultToConfig2,
    httpsAgent: defaultToConfig2,
    cancelToken: defaultToConfig2,
    socketPath: defaultToConfig2,
    allowedSocketPaths: defaultToConfig2,
    responseEncoding: defaultToConfig2,
    validateStatus: mergeDirectKeys,
    headers: (a, b, prop) => mergeDeepProperties(headersToObject(a), headersToObject(b), prop, true)
  };
  utils$1.forEach(ownEnumerableKeys({ ...config1, ...config2 }), function computeConfigValue(prop) {
    if (prop === "__proto__" || prop === "constructor" || prop === "prototype") return;
    const merge2 = utils$1.hasOwnProp(mergeMap, prop) ? mergeMap[prop] : mergeDeepProperties;
    const a = utils$1.hasOwnProp(config1, prop) ? config1[prop] : void 0;
    const b = utils$1.hasOwnProp(config2, prop) ? config2[prop] : void 0;
    const configValue = merge2(a, b, prop);
    utils$1.isUndefined(configValue) && merge2 !== mergeDirectKeys || (config[prop] = configValue);
  });
  if (utils$1.hasOwnProp(config2, "validateStatus") && utils$1.isUndefined(config2.validateStatus) && getMergedTransitionalOption("validateStatusUndefinedResolves") === false) {
    if (utils$1.hasOwnProp(config1, "validateStatus")) {
      config.validateStatus = getMergedValue(void 0, config1.validateStatus);
    } else {
      delete config.validateStatus;
    }
  }
  return config;
}
const encodeUTF8$1 = (str) => encodeURIComponent(str).replace(
  /%([0-9A-F]{2})/gi,
  (_, hex) => String.fromCharCode(parseInt(hex, 16))
);
function resolveConfig(config) {
  const newConfig = mergeConfig$1({}, config);
  const own2 = (key) => utils$1.hasOwnProp(newConfig, key) ? newConfig[key] : void 0;
  const data = own2("data");
  let withXSRFToken = own2("withXSRFToken");
  const xsrfHeaderName = own2("xsrfHeaderName");
  const xsrfCookieName = own2("xsrfCookieName");
  let headers = own2("headers");
  const auth = own2("auth");
  const baseURL = own2("baseURL");
  const allowAbsoluteUrls = own2("allowAbsoluteUrls");
  const url = own2("url");
  newConfig.headers = headers = AxiosHeaders$1.from(headers);
  newConfig.url = buildURL(
    buildFullPath(baseURL, url, allowAbsoluteUrls, newConfig),
    own2("params"),
    own2("paramsSerializer")
  );
  if (auth) {
    const username = utils$1.getSafeProp(auth, "username") || "";
    const password = utils$1.getSafeProp(auth, "password") || "";
    try {
      headers.set(
        "Authorization",
        "Basic " + btoa(username + ":" + (password ? encodeUTF8$1(password) : ""))
      );
    } catch (e) {
      throw AxiosError$1.from(e, AxiosError$1.ERR_BAD_OPTION_VALUE, config);
    }
  }
  if (utils$1.isFormData(data)) {
    if (platform.hasStandardBrowserEnv || platform.hasStandardBrowserWebWorkerEnv || utils$1.isReactNative(data)) {
      headers.setContentType(void 0);
    } else if (utils$1.isFunction(data.getHeaders)) {
      setFormDataHeaders(headers, data.getHeaders(), own2("formDataHeaderPolicy"));
    }
  }
  if (platform.hasStandardBrowserEnv) {
    if (utils$1.isFunction(withXSRFToken)) {
      withXSRFToken = withXSRFToken(newConfig);
    }
    const shouldSendXSRF = withXSRFToken === true || withXSRFToken == null && isURLSameOrigin(newConfig.url);
    if (shouldSendXSRF) {
      const xsrfValue = xsrfHeaderName && xsrfCookieName && cookies.read(xsrfCookieName);
      if (xsrfValue) {
        headers.set(xsrfHeaderName, xsrfValue);
      }
    }
  }
  return newConfig;
}
const isXHRAdapterSupported = typeof XMLHttpRequest !== "undefined";
const xhrAdapter = isXHRAdapterSupported && function(config) {
  return new Promise(function dispatchXhrRequest(resolve2, reject) {
    const _config = resolveConfig(config);
    let requestData = _config.data;
    const requestHeaders = AxiosHeaders$1.from(_config.headers).normalize();
    let { responseType, onUploadProgress, onDownloadProgress } = _config;
    let onCanceled;
    let uploadThrottled, downloadThrottled;
    let flushUpload, flushDownload;
    function done() {
      flushUpload && flushUpload();
      flushDownload && flushDownload();
      _config.cancelToken && _config.cancelToken.unsubscribe(onCanceled);
      _config.signal && _config.signal.removeEventListener("abort", onCanceled);
    }
    let request = new XMLHttpRequest();
    request.open(_config.method.toUpperCase(), _config.url, true);
    request.timeout = _config.timeout;
    function onloadend() {
      if (!request) {
        return;
      }
      const responseHeaders = AxiosHeaders$1.from(
        "getAllResponseHeaders" in request && request.getAllResponseHeaders()
      );
      const responseData = !responseType || responseType === "text" || responseType === "json" ? request.responseText : request.response;
      const response = {
        data: responseData,
        status: request.status,
        statusText: request.statusText,
        headers: responseHeaders,
        config,
        request
      };
      settle(
        function _resolve(value) {
          resolve2(value);
          done();
        },
        function _reject(err) {
          reject(err);
          done();
        },
        response
      );
      request = null;
    }
    if ("onloadend" in request) {
      request.onloadend = onloadend;
    } else {
      request.onreadystatechange = function handleLoad() {
        if (!request || request.readyState !== 4) {
          return;
        }
        if (request.status === 0 && !(request.responseURL && request.responseURL.startsWith("file:"))) {
          return;
        }
        setTimeout(onloadend);
      };
    }
    request.onabort = function handleAbort() {
      if (!request) {
        return;
      }
      reject(new AxiosError$1("Request aborted", AxiosError$1.ECONNABORTED, config, request));
      done();
      request = null;
    };
    request.onerror = function handleError(event) {
      const msg = event && event.message ? event.message : "Network Error";
      const err = new AxiosError$1(msg, AxiosError$1.ERR_NETWORK, config, request);
      err.event = event || null;
      reject(err);
      done();
      request = null;
    };
    request.ontimeout = function handleTimeout() {
      let timeoutErrorMessage = _config.timeout ? "timeout of " + _config.timeout + "ms exceeded" : "timeout exceeded";
      const transitional2 = _config.transitional || transitionalDefaults;
      if (_config.timeoutErrorMessage) {
        timeoutErrorMessage = _config.timeoutErrorMessage;
      }
      reject(
        new AxiosError$1(
          timeoutErrorMessage,
          transitional2.clarifyTimeoutError ? AxiosError$1.ETIMEDOUT : AxiosError$1.ECONNABORTED,
          config,
          request
        )
      );
      done();
      request = null;
    };
    requestData === void 0 && requestHeaders.setContentType(null);
    if ("setRequestHeader" in request) {
      utils$1.forEach(toByteStringHeaderObject(requestHeaders), function setRequestHeader(val, key) {
        request.setRequestHeader(key, val);
      });
    }
    if (!utils$1.isUndefined(_config.withCredentials)) {
      request.withCredentials = !!_config.withCredentials;
    }
    if (responseType && responseType !== "json") {
      request.responseType = _config.responseType;
    }
    if (onDownloadProgress) {
      [downloadThrottled, flushDownload] = progressEventReducer(onDownloadProgress, true);
      request.addEventListener("progress", downloadThrottled);
    }
    if (onUploadProgress && request.upload) {
      [uploadThrottled, flushUpload] = progressEventReducer(onUploadProgress);
      request.upload.addEventListener("progress", uploadThrottled);
      request.upload.addEventListener("loadend", flushUpload);
    }
    if (_config.cancelToken || _config.signal) {
      onCanceled = (cancel) => {
        if (!request) {
          return;
        }
        reject(!cancel || cancel.type ? new CanceledError$1(null, config, request) : cancel);
        request.abort();
        done();
        request = null;
      };
      _config.cancelToken && _config.cancelToken.subscribe(onCanceled);
      if (_config.signal) {
        _config.signal.aborted ? onCanceled() : _config.signal.addEventListener("abort", onCanceled);
      }
    }
    const protocol2 = parseProtocol(_config.url);
    if (protocol2 && !platform.protocols.includes(protocol2)) {
      reject(
        new AxiosError$1(
          "Unsupported protocol " + protocol2 + ":",
          AxiosError$1.ERR_BAD_REQUEST,
          config
        )
      );
      done();
      return;
    }
    request.send(requestData || null);
  });
};
const composeSignals = (signals, timeout) => {
  signals = signals ? signals.filter(Boolean) : [];
  if (!timeout && !signals.length) {
    return;
  }
  const controller = new AbortController();
  let aborted = false;
  const onabort = function(reason) {
    if (!aborted) {
      aborted = true;
      unsubscribe();
      const err = reason instanceof Error ? reason : this.reason;
      controller.abort(
        err instanceof AxiosError$1 ? err : new CanceledError$1(err instanceof Error ? err.message : err)
      );
    }
  };
  let timer = timeout && setTimeout(() => {
    timer = null;
    onabort(new AxiosError$1(`timeout of ${timeout}ms exceeded`, AxiosError$1.ETIMEDOUT));
  }, timeout);
  const unsubscribe = () => {
    if (!signals) {
      return;
    }
    timer && clearTimeout(timer);
    timer = null;
    signals.forEach((signal2) => {
      signal2.unsubscribe ? signal2.unsubscribe(onabort) : signal2.removeEventListener("abort", onabort);
    });
    signals = null;
  };
  signals.forEach((signal2) => {
    if (aborted) {
      return;
    }
    if (signal2.aborted) {
      onabort.call(signal2);
      return;
    }
    signal2.addEventListener("abort", onabort, { once: true });
  });
  const { signal } = controller;
  signal.unsubscribe = () => utils$1.asap(unsubscribe);
  return signal;
};
const streamChunk = function* (chunk, chunkSize) {
  let len = chunk.byteLength;
  if (len < chunkSize) {
    yield chunk;
    return;
  }
  let pos = 0;
  let end;
  while (pos < len) {
    end = pos + chunkSize;
    yield chunk.slice(pos, end);
    pos = end;
  }
};
const readBytes = async function* (iterable, chunkSize) {
  for await (const chunk of readStream(iterable)) {
    yield* streamChunk(chunk, chunkSize);
  }
};
const readStream = async function* (stream2) {
  if (stream2[Symbol.asyncIterator]) {
    yield* stream2;
    return;
  }
  const reader = stream2.getReader();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      yield value;
    }
  } finally {
    await reader.cancel();
  }
};
const trackStream = (stream2, chunkSize, onProgress, onFinish) => {
  const iterator2 = readBytes(stream2, chunkSize);
  let bytes = 0;
  let done;
  let _onFinish = (e) => {
    if (!done) {
      done = true;
      onFinish && onFinish(e);
    }
  };
  return new ReadableStream(
    {
      async pull(controller) {
        try {
          const { done: done2, value } = await iterator2.next();
          if (done2) {
            _onFinish();
            controller.close();
            return;
          }
          let len = value.byteLength;
          if (onProgress) {
            let loadedBytes = bytes += len;
            onProgress(loadedBytes);
          }
          controller.enqueue(new Uint8Array(value));
        } catch (err) {
          _onFinish(err);
          throw err;
        }
      },
      cancel(reason) {
        _onFinish(reason);
        return iterator2.return();
      }
    },
    {
      highWaterMark: 2
    }
  );
};
const DEFAULT_CHUNK_SIZE = 64 * 1024;
const { isFunction } = utils$1;
const encodeUTF8 = (str) => encodeURIComponent(str).replace(
  /%([0-9A-F]{2})/gi,
  (_, hex) => String.fromCharCode(parseInt(hex, 16))
);
const decodeURIComponentSafe = (value) => {
  if (!utils$1.isString(value)) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
};
const test = (fn, ...args) => {
  try {
    return !!fn(...args);
  } catch (e) {
    return false;
  }
};
const maybeWithAuthCredentials = (url) => {
  const protocolIndex = url.indexOf("://");
  let urlToCheck = url;
  if (protocolIndex !== -1) {
    urlToCheck = urlToCheck.slice(protocolIndex + 3);
  }
  return urlToCheck.includes("@") || urlToCheck.includes(":");
};
const factory = (env2) => {
  const globalObject = utils$1.global !== void 0 && utils$1.global !== null ? utils$1.global : globalThis;
  const { ReadableStream: ReadableStream2, TextEncoder: TextEncoder2 } = globalObject;
  env2 = utils$1.merge.call(
    {
      skipUndefined: true
    },
    {
      Request: globalObject.Request,
      Response: globalObject.Response
    },
    env2
  );
  const { fetch: envFetch, Request, Response: Response2 } = env2;
  const isFetchSupported = envFetch ? isFunction(envFetch) : typeof fetch === "function";
  const isRequestSupported = isFunction(Request);
  const isResponseSupported = isFunction(Response2);
  if (!isFetchSupported) {
    return false;
  }
  const isReadableStreamSupported = isFetchSupported && isFunction(ReadableStream2);
  const encodeText = isFetchSupported && (typeof TextEncoder2 === "function" ? /* @__PURE__ */ ((encoder) => (str) => encoder.encode(str))(new TextEncoder2()) : async (str) => new Uint8Array(await new Request(str).arrayBuffer()));
  const supportsRequestStream = isRequestSupported && isReadableStreamSupported && test(() => {
    let duplexAccessed = false;
    const request = new Request(platform.origin, {
      body: new ReadableStream2(),
      method: "POST",
      get duplex() {
        duplexAccessed = true;
        return "half";
      }
    });
    const hasContentType = request.headers.has("Content-Type");
    if (request.body != null) {
      request.body.cancel();
    }
    return duplexAccessed && !hasContentType;
  });
  const supportsResponseStream = isResponseSupported && isReadableStreamSupported && test(() => utils$1.isReadableStream(new Response2("").body));
  const resolvers = {
    stream: supportsResponseStream && ((res) => res.body)
  };
  isFetchSupported && (() => {
    ["text", "arrayBuffer", "blob", "formData", "stream"].forEach((type2) => {
      !resolvers[type2] && (resolvers[type2] = (res, config) => {
        let method = res && res[type2];
        if (method) {
          return method.call(res);
        }
        throw new AxiosError$1(
          `Response type '${type2}' is not supported`,
          AxiosError$1.ERR_NOT_SUPPORT,
          config
        );
      });
    });
  })();
  const getBodyLength = async (body) => {
    if (body == null) {
      return 0;
    }
    if (utils$1.isBlob(body)) {
      return body.size;
    }
    if (utils$1.isSpecCompliantForm(body)) {
      const _request = new Request(platform.origin, {
        method: "POST",
        body
      });
      return (await _request.arrayBuffer()).byteLength;
    }
    if (utils$1.isArrayBufferView(body) || utils$1.isArrayBuffer(body)) {
      return body.byteLength;
    }
    if (utils$1.isURLSearchParams(body)) {
      body = body + "";
    }
    if (utils$1.isString(body)) {
      return (await encodeText(body)).byteLength;
    }
  };
  const resolveBodyLength = async (headers, body) => {
    const length = utils$1.toFiniteNumber(headers.getContentLength());
    return length == null ? getBodyLength(body) : length;
  };
  return async (config) => {
    let {
      url,
      method,
      data,
      signal,
      cancelToken,
      timeout,
      onDownloadProgress,
      onUploadProgress,
      responseType,
      headers,
      withCredentials = "same-origin",
      fetchOptions,
      maxContentLength,
      maxBodyLength
    } = resolveConfig(config);
    const hasMaxContentLength = utils$1.isNumber(maxContentLength) && maxContentLength > -1;
    const hasMaxBodyLength = utils$1.isNumber(maxBodyLength) && maxBodyLength > -1;
    const own2 = (key) => utils$1.hasOwnProp(config, key) ? config[key] : void 0;
    let _fetch = envFetch || fetch;
    responseType = responseType ? (responseType + "").toLowerCase() : "text";
    let composedSignal = composeSignals(
      [signal, cancelToken && cancelToken.toAbortSignal()],
      timeout
    );
    let request = null;
    const unsubscribe = composedSignal && composedSignal.unsubscribe && (() => {
      composedSignal.unsubscribe();
    });
    let requestContentLength;
    let pendingBodyError = null;
    const maxBodyLengthError = () => new AxiosError$1(
      "Request body larger than maxBodyLength limit",
      AxiosError$1.ERR_BAD_REQUEST,
      config,
      request
    );
    try {
      let auth = void 0;
      const configAuth = own2("auth");
      if (configAuth) {
        const username = utils$1.getSafeProp(configAuth, "username") || "";
        const password = utils$1.getSafeProp(configAuth, "password") || "";
        auth = {
          username,
          password
        };
      }
      if (maybeWithAuthCredentials(url)) {
        const parsedURL = new URL(url, platform.origin);
        if (!auth && (parsedURL.username || parsedURL.password)) {
          const urlUsername = decodeURIComponentSafe(parsedURL.username);
          const urlPassword = decodeURIComponentSafe(parsedURL.password);
          auth = {
            username: urlUsername,
            password: urlPassword
          };
        }
        if (parsedURL.username || parsedURL.password) {
          parsedURL.username = "";
          parsedURL.password = "";
          url = parsedURL.href;
        }
      }
      if (auth) {
        headers.delete("authorization");
        headers.set(
          "Authorization",
          "Basic " + btoa(encodeUTF8((auth.username || "") + ":" + (auth.password || "")))
        );
      }
      if (hasMaxContentLength && typeof url === "string" && url.startsWith("data:")) {
        const estimated = estimateDataURLDecodedBytes(url);
        if (estimated > maxContentLength) {
          throw new AxiosError$1(
            "maxContentLength size of " + maxContentLength + " exceeded",
            AxiosError$1.ERR_BAD_RESPONSE,
            config,
            request
          );
        }
      }
      if (hasMaxBodyLength && method !== "get" && method !== "head") {
        const outboundLength = await getBodyLength(data);
        if (typeof outboundLength === "number" && isFinite(outboundLength)) {
          requestContentLength = outboundLength;
          if (outboundLength > maxBodyLength) {
            throw maxBodyLengthError();
          }
        }
      }
      const mustEnforceStreamBody = hasMaxBodyLength && (utils$1.isReadableStream(data) || utils$1.isStream(data));
      const trackRequestStream = (stream2, onProgress, flush) => trackStream(
        stream2,
        DEFAULT_CHUNK_SIZE,
        (loadedBytes) => {
          if (hasMaxBodyLength && loadedBytes > maxBodyLength) {
            throw pendingBodyError = maxBodyLengthError();
          }
          onProgress && onProgress(loadedBytes);
        },
        flush
      );
      if (supportsRequestStream && method !== "get" && method !== "head" && (onUploadProgress || mustEnforceStreamBody)) {
        requestContentLength = requestContentLength == null ? await resolveBodyLength(headers, data) : requestContentLength;
        if (requestContentLength !== 0 || mustEnforceStreamBody) {
          let _request = new Request(url, {
            method: "POST",
            body: data,
            duplex: "half"
          });
          let contentTypeHeader;
          if (utils$1.isFormData(data) && (contentTypeHeader = _request.headers.get("content-type"))) {
            headers.setContentType(contentTypeHeader);
          }
          if (_request.body) {
            const [onProgress, flush] = onUploadProgress && progressEventDecorator(
              requestContentLength,
              progressEventReducer(asyncDecorator(onUploadProgress))
            ) || [];
            data = trackRequestStream(_request.body, onProgress, flush);
          }
        }
      } else if (mustEnforceStreamBody && !isRequestSupported && isReadableStreamSupported && method !== "get" && method !== "head") {
        data = trackRequestStream(data);
      } else if (mustEnforceStreamBody && isRequestSupported && !supportsRequestStream && method !== "get" && method !== "head") {
        throw new AxiosError$1(
          "Stream request bodies are not supported by the current fetch implementation",
          AxiosError$1.ERR_NOT_SUPPORT,
          config,
          request
        );
      }
      if (!utils$1.isString(withCredentials)) {
        withCredentials = withCredentials ? "include" : "omit";
      }
      const isCredentialsSupported = isRequestSupported && "credentials" in Request.prototype;
      if (utils$1.isFormData(data)) {
        const contentType = headers.getContentType();
        if (contentType && /^multipart\/form-data/i.test(contentType) && !/boundary=/i.test(contentType)) {
          headers.delete("content-type");
        }
      }
      headers.set("User-Agent", "axios/" + VERSION$1, false);
      const resolvedOptions = {
        ...fetchOptions,
        signal: composedSignal,
        method: method.toUpperCase(),
        headers: toByteStringHeaderObject(headers.normalize()),
        body: data,
        duplex: "half",
        credentials: isCredentialsSupported ? withCredentials : void 0
      };
      request = isRequestSupported && new Request(url, resolvedOptions);
      let response = await (isRequestSupported ? _fetch(request, fetchOptions) : _fetch(url, resolvedOptions));
      const responseHeaders = AxiosHeaders$1.from(response.headers);
      if (hasMaxContentLength) {
        const declaredLength = utils$1.toFiniteNumber(responseHeaders.getContentLength());
        if (declaredLength != null && declaredLength > maxContentLength) {
          throw new AxiosError$1(
            "maxContentLength size of " + maxContentLength + " exceeded",
            AxiosError$1.ERR_BAD_RESPONSE,
            config,
            request
          );
        }
      }
      const isStreamResponse = supportsResponseStream && (responseType === "stream" || responseType === "response");
      if (supportsResponseStream && response.body && (onDownloadProgress || hasMaxContentLength || isStreamResponse && unsubscribe)) {
        const options = {};
        ["status", "statusText", "headers"].forEach((prop) => {
          options[prop] = response[prop];
        });
        const responseContentLength = utils$1.toFiniteNumber(responseHeaders.getContentLength());
        const [onProgress, flush] = onDownloadProgress && progressEventDecorator(
          responseContentLength,
          progressEventReducer(asyncDecorator(onDownloadProgress), true)
        ) || [];
        let bytesRead = 0;
        const onChunkProgress = (loadedBytes) => {
          if (hasMaxContentLength) {
            bytesRead = loadedBytes;
            if (bytesRead > maxContentLength) {
              throw new AxiosError$1(
                "maxContentLength size of " + maxContentLength + " exceeded",
                AxiosError$1.ERR_BAD_RESPONSE,
                config,
                request
              );
            }
          }
          onProgress && onProgress(loadedBytes);
        };
        response = new Response2(
          trackStream(response.body, DEFAULT_CHUNK_SIZE, onChunkProgress, () => {
            flush && flush();
            unsubscribe && unsubscribe();
          }),
          options
        );
      }
      responseType = responseType || "text";
      let responseData = await resolvers[utils$1.findKey(resolvers, responseType) || "text"](
        response,
        config
      );
      if (hasMaxContentLength && !supportsResponseStream && !isStreamResponse) {
        let materializedSize;
        if (responseData != null) {
          if (typeof responseData.byteLength === "number") {
            materializedSize = responseData.byteLength;
          } else if (typeof responseData.size === "number") {
            materializedSize = responseData.size;
          } else if (typeof responseData === "string") {
            materializedSize = typeof TextEncoder2 === "function" ? new TextEncoder2().encode(responseData).byteLength : responseData.length;
          }
        }
        if (typeof materializedSize === "number" && materializedSize > maxContentLength) {
          throw new AxiosError$1(
            "maxContentLength size of " + maxContentLength + " exceeded",
            AxiosError$1.ERR_BAD_RESPONSE,
            config,
            request
          );
        }
      }
      !isStreamResponse && unsubscribe && unsubscribe();
      return await new Promise((resolve2, reject) => {
        settle(resolve2, reject, {
          data: responseData,
          headers: AxiosHeaders$1.from(response.headers),
          status: response.status,
          statusText: response.statusText,
          config,
          request
        });
      });
    } catch (err) {
      unsubscribe && unsubscribe();
      if (composedSignal && composedSignal.aborted && composedSignal.reason instanceof AxiosError$1) {
        const canceledError = composedSignal.reason;
        canceledError.config = config;
        request && (canceledError.request = request);
        if (err !== canceledError) {
          Object.defineProperty(canceledError, "cause", {
            __proto__: null,
            value: err,
            writable: true,
            enumerable: false,
            configurable: true
          });
        }
        throw canceledError;
      }
      if (pendingBodyError) {
        request && !pendingBodyError.request && (pendingBodyError.request = request);
        throw pendingBodyError;
      }
      if (err instanceof AxiosError$1) {
        request && !err.request && (err.request = request);
        throw err;
      }
      if (err && err.name === "TypeError" && /Load failed|fetch/i.test(err.message)) {
        const networkError = new AxiosError$1(
          "Network Error",
          AxiosError$1.ERR_NETWORK,
          config,
          request,
          err && err.response
        );
        Object.defineProperty(networkError, "cause", {
          __proto__: null,
          value: err.cause || err,
          writable: true,
          enumerable: false,
          configurable: true
        });
        throw networkError;
      }
      throw AxiosError$1.from(err, err && err.code, config, request, err && err.response);
    }
  };
};
const seedCache = /* @__PURE__ */ new Map();
const getFetch = (config) => {
  let env2 = config && config.env || {};
  const { fetch: fetch2, Request, Response: Response2 } = env2;
  const seeds = [Request, Response2, fetch2];
  let len = seeds.length, i = len, seed, target, map = seedCache;
  while (i--) {
    seed = seeds[i];
    target = map.get(seed);
    target === void 0 && map.set(seed, target = i ? /* @__PURE__ */ new Map() : factory(env2));
    map = target;
  }
  return target;
};
getFetch();
const knownAdapters = {
  http: httpAdapter,
  xhr: xhrAdapter,
  fetch: {
    get: getFetch
  }
};
utils$1.forEach(knownAdapters, (fn, value) => {
  if (fn) {
    try {
      Object.defineProperty(fn, "name", { __proto__: null, value });
    } catch (e) {
    }
    Object.defineProperty(fn, "adapterName", { __proto__: null, value });
  }
});
const renderReason = (reason) => `- ${reason}`;
const isResolvedHandle = (adapter) => utils$1.isFunction(adapter) || adapter === null || adapter === false;
function getAdapter$1(adapters2, config) {
  adapters2 = utils$1.isArray(adapters2) ? adapters2 : [adapters2];
  const { length } = adapters2;
  let nameOrAdapter;
  let adapter;
  const rejectedReasons = {};
  for (let i = 0; i < length; i++) {
    nameOrAdapter = adapters2[i];
    let id;
    adapter = nameOrAdapter;
    if (!isResolvedHandle(nameOrAdapter)) {
      adapter = knownAdapters[(id = String(nameOrAdapter)).toLowerCase()];
      if (adapter === void 0) {
        throw new AxiosError$1(`Unknown adapter '${id}'`);
      }
    }
    if (adapter && (utils$1.isFunction(adapter) || (adapter = adapter.get(config)))) {
      break;
    }
    rejectedReasons[id || "#" + i] = adapter;
  }
  if (!adapter) {
    const reasons = Object.entries(rejectedReasons).map(
      ([id, state]) => `adapter ${id} ` + (state === false ? "is not supported by the environment" : "is not available in the build")
    );
    let s = length ? reasons.length > 1 ? "since :\n" + reasons.map(renderReason).join("\n") : " " + renderReason(reasons[0]) : "as no adapter specified";
    throw new AxiosError$1(
      `There is no suitable adapter to dispatch the request ` + s,
      AxiosError$1.ERR_NOT_SUPPORT
    );
  }
  return adapter;
}
const adapters = {
  /**
   * Resolve an adapter from a list of adapter names or functions.
   * @type {Function}
   */
  getAdapter: getAdapter$1,
  /**
   * Exposes all known adapters
   * @type {Object<string, Function|Object>}
   */
  adapters: knownAdapters
};
function throwIfCancellationRequested(config) {
  if (config.cancelToken) {
    config.cancelToken.throwIfRequested();
  }
  if (config.signal && config.signal.aborted) {
    throw new CanceledError$1(null, config);
  }
}
function dispatchRequest(config) {
  throwIfCancellationRequested(config);
  config.headers = AxiosHeaders$1.from(config.headers);
  config.data = transformData.call(config, config.transformRequest);
  if (["post", "put", "patch"].indexOf(config.method) !== -1) {
    config.headers.setContentType("application/x-www-form-urlencoded", false);
  }
  const adapter = adapters.getAdapter(config.adapter || defaults.adapter, config);
  return adapter(config).then(
    function onAdapterResolution(response) {
      throwIfCancellationRequested(config);
      config.response = response;
      try {
        response.data = transformData.call(config, config.transformResponse, response);
      } finally {
        delete config.response;
      }
      response.headers = AxiosHeaders$1.from(response.headers);
      return response;
    },
    function onAdapterRejection(reason) {
      if (!isCancel$1(reason)) {
        throwIfCancellationRequested(config);
        if (reason && reason.response) {
          config.response = reason.response;
          try {
            reason.response.data = transformData.call(
              config,
              config.transformResponse,
              reason.response
            );
          } finally {
            delete config.response;
          }
          reason.response.headers = AxiosHeaders$1.from(reason.response.headers);
        }
      }
      return Promise.reject(reason);
    }
  );
}
const validators$1 = {};
["object", "boolean", "number", "function", "string", "symbol"].forEach((type2, i) => {
  validators$1[type2] = function validator2(thing) {
    return typeof thing === type2 || "a" + (i < 1 ? "n " : " ") + type2;
  };
});
const deprecatedWarnings = {};
validators$1.transitional = function transitional(validator2, version, message) {
  function formatMessage(opt, desc) {
    return "[Axios v" + VERSION$1 + "] Transitional option '" + opt + "'" + desc + (message ? ". " + message : "");
  }
  return (value, opt, opts) => {
    if (validator2 === false) {
      throw new AxiosError$1(
        formatMessage(opt, " has been removed" + (version ? " in " + version : "")),
        AxiosError$1.ERR_DEPRECATED
      );
    }
    if (version && !deprecatedWarnings[opt]) {
      deprecatedWarnings[opt] = true;
      console.warn(
        formatMessage(
          opt,
          " has been deprecated since v" + version + " and will be removed in the near future"
        )
      );
    }
    return validator2 ? validator2(value, opt, opts) : true;
  };
};
validators$1.spelling = function spelling(correctSpelling) {
  return (value, opt) => {
    console.warn(`${opt} is likely a misspelling of ${correctSpelling}`);
    return true;
  };
};
function assertOptions(options, schema, allowUnknown) {
  if (typeof options !== "object" || options === null) {
    throw new AxiosError$1("options must be an object", AxiosError$1.ERR_BAD_OPTION_VALUE);
  }
  const keys = Object.keys(options);
  let i = keys.length;
  while (i-- > 0) {
    const opt = keys[i];
    const validator2 = Object.prototype.hasOwnProperty.call(schema, opt) ? schema[opt] : void 0;
    if (validator2) {
      const value = options[opt];
      const result = value === void 0 || validator2(value, opt, options);
      if (result !== true) {
        throw new AxiosError$1(
          "option " + opt + " must be " + result,
          AxiosError$1.ERR_BAD_OPTION_VALUE
        );
      }
      continue;
    }
    if (allowUnknown !== true) {
      throw new AxiosError$1("Unknown option " + opt, AxiosError$1.ERR_BAD_OPTION);
    }
  }
}
const validator = {
  assertOptions,
  validators: validators$1
};
const validators = validator.validators;
let Axios$1 = class Axios {
  constructor(instanceConfig) {
    this.defaults = instanceConfig || {};
    this.interceptors = {
      request: new InterceptorManager(),
      response: new InterceptorManager()
    };
  }
  /**
   * Dispatch a request
   *
   * @param {String|Object} configOrUrl The config specific for this request (merged with this.defaults)
   * @param {?Object} config
   *
   * @returns {Promise} The Promise to be fulfilled
   */
  async request(configOrUrl, config) {
    try {
      return await this._request(configOrUrl, config);
    } catch (err) {
      if (err instanceof Error) {
        let dummy = {};
        Error.captureStackTrace ? Error.captureStackTrace(dummy) : dummy = new Error();
        const stack = (() => {
          if (!dummy.stack) {
            return "";
          }
          const firstNewlineIndex = dummy.stack.indexOf("\n");
          return firstNewlineIndex === -1 ? "" : dummy.stack.slice(firstNewlineIndex + 1);
        })();
        try {
          if (!err.stack) {
            err.stack = stack;
          } else if (stack) {
            const firstNewlineIndex = stack.indexOf("\n");
            const secondNewlineIndex = firstNewlineIndex === -1 ? -1 : stack.indexOf("\n", firstNewlineIndex + 1);
            const stackWithoutTwoTopLines = secondNewlineIndex === -1 ? "" : stack.slice(secondNewlineIndex + 1);
            if (!String(err.stack).endsWith(stackWithoutTwoTopLines)) {
              err.stack += "\n" + stack;
            }
          }
        } catch (e) {
        }
      }
      throw err;
    }
  }
  _request(configOrUrl, config) {
    if (typeof configOrUrl === "string") {
      config = config || {};
      config.url = configOrUrl;
    } else {
      config = configOrUrl || {};
    }
    config = mergeConfig$1(this.defaults, config);
    const { transitional: transitional2, paramsSerializer, headers } = config;
    if (transitional2 !== void 0) {
      validator.assertOptions(
        transitional2,
        {
          silentJSONParsing: validators.transitional(validators.boolean),
          forcedJSONParsing: validators.transitional(validators.boolean),
          clarifyTimeoutError: validators.transitional(validators.boolean),
          legacyInterceptorReqResOrdering: validators.transitional(validators.boolean),
          advertiseZstdAcceptEncoding: validators.transitional(validators.boolean),
          validateStatusUndefinedResolves: validators.transitional(validators.boolean)
        },
        false
      );
    }
    if (paramsSerializer != null) {
      if (utils$1.isFunction(paramsSerializer)) {
        config.paramsSerializer = {
          serialize: paramsSerializer
        };
      } else {
        validator.assertOptions(
          paramsSerializer,
          {
            encode: validators.function,
            serialize: validators.function
          },
          true
        );
      }
    }
    if (config.allowAbsoluteUrls !== void 0) ;
    else if (this.defaults.allowAbsoluteUrls !== void 0) {
      config.allowAbsoluteUrls = this.defaults.allowAbsoluteUrls;
    } else {
      config.allowAbsoluteUrls = true;
    }
    validator.assertOptions(
      config,
      {
        baseUrl: validators.spelling("baseURL"),
        withXsrfToken: validators.spelling("withXSRFToken")
      },
      true
    );
    config.method = (config.method || this.defaults.method || "get").toLowerCase();
    let contextHeaders = headers && utils$1.merge(headers.common, headers[config.method]);
    headers && utils$1.forEach(["delete", "get", "head", "post", "put", "patch", "query", "common"], (method) => {
      delete headers[method];
    });
    config.headers = AxiosHeaders$1.concat(contextHeaders, headers);
    const requestInterceptorChain = [];
    let synchronousRequestInterceptors = true;
    this.interceptors.request.forEach(function unshiftRequestInterceptors(interceptor) {
      if (typeof interceptor.runWhen === "function" && interceptor.runWhen(config) === false) {
        return;
      }
      synchronousRequestInterceptors = synchronousRequestInterceptors && interceptor.synchronous;
      const transitional3 = config.transitional || transitionalDefaults;
      const legacyInterceptorReqResOrdering = transitional3 && transitional3.legacyInterceptorReqResOrdering;
      if (legacyInterceptorReqResOrdering) {
        requestInterceptorChain.unshift(interceptor.fulfilled, interceptor.rejected);
      } else {
        requestInterceptorChain.push(interceptor.fulfilled, interceptor.rejected);
      }
    });
    const responseInterceptorChain = [];
    this.interceptors.response.forEach(function pushResponseInterceptors(interceptor) {
      responseInterceptorChain.push(interceptor.fulfilled, interceptor.rejected);
    });
    let promise;
    let i = 0;
    let len;
    if (!synchronousRequestInterceptors) {
      const chain = [dispatchRequest.bind(this), void 0];
      chain.unshift(...requestInterceptorChain);
      chain.push(...responseInterceptorChain);
      len = chain.length;
      promise = Promise.resolve(config);
      while (i < len) {
        promise = promise.then(chain[i++], chain[i++]);
      }
      return promise;
    }
    len = requestInterceptorChain.length;
    let newConfig = config;
    while (i < len) {
      const onFulfilled = requestInterceptorChain[i++];
      const onRejected = requestInterceptorChain[i++];
      try {
        newConfig = onFulfilled ? onFulfilled(newConfig) : newConfig;
      } catch (error) {
        if (!onRejected) {
          promise = Promise.reject(error);
          break;
        }
        try {
          const rejectedResult = onRejected.call(this, error);
          if (utils$1.isThenable(rejectedResult)) {
            promise = Promise.resolve(rejectedResult).then(
              () => dispatchRequest.call(this, newConfig)
            );
          }
        } catch (rejectedError) {
          promise = Promise.reject(rejectedError);
        }
        break;
      }
    }
    if (!promise) {
      try {
        promise = dispatchRequest.call(this, newConfig);
      } catch (error) {
        promise = Promise.reject(error);
      }
    }
    i = 0;
    len = responseInterceptorChain.length;
    while (i < len) {
      promise = promise.then(responseInterceptorChain[i++], responseInterceptorChain[i++]);
    }
    return promise;
  }
  getUri(config) {
    config = mergeConfig$1(this.defaults, config);
    const fullPath = buildFullPath(config.baseURL, config.url, config.allowAbsoluteUrls, config);
    return buildURL(fullPath, config.params, config.paramsSerializer);
  }
};
utils$1.forEach(["delete", "get", "head", "options"], function forEachMethodNoData(method) {
  Axios$1.prototype[method] = function(url, config) {
    return this.request(
      mergeConfig$1(config || {}, {
        method,
        url,
        data: config && utils$1.hasOwnProp(config, "data") ? config.data : void 0
      })
    );
  };
});
utils$1.forEach(["post", "put", "patch", "query"], function forEachMethodWithData(method) {
  function generateHTTPMethod(isForm) {
    return function httpMethod(url, data, config) {
      return this.request(
        mergeConfig$1(config || {}, {
          method,
          headers: isForm ? {
            "Content-Type": "multipart/form-data"
          } : {},
          url,
          data
        })
      );
    };
  }
  Axios$1.prototype[method] = generateHTTPMethod();
  if (method !== "query") {
    Axios$1.prototype[method + "Form"] = generateHTTPMethod(true);
  }
});
let CancelToken$1 = class CancelToken {
  constructor(executor) {
    if (typeof executor !== "function") {
      throw new TypeError("executor must be a function.");
    }
    let resolvePromise;
    this.promise = new Promise(function promiseExecutor(resolve2) {
      resolvePromise = resolve2;
    });
    const token = this;
    this.promise.then((cancel) => {
      if (!token._listeners) return;
      let i = token._listeners.length;
      while (i-- > 0) {
        token._listeners[i](cancel);
      }
      token._listeners = null;
    });
    this.promise.then = (onfulfilled) => {
      let _resolve;
      const promise = new Promise((resolve2) => {
        token.subscribe(resolve2);
        _resolve = resolve2;
      }).then(onfulfilled);
      promise.cancel = function reject() {
        token.unsubscribe(_resolve);
      };
      return promise;
    };
    executor(function cancel(message, config, request) {
      if (token.reason) {
        return;
      }
      token.reason = new CanceledError$1(message, config, request);
      resolvePromise(token.reason);
    });
  }
  /**
   * Throws a `CanceledError` if cancellation has been requested.
   */
  throwIfRequested() {
    if (this.reason) {
      throw this.reason;
    }
  }
  /**
   * Subscribe to the cancel signal
   */
  subscribe(listener) {
    if (this.reason) {
      listener(this.reason);
      return;
    }
    if (this._listeners) {
      this._listeners.push(listener);
    } else {
      this._listeners = [listener];
    }
  }
  /**
   * Unsubscribe from the cancel signal
   */
  unsubscribe(listener) {
    if (!this._listeners) {
      return;
    }
    const index = this._listeners.indexOf(listener);
    if (index !== -1) {
      this._listeners.splice(index, 1);
    }
  }
  toAbortSignal() {
    const controller = new AbortController();
    const abort = (err) => {
      controller.abort(err);
    };
    this.subscribe(abort);
    controller.signal.unsubscribe = () => this.unsubscribe(abort);
    return controller.signal;
  }
  /**
   * Returns an object that contains a new `CancelToken` and a function that, when called,
   * cancels the `CancelToken`.
   */
  static source() {
    let cancel;
    const token = new CancelToken(function executor(c) {
      cancel = c;
    });
    return {
      token,
      cancel
    };
  }
};
function spread$1(callback) {
  return function wrap(arr) {
    return callback.apply(null, arr);
  };
}
function isAxiosError$1(payload) {
  return utils$1.isObject(payload) && payload.isAxiosError === true;
}
const HttpStatusCode$1 = {
  Continue: 100,
  SwitchingProtocols: 101,
  Processing: 102,
  EarlyHints: 103,
  Ok: 200,
  Created: 201,
  Accepted: 202,
  NonAuthoritativeInformation: 203,
  NoContent: 204,
  ResetContent: 205,
  PartialContent: 206,
  MultiStatus: 207,
  AlreadyReported: 208,
  ImUsed: 226,
  MultipleChoices: 300,
  MovedPermanently: 301,
  Found: 302,
  SeeOther: 303,
  NotModified: 304,
  UseProxy: 305,
  Unused: 306,
  TemporaryRedirect: 307,
  PermanentRedirect: 308,
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  NotAcceptable: 406,
  ProxyAuthenticationRequired: 407,
  RequestTimeout: 408,
  Conflict: 409,
  Gone: 410,
  LengthRequired: 411,
  PreconditionFailed: 412,
  PayloadTooLarge: 413,
  UriTooLong: 414,
  UnsupportedMediaType: 415,
  RangeNotSatisfiable: 416,
  ExpectationFailed: 417,
  ImATeapot: 418,
  MisdirectedRequest: 421,
  UnprocessableEntity: 422,
  Locked: 423,
  FailedDependency: 424,
  TooEarly: 425,
  UpgradeRequired: 426,
  PreconditionRequired: 428,
  TooManyRequests: 429,
  RequestHeaderFieldsTooLarge: 431,
  UnavailableForLegalReasons: 451,
  InternalServerError: 500,
  NotImplemented: 501,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
  HttpVersionNotSupported: 505,
  VariantAlsoNegotiates: 506,
  InsufficientStorage: 507,
  LoopDetected: 508,
  NotExtended: 510,
  NetworkAuthenticationRequired: 511,
  WebServerReturnsAnUnknownError: 520,
  WebServerIsDown: 521,
  ConnectionTimedOut: 522,
  OriginIsUnreachable: 523,
  TimeoutOccurred: 524,
  SslHandshakeFailed: 525,
  InvalidSslCertificate: 526
};
Object.entries(HttpStatusCode$1).forEach(([key, value]) => {
  HttpStatusCode$1[value] = key;
});
function createInstance(defaultConfig) {
  const context = new Axios$1(defaultConfig);
  const instance = bind(Axios$1.prototype.request, context);
  utils$1.extend(instance, Axios$1.prototype, context, { allOwnKeys: true });
  utils$1.extend(instance, context, null, { allOwnKeys: true });
  instance.create = function create2(instanceConfig) {
    return createInstance(mergeConfig$1(defaultConfig, instanceConfig));
  };
  return instance;
}
const axios = createInstance(defaults);
axios.Axios = Axios$1;
axios.CanceledError = CanceledError$1;
axios.CancelToken = CancelToken$1;
axios.isCancel = isCancel$1;
axios.VERSION = VERSION$1;
axios.toFormData = toFormData$1;
axios.AxiosError = AxiosError$1;
axios.Cancel = axios.CanceledError;
axios.all = function all(promises) {
  return Promise.all(promises);
};
axios.spread = spread$1;
axios.isAxiosError = isAxiosError$1;
axios.mergeConfig = mergeConfig$1;
axios.AxiosHeaders = AxiosHeaders$1;
axios.formToJSON = (thing) => formDataToJSON(utils$1.isHTMLForm(thing) ? new FormData(thing) : thing);
axios.getAdapter = adapters.getAdapter;
axios.HttpStatusCode = HttpStatusCode$1;
axios.default = axios;
const {
  Axios: Axios2,
  AxiosError: AxiosError2,
  CanceledError: CanceledError2,
  isCancel,
  CancelToken: CancelToken2,
  VERSION,
  all: all2,
  Cancel,
  isAxiosError,
  spread,
  toFormData,
  AxiosHeaders: AxiosHeaders2,
  HttpStatusCode,
  formToJSON,
  getAdapter,
  mergeConfig,
  create
} = axios;
const require$1 = createRequire(import.meta.url);
const Sentry = process.versions.electron ? require$1("@sentry/electron/main") : null;
const PRODUCTION_DSN = "https://a5e0b3306fef49aa9103551d4b492868@logs.everroom.vyitec.com/2";
let configured = false;
let enabledUntil = 0;
let currentAccount = null;
const LOCAL_ONLY_LOG_MODULES = /* @__PURE__ */ new Set(["document-cursor-completion"]);
function isSentryLogModuleAllowed(module) {
  return !LOCAL_ONLY_LOG_MODULES.has(module);
}
function isRemoteDebugEligible(account, now = Date.now()) {
  const subscription = account.subscription;
  if (!account.authenticated || !account.user || !subscription) return false;
  if (subscription.status !== "active" || subscription.planCode.toLowerCase() === "free") return false;
  return Date.parse(subscription.periodEnd) > now;
}
function isRemoteDebugActive() {
  return Date.now() < enabledUntil;
}
function configureSentry(version, packaged) {
  if (!Sentry) return;
  const dsn = process.env.NXCORE_SENTRY_DSN?.trim() || (packaged ? PRODUCTION_DSN : "");
  if (!dsn) return;
  try {
    Sentry.init({
      dsn,
      release: `everroom@${version}`,
      environment: packaged ? "production" : "development",
      enableLogs: true,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      integrations: (defaults2) => defaults2.filter(
        ({ name }) => name !== "MainProcessSession" && name !== "SentryMinidump"
      ),
      beforeBreadcrumb: (breadcrumb) => isRemoteDebugActive() ? breadcrumb : null,
      beforeSend: (event) => isRemoteDebugActive() ? event : null,
      beforeSendLog: (log2) => isRemoteDebugActive() ? log2 : null
    });
    configured = true;
    if (currentAccount) applyAccountScope(currentAccount);
  } catch (error) {
    process.stderr.write(`[desktop][sentry] ${error instanceof Error ? error.message : String(error)}
`);
  }
}
function applyAccountScope(account) {
  if (!configured || !Sentry) return;
  const eligible = isRemoteDebugEligible(account);
  Sentry.getCurrentScope().clearBreadcrumbs();
  Sentry.setUser(eligible ? { id: account.user.id } : null);
  if (eligible) {
    Sentry.setTags({
      plan: account.subscription.planCode,
      subscription_status: account.subscription.status
    });
  }
}
function syncSentryAccount(account) {
  currentAccount = account;
  enabledUntil = isRemoteDebugEligible(account) ? Date.parse(account.subscription.periodEnd) : 0;
  applyAccountScope(account);
}
function captureSentryLog(module, level, event) {
  if (!isSentryLogModuleAllowed(module)) return;
  if (!configured || !Sentry || !Sentry.isInitialized() || !isRemoteDebugActive()) return;
  const message = typeof event.event === "string" ? event.event : `${module}.${level}`;
  if (level === "debug") return;
  Sentry.logger[level](message, { source: "desktop", module, ...event });
}
const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
function parseThreshold(value, fallback) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "none" || normalized === "0") return "off";
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return fallback;
}
const DESKTOP_LOG_THRESHOLD = parseThreshold(process.env.NXCORE_DESKTOP_LOG_LEVEL, "info");
const HTTP_LOG_THRESHOLD = parseThreshold(process.env.NXCORE_DESKTOP_HTTP_LOG_LEVEL, "warn");
const CONSOLE_LOG_ENABLED = process.env.NXCORE_DESKTOP_LOG_CONSOLE !== "0";
const FILE_LOG_ENABLED = process.env.NXCORE_DESKTOP_LOG_FILE !== "0";
const LEVEL_LABEL = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR"
};
const ANSI = {
  reset: "\x1B[0m",
  dim: "\x1B[90m",
  magenta: "\x1B[35m",
  infoBadge: "\x1B[30;42m",
  warnBadge: "\x1B[30;43m",
  errorBadge: "\x1B[97;41m",
  debugBadge: "\x1B[30;46m"
};
const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|signature|token|transcript|detailmarkdown/i;
const MAX_VALUE_LENGTH = 500;
const LOG_RETENTION_DAYS = 30;
const LOG_FILE_PATTERN = /^(?:desktop|cursor-completion)-(\d{4}-\d{2}-\d{2})\.log$/;
let logsDirectory = null;
let writeQueue = Promise.resolve();
let consoleInstalled = false;
function localDate(value) {
  return [value.getFullYear(), value.getMonth() + 1, value.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
}
function timestamp(value) {
  const date = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  const time = `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}:${String(value.getSeconds()).padStart(2, "0")}.${String(value.getMilliseconds()).padStart(3, "0")}`;
  const offsetMinutes = -value.getTimezoneOffset();
  const sign2 = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign2}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(absoluteOffset % 60).padStart(2, "0")}`;
  return `${date} ${time} ${offset}`;
}
function formatValue(value, key) {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === void 0) return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") {
    const cleaned = value.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]").replace(/([?&](?:token|signature|credential|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]").replace(/\s+/g, " ").slice(0, MAX_VALUE_LENGTH);
    return /[\s|=]/.test(cleaned) ? JSON.stringify(cleaned) : cleaned;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") return `{${Object.keys(value).slice(0, 8).join(",")}}`;
  return String(value);
}
function formatConsoleLine(now, module, level, event) {
  const eventName = typeof event.event === "string" ? event.event : "event";
  const fields = Object.entries(event).filter(([key, value]) => key !== "event" && value !== void 0).map(([key, value]) => `${key}=${formatValue(value, key)}`);
  const suffix = fields.length > 0 ? ` | ${fields.join(" ")}` : "";
  const levelColor = level === "error" ? ANSI.errorBadge : level === "warn" ? ANSI.warnBadge : level === "debug" ? ANSI.debugBadge : ANSI.infoBadge;
  const plainTimestamp = timestamp(now);
  const plainLevel = LEVEL_LABEL[level].padEnd(5);
  const scope = `[desktop/${module}]`;
  return `${ANSI.dim}${plainTimestamp}${ANSI.reset} ${levelColor} ${plainLevel} ${ANSI.reset} ${ANSI.magenta}${scope}${ANSI.reset} ${eventName}${suffix}`;
}
function appendLogFile(now, module, level, event, filePrefix = "desktop") {
  const directory = logsDirectory;
  if (!directory) return;
  const entry = {
    time: now.toISOString(),
    level,
    source: "desktop",
    module,
    ...event
  };
  enqueue(() => appendFile(
    join(directory, `${filePrefix}-${localDate(now)}.log`),
    `${JSON.stringify(entry)}
`,
    "utf8"
  ));
}
function writeToOriginalConsole(level, line) {
  if (!CONSOLE_LOG_ENABLED) return;
  const stream2 = level === "info" ? process.stdout : process.stderr;
  stream2.write(`${line}
`);
}
function installGlobalConsole() {
  if (consoleInstalled) return;
  consoleInstalled = true;
  const writeGlobal = (level, args) => {
    const actualLevel = level === "log" ? "info" : level;
    const [first, ...rest] = args;
    const event = typeof first === "string" ? first : "console event";
    const details = rest.length === 0 ? void 0 : rest.length === 1 ? rest[0] : rest;
    const now = /* @__PURE__ */ new Date();
    const payload = details === void 0 ? { event } : { event, details };
    const threshold = desktopLogThreshold("console");
    if (threshold === "off" || LEVEL_ORDER[actualLevel] < LEVEL_ORDER[threshold]) return;
    writeToOriginalConsole(actualLevel, formatConsoleLine(now, "console", actualLevel, payload));
    appendLogFile(now, "console", actualLevel, payload);
  };
  console.log = (...args) => writeGlobal("log", args);
  console.info = (...args) => writeGlobal("info", args);
  console.warn = (...args) => writeGlobal("warn", args);
  console.error = (...args) => writeGlobal("error", args);
}
async function removeExpiredLogs(directory) {
  const cutoff = /* @__PURE__ */ new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - LOG_RETENTION_DAYS);
  const names = await readdir(directory);
  await Promise.all(names.map(async (name) => {
    const match = LOG_FILE_PATTERN.exec(name);
    if (!match) return;
    const createdAt = /* @__PURE__ */ new Date(`${match[1]}T00:00:00`);
    if (createdAt < cutoff) await unlink(join(directory, name));
  }));
}
function enqueue(operation) {
  writeQueue = writeQueue.then(operation).catch((error) => {
    writeToOriginalConsole("error", `${timestamp(/* @__PURE__ */ new Date())} ERROR [desktop/logger] write failed | error=${formatValue(error, "error")}`);
  });
}
function configureDesktopLogger(dataDirectory2) {
  logsDirectory = join(dataDirectory2, "logs");
  const directory = logsDirectory;
  installGlobalConsole();
  if (!FILE_LOG_ENABLED) {
    logsDirectory = null;
    return;
  }
  enqueue(async () => {
    await mkdir(directory, { recursive: true });
    await removeExpiredLogs(directory);
  });
}
function logDesktop(module, level, event) {
  writeDesktopLog(module, level, event, true);
}
function desktopLogThreshold(module) {
  return module === "axios" ? HTTP_LOG_THRESHOLD : DESKTOP_LOG_THRESHOLD;
}
function logLocalDesktop(module, level, event) {
  writeDesktopLog(module, level, event, false);
}
function logDocumentCursorCompletion(level, event) {
  writeDesktopLog("document-cursor-completion", level, event, false, "cursor-completion");
}
function writeDesktopLog(module, level, event, captureRemote, filePrefix = "desktop") {
  const now = /* @__PURE__ */ new Date();
  const threshold = desktopLogThreshold(module);
  if (threshold === "off" || LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;
  writeToOriginalConsole(level, formatConsoleLine(now, module, level, event));
  if (captureRemote) captureSentryLog(module, level, event);
  appendLogFile(now, module, level, event, filePrefix);
}
function flushDesktopLogs() {
  return writeQueue;
}
const metadata$1 = /* @__PURE__ */ new WeakMap();
const SENSITIVE_QUERY_KEYS = /token|code|secret|signature|credential|password|key/i;
function requestUrl(config) {
  const rawUrl = config.url ?? "";
  try {
    const url = new URL(rawUrl, config.baseURL);
    const queryKeys = [.../* @__PURE__ */ new Set([...url.searchParams.keys()])];
    url.search = queryKeys.length > 0 ? `?${queryKeys.map((key) => `${encodeURIComponent(key)}=<redacted>`).join("&")}` : "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return rawUrl.replace(/\?.*$/, "?<redacted>");
  }
}
function payloadSummary(data) {
  if (data === void 0 || data === null) return void 0;
  if (typeof data === "string") return `string:${Buffer.byteLength(data)}B`;
  if (Buffer.isBuffer(data)) return `buffer:${data.byteLength}B`;
  if (data instanceof URLSearchParams) {
    return `form:${[.../* @__PURE__ */ new Set([...data.keys()])].join(",")}`;
  }
  if (typeof data === "object") {
    const value = data;
    if (typeof value.pipe === "function") return "stream";
    const keys = Object.keys(value).map((key) => SENSITIVE_QUERY_KEYS.test(key) ? `${key}:redacted` : key);
    return `json:${keys.join(",")}`;
  }
  return typeof data;
}
function log(level, event) {
  const threshold = desktopLogThreshold("axios");
  if (threshold === "off") return;
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  if (order[level] < order[threshold]) return;
  logDesktop("axios", level, event);
}
function responseLog(level, client, response) {
  const request = metadata$1.get(response.config);
  log(level, {
    event: "http.response",
    client,
    requestId: request?.requestId,
    method: request?.method ?? response.config.method?.toUpperCase(),
    url: request?.url ?? requestUrl(response.config),
    status: response.status,
    durationMs: request ? Date.now() - request.startedAt : void 0
  });
}
function createLoggedHttpClient(client, defaults2 = {}, options = {}) {
  const instance = axios.create(defaults2);
  const routineLevel = options.quiet ? "debug" : "info";
  instance.interceptors.request.use((config) => {
    const request = {
      requestId: randomUUID(),
      startedAt: Date.now(),
      method: (config.method ?? "GET").toUpperCase(),
      url: requestUrl(config),
      payload: payloadSummary(config.data)
    };
    metadata$1.set(config, request);
    log(routineLevel, {
      event: "http.request",
      client,
      requestId: request.requestId,
      method: request.method,
      url: request.url,
      payload: request.payload
    });
    return config;
  });
  instance.interceptors.response.use(
    (response) => {
      responseLog(response.status >= 400 ? "warn" : routineLevel, client, response);
      return response;
    },
    (error) => {
      const request = error.config ? metadata$1.get(error.config) : void 0;
      log("error", {
        event: "http.error",
        client,
        requestId: request?.requestId,
        method: request?.method ?? error.config?.method?.toUpperCase(),
        url: request?.url ?? (error.config ? requestUrl(error.config) : void 0),
        status: error.response?.status,
        durationMs: request ? Date.now() - request.startedAt : void 0,
        code: error.code,
        message: error.message
      });
      return Promise.reject(error);
    }
  );
  return instance;
}
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const http$9 = createLoggedHttpClient("github", {
  baseURL: "https://api.github.com",
  timeout: 15e3
});
const TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);
class GitHubConnector {
  constructor(resolveToken) {
    this.resolveToken = resolveToken;
  }
  kind = "github";
  capabilities = ["pull", "incremental"];
  getConnectionKey(config) {
    const repository = this.normalizeRepository(config.repository);
    return `${repository}:${config.branch?.trim() || "default"}:${config.syncIssues !== false ? "issues" : "code"}`;
  }
  async scan(connection) {
    const config = connection.config;
    const repository = this.normalizeRepository(config.repository);
    const token = await this.resolveToken(config.tokenCredentialKey);
    const headers = this.headers(token);
    const repo = await this.request(`/repos/${repository}`, headers);
    const branch = config.branch?.trim() || repo.data.default_branch;
    const ref2 = await this.request(`/repos/${repository}/commits/${encodeURIComponent(branch)}`, headers);
    const modifiedAt = ref2.data.commit.committer.date || repo.data.pushed_at || (/* @__PURE__ */ new Date()).toISOString();
    const tree = await this.request(`/repos/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`, headers);
    if (tree.data.truncated) throw new Error("GitHub 仓库目录过大，无法在一次同步中完整读取。");
    const items = [];
    let failed = 0;
    for (const entry of tree.data.tree) {
      if (entry.type !== "blob" || !this.isTextFile(entry.path) || (entry.size ?? 0) > MAX_FILE_SIZE) continue;
      try {
        const blob = await this.request(`/repos/${repository}/git/blobs/${entry.sha}`, headers);
        const content = this.decodeBlob(blob.data.content, blob.data.encoding);
        items.push(this.item(
          `repo:blob:${entry.path}`,
          entry.path.split("/").at(-1) || entry.path,
          `https://github.com/${repository}/blob/${encodeURIComponent(branch)}/${entry.path}`,
          entry.path,
          this.extension(entry.path),
          content,
          entry.size ?? Buffer.byteLength(content),
          modifiedAt
        ));
      } catch {
        failed += 1;
      }
    }
    if (config.syncIssues !== false) {
      const issues = await this.listAll(`/repos/${repository}/issues?state=all&per_page=100`, headers);
      for (const issue of issues) {
        if (issue.pull_request) continue;
        try {
          const comments = await this.listAll(`/repos/${repository}/issues/${issue.number}/comments?per_page=100`, headers);
          const content = [`# ${issue.title}`, "", issue.body || "", ...comments.map((comment) => `
## ${comment.user?.login || "评论"} · ${comment.created_at}

${comment.body || ""}`)].join("\n").trim() + "\n";
          items.push(this.item(`repo:issue:${issue.number}`, issue.title, issue.html_url, `issues/${issue.number}.md`, ".md", content, Buffer.byteLength(content), issue.updated_at));
        } catch {
          failed += 1;
        }
      }
    }
    return { items, failed };
  }
  item(remoteId, title, uri2, path, extension, content, byteSize, modifiedAt) {
    return { remoteId, title, uri: uri2, path, extension, byteSize, modifiedAt, openContent: () => Readable$1.from([content]) };
  }
  headers(token) {
    return { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "NxCore-CE", ...token ? { Authorization: `Bearer ${token}` } : {} };
  }
  async request(path, headers) {
    const response = await http$9.get(path, { headers, validateStatus: () => true });
    if (response.status >= 400) {
      if (response.status === 401) throw new Error("GitHub 凭证无效或已过期。");
      if (response.status === 403) throw new Error("GitHub 请求被拒绝，可能触发了速率限制。");
      if (response.status === 404) throw new Error("GitHub 仓库、分支或对象不存在。");
      throw new Error(`GitHub API 请求失败（${response.status}）。`);
    }
    return { data: response.data };
  }
  async listAll(path, headers) {
    const separator = path.includes("?") ? "&" : "?";
    const all3 = [];
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request(`${path}${separator}page=${page}`, headers);
      all3.push(...response.data);
      if (response.data.length < 100) return all3;
    }
    throw new Error("GitHub 返回数据超过分页上限。");
  }
  decodeBlob(content, encoding) {
    if (encoding !== "base64") throw new Error("GitHub 返回了不支持的内容编码。");
    return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
  }
  isTextFile(path) {
    const dot = path.lastIndexOf(".");
    return dot > -1 && TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
  }
  extension(path) {
    const dot = path.lastIndexOf(".");
    return dot > -1 ? path.slice(dot).toLowerCase() : ".txt";
  }
  normalizeRepository(value) {
    const repository = value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error("GitHub 仓库格式应为 owner/repository。");
    return repository;
  }
}
const http$8 = createLoggedHttpClient("google-docs", { baseURL: "https://docs.googleapis.com", timeout: 2e4 });
function idFromValue(value) {
  const match = value.match(/\/document\/d\/([a-zA-Z0-9_-]+)/) ?? value.match(/^([a-zA-Z0-9_-]{10,})$/);
  if (!match) throw new Error(`Google Docs 文档 ID 无效：${value}`);
  return match[1];
}
function inline(text2) {
  return text2.replace(/\u000b/g, "").replace(/\r?\n$/, "");
}
function toMarkdown(elements = []) {
  const lines = [];
  for (const element of elements) {
    if (element.paragraph) {
      const text2 = inline((element.paragraph.elements ?? []).map((item) => item.textRun?.content ?? "").join(""));
      if (text2) lines.push(text2);
    } else if (element.table) {
      const rows = element.table.tableRows ?? [];
      for (const [index, row] of rows.entries()) {
        const cells = (row.tableCells ?? []).map((cell) => toMarkdown(cell.content).replace(/\n+/g, " ").trim());
        lines.push(`| ${cells.join(" | ")} |`);
        if (index === 0) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
      }
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
class GoogleDocsConnector {
  constructor(resolveToken) {
    this.resolveToken = resolveToken;
  }
  kind = "google-docs";
  capabilities = ["pull"];
  getConnectionKey(config) {
    return config.documentIds.map(idFromValue).sort().join(",");
  }
  async scan(connection) {
    const token = connection.config.token ?? await this.resolveToken(connection.config.tokenCredentialKey);
    if (!token) throw new Error("Google Docs access token 不存在或已过期。");
    const items = [];
    let failed = 0;
    for (const rawId of connection.config.documentIds) {
      try {
        const id = idFromValue(rawId);
        const response = await http$8.get(`/v1/documents/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
        const title = response.data.title?.trim() || id;
        const content = `# ${title}

${toMarkdown(response.data.body?.content ?? [])}`;
        items.push({ remoteId: id, title, uri: `https://docs.google.com/document/d/${id}/edit`, path: `${title.replace(/[\\/:*?"<>|]/g, "_")}.md`, extension: ".md", byteSize: Buffer.byteLength(content), modifiedAt: (/* @__PURE__ */ new Date()).toISOString(), openContent: () => Readable$1.from([content]) });
      } catch {
        failed += 1;
      }
    }
    return { items, failed };
  }
}
const http$7 = createLoggedHttpClient("notion", { baseURL: "https://api.notion.com", timeout: 2e4 });
function pageId(value) {
  const match = value.match(/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{32})/i);
  if (!match) throw new Error(`Notion 页面 ID 无效：${value}`);
  return match[1].replace(/-/g, "");
}
function text(items = []) {
  return items.map((item) => item.href ? `[${item.plain_text ?? ""}](${item.href})` : item.plain_text ?? "").join("");
}
function blockMarkdown(block) {
  const data = block[block.type ?? ""];
  const value = text(data?.rich_text);
  switch (block.type) {
    case "heading_1":
      return `# ${value}`;
    case "heading_2":
      return `## ${value}`;
    case "heading_3":
      return `### ${value}`;
    case "bulleted_list_item":
      return `- ${value}`;
    case "numbered_list_item":
      return `1. ${value}`;
    case "to_do":
      return `- [${data?.checked ? "x" : " "}] ${value}`;
    case "quote":
      return `> ${value}`;
    case "callout":
      return `> ${value}`;
    case "code":
      return `\`\`\`${data?.language ?? ""}
${value}
\`\`\``;
    case "divider":
      return "---";
    case "image":
      return value ? `![${value}](${value})` : "";
    default:
      return value;
  }
}
class NotionConnector {
  constructor(resolveToken) {
    this.resolveToken = resolveToken;
  }
  kind = "notion";
  capabilities = ["pull"];
  getConnectionKey(config) {
    return config.pageIds.map(pageId).sort().join(",");
  }
  async scan(connection) {
    const token = connection.config.token ?? await this.resolveToken(connection.config.tokenCredentialKey);
    if (!token) throw new Error("Notion integration token 不存在或已过期。");
    const headers = { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" };
    const items = [];
    let failed = 0;
    for (const rawId of connection.config.pageIds) {
      try {
        const id = pageId(rawId);
        const page = await http$7.get(`/v1/pages/${id}`, { headers });
        const titleProperty = Object.values(page.data.properties ?? {}).find((property) => property.type === "title");
        const title = text(titleProperty?.title ?? titleProperty?.rich_text) || id;
        const blocks = [];
        let cursor;
        do {
          const response = await http$7.get(`/v1/blocks/${id}/children`, { headers, params: { page_size: 100, ...cursor ? { start_cursor: cursor } : {} } });
          blocks.push(...response.data.results ?? []);
          cursor = response.data.next_cursor ?? void 0;
        } while (cursor);
        const content = `# ${title}

${blocks.map(blockMarkdown).filter(Boolean).join("\n\n")}
`;
        items.push({ remoteId: id, title, uri: page.data.url ?? `https://www.notion.so/${id}`, path: `${title.replace(/[\\/:*?"<>|]/g, "_")}.md`, extension: ".md", byteSize: Buffer.byteLength(content), modifiedAt: (/* @__PURE__ */ new Date()).toISOString(), openContent: () => Readable$1.from([content]) });
      } catch {
        failed += 1;
      }
    }
    return { items, failed };
  }
}
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/;
const SETEXT_HEADING = /^ {0,3}(=+|-+)[\t ]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
function splitLines(text2) {
  const lines = [];
  let lineStart = 0;
  let lineNumber = 1;
  while (lineStart < text2.length) {
    let lineEnd = lineStart;
    while (lineEnd < text2.length && text2[lineEnd] !== "\n" && text2[lineEnd] !== "\r") {
      lineEnd += 1;
    }
    lines.push({
      number: lineNumber,
      startOffset: lineStart,
      endOffset: lineEnd,
      text: text2.slice(lineStart, lineEnd)
    });
    if (text2[lineEnd] === "\r" && text2[lineEnd + 1] === "\n") lineEnd += 2;
    else if (lineEnd < text2.length) lineEnd += 1;
    lineStart = lineEnd;
    lineNumber += 1;
  }
  if (text2.length === 0 || text2.endsWith("\n") || text2.endsWith("\r")) {
    lines.push({
      number: lineNumber,
      startOffset: text2.length,
      endOffset: text2.length,
      text: ""
    });
  }
  return lines;
}
function paragraphBlock(paragraphLines, ordinal, headings) {
  const firstContent = paragraphLines.findIndex((line) => line.text.trim().length > 0);
  let lastContent = paragraphLines.length - 1;
  while (lastContent >= 0 && paragraphLines[lastContent].text.trim().length === 0) {
    lastContent -= 1;
  }
  if (firstContent < 0 || lastContent < firstContent) return null;
  const selected = paragraphLines.slice(firstContent, lastContent + 1);
  const first = selected[0];
  const last = selected[selected.length - 1];
  return {
    kind: "paragraph",
    ordinal,
    parentOrdinal: headings.at(-1)?.ordinal ?? null,
    headingLevel: null,
    headingPath: headings.map((heading) => heading.title),
    startLine: first.number,
    endLine: last.number,
    startOffset: first.startOffset,
    endOffset: last.endOffset,
    text: selected.map((line) => line.text).join("\n").trim()
  };
}
function headingTitle(raw) {
  return raw.replace(/[\t ]+#+[\t ]*$/, "").trim();
}
function parseMarkdown(text2) {
  const lines = splitLines(text2);
  const blocks = [];
  const headings = [];
  let paragraphLines = [];
  let fenceMarker = null;
  const flushParagraph = () => {
    const block = paragraphBlock(paragraphLines, blocks.length, headings);
    if (block) blocks.push(block);
    paragraphLines = [];
  };
  const addHeading = (line, level, title, endLine = line) => {
    flushParagraph();
    while (headings.length > 0 && headings[headings.length - 1].level >= level) headings.pop();
    const block = {
      kind: "heading",
      ordinal: blocks.length,
      parentOrdinal: headings.at(-1)?.ordinal ?? null,
      headingLevel: level,
      headingPath: [...headings.map((heading) => heading.title), title],
      startLine: line.number,
      endLine: endLine.number,
      startOffset: line.startOffset,
      endOffset: endLine.endOffset,
      text: title
    };
    blocks.push(block);
    headings.push({ level, title, ordinal: block.ordinal });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.text.match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      if (fenceMarker === marker) fenceMarker = null;
      else if (!fenceMarker) fenceMarker = marker;
      paragraphLines.push(line);
      continue;
    }
    if (!fenceMarker) {
      const atx = line.text.match(ATX_HEADING);
      if (atx) {
        const title = headingTitle(atx[2]);
        if (title) addHeading(line, atx[1].length, title);
        continue;
      }
      const nextLine = lines[index + 1];
      const setext = nextLine?.text.match(SETEXT_HEADING);
      if (line.text.trim() && setext) {
        addHeading(line, setext[1][0] === "=" ? 1 : 2, line.text.trim(), nextLine);
        index += 1;
        continue;
      }
      if (!line.text.trim()) {
        flushParagraph();
        continue;
      }
    }
    paragraphLines.push(line);
  }
  flushParagraph();
  return blocks;
}
function parsePlainText(text2) {
  const blocks = [];
  let paragraphLines = [];
  const flushParagraph = () => {
    const block = paragraphBlock(paragraphLines, blocks.length, []);
    if (block) blocks.push(block);
    paragraphLines = [];
  };
  for (const line of splitLines(text2)) {
    if (!line.text.trim()) flushParagraph();
    else paragraphLines.push(line);
  }
  flushParagraph();
  return blocks;
}
const MARKDOWN_EXTENSIONS = /* @__PURE__ */ new Set([".md", ".mdx"]);
function normalizeForFts(value) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu, " $1 ").replace(/[^\p{Letter}\p{Number}_]+/gu, " ").trim().replace(/\s+/g, " ");
}
function makeFtsQuery(query) {
  const normalized = normalizeForFts(query);
  if (!normalized) return null;
  return `"${normalized.replaceAll('"', '""')}"`;
}
class EvidenceService {
  constructor(database, objectPath, onUpdated) {
    this.database = database;
    this.objectPath = objectPath;
    this.onUpdated = onUpdated;
  }
  processor = null;
  stopping = false;
  initialize() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS evidence_parse_jobs (
        source_version_id TEXT PRIMARY KEY REFERENCES source_versions(id) ON DELETE CASCADE,
        parser TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        parsed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS evidence_blocks (
        id TEXT PRIMARY KEY,
        source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES evidence_blocks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('heading', 'paragraph')),
        ordinal INTEGER NOT NULL,
        heading_level INTEGER,
        heading_path_json TEXT NOT NULL DEFAULT '[]',
        page_number INTEGER,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        search_text TEXT NOT NULL,
        search_heading_path TEXT NOT NULL,
        UNIQUE(source_version_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_blocks_version_ordinal
        ON evidence_blocks(source_version_id, ordinal);

      CREATE INDEX IF NOT EXISTS idx_evidence_blocks_parent_id
        ON evidence_blocks(parent_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
        search_text,
        search_heading_path,
        content = 'evidence_blocks',
        content_rowid = 'rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS evidence_blocks_ai AFTER INSERT ON evidence_blocks BEGIN
        INSERT INTO evidence_fts(rowid, search_text, search_heading_path)
        VALUES (new.rowid, new.search_text, new.search_heading_path);
      END;

      CREATE TRIGGER IF NOT EXISTS evidence_blocks_ad AFTER DELETE ON evidence_blocks BEGIN
        INSERT INTO evidence_fts(evidence_fts, rowid, search_text, search_heading_path)
        VALUES ('delete', old.rowid, old.search_text, old.search_heading_path);
      END;

      CREATE TRIGGER IF NOT EXISTS evidence_blocks_au AFTER UPDATE ON evidence_blocks BEGIN
        INSERT INTO evidence_fts(evidence_fts, rowid, search_text, search_heading_path)
        VALUES ('delete', old.rowid, old.search_text, old.search_heading_path);
        INSERT INTO evidence_fts(rowid, search_text, search_heading_path)
        VALUES (new.rowid, new.search_text, new.search_heading_path);
      END;
    `);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.database.prepare(`
      UPDATE evidence_parse_jobs
      SET status = 'pending', error_message = '应用在解析完成前退出', started_at = NULL
      WHERE status = 'running'
    `).run();
    this.database.prepare(`
      INSERT OR IGNORE INTO evidence_parse_jobs (
        source_version_id, parser, status, queued_at
      )
      SELECT source_versions.id,
        CASE WHEN LOWER(source_items.extension) IN ('.md', '.mdx') THEN 'markdown-v1' ELSE 'text-v1' END,
        'pending', ?
      FROM source_versions
      JOIN source_items ON source_items.id = source_versions.source_item_id
      WHERE LOWER(source_items.extension) IN ('.md', '.mdx', '.text', '.txt')
    `).run(now);
    const indexCounts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM evidence_blocks) AS block_count,
        (SELECT COUNT(*) FROM evidence_fts) AS index_count
    `).get();
    if (Number(indexCounts.block_count) !== Number(indexCounts.index_count)) {
      this.database.exec("INSERT INTO evidence_fts(evidence_fts) VALUES ('rebuild')");
    }
    this.schedulePending();
  }
  enqueueVersion(sourceVersionId, extension) {
    const normalizedExtension = extension.toLowerCase();
    if (!isLocalParseableExtension(normalizedExtension)) return;
    this.database.prepare(`
      INSERT OR IGNORE INTO evidence_parse_jobs (
        source_version_id, parser, status, queued_at
      ) VALUES (?, ?, 'pending', ?)
    `).run(
      sourceVersionId,
      MARKDOWN_EXTENSIONS.has(normalizedExtension) ? "markdown-v1" : "text-v1",
      (/* @__PURE__ */ new Date()).toISOString()
    );
    this.schedulePending();
  }
  async shutdown() {
    this.stopping = true;
    await this.processor;
  }
  listDocument(dataSourceId, fileId) {
    const row = this.database.prepare(`
      SELECT
        source_versions.id AS version_id,
        source_items.relative_path AS file_name,
        source_items.relative_path,
        source_items.extension,
        source_versions.source_modified_at AS modified_at,
        source_versions.content_hash,
        source_items.state,
        evidence_parse_jobs.status,
        evidence_parse_jobs.parser,
        evidence_parse_jobs.error_message,
        evidence_parse_jobs.parsed_at
      FROM source_items
      JOIN source_versions ON source_versions.id = (
        SELECT latest.id FROM source_versions AS latest
        WHERE latest.source_item_id = source_items.id
        ORDER BY latest.captured_at DESC, latest.rowid DESC
        LIMIT 1
      )
      LEFT JOIN evidence_parse_jobs ON evidence_parse_jobs.source_version_id = source_versions.id
      WHERE source_items.id = ? AND source_items.data_source_id = ?
    `).get(fileId, dataSourceId);
    if (!row) throw new Error("文件或文件版本不存在。");
    const status = row.status ?? "unsupported";
    const blocks = status === "success" ? this.database.prepare(`
          SELECT id, kind, ordinal, parent_id, heading_level, heading_path_json,
            page_number, start_line, end_line, start_offset, end_offset, text, content_hash
          FROM evidence_blocks
          WHERE source_version_id = ?
          ORDER BY ordinal
        `).all(row.version_id) : [];
    return {
      sourceId: dataSourceId,
      fileId,
      versionId: row.version_id,
      fileName: row.file_name.split("/").at(-1) ?? row.file_name,
      relativePath: row.relative_path,
      extension: row.extension,
      modifiedAt: row.modified_at,
      contentHash: row.content_hash,
      exists: row.state === "present",
      status,
      parser: row.parser,
      error: row.error_message,
      parsedAt: row.parsed_at,
      blocks: blocks.map((block) => this.toBlock(block))
    };
  }
  search(query, dataSourceId, limit = 50) {
    const ftsQuery = makeFtsQuery(query);
    if (!ftsQuery) return [];
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = this.database.prepare(`
      SELECT
        evidence_blocks.id,
        evidence_blocks.kind,
        evidence_blocks.ordinal,
        evidence_blocks.parent_id,
        evidence_blocks.heading_level,
        evidence_blocks.heading_path_json,
        evidence_blocks.page_number,
        evidence_blocks.start_line,
        evidence_blocks.end_line,
        evidence_blocks.start_offset,
        evidence_blocks.end_offset,
        evidence_blocks.text,
        evidence_blocks.content_hash,
        data_sources.id AS source_id,
        data_sources.name AS source_name,
        source_items.id AS file_id,
        source_items.relative_path AS file_name,
        source_items.relative_path,
        source_versions.id AS version_id,
        source_versions.source_modified_at AS modified_at
      FROM evidence_fts
      JOIN evidence_blocks ON evidence_blocks.rowid = evidence_fts.rowid
      JOIN source_versions ON source_versions.id = evidence_blocks.source_version_id
      JOIN source_items ON source_items.id = source_versions.source_item_id
      JOIN data_sources ON data_sources.id = source_items.data_source_id
      WHERE evidence_fts MATCH ?
        AND (? IS NULL OR data_sources.id = ?)
        AND source_versions.id = (
          SELECT latest.id FROM source_versions AS latest
          WHERE latest.source_item_id = source_items.id
          ORDER BY latest.captured_at DESC, latest.rowid DESC
          LIMIT 1
        )
      ORDER BY bm25(evidence_fts), source_items.relative_path, evidence_blocks.ordinal
      LIMIT ?
    `).all(ftsQuery, dataSourceId, dataSourceId, boundedLimit);
    return rows.map((row) => ({
      ...this.toBlock(row),
      sourceId: row.source_id,
      sourceName: row.source_name,
      fileId: row.file_id,
      fileName: row.file_name.split("/").at(-1) ?? row.file_name,
      relativePath: row.relative_path,
      versionId: row.version_id,
      modifiedAt: row.modified_at
    }));
  }
  schedulePending() {
    if (this.stopping || this.processor) return;
    this.processor = this.processPending().finally(() => {
      this.processor = null;
      if (!this.stopping && this.hasPending()) this.schedulePending();
    });
  }
  hasPending() {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM evidence_parse_jobs WHERE status = 'pending' LIMIT 1
    `).get());
  }
  async processPending() {
    while (!this.stopping) {
      const job = this.database.prepare(`
        SELECT evidence_parse_jobs.source_version_id, source_versions.object_hash,
          source_items.extension, source_items.data_source_id
        FROM evidence_parse_jobs
        JOIN source_versions ON source_versions.id = evidence_parse_jobs.source_version_id
        JOIN source_items ON source_items.id = source_versions.source_item_id
        WHERE evidence_parse_jobs.status = 'pending'
        ORDER BY evidence_parse_jobs.queued_at
        LIMIT 1
      `).get();
      if (!job) return;
      await this.parseJob(job);
    }
  }
  async parseJob(job) {
    this.database.prepare(`
      UPDATE evidence_parse_jobs
      SET status = 'running', attempt_count = attempt_count + 1,
        error_message = NULL, started_at = ?, parsed_at = NULL
      WHERE source_version_id = ?
    `).run((/* @__PURE__ */ new Date()).toISOString(), job.source_version_id);
    try {
      const buffer = await readFile(this.objectPath(job.object_hash));
      const text2 = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "");
      const blocks = MARKDOWN_EXTENSIONS.has(job.extension.toLowerCase()) ? parseMarkdown(text2) : parsePlainText(text2);
      this.replaceBlocks(job.source_version_id, blocks);
      this.database.prepare(`
        UPDATE evidence_parse_jobs
        SET status = 'success', error_message = NULL, parsed_at = ?
        WHERE source_version_id = ?
      `).run((/* @__PURE__ */ new Date()).toISOString(), job.source_version_id);
      this.onUpdated(job.data_source_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "文档解析失败";
      this.database.prepare(`
        UPDATE evidence_parse_jobs
        SET status = 'failed', error_message = ?, parsed_at = ?
        WHERE source_version_id = ?
      `).run(message.slice(0, 500), (/* @__PURE__ */ new Date()).toISOString(), job.source_version_id);
      this.onUpdated(job.data_source_id);
    }
  }
  replaceBlocks(sourceVersionId, blocks) {
    const ids = blocks.map(() => randomUUID());
    const insert = this.database.prepare(`
      INSERT INTO evidence_blocks (
        id, source_version_id, parent_id, kind, ordinal, heading_level,
        heading_path_json, page_number, start_line, end_line, start_offset,
        end_offset, text, content_hash, search_text, search_heading_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM evidence_blocks WHERE source_version_id = ?").run(sourceVersionId);
      for (const block of blocks) {
        const headingPath = block.headingPath.join(" / ");
        insert.run(
          ids[block.ordinal],
          sourceVersionId,
          block.parentOrdinal === null ? null : ids[block.parentOrdinal],
          block.kind,
          block.ordinal,
          block.headingLevel,
          JSON.stringify(block.headingPath),
          block.startLine,
          block.endLine,
          block.startOffset,
          block.endOffset,
          block.text,
          createHash("sha256").update(block.text).digest("hex"),
          normalizeForFts(block.text),
          normalizeForFts(headingPath)
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  toBlock(row) {
    let headingPath = [];
    try {
      const parsed = JSON.parse(row.heading_path_json);
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) {
        headingPath = parsed;
      }
    } catch {
    }
    return {
      id: row.id,
      kind: row.kind,
      ordinal: Number(row.ordinal),
      parentId: row.parent_id,
      headingLevel: row.heading_level === null ? null : Number(row.heading_level),
      headingPath,
      pageNumber: row.page_number === null ? null : Number(row.page_number),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset),
      text: row.text,
      contentHash: row.content_hash
    };
  }
}
class LocalDataService {
  constructor(dataDirectory2, connectors, fileExports = null, autoScanExtensions = LOCAL_AUTO_SCAN_EXTENSIONS, connectorImportExtensions = LOCAL_PARSEABLE_EXTENSIONS, highRiskImports = null) {
    this.dataDirectory = dataDirectory2;
    this.connectors = connectors;
    this.fileExports = fileExports;
    this.autoScanExtensions = autoScanExtensions;
    this.connectorImportExtensions = connectorImportExtensions;
    this.highRiskImports = highRiskImports;
    this.objectsDirectory = join(dataDirectory2, "objects", "sha256");
    mkdirSync(join(dataDirectory2, "database"), { recursive: true });
    this.database = new DatabaseSync(join(dataDirectory2, "database", "nxcore.db"));
    this.evidence = new EvidenceService(
      this.database,
      (hash2) => this.objectPath(hash2),
      (sourceId) => this.notifyChanged(sourceId, true)
    );
    this.highRiskImports?.setAutoResolver((batch, accepted) => this.resolveAutoScanBatch(batch, accepted));
  }
  database;
  objectsDirectory;
  evidence;
  activeScans = /* @__PURE__ */ new Map();
  disconnectingSources = /* @__PURE__ */ new Set();
  pendingDisconnects = /* @__PURE__ */ new Set();
  watchers = /* @__PURE__ */ new Map();
  scanStates = /* @__PURE__ */ new Map();
  watcherRetryTimers = /* @__PURE__ */ new Map();
  changeListeners = /* @__PURE__ */ new Set();
  exportWorker = null;
  shuttingDown = false;
  async initialize() {
    await Promise.all([
      mkdir(join(this.dataDirectory, "database"), { recursive: true }),
      mkdir(this.objectsDirectory, { recursive: true }),
      mkdir(join(this.dataDirectory, "logs"), { recursive: true })
    ]);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS data_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        root_path TEXT UNIQUE,
        connection_key TEXT NOT NULL UNIQUE,
        config_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        last_synced_at TEXT,
        last_error TEXT,
        last_change_run_id TEXT,
        disconnected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_items (
        id TEXT PRIMARY KEY,
        data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
        file_identity TEXT NOT NULL,
        remote_id TEXT,
        title TEXT,
        uri TEXT,
        relative_path TEXT NOT NULL,
        extension TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        content_hash TEXT,
        state TEXT NOT NULL DEFAULT 'present' CHECK (state IN ('present', 'missing')),
        sync_status TEXT NOT NULL DEFAULT 'unchanged',
        previous_relative_path TEXT,
        last_change_run_id TEXT,
        last_changed_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(data_source_id, file_identity)
      );

      CREATE INDEX IF NOT EXISTS idx_source_items_source_path
        ON source_items(data_source_id, relative_path);

      CREATE TABLE IF NOT EXISTS source_ignored_items (
        data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
        remote_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        ignored_at TEXT NOT NULL,
        PRIMARY KEY(data_source_id, remote_id)
      );

      CREATE TABLE IF NOT EXISTS source_versions (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        object_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        source_modified_at TEXT NOT NULL,
        import_policy TEXT NOT NULL DEFAULT 'normal',
        captured_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_source_versions_object_hash
        ON source_versions(object_hash);

      CREATE INDEX IF NOT EXISTS idx_source_versions_item_captured
        ON source_versions(source_item_id, captured_at);

      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
        discovered INTEGER NOT NULL DEFAULT 0,
        added INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        moved INTEGER NOT NULL DEFAULT 0,
        unchanged INTEGER NOT NULL DEFAULT 0,
        removed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS local_service_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_exports (
        source_version_id TEXT PRIMARY KEY REFERENCES source_versions(id) ON DELETE CASCADE,
        file_entry_id TEXT,
        file_version_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'exporting', 'exported', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_source_exports_status_updated
        ON source_exports(status, updated_at);
    `);
    const sourceColumns = this.database.prepare("PRAGMA table_info(data_sources)").all();
    const sourceSchema = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'data_sources'
    `).get();
    if (sourceSchema.sql.includes("CHECK (kind = 'local-folder')")) {
      this.migrateDataSourcesTable(sourceColumns);
    }
    const migratedSourceColumns = this.database.prepare("PRAGMA table_info(data_sources)").all();
    if (!migratedSourceColumns.some((column) => column.name === "disconnected_at")) {
      this.database.exec("ALTER TABLE data_sources ADD COLUMN disconnected_at TEXT");
    }
    if (!migratedSourceColumns.some((column) => column.name === "last_change_run_id")) {
      this.database.exec("ALTER TABLE data_sources ADD COLUMN last_change_run_id TEXT");
    }
    if (!migratedSourceColumns.some((column) => column.name === "config_json")) {
      this.database.exec("ALTER TABLE data_sources ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!migratedSourceColumns.some((column) => column.name === "connection_key")) {
      this.database.exec("ALTER TABLE data_sources ADD COLUMN connection_key TEXT");
      this.database.exec(`
        UPDATE data_sources
        SET connection_key = kind || ':' || COALESCE(root_path, id)
        WHERE connection_key IS NULL
      `);
      this.database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_data_sources_connection_key
        ON data_sources(connection_key)
      `);
    }
    this.database.exec(`
      UPDATE data_sources
      SET config_json = json_object('rootPath', root_path)
      WHERE kind = 'local-folder' AND (config_json = '{}' OR config_json IS NULL)
    `);
    const itemColumns = this.database.prepare("PRAGMA table_info(source_items)").all();
    if (!itemColumns.some((column) => column.name === "sync_status")) {
      this.database.exec("ALTER TABLE source_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'unchanged'");
    }
    if (!itemColumns.some((column) => column.name === "remote_id")) {
      this.database.exec("ALTER TABLE source_items ADD COLUMN remote_id TEXT");
    }
    if (!itemColumns.some((column) => column.name === "title")) {
      this.database.exec("ALTER TABLE source_items ADD COLUMN title TEXT");
    }
    if (!itemColumns.some((column) => column.name === "uri")) {
      this.database.exec("ALTER TABLE source_items ADD COLUMN uri TEXT");
    }
    this.database.exec(`
      UPDATE source_items
      SET remote_id = COALESCE(remote_id, file_identity),
          title = COALESCE(title, relative_path),
          uri = COALESCE(uri, relative_path)
      WHERE remote_id IS NULL OR title IS NULL OR uri IS NULL
    `);
    if (!itemColumns.some((column) => column.name === "previous_relative_path")) {
      this.database.exec("ALTER TABLE source_items ADD COLUMN previous_relative_path TEXT");
    }
    if (!itemColumns.some((column) => column.name === "last_change_run_id")) {
      this.database.exec("ALTER TABLE source_items ADD COLUMN last_change_run_id TEXT");
    }
    if (!itemColumns.some((column) => column.name === "last_changed_at")) {
      this.database.exec("ALTER TABLE source_items ADD COLUMN last_changed_at TEXT");
      this.database.exec(`
        UPDATE source_items
        SET last_changed_at = COALESCE(last_seen_at, first_seen_at)
        WHERE last_changed_at IS NULL
      `);
    }
    this.database.exec(`
      UPDATE source_items
      SET sync_status = CASE
        WHEN state = 'missing' THEN 'missing'
        WHEN (
          SELECT COUNT(*) FROM source_versions
          WHERE source_versions.source_item_id = source_items.id
        ) > 1 THEN 'updated'
        WHEN (
          SELECT COUNT(*) FROM source_versions
          WHERE source_versions.source_item_id = source_items.id
        ) = 1 THEN 'added'
        ELSE sync_status
      END
      WHERE sync_status = 'unchanged'
    `);
    const versionSchema = this.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_versions'
    `).get();
    if (versionSchema.sql.includes("UNIQUE(source_item_id, content_hash)")) {
      this.migrateSourceVersionsTable();
    }
    const versionColumns = this.database.prepare("PRAGMA table_info(source_versions)").all();
    if (!versionColumns.some((column) => column.name === "import_policy")) {
      this.database.exec("ALTER TABLE source_versions ADD COLUMN import_policy TEXT NOT NULL DEFAULT 'normal'");
    }
    this.backfillLatestChangeRuns();
    this.evidence.initialize();
    const recoveredAt = (/* @__PURE__ */ new Date()).toISOString();
    this.database.prepare(`
      UPDATE sync_runs
      SET status = 'failed', error_message = '应用在同步完成前退出', finished_at = ?
      WHERE status = 'running'
    `).run(recoveredAt);
    this.database.prepare(`
      UPDATE data_sources
      SET status = 'error', last_error = '上次同步未完成，请重新扫描', updated_at = ?
      WHERE status = 'syncing'
    `).run(recoveredAt);
    this.database.prepare(`
      UPDATE source_exports SET status = 'pending', updated_at = ? WHERE status = 'exporting'
    `).run(recoveredAt);
    if (this.fileExports) {
      this.database.prepare(`
        INSERT OR IGNORE INTO source_exports (source_version_id, status, updated_at)
        SELECT source_versions.id, 'pending', ?
        FROM source_versions
        JOIN source_items ON source_items.id = source_versions.source_item_id
        JOIN data_sources ON data_sources.id = source_items.data_source_id
        WHERE data_sources.kind = 'local-folder' AND source_items.state = 'present'
          AND source_versions.import_policy IN ('normal', 'approved')
      `).run(recoveredAt);
      const connectorVersions = this.database.prepare(`
        SELECT source_versions.id, data_sources.kind, source_items.extension, source_items.remote_id
        FROM source_versions
        JOIN source_items ON source_items.id = source_versions.source_item_id
        JOIN data_sources ON data_sources.id = source_items.data_source_id
        WHERE data_sources.kind != 'local-folder' AND source_items.state = 'present'
      `).all();
      const backfill = this.database.prepare(`
        INSERT OR IGNORE INTO source_exports (source_version_id, status, updated_at)
        VALUES (?, 'pending', ?)
      `);
      for (const version of connectorVersions) {
        const eligible = this.connectorImportExtensions.has(version.extension.toLowerCase()) && (version.kind === "google-docs" || version.kind === "notion" || version.kind === "github" && !version.remote_id.startsWith("repo:issue:"));
        if (eligible) backfill.run(version.id, recoveredAt);
      }
    }
    const connectedSources = this.database.prepare(`
      SELECT * FROM data_sources
      WHERE status = 'connected' AND disconnected_at IS NULL
    `).all();
    for (const source of connectedSources) {
      this.startWatching(source);
      void this.sync(source.id).catch(() => void 0);
    }
    this.kickExportWorker();
  }
  migrateDataSourcesTable(columns) {
    const hasDisconnectedAt = columns.some((column) => column.name === "disconnected_at");
    const hasLastChangeRunId = columns.some((column) => column.name === "last_change_run_id");
    const disconnectedAt = hasDisconnectedAt ? "disconnected_at" : "NULL";
    const lastChangeRunId = hasLastChangeRunId ? "last_change_run_id" : "NULL";
    this.database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      BEGIN IMMEDIATE;

      ALTER TABLE data_sources RENAME TO data_sources_legacy;

      CREATE TABLE data_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        root_path TEXT UNIQUE,
        connection_key TEXT NOT NULL UNIQUE,
        config_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        last_synced_at TEXT,
        last_error TEXT,
        last_change_run_id TEXT,
        disconnected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO data_sources (
        id, kind, name, root_path, connection_key, config_json, status, last_synced_at, last_error,
        last_change_run_id, disconnected_at, created_at, updated_at
      )
      SELECT
        id, kind, name, root_path, kind || ':' || COALESCE(root_path, id),
        json_object('rootPath', root_path), status,
        last_synced_at, last_error, ${lastChangeRunId}, ${disconnectedAt}, created_at, updated_at
      FROM data_sources_legacy;

      DROP TABLE data_sources_legacy;
      COMMIT;
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;
    `);
    const foreignKeyIssues = this.database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyIssues.length > 0) {
      throw new Error("数据源数据库迁移后外键检查失败。");
    }
  }
  migrateSourceVersionsTable() {
    this.database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      BEGIN IMMEDIATE;

      ALTER TABLE source_versions RENAME TO source_versions_legacy;

      CREATE TABLE source_versions (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        object_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        source_modified_at TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      INSERT INTO source_versions (
        id, source_item_id, content_hash, object_hash, size, source_modified_at, captured_at
      )
      SELECT
        id, source_item_id, content_hash, object_hash, size, source_modified_at, captured_at
      FROM source_versions_legacy;

      DROP TABLE source_versions_legacy;
      CREATE INDEX IF NOT EXISTS idx_source_versions_object_hash
        ON source_versions(object_hash);
      CREATE INDEX IF NOT EXISTS idx_source_versions_item_captured
        ON source_versions(source_item_id, captured_at);

      COMMIT;
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;
    `);
    const foreignKeyIssues = this.database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyIssues.length > 0) {
      throw new Error("文件版本数据库迁移后外键检查失败。");
    }
  }
  backfillLatestChangeRuns() {
    this.database.exec(`
      UPDATE data_sources
      SET last_change_run_id = (
        SELECT sync_runs.id
        FROM sync_runs
        WHERE sync_runs.data_source_id = data_sources.id
          AND sync_runs.status = 'success'
          AND (
            sync_runs.added > 0 OR sync_runs.updated > 0 OR sync_runs.moved > 0 OR
            sync_runs.removed > 0 OR sync_runs.failed > 0
          )
        ORDER BY sync_runs.finished_at DESC, sync_runs.started_at DESC
        LIMIT 1
      )
      WHERE last_change_run_id IS NULL
    `);
    this.database.exec(`
      UPDATE source_items
      SET last_change_run_id = (
        SELECT sync_runs.id
        FROM sync_runs
        WHERE sync_runs.data_source_id = source_items.data_source_id
          AND sync_runs.status = 'success'
          AND (
            EXISTS (
              SELECT 1
              FROM source_versions
              WHERE source_versions.source_item_id = source_items.id
                AND source_versions.captured_at >= sync_runs.started_at
                AND source_versions.captured_at <= COALESCE(sync_runs.finished_at, sync_runs.started_at)
            )
            OR (
              source_items.sync_status IN ('renamed', 'moved', 'restored', 'error')
              AND source_items.last_changed_at >= sync_runs.started_at
              AND source_items.last_changed_at <= COALESCE(sync_runs.finished_at, sync_runs.started_at)
            )
          )
        ORDER BY sync_runs.finished_at DESC, sync_runs.started_at DESC
        LIMIT 1
      )
      WHERE last_change_run_id IS NULL
    `);
  }
  async shutdown() {
    this.shuttingDown = true;
    for (const state of this.scanStates.values()) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
    }
    this.scanStates.clear();
    for (const timer of this.watcherRetryTimers.values()) clearTimeout(timer);
    this.watcherRetryTimers.clear();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await Promise.allSettled(this.activeScans.values());
    await Promise.allSettled(this.pendingDisconnects);
    await this.exportWorker;
    await this.evidence.shutdown();
    this.database.close();
  }
  listSources() {
    const rows = this.database.prepare("SELECT * FROM data_sources ORDER BY created_at DESC").all();
    return rows.map((row) => this.toSummary(row));
  }
  onChanged(listener) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  listFiles(dataSourceId) {
    this.requireSource(dataSourceId);
    const rows = this.database.prepare(`
      SELECT
        source_items.id,
        source_items.relative_path,
        source_items.previous_relative_path,
        source_items.extension,
        source_items.size,
        source_items.modified_at,
        source_items.state,
        source_items.sync_status,
        source_items.last_change_run_id,
        source_items.last_changed_at,
        source_items.content_hash,
        source_items.last_seen_at,
        COUNT(CASE WHEN source_versions.import_policy IN ('normal', 'approved') THEN source_versions.id END) AS version_count,
        (
          SELECT evidence_parse_jobs.status
          FROM source_versions AS latest_version
          LEFT JOIN evidence_parse_jobs
            ON evidence_parse_jobs.source_version_id = latest_version.id
          WHERE latest_version.source_item_id = source_items.id
            AND latest_version.import_policy IN ('normal', 'approved')
          ORDER BY latest_version.captured_at DESC, latest_version.rowid DESC
          LIMIT 1
        ) AS parse_status,
        (
          SELECT COUNT(*)
          FROM evidence_blocks
          WHERE evidence_blocks.source_version_id = (
            SELECT latest_evidence_version.id
            FROM source_versions AS latest_evidence_version
            WHERE latest_evidence_version.source_item_id = source_items.id
              AND latest_evidence_version.import_policy IN ('normal', 'approved')
            ORDER BY latest_evidence_version.captured_at DESC, latest_evidence_version.rowid DESC
            LIMIT 1
          )
        ) AS evidence_count
      FROM source_items
      LEFT JOIN source_versions ON source_versions.source_item_id = source_items.id
      WHERE source_items.data_source_id = ?
        AND EXISTS (
          SELECT 1
          FROM source_versions AS visible_version
          WHERE visible_version.source_item_id = source_items.id
            AND visible_version.import_policy IN ('normal', 'approved')
        )
      GROUP BY source_items.id
      ORDER BY source_items.state = 'missing', source_items.relative_path COLLATE NOCASE
    `).all(dataSourceId);
    const source = this.requireSource(dataSourceId);
    const connector = this.connectors.get(source.kind);
    const connection = this.toConnection(source);
    return rows.map((row) => ({
      id: row.id,
      name: basename(row.relative_path),
      relativePath: row.relative_path,
      previousRelativePath: row.previous_relative_path,
      originalPath: connector.resolveLocalPath ? connector.resolveLocalPath(connection, row.relative_path) : row.relative_path,
      extension: row.extension,
      size: Number(row.size),
      modifiedAt: row.modified_at,
      exists: row.state === "present",
      status: row.state === "missing" ? "missing" : source.last_change_run_id !== null && row.last_change_run_id === source.last_change_run_id ? row.sync_status : "unchanged",
      changedAt: row.last_changed_at,
      versionCount: Number(row.version_count),
      contentHash: row.content_hash,
      lastSeenAt: row.last_seen_at,
      parseStatus: row.parse_status ?? "unsupported",
      evidenceCount: Number(row.evidence_count)
    }));
  }
  listEvidence(dataSourceId, fileId) {
    this.requireSource(dataSourceId);
    return this.evidence.listDocument(dataSourceId, fileId);
  }
  async previewFile(dataSourceId, fileId) {
    this.requireSource(dataSourceId);
    const row = this.database.prepare(`
      SELECT relative_path, extension, modified_at, content_hash, state
      FROM source_items WHERE id = ? AND data_source_id = ?
    `).get(fileId, dataSourceId);
    if (!row) throw new Error("文件记录不存在。");
    if (row.state !== "present" || !row.content_hash) throw new Error("文件当前不可预览。");
    if (![".md", ".mdx", ".markdown"].includes(row.extension.toLowerCase())) throw new Error("仅支持 Markdown 文件预览。");
    const content = await readFile(this.objectPath(row.content_hash), "utf8");
    if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) throw new Error("Markdown 文件过大，无法预览。");
    return { fileName: basename(row.relative_path), relativePath: row.relative_path, modifiedAt: row.modified_at, content };
  }
  searchEvidence(query, dataSourceId) {
    if (dataSourceId) this.requireSource(dataSourceId);
    return this.evidence.search(query, dataSourceId);
  }
  getOriginalFilePath(dataSourceId, fileId) {
    const source = this.requireSource(dataSourceId);
    const connector = this.connectors.get(source.kind);
    if (!connector.resolveLocalPath) throw new Error("该数据源没有可在本机打开的位置。");
    const item = this.database.prepare(`
      SELECT relative_path, state
      FROM source_items
      WHERE id = ? AND data_source_id = ?
    `).get(fileId, dataSourceId);
    if (!item) throw new Error("文件记录不存在。");
    if (item.state !== "present") throw new Error("原始文件当前不存在。");
    return connector.resolveLocalPath(this.toConnection(source), item.relative_path);
  }
  getSourceItemLocation(dataSourceId, fileId) {
    const source = this.requireSource(dataSourceId);
    const item = this.database.prepare(`
      SELECT relative_path, uri, state
      FROM source_items
      WHERE id = ? AND data_source_id = ?
    `).get(fileId, dataSourceId);
    if (!item) throw new Error("文件记录不存在。");
    if (item.state !== "present") throw new Error("原始文件当前不存在。");
    const connector = this.connectors.get(source.kind);
    if (connector.resolveLocalPath) {
      return { kind: "local", value: connector.resolveLocalPath(this.toConnection(source), item.relative_path) };
    }
    if (!item.uri) throw new Error("该文件没有可打开的来源地址。");
    return { kind: "remote", value: item.uri };
  }
  async addLocalFolder(rootPath) {
    return this.addConnection("local-folder", basename(rootPath), { rootPath }, rootPath);
  }
  async connectLocalFolders(rootPaths) {
    const results = [];
    const uniquePaths = [...new Set(rootPaths.map((rootPath) => rootPath.trim()).filter(Boolean))];
    for (const rootPath of uniquePaths) {
      try {
        const info = await stat(rootPath);
        if (!info.isDirectory()) throw new Error("所选位置不是文件夹。");
        await this.addLocalFolder(rootPath);
        results.push({ rootPath, connected: true });
      } catch (error) {
        results.push({
          rootPath,
          connected: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return results;
  }
  async addConnection(kind, name, config, compatibilityRootPath = null) {
    const connector = this.connectors.get(kind);
    const connectionKey = `${kind}:${connector.getConnectionKey(config)}`;
    const existing = this.database.prepare("SELECT * FROM data_sources WHERE kind = ? AND connection_key = ?").get(kind, connectionKey);
    if (existing) {
      if (existing.status === "paused" || existing.disconnected_at) {
        this.setPaused(existing.id, false);
      }
      this.startWatching(this.requireSource(existing.id));
      const result = await this.sync(existing.id);
      return result;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO data_sources (
        id, kind, name, root_path, connection_key, config_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'connected', ?, ?)
    `).run(
      id,
      kind,
      name,
      compatibilityRootPath,
      connectionKey,
      JSON.stringify(config),
      now,
      now
    );
    this.startWatching(this.requireSource(id));
    return this.sync(id);
  }
  sync(id) {
    if (this.disconnectingSources.has(id)) {
      return Promise.reject(new Error("数据源正在清理，请稍候。"));
    }
    const running = this.activeScans.get(id);
    if (running) {
      this.scanState(id).dirty = true;
      return running;
    }
    const state = this.scanState(id);
    state.dirty = false;
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
    const scan = this.performSync(id).finally(() => this.activeScans.delete(id));
    this.activeScans.set(id, scan);
    const schedulePendingScan = () => {
      const nextState = this.scanStates.get(id);
      if (nextState?.dirty && !this.shuttingDown && !this.disconnectingSources.has(id)) {
        this.scheduleScan(id);
      }
    };
    void scan.then(schedulePendingScan, schedulePendingScan);
    return scan;
  }
  setPaused(id, paused) {
    if (this.disconnectingSources.has(id)) throw new Error("数据源正在清理，请稍候。");
    if (this.activeScans.has(id)) throw new Error("同步进行中，请等待完成后再更改状态。");
    const source = this.requireSource(id);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.database.prepare("UPDATE data_sources SET status = ?, disconnected_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?").run(paused ? "paused" : "connected", now, id);
    if (paused) this.stopWatching(id);
    else {
      this.startWatching({ ...source, status: "connected", disconnected_at: null });
      void this.sync(id).catch(() => void 0);
    }
    this.notifyChanged(id, false);
    return this.toSummary({
      ...source,
      status: paused ? "paused" : "connected",
      disconnected_at: null,
      last_error: null
    });
  }
  disconnect(id, deleteLocalData) {
    this.requireSource(id);
    this.stopWatching(id);
    if (!deleteLocalData) {
      this.database.prepare(`
        UPDATE data_sources SET status = 'paused', disconnected_at = ?, last_error = NULL, updated_at = ? WHERE id = ?
      `).run((/* @__PURE__ */ new Date()).toISOString(), (/* @__PURE__ */ new Date()).toISOString(), id);
      this.notifyChanged(id, false);
      return Promise.resolve();
    }
    if (this.disconnectingSources.has(id)) return Promise.resolve();
    this.disconnectingSources.add(id);
    this.notifyDeletion(id, "queued", 5, "已加入清理队列。");
    const activeScan = this.activeScans.get(id);
    if (!activeScan) {
      return this.clearSourceData(id).finally(() => this.disconnectingSources.delete(id));
    }
    this.notifyDeletion(id, "waiting", 15, "正在等待当前扫描结束。");
    const cleanup = (activeScan ?? Promise.resolve()).catch(() => void 0).then(() => new Promise((resolve2) => setImmediate(resolve2))).then(() => this.clearSourceData(id)).finally(() => this.disconnectingSources.delete(id));
    this.pendingDisconnects.add(cleanup);
    void cleanup.then(
      () => this.pendingDisconnects.delete(cleanup),
      () => this.pendingDisconnects.delete(cleanup)
    );
    void cleanup.catch((error) => {
      this.notifyDeletion(id, "failed", 0, "清理失败，请重试。");
      console.error(`[local-data] failed to clear source ${id}`, error);
    });
    return Promise.resolve();
  }
  async clearSourceData(id) {
    await this.highRiskImports?.discardAutoSource(id);
    const objectHashes = this.database.prepare(`
      SELECT DISTINCT source_versions.object_hash AS object_hash
      FROM source_versions
      JOIN source_items ON source_items.id = source_versions.source_item_id
      WHERE source_items.data_source_id = ?
    `).all(id);
    this.notifyDeletion(id, "database", 55, "正在清理数据库记录。");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM source_items WHERE data_source_id = ?").run(id);
      this.database.prepare("DELETE FROM sync_runs WHERE data_source_id = ?").run(id);
      this.database.prepare(`
        UPDATE data_sources
        SET status = 'paused', last_synced_at = NULL, last_error = NULL,
            last_change_run_id = NULL, disconnected_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(now, id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.notifyDeletion(id, "objects", 75, "正在删除本地文件副本。");
    let lastPercent = 75;
    const totalObjects = Math.max(1, objectHashes.length);
    for (const [index, { object_hash: objectHash }] of objectHashes.entries()) {
      const reference = this.database.prepare("SELECT 1 FROM source_versions WHERE object_hash = ? LIMIT 1").get(objectHash);
      if (!reference && /^[a-f0-9]{64}$/.test(objectHash)) {
        await unlink(this.objectPath(objectHash)).catch(() => void 0);
      }
      const percent = 75 + Math.round((index + 1) / totalObjects * 25);
      if (percent !== lastPercent) {
        this.notifyDeletion(id, "objects", percent, "正在删除本地文件副本。");
        lastPercent = percent;
      }
    }
    this.notifyDeletion(id, "completed", 100, "文档数据已清理，目录已保留并暂停扫描。");
    this.notifyChanged(id, true);
  }
  async performSync(id) {
    const source = this.requireSource(id);
    if (source.disconnected_at) throw new Error("该数据源已断开，请先重新连接。");
    if (source.status === "paused") throw new Error("该数据源已暂停，请先恢复同步。");
    const runId = randomUUID();
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    const counts = { discovered: 0, added: 0, updated: 0, moved: 0, unchanged: 0, removed: 0, failed: 0 };
    this.database.prepare(`
      INSERT INTO sync_runs (id, data_source_id, status, started_at)
      VALUES (?, ?, 'running', ?)
    `).run(runId, id, startedAt);
    this.database.prepare("UPDATE data_sources SET status = 'syncing', last_error = NULL, updated_at = ? WHERE id = ?").run(startedAt, id);
    try {
      const connector = this.connectors.get(source.kind);
      const scan = await connector.scan(this.toConnection(source));
      if (this.disconnectingSources.has(id)) throw new Error("数据源正在清理。");
      const ignoredRemoteIds = source.kind === "local-folder" ? new Set(this.database.prepare(
        "SELECT remote_id FROM source_ignored_items WHERE data_source_id = ?"
      ).all(id).map((row) => row.remote_id)) : /* @__PURE__ */ new Set();
      const items = source.kind === "local-folder" ? scan.items.filter((item) => {
        const segments = item.path.split(/[\\/]/);
        const extension = extname(item.path).toLowerCase();
        return !segments.slice(0, -1).some(isIgnoredLocalDirectory) && !item.title.startsWith(".") && !ignoredRemoteIds.has(item.remoteId) && this.autoScanExtensions.has(extension);
      }) : scan.items;
      counts.failed = scan.failed;
      counts.discovered = items.length;
      const allExistingItems = this.database.prepare("SELECT id, remote_id, relative_path, content_hash, state, size, modified_at FROM source_items WHERE data_source_id = ?").all(id);
      const filteredItemIds = source.kind === "local-folder" ? await this.pruneFilteredLocalItems(allExistingItems) : /* @__PURE__ */ new Set();
      const existingItems = allExistingItems.filter((item) => !filteredItemIds.has(item.id));
      counts.removed += filteredItemIds.size;
      const itemsByRemoteId = new Map(existingItems.map((item) => [item.remote_id, item]));
      const itemsByPath = new Map(existingItems.map((item) => [item.relative_path, item]));
      const seenRemoteIds = /* @__PURE__ */ new Set();
      if (source.kind === "local-folder") {
        for (const item of scan.items) {
          if (ignoredRemoteIds.has(item.remoteId)) seenRemoteIds.add(item.remoteId);
        }
      }
      const highRiskImportCandidates = source.kind === "local-folder" ? items.filter((item) => {
        if (isLowRiskFileExtension(item.extension)) return false;
        const existing = itemsByRemoteId.get(item.remoteId) ?? itemsByPath.get(item.path);
        return !existing || existing.state === "missing" || existing.size !== item.byteSize || existing.modified_at !== item.modifiedAt;
      }) : [];
      const needsHighRiskReview = Boolean(
        this.highRiskImports && highRiskImportCandidates.length > HIGH_RISK_FILE_BATCH_THRESHOLD
      );
      const deferredRemoteIds = new Set(needsHighRiskReview ? highRiskImportCandidates.map((item) => item.remoteId) : []);
      const orderedItems = needsHighRiskReview ? [
        ...items.filter((item) => !deferredRemoteIds.has(item.remoteId)),
        ...items.filter((item) => deferredRemoteIds.has(item.remoteId))
      ] : items;
      const lowRiskItemCount = orderedItems.length - deferredRemoteIds.size;
      const deferredVersionIds = [];
      for (const [itemIndex, item] of orderedItems.entries()) {
        if (needsHighRiskReview && itemIndex === lowRiskItemCount) this.kickExportWorker();
        if (this.disconnectingSources.has(id)) throw new Error("数据源正在清理。");
        const existingItem = itemsByRemoteId.get(item.remoteId) ?? itemsByPath.get(item.path);
        seenRemoteIds.add(item.remoteId);
        if (existingItem) seenRemoteIds.add(existingItem.remote_id);
        try {
          if (existingItem && source.kind === "local-folder" && existingItem.content_hash && existingItem.size === item.byteSize && existingItem.modified_at === item.modifiedAt) {
            const moved2 = existingItem.relative_path !== item.path;
            if (moved2) {
              const status = basename(existingItem.relative_path) === basename(item.path) ? "moved" : "renamed";
              this.recordItemChange(existingItem, runId, item, existingItem.content_hash, status);
              counts.moved += 1;
            } else {
              this.markItemSeen(existingItem.id, item, existingItem.content_hash);
              counts.unchanged += 1;
            }
            continue;
          }
          const contentHash = await this.hashItem(item);
          const deferExport = deferredRemoteIds.has(item.remoteId);
          const shouldExport = this.shouldExport(source.kind, item) && !deferExport;
          if (!existingItem) {
            if (source.kind !== "local-folder" || !this.fileExports) await this.storeObject(item, contentHash);
            const versionId2 = this.insertItemAndVersion(id, runId, item, contentHash, shouldExport, deferExport);
            if (deferExport) deferredVersionIds.push(versionId2);
            counts.added += 1;
            continue;
          }
          const moved = existingItem.relative_path !== item.path;
          const restored = existingItem.state === "missing";
          if (existingItem.content_hash === contentHash) {
            if (moved) {
              const status = basename(existingItem.relative_path) === basename(item.path) ? "moved" : "renamed";
              this.recordItemChange(existingItem, runId, item, contentHash, status);
              counts.moved += 1;
            } else if (restored) {
              this.recordItemChange(existingItem, runId, item, contentHash, "restored");
              const versionId2 = this.insertVersion(id, existingItem.id, item, contentHash, shouldExport, deferExport);
              if (deferExport) deferredVersionIds.push(versionId2);
              counts.added += 1;
            } else {
              this.markItemSeen(existingItem.id, item, contentHash);
              counts.unchanged += 1;
            }
            continue;
          }
          if (source.kind !== "local-folder" || !this.fileExports) await this.storeObject(item, contentHash);
          this.recordItemChange(existingItem, runId, item, contentHash, "updated");
          const versionId = this.insertVersion(id, existingItem.id, item, contentHash, shouldExport, deferExport);
          if (deferExport) deferredVersionIds.push(versionId);
          if (moved) counts.moved += 1;
          counts.updated += 1;
        } catch {
          if (existingItem) {
            const failedAt = (/* @__PURE__ */ new Date()).toISOString();
            this.database.prepare(`
              UPDATE source_items
              SET sync_status = 'error', previous_relative_path = NULL,
                  last_change_run_id = ?, last_changed_at = ?, last_seen_at = ?
              WHERE id = ?
            `).run(runId, failedAt, failedAt, existingItem.id);
          }
          counts.failed += 1;
        }
      }
      const missingItems = existingItems.filter(
        (item) => item.state === "present" && !seenRemoteIds.has(item.remote_id)
      );
      if (missingItems.length > 0) {
        const markMissing = this.database.prepare(`
          UPDATE source_items
          SET state = 'missing', sync_status = 'missing', previous_relative_path = NULL,
              last_change_run_id = ?, last_changed_at = ?
          WHERE id = ?
        `);
        const changedAt = (/* @__PURE__ */ new Date()).toISOString();
        for (const item of missingItems) markMissing.run(runId, changedAt, item.id);
        counts.removed = missingItems.length;
      }
      const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.finishRun(runId, "success", counts, finishedAt, null);
      const hasChanges = counts.added > 0 || counts.updated > 0 || counts.moved > 0 || counts.removed > 0 || counts.failed > 0;
      this.database.prepare(`
        UPDATE data_sources
        SET status = 'connected', last_synced_at = ?, last_error = NULL,
            last_change_run_id = CASE WHEN ? THEN ? ELSE last_change_run_id END,
            updated_at = ?
        WHERE id = ?
      `).run(finishedAt, hasChanges ? 1 : 0, runId, finishedAt, id);
      this.notifyChanged(id, hasChanges);
      this.kickExportWorker();
      if (deferredVersionIds.length > HIGH_RISK_FILE_BATCH_THRESHOLD) {
        await this.highRiskImports.enqueueAuto({ sourceId: id, versionIds: deferredVersionIds }, source.name);
      } else if (deferredVersionIds.length > 0) {
        await this.resolveAutoScanBatch({ sourceId: id, versionIds: deferredVersionIds }, true);
      }
      return { source: this.getSummary(id), ...counts };
    } catch (error) {
      if (this.disconnectingSources.has(id)) throw error;
      const message = error instanceof Error ? error.message : "同步失败";
      const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.finishRun(runId, "failed", counts, finishedAt, message);
      this.database.prepare(`
        UPDATE data_sources SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?
      `).run(message, finishedAt, id);
      this.notifyChanged(id, false);
      throw new Error(message);
    }
  }
  startWatching(source) {
    if (this.shuttingDown || this.watchers.has(source.id)) return;
    try {
      const connector = this.connectors.get(source.kind);
      if (!connector.watch) return;
      const watcher = connector.watch(this.toConnection(source), () => {
        this.markSourceDirty(source.id);
      }, () => this.handleWatcherFailure(source.id));
      if (watcher) {
        this.watchers.set(source.id, watcher);
        const retryTimer = this.watcherRetryTimers.get(source.id);
        if (retryTimer) clearTimeout(retryTimer);
        this.watcherRetryTimers.delete(source.id);
      } else {
        this.scheduleWatcherRetry(source.id);
      }
    } catch {
      this.scheduleWatcherRetry(source.id);
    }
  }
  stopWatching(id) {
    const state = this.scanStates.get(id);
    if (state?.debounceTimer) clearTimeout(state.debounceTimer);
    this.scanStates.delete(id);
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    const retryTimer = this.watcherRetryTimers.get(id);
    if (retryTimer) clearTimeout(retryTimer);
    this.watcherRetryTimers.delete(id);
  }
  scanState(id) {
    let state = this.scanStates.get(id);
    if (!state) {
      state = { dirty: false, debounceTimer: null };
      this.scanStates.set(id, state);
    }
    return state;
  }
  markSourceDirty(id) {
    if (this.shuttingDown || this.disconnectingSources.has(id)) return;
    const state = this.scanState(id);
    state.dirty = true;
    if (!this.activeScans.has(id)) this.scheduleScan(id);
  }
  scheduleScan(id) {
    if (this.shuttingDown || this.disconnectingSources.has(id)) return;
    const state = this.scanState(id);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      if (!state.dirty || this.shuttingDown || this.disconnectingSources.has(id)) return;
      void this.sync(id).catch(() => void 0);
    }, 750);
  }
  handleWatcherFailure(id) {
    if (this.shuttingDown || this.disconnectingSources.has(id)) return;
    this.watchers.delete(id);
    this.markSourceDirty(id);
    this.scheduleWatcherRetry(id);
  }
  scheduleWatcherRetry(id) {
    if (this.shuttingDown || this.disconnectingSources.has(id) || this.watcherRetryTimers.has(id)) return;
    this.watcherRetryTimers.set(id, setTimeout(() => {
      this.watcherRetryTimers.delete(id);
      try {
        const source = this.requireSource(id);
        if (source.status !== "paused" && !source.disconnected_at) this.startWatching(source);
      } catch {
      }
    }, 5e3));
  }
  hashItem(item) {
    return new Promise((resolve2, reject) => {
      const hash2 = createHash("sha256");
      const stream2 = item.openContent();
      stream2.on("data", (chunk) => hash2.update(chunk));
      stream2.on("error", reject);
      stream2.on("end", () => resolve2(hash2.digest("hex")));
    });
  }
  async storeObject(item, hash2) {
    const destination = this.objectPath(hash2);
    try {
      await stat(destination);
      return;
    } catch {
    }
    const destinationDirectory = join(this.objectsDirectory, hash2.slice(0, 2));
    const temporaryPath = join(destinationDirectory, `.${hash2}.${randomUUID()}.tmp`);
    await mkdir(destinationDirectory, { recursive: true });
    try {
      await pipeline(item.openContent(), createWriteStream(temporaryPath, { flags: "wx" }));
      const temporaryHash = await this.hashStoredObject(temporaryPath);
      if (temporaryHash !== hash2) {
        throw new Error("文件在扫描过程中发生变化，请重新扫描。");
      }
      await rename(temporaryPath, destination);
    } finally {
      await unlink(temporaryPath).catch(() => void 0);
    }
  }
  hashStoredObject(path) {
    return new Promise((resolve2, reject) => {
      const hash2 = createHash("sha256");
      const stream2 = createReadStream(path);
      stream2.on("data", (chunk) => hash2.update(chunk));
      stream2.on("error", reject);
      stream2.on("end", () => resolve2(hash2.digest("hex")));
    });
  }
  async pruneFilteredLocalItems(items) {
    const filtered = items.filter((item) => {
      const segments = item.relative_path.split(/[\\/]/);
      const extension = extname(item.relative_path).toLowerCase();
      return segments.slice(0, -1).some(isIgnoredLocalDirectory) || !this.autoScanExtensions.has(extension);
    });
    if (filtered.length === 0) return /* @__PURE__ */ new Set();
    const objectHashes = /* @__PURE__ */ new Set();
    const findVersions = this.database.prepare(
      "SELECT object_hash FROM source_versions WHERE source_item_id = ?"
    );
    const deleteItem = this.database.prepare("DELETE FROM source_items WHERE id = ?");
    for (const item of filtered) {
      const versions = findVersions.all(item.id);
      for (const version of versions) objectHashes.add(version.object_hash);
      deleteItem.run(item.id);
    }
    for (const objectHash of objectHashes) {
      const reference = this.database.prepare(
        "SELECT 1 FROM source_versions WHERE object_hash = ? LIMIT 1"
      ).get(objectHash);
      if (!reference && /^[a-f0-9]{64}$/.test(objectHash)) {
        await unlink(this.objectPath(objectHash)).catch(() => void 0);
      }
    }
    return new Set(filtered.map((item) => item.id));
  }
  objectPath(hash2) {
    return join(this.objectsDirectory, hash2.slice(0, 2), hash2);
  }
  notifyChanged(sourceId, filesChanged) {
    for (const listener of this.changeListeners) listener({ sourceId, filesChanged });
  }
  notifyDeletion(sourceId, stage, percent, message) {
    for (const listener of this.changeListeners) {
      listener({ sourceId, filesChanged: false, deletion: { stage, percent, message } });
    }
  }
  insertItemAndVersion(dataSourceId, runId, item, hash2, shouldExport, deferExport = false) {
    const itemId = randomUUID();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.database.prepare(`
      INSERT INTO source_items (
        id, data_source_id, file_identity, remote_id, title, uri,
        relative_path, extension, size, modified_at,
        content_hash, state, sync_status, previous_relative_path, last_change_run_id, last_changed_at,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'present', 'added', NULL, ?, ?, ?, ?)
    `).run(
      itemId,
      dataSourceId,
      item.remoteId,
      item.remoteId,
      item.title,
      item.uri,
      item.path,
      item.extension,
      item.byteSize,
      item.modifiedAt,
      hash2,
      runId,
      now,
      now,
      now
    );
    return this.insertVersion(dataSourceId, itemId, item, hash2, shouldExport, deferExport);
  }
  recordItemChange(existingItem, runId, item, hash2, status) {
    const previousPath = existingItem.relative_path === item.path ? null : existingItem.relative_path;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.database.prepare(`
      UPDATE source_items
      SET file_identity = ?, remote_id = ?, title = ?, uri = ?, relative_path = ?,
          extension = ?, size = ?, modified_at = ?, content_hash = ?,
          state = 'present', sync_status = ?, previous_relative_path = ?,
          last_change_run_id = ?, last_changed_at = ?, last_seen_at = ?
      WHERE id = ?
    `).run(
      item.remoteId,
      item.remoteId,
      item.title,
      item.uri,
      item.path,
      item.extension,
      item.byteSize,
      item.modifiedAt,
      hash2,
      status,
      previousPath,
      runId,
      now,
      now,
      existingItem.id
    );
  }
  markItemSeen(itemId, item, hash2) {
    this.database.prepare(`
      UPDATE source_items
      SET file_identity = ?, remote_id = ?, title = ?, uri = ?, relative_path = ?,
          extension = ?, size = ?, modified_at = ?,
          content_hash = ?, state = 'present', last_seen_at = ?
      WHERE id = ?
    `).run(
      item.remoteId,
      item.remoteId,
      item.title,
      item.uri,
      item.path,
      item.extension,
      item.byteSize,
      item.modifiedAt,
      hash2,
      (/* @__PURE__ */ new Date()).toISOString(),
      itemId
    );
  }
  insertVersion(dataSourceId, itemId, item, hash2, shouldExport, deferExport = false) {
    const versionId = randomUUID();
    this.database.prepare(`
      INSERT INTO source_versions (
        id, source_item_id, content_hash, object_hash, size, source_modified_at, import_policy, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      versionId,
      itemId,
      hash2,
      hash2,
      item.byteSize,
      item.modifiedAt,
      deferExport ? "pending" : "normal",
      (/* @__PURE__ */ new Date()).toISOString()
    );
    if (!shouldExport && !deferExport && isLocalParseableExtension(item.extension)) {
      this.evidence.enqueueVersion(versionId, item.extension);
    }
    if (shouldExport && this.fileExports) {
      this.database.prepare(`
        INSERT OR IGNORE INTO source_exports (source_version_id, status, updated_at)
        VALUES (?, 'pending', ?)
      `).run(versionId, (/* @__PURE__ */ new Date()).toISOString());
    }
    return versionId;
  }
  async resolveAutoScanBatch(batch, accepted) {
    const findVersion = this.database.prepare(`
      SELECT source_versions.id, source_versions.object_hash, source_versions.source_item_id,
        source_items.remote_id, source_items.relative_path,
        (
          SELECT COUNT(*)
          FROM source_versions AS accepted_version
          WHERE accepted_version.source_item_id = source_versions.source_item_id
            AND accepted_version.id != source_versions.id
            AND accepted_version.import_policy IN ('normal', 'approved')
        ) AS accepted_version_count
      FROM source_versions
      JOIN source_items ON source_items.id = source_versions.source_item_id
      WHERE source_versions.id = ? AND source_items.data_source_id = ?
        AND source_items.state = 'present'
        AND source_items.modified_at = source_versions.source_modified_at
        AND source_versions.import_policy = 'pending'
    `);
    const updatePolicy = this.database.prepare(
      "UPDATE source_versions SET import_policy = ? WHERE id = ?"
    );
    const addIgnored = this.database.prepare(`
      INSERT OR REPLACE INTO source_ignored_items (data_source_id, remote_id, relative_path, ignored_at)
      VALUES (?, ?, ?, ?)
    `);
    const deleteVersion = this.database.prepare("DELETE FROM source_versions WHERE id = ?");
    const deleteItem = this.database.prepare("DELETE FROM source_items WHERE id = ?");
    const findObjectReference = this.database.prepare(
      "SELECT 1 FROM source_versions WHERE object_hash = ? LIMIT 1"
    );
    const enqueue2 = this.database.prepare(`
      INSERT OR IGNORE INTO source_exports (source_version_id, status, updated_at)
      VALUES (?, 'pending', ?)
    `);
    let processed = 0;
    for (const versionId of batch.versionIds) {
      const version = findVersion.get(versionId, batch.sourceId);
      if (!version) continue;
      if (accepted) {
        updatePolicy.run("approved", versionId);
        enqueue2.run(versionId, (/* @__PURE__ */ new Date()).toISOString());
      } else {
        addIgnored.run(batch.sourceId, version.remote_id, version.relative_path, (/* @__PURE__ */ new Date()).toISOString());
        if (Number(version.accepted_version_count) === 0) {
          deleteItem.run(version.source_item_id);
        } else {
          deleteVersion.run(versionId);
        }
        if (!findObjectReference.get(version.object_hash) && /^[a-f0-9]{64}$/.test(version.object_hash)) {
          await unlink(this.objectPath(version.object_hash)).catch(() => void 0);
        }
      }
      processed += 1;
    }
    if (accepted && processed > 0) this.kickExportWorker();
    if (!accepted && processed > 0) this.notifyChanged(batch.sourceId, true);
    return { accepted, imported: accepted ? processed : 0, failed: batch.versionIds.length - processed };
  }
  kickExportWorker() {
    if (!this.fileExports || this.shuttingDown || this.exportWorker) return;
    this.exportWorker = this.processExports().finally(() => {
      this.exportWorker = null;
      if (!this.shuttingDown && this.hasPendingExports()) this.kickExportWorker();
    });
  }
  hasPendingExports() {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM source_exports WHERE status = 'pending' LIMIT 1
    `).get());
  }
  async processExports() {
    while (!this.shuttingDown && this.fileExports) {
      const rows = this.database.prepare(`
        SELECT
          source_exports.source_version_id,
          source_exports.attempt_count,
          source_items.id AS local_item_id,
          source_items.remote_id,
          source_items.relative_path,
          source_items.title,
          source_items.uri,
          source_items.state,
          source_versions.source_modified_at,
          source_versions.object_hash,
          data_sources.*
        FROM source_exports
        JOIN source_versions ON source_versions.id = source_exports.source_version_id
        JOIN source_items ON source_items.id = source_versions.source_item_id
        JOIN data_sources ON data_sources.id = source_items.data_source_id
        WHERE source_exports.status = 'pending' AND source_items.state = 'present'
        ORDER BY source_exports.updated_at
        LIMIT 2
      `).all();
      if (rows.length === 0) return;
      await Promise.all(rows.map((row) => this.exportVersion(row)));
    }
  }
  async exportVersion(row) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.database.prepare(`
      UPDATE source_exports SET status = 'exporting', attempt_count = attempt_count + 1,
        last_error = NULL, updated_at = ? WHERE source_version_id = ?
    `).run(now, row.source_version_id);
    try {
      const connector = this.connectors.get(row.kind);
      const result = row.kind === "local-folder" ? await this.fileExports.importLocalFile({
        filePath: connector.resolveLocalPath(this.toConnection(row), row.relative_path),
        sourceKey: `local:${row.id}:${row.remote_id}`,
        originalName: basename(row.relative_path),
        localSourceId: row.id,
        localItemId: row.local_item_id,
        relativePath: row.relative_path,
        sourceModifiedAt: row.source_modified_at
      }) : await this.fileExports.importConnectorFile({
        filePath: this.objectPath(row.object_hash),
        sourceKey: `connector:${row.kind}:${row.id}:${row.remote_id}`,
        originalName: basename(row.relative_path),
        provider: row.kind,
        connectionId: row.id,
        relativePath: row.relative_path,
        sourceUri: row.uri ?? "",
        sourceModifiedAt: row.source_modified_at
      });
      this.database.prepare(`
        UPDATE source_exports SET status = 'exported', file_entry_id = ?, file_version_id = ?,
          last_error = NULL, updated_at = ? WHERE source_version_id = ?
      `).run(result.fileEntryId, result.fileVersionId, (/* @__PURE__ */ new Date()).toISOString(), row.source_version_id);
    } catch (error) {
      const attempt = row.attempt_count + 1;
      this.database.prepare(`
        UPDATE source_exports SET status = ?, last_error = ?, updated_at = ? WHERE source_version_id = ?
      `).run(
        attempt >= 3 ? "failed" : "pending",
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        (/* @__PURE__ */ new Date()).toISOString(),
        row.source_version_id
      );
    }
  }
  shouldExport(kind, item) {
    if (!this.fileExports) return false;
    if (kind === "local-folder") return this.autoScanExtensions.has(item.extension.toLowerCase());
    if (!this.connectorImportExtensions.has(item.extension.toLowerCase())) return false;
    if (kind === "google-docs" || kind === "notion") return true;
    return kind === "github" && !item.remoteId.startsWith("repo:issue:");
  }
  toConnection(source) {
    let config;
    try {
      config = JSON.parse(source.config_json);
    } catch {
      throw new Error(`数据源“${source.name}”的配置无效。`);
    }
    return {
      id: source.id,
      kind: source.kind,
      name: source.name,
      config
    };
  }
  finishRun(runId, status, counts, finishedAt, errorMessage) {
    this.database.prepare(`
      UPDATE sync_runs SET
        status = ?, discovered = ?, added = ?, updated = ?, moved = ?, unchanged = ?,
        removed = ?, failed = ?, error_message = ?, finished_at = ?
      WHERE id = ?
    `).run(
      status,
      counts.discovered,
      counts.added,
      counts.updated,
      counts.moved,
      counts.unchanged,
      counts.removed,
      counts.failed,
      errorMessage,
      finishedAt,
      runId
    );
  }
  requireSource(id) {
    const source = this.database.prepare("SELECT * FROM data_sources WHERE id = ?").get(id);
    if (!source) throw new Error("数据源不存在或已断开。");
    return source;
  }
  getSummary(id) {
    return this.toSummary(this.requireSource(id));
  }
  toSummary(source) {
    const counts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM source_items
          WHERE data_source_id = ? AND state = 'present'
            AND EXISTS (
              SELECT 1 FROM source_versions
              WHERE source_versions.source_item_id = source_items.id
                AND source_versions.import_policy IN ('normal', 'approved')
            )) AS file_count,
        (SELECT COUNT(*) FROM source_versions
          JOIN source_items ON source_items.id = source_versions.source_item_id
          WHERE source_items.data_source_id = ?
            AND source_versions.import_policy IN ('normal', 'approved')) AS version_count,
        (SELECT COALESCE(SUM(size), 0) FROM source_items
          WHERE data_source_id = ? AND state = 'present'
            AND EXISTS (
              SELECT 1 FROM source_versions
              WHERE source_versions.source_item_id = source_items.id
                AND source_versions.import_policy IN ('normal', 'approved')
            )) AS total_bytes
    `).get(source.id, source.id, source.id);
    return {
      id: source.id,
      kind: source.kind,
      name: source.name,
      rootPath: source.root_path ?? "",
      status: source.disconnected_at ? "disconnected" : source.status,
      fileCount: Number(counts.file_count ?? 0),
      versionCount: Number(counts.version_count ?? 0),
      totalBytes: Number(counts.total_bytes ?? 0),
      lastSyncedAt: source.last_synced_at,
      lastError: source.last_error,
      createdAt: source.created_at
    };
  }
}
class HighRiskImportCoordinator {
  constructor(statePath) {
    this.statePath = statePath;
  }
  batches = [];
  listeners = /* @__PURE__ */ new Set();
  resolving = /* @__PURE__ */ new Set();
  persistChain = Promise.resolve();
  manualResolver = null;
  autoResolver = null;
  async initialize() {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8"));
      if (parsed.version === 1 && Array.isArray(parsed.batches)) {
        this.batches = parsed.batches.filter(isStoredBatch);
      }
    } catch {
      this.batches = [];
    }
  }
  list() {
    return this.batches.map(toReview);
  }
  onChanged(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setManualResolver(resolver) {
    this.manualResolver = resolver;
  }
  setAutoResolver(resolver) {
    this.autoResolver = resolver;
  }
  enqueueManual(batch, sourceLabel) {
    return this.enqueue({
      id: randomUUID(),
      origin: "manual-import",
      sourceLabel,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      payload: batch
    });
  }
  enqueueAuto(batch, sourceLabel) {
    return this.enqueue({
      id: randomUUID(),
      origin: "auto-scan",
      sourceLabel,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      payload: batch
    });
  }
  async resolve(id, accepted) {
    const batch = this.batches.find((item) => item.id === id);
    if (!batch) throw new Error("待确认的文件批次不存在。");
    if (this.resolving.has(id)) throw new Error("该文件批次正在处理中。");
    this.resolving.add(id);
    try {
      let result;
      if (batch.origin === "manual-import") {
        if (!this.manualResolver) throw new Error("文件导入服务尚未就绪。");
        result = await this.manualResolver(batch.payload, accepted);
      } else {
        if (!this.autoResolver) throw new Error("文件导入服务尚未就绪。");
        result = await this.autoResolver(batch.payload, accepted);
      }
      this.batches = this.batches.filter((item) => item.id !== id);
      await this.persistWithoutBlockingUserWork();
      this.notifyChanged();
      return result;
    } finally {
      this.resolving.delete(id);
    }
  }
  async discardAutoSource(sourceId) {
    const next = this.batches.filter((batch) => batch.origin !== "auto-scan" || batch.payload.sourceId !== sourceId);
    if (next.length === this.batches.length) return;
    this.batches = next;
    await this.persistWithoutBlockingUserWork();
    this.notifyChanged();
  }
  async enqueue(batch) {
    this.batches.push(batch);
    await this.persistWithoutBlockingUserWork();
    this.notifyChanged();
    return toReview(batch);
  }
  persist() {
    this.persistChain = this.persistChain.catch(() => void 0).then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.tmp`;
      await writeFile(
        temporaryPath,
        JSON.stringify({ version: 1, batches: this.batches }),
        { encoding: "utf8", mode: 384 }
      );
      await rename(temporaryPath, this.statePath);
    });
    return this.persistChain;
  }
  async persistWithoutBlockingUserWork() {
    try {
      await this.persist();
    } catch (error) {
      console.error("[high-risk-imports] unable to persist review state", error);
    }
  }
  notifyChanged() {
    for (const listener of this.listeners) listener();
  }
}
function toReview(batch) {
  return {
    id: batch.id,
    origin: batch.origin,
    sourceLabel: batch.sourceLabel,
    fileCount: batch.origin === "manual-import" ? batch.payload.files.length : batch.payload.versionIds.length,
    createdAt: batch.createdAt
  };
}
function isStoredBatch(value) {
  if (!value || typeof value !== "object") return false;
  const batch = value;
  if (typeof batch.id !== "string" || typeof batch.sourceLabel !== "string" || typeof batch.createdAt !== "string") return false;
  if (batch.origin === "manual-import") {
    return Boolean(
      batch.payload && "files" in batch.payload && Array.isArray(batch.payload.files) && batch.payload.files.every((file) => file && typeof file === "object" && "filePath" in file && typeof file.filePath === "string" && "filename" in file && typeof file.filename === "string")
    );
  }
  return batch.origin === "auto-scan" && Boolean(
    batch.payload && "sourceId" in batch.payload && typeof batch.payload.sourceId === "string" && "versionIds" in batch.payload && Array.isArray(batch.payload.versionIds) && batch.payload.versionIds.every((id) => typeof id === "string")
  );
}
class CredentialStore {
  constructor(filePath) {
    this.filePath = filePath;
  }
  credentials = /* @__PURE__ */ new Map();
  loaded = false;
  async initialize() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value?.value === "string") this.credentials.set(key, value);
      }
    } catch {
    }
  }
  async set(value) {
    await this.initialize();
    const key = randomUUID();
    this.credentials.set(key, { value });
    await this.persist();
    return key;
  }
  async get(key) {
    await this.initialize();
    return key ? this.credentials.get(key)?.value : void 0;
  }
  async setNamed(key, value) {
    await this.initialize();
    this.credentials.set(key, { value });
    await this.persist();
  }
  async getPlainText(key) {
    await this.initialize();
    return this.credentials.get(key)?.value;
  }
  async setPlainText(key, value) {
    await this.setNamed(key, value);
  }
  async delete(key) {
    await this.initialize();
    if (!this.credentials.delete(key)) return;
    await this.persist();
  }
  async persist() {
    const output = {};
    for (const [key, value] of this.credentials) output[key] = value;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(output), { mode: 384 });
  }
}
const PACKAGE_ALGORITHM = "X25519-HKDF-SHA256-AES-256-GCM";
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
function rawPublicKey(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(-32).toString("base64");
}
function publicKeyObject(raw) {
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error("设备公钥格式无效。");
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, bytes]), format: "der", type: "spki" });
}
function combinedEncrypt(key, plaintext, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64");
}
function combinedDecrypt(key, encoded, aad) {
  const combined = Buffer.from(encoded, "base64");
  if (combined.length < 28) throw new Error("密钥包密文格式无效。");
  const decipher = createDecipheriv("aes-256-gcm", key, combined.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(combined.subarray(-16));
  return Buffer.concat([decipher.update(combined.subarray(12, -16)), decipher.final()]);
}
function keyId(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function verificationCode(publicKey) {
  const digest = createHash("sha256").update(`everroom-device-verification-v1:${publicKey}`, "utf8").digest("hex").slice(0, 12).toUpperCase();
  return digest.match(/.{1,4}/g).join("-");
}
function isBasicTextStorage() {
  if (process.platform !== "linux") return false;
  return safeStorage.getSelectedStorageBackend?.() === "basic_text";
}
class AccountKeyringService {
  constructor(filePath) {
    this.filePath = filePath;
  }
  loaded = false;
  file = null;
  async initialize() {
    if (this.loaded) return;
    this.loaded = true;
    if (!safeStorage.isEncryptionAvailable() || isBasicTextStorage()) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
        this.file = { publicKey: parsed.publicKey, privateKey: parsed.privateKey, umks: parsed.umks ?? {} };
      }
    } catch {
    }
  }
  isAvailable() {
    return safeStorage.isEncryptionAvailable() && !isBasicTextStorage();
  }
  async status(client, userId) {
    await this.initialize();
    if (!this.isAvailable()) {
      return { enabled: false, reason: "系统密钥环不可用，无法启用端到端同步。", initialized: false, umkId: null, activeVersion: null, deviceStatus: "unregistered", verificationCode: null };
    }
    const material = await this.ensureMaterial();
    await client.registerKeyAgreement(material.publicKey);
    let keyring = await client.getKeyring();
    if (!keyring.initialized) {
      const existing = await this.getUmk(userId);
      const umk = existing?.value ?? randomBytes(32);
      const umkVersion = existing?.version ?? 1;
      try {
        await client.bootstrapKeyring({ ...this.makePackage(material.publicKey, umk, keyId(umk), umkVersion, keyring.currentDevice.deviceId), packageAlgorithm: PACKAGE_ALGORITHM });
        keyring = await client.getKeyring();
      } catch (error) {
        if (!(error instanceof Error) || !/409|already initialized|冲突/i.test(error.message)) throw error;
        keyring = await client.getKeyring();
      }
    }
    if (keyring.currentDevice.status === "ready" && keyring.currentDevice.keyPackage) {
      const packageData = keyring.currentDevice.keyPackage;
      const umk = this.openPackage(packageData, keyring.currentDevice.deviceId, material.privateKey);
      if (keyId(umk) !== keyring.umkId || packageData.umkId !== keyring.umkId || packageData.umkVersion !== keyring.activeVersion) {
        throw new Error("UMK 校验失败，请在 iPhone 上重新批准此设备。");
      }
      await this.saveUmk(userId, keyring.umkId, keyring.activeVersion, umk);
    }
    return {
      enabled: true,
      initialized: keyring.initialized,
      umkId: keyring.umkId,
      activeVersion: keyring.activeVersion,
      deviceStatus: keyring.currentDevice.status,
      verificationCode: verificationCode(material.publicKey)
    };
  }
  async getUmk(userId) {
    await this.initialize();
    if (!this.file) return null;
    const entry = Object.entries(this.file.umks).filter(([key]) => key.startsWith(`${userId}:`)).map(([, value]) => value).sort((left, right) => right.version - left.version)[0];
    if (!entry) return null;
    return { value: Buffer.from(safeStorage.decryptString(Buffer.from(entry.value, "base64")), "base64"), umkId: entry.umkId, version: entry.version };
  }
  async getVerificationCode() {
    await this.initialize();
    return this.file?.publicKey ? verificationCode(this.file.publicKey) : null;
  }
  async createPairingSession(client, userId) {
    const status = await this.status(client, userId);
    if (!status.enabled || status.deviceStatus !== "ready") throw new Error("请先完成本机的端到端密钥初始化。");
    return client.createPairingSession();
  }
  async approvePairingSession(client, userId, sessionId) {
    const approved = await client.approvePairingSession(sessionId);
    if (!approved.targetDeviceId || !approved.targetPublicKey) throw new Error("配对目标信息不完整。");
    const keyring = await client.getKeyring();
    if (!keyring.umkId || !keyring.activeVersion) throw new Error("账号密钥状态无效。");
    const material = await this.getUmk(userId);
    if (!material || material.umkId !== keyring.umkId || material.version !== keyring.activeVersion) throw new Error("本机账号主密钥不可用。");
    const keyPackage = this.makePackage(approved.targetPublicKey, material.value, keyring.umkId, keyring.activeVersion, approved.targetDeviceId);
    return client.packagePairingSession(sessionId, { ...keyPackage, packageAlgorithm: PACKAGE_ALGORITHM });
  }
  async ensureMaterial() {
    if (this.file?.privateKey && this.file.publicKey) {
      return { publicKey: this.file.publicKey, privateKey: Buffer.from(safeStorage.decryptString(Buffer.from(this.file.privateKey, "base64")), "base64") };
    }
    const pair = generateKeyPairSync("x25519");
    const publicKey = rawPublicKey(pair.publicKey);
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" });
    this.file = { publicKey, privateKey: safeStorage.encryptString(privateKey.toString("base64")).toString("base64"), umks: this.file?.umks ?? {} };
    await this.persist();
    return { publicKey, privateKey };
  }
  makePackage(targetPublicKey, umk, umkId, version, deviceId) {
    const pair = generateKeyPairSync("x25519");
    const ephemeralPublicKey = rawPublicKey(pair.publicKey);
    const salt = randomBytes(32);
    const context = Buffer.from(`everroom.umk-package.v1:${umkId}:${version}:${deviceId}`, "utf8");
    const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: publicKeyObject(targetPublicKey) });
    const wrappingKey = Buffer.from(hkdfSync("sha256", shared, salt, context, 32));
    return { umkId, umkVersion: version, ephemeralPublicKey, salt: salt.toString("base64"), ciphertext: combinedEncrypt(wrappingKey, umk, context) };
  }
  openPackage(input, deviceId, privateKeyBytes) {
    const ephemeralPublicKey = publicKeyObject(input.ephemeralPublicKey);
    const privateKey = createPrivateKey({ key: privateKeyBytes, format: "der", type: "pkcs8" });
    const context = Buffer.from(`everroom.umk-package.v1:${input.umkId}:${input.umkVersion}:${deviceId}`, "utf8");
    const shared = diffieHellman({ privateKey, publicKey: ephemeralPublicKey });
    const wrappingKey = Buffer.from(hkdfSync("sha256", shared, Buffer.from(input.salt, "base64"), context, 32));
    const umk = combinedDecrypt(wrappingKey, input.ciphertext, context);
    if (umk.length !== 32) throw new Error("UMK 长度无效。");
    return umk;
  }
  async saveUmk(userId, umkId, version, value) {
    await this.initialize();
    if (!this.file) return;
    this.file.umks[`${userId}:${umkId}:${version}`] = { umkId, version, value: safeStorage.encryptString(value.toString("base64")).toString("base64") };
    await this.persist();
  }
  async persist() {
    if (!this.file) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.file), { mode: 384 });
    await chmod(this.filePath, 384);
  }
}
const AGENT_PROTOCOL_VERSION = 1;
function isAgentSocketFrame(value) {
  if (!value || typeof value !== "object") return false;
  const frame = value;
  if (frame.protocol !== AGENT_PROTOCOL_VERSION) return false;
  if (frame.type === "ready") {
    return typeof frame.sessionId === "string" && Number.isInteger(frame.lastEventSeq);
  }
  if (frame.type !== "event" || !frame.event || typeof frame.event !== "object") return false;
  const event = frame.event;
  return typeof event.id === "string" && typeof event.sessionId === "string" && typeof event.runId === "string" && Number.isInteger(event.seq) && typeof event.type === "string" && typeof event.occurredAt === "string";
}
class WebContentsLifecycle {
  observed = /* @__PURE__ */ new WeakSet();
  observe(contents, onDestroyed) {
    if (this.observed.has(contents)) return;
    this.observed.add(contents);
    contents.once("destroyed", onDestroyed);
  }
}
const AGENT_EVENT_CHANNEL = "agent:event";
const http$6 = createLoggedHttpClient("gateway-agent");
const RECOVERABLE_CONNECTION_ERROR_CODES$2 = /* @__PURE__ */ new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ERR_SOCKET_CLOSED"
]);
function isRecoverableConnectionError$2(error) {
  if (!isAxiosError(error)) return false;
  if (error.code && RECOVERABLE_CONNECTION_ERROR_CODES$2.has(error.code)) return true;
  return typeof error.message === "string" && /socket hang up/i.test(error.message);
}
class AgentGatewayBridge {
  constructor(supervisor, activity) {
    this.supervisor = supervisor;
    this.activity = activity;
  }
  subscriptions = /* @__PURE__ */ new Map();
  contentsLifecycle = new WebContentsLifecycle();
  runWatches = /* @__PURE__ */ new Map();
  eventObserver = null;
  setEventObserver(observer) {
    this.eventObserver = observer;
  }
  startRemoteRun(input) {
    if (input.sessionId) {
      return this.startRun(input.sessionId, {
        prompt: input.prompt,
        idempotencyKey: input.idempotencyKey,
        captureMemory: false,
        recallMemory: false,
        toolsEnabled: false
      });
    }
    return this.request("/v1/agent/remote/commands", { method: "POST", data: input }).then((run) => {
      this.activity?.trackRun(run);
      this.watchRun(run);
      return run;
    });
  }
  cancelRemoteRun(commandId, runId, sessionId) {
    return this.request(`/v1/agent/remote/commands/${encodeURIComponent(commandId)}/cancel`, {
      method: "POST",
      data: { ...runId ? { runId } : {}, ...sessionId ? { sessionId } : {} }
    });
  }
  getStatus() {
    return this.request("/v1/agent/status");
  }
  createSession(input) {
    return this.request("/v1/agent/sessions", { method: "POST", data: input });
  }
  createSessionLink(input) {
    return this.request("/v1/agent/session-links", { method: "POST", data: input });
  }
  listSessionLinks(sessionId) {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/links`);
  }
  markSessionLinkReturned(linkId) {
    return this.request(`/v1/agent/session-links/${encodeURIComponent(linkId)}/return`, { method: "POST" });
  }
  listSessions(pageLabel, roomId) {
    const query = new URLSearchParams();
    if (pageLabel) query.set("pageLabel", pageLabel);
    if (roomId !== void 0) query.set("roomId", roomId ?? "");
    return this.request(`/v1/agent/sessions?${query}`);
  }
  listAllSessions() {
    return this.listSessions();
  }
  async listAllSessionSnapshots() {
    const sessions = await this.listSessions();
    const snapshots = await Promise.all(sessions.map(async (session2) => {
      try {
        return await this.getSession(session2.id);
      } catch {
        return null;
      }
    }));
    return snapshots.filter((snapshot) => snapshot !== null);
  }
  updateSession(sessionId, input) {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      data: input
    });
  }
  deleteSession(sessionId) {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }
  getSession(sessionId) {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`);
  }
  getUsage(range2 = "7d") {
    return this.request(`/v1/agent/usage?range=${encodeURIComponent(range2)}`);
  }
  getEvents(sessionId, runId, afterSeq) {
    const query = new URLSearchParams({ runId, afterSeq: String(afterSeq) });
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/events?${query}`);
  }
  async startRun(sessionId, input) {
    const run = await this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/runs`, {
      method: "POST",
      data: input
    });
    this.activity?.trackRun(run);
    this.watchRun(run);
    return run;
  }
  async submitPendingIntent(intentId, input) {
    const result = await this.request(`/v1/agent/pending-intents/${encodeURIComponent(intentId)}/submit`, {
      method: "POST",
      data: input
    });
    this.activity?.trackRun(result.run);
    this.watchRun(result.run);
    return result;
  }
  async cancelRun(runId) {
    const run = await this.request(`/v1/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    const cancelledEvent = {
      id: `local-cancel-${run.id}`,
      sessionId: run.sessionId,
      runId: run.id,
      seq: run.lastEventSeq,
      type: "run.cancelled",
      occurredAt: run.completedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      payload: {}
    };
    this.activity?.trackEvent(cancelledEvent);
    this.eventObserver?.(cancelledEvent);
    this.stopRunWatch(run.id);
    return run;
  }
  summarizeTranscription(input) {
    return this.request("/v1/processing/transcription-summary", {
      method: "POST",
      data: input,
      timeout: 10 * 6e4
    });
  }
  subscribe(contents, sessionId) {
    this.unsubscribe(contents.id);
    const subscription = {
      sessionId,
      socket: this.openSocket(contents, sessionId),
      closed: false,
      reconnectTimer: null
    };
    this.subscriptions.set(contents.id, subscription);
    this.contentsLifecycle.observe(contents, () => this.unsubscribe(contents.id));
  }
  unsubscribe(contentsId) {
    const subscription = this.subscriptions.get(contentsId);
    if (!subscription) return;
    subscription.closed = true;
    if (subscription.reconnectTimer) clearTimeout(subscription.reconnectTimer);
    subscription.socket.close();
    this.subscriptions.delete(contentsId);
  }
  dispose() {
    for (const contentsId of [...this.subscriptions.keys()]) this.unsubscribe(contentsId);
    for (const runId of [...this.runWatches.keys()]) this.stopRunWatch(runId);
  }
  watchRun(run) {
    if (!this.activity || this.runWatches.has(run.id)) return;
    const watch2 = {
      sessionId: run.sessionId,
      socket: null,
      reconnectTimer: null,
      closed: false
    };
    this.runWatches.set(run.id, watch2);
    watch2.socket = this.openRunWatch(run.id, watch2);
  }
  openRunWatch(runId, watch2) {
    const connection = this.supervisor.getConnection();
    const url = new URL(connection.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/v1/agent/sessions/${encodeURIComponent(watch2.sessionId)}/stream`;
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } });
    socket.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString());
        if (!isAgentSocketFrame(frame) || frame.type !== "event" || frame.event.runId !== runId) return;
        this.activity?.trackEvent(frame.event);
        this.eventObserver?.(frame.event);
        if (["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(frame.event.type)) {
          this.stopRunWatch(runId);
        }
      } catch {
      }
    });
    socket.on("close", () => {
      if (watch2.closed || !this.runWatches.has(runId)) return;
      watch2.reconnectTimer = setTimeout(() => {
        if (watch2.closed || !this.runWatches.has(runId)) return;
        watch2.socket = this.openRunWatch(runId, watch2);
      }, 750);
    });
    socket.on("error", () => void 0);
    return socket;
  }
  stopRunWatch(runId) {
    const watch2 = this.runWatches.get(runId);
    if (!watch2) return;
    watch2.closed = true;
    if (watch2.reconnectTimer) clearTimeout(watch2.reconnectTimer);
    watch2.socket?.close();
    this.runWatches.delete(runId);
  }
  openSocket(contents, sessionId) {
    const connection = this.supervisor.getConnection();
    const url = new URL(connection.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/v1/agent/sessions/${encodeURIComponent(sessionId)}/stream`;
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } });
    socket.on("message", (data) => {
      if (contents.isDestroyed()) return;
      try {
        const frame = JSON.parse(data.toString());
        if (isAgentSocketFrame(frame)) {
          contents.send(AGENT_EVENT_CHANNEL, frame);
          if (frame.type === "event") {
            this.activity?.trackEvent(frame.event);
            this.eventObserver?.(frame.event);
          }
        }
      } catch {
      }
    });
    socket.on("close", () => {
      const subscription = this.subscriptions.get(contents.id);
      if (!subscription || subscription.closed || contents.isDestroyed()) return;
      subscription.reconnectTimer = setTimeout(() => {
        const current = this.subscriptions.get(contents.id);
        if (!current || current.closed || contents.isDestroyed()) return;
        current.socket = this.openSocket(contents, sessionId);
      }, 750);
    });
    socket.on("error", () => void 0);
    return socket;
  }
  async request(path, config = {}) {
    const connection = await this.supervisor.ensureConnection();
    try {
      return await this.requestWithConnection(connection, path, config);
    } catch (error) {
      if (!isRecoverableConnectionError$2(error)) throw error;
      const recoveredConnection = await this.supervisor.recoverConnection(connection);
      return this.requestWithConnection(recoveredConnection, path, config);
    }
  }
  async requestWithConnection(connection, path, config) {
    const hasBody = config.data !== void 0 && config.data !== null;
    const response = await http$6.request({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": hasBody ? "application/json" : false,
        ...config.headers
      },
      validateStatus: () => true
    });
    if (response.status >= 400) {
      throw new Error(
        typeof response.data?.message === "string" ? response.data.message : `Agent 请求失败（${response.status}）`
      );
    }
    if (response.status === 204) return void 0;
    return response.data;
  }
}
const http$5 = createLoggedHttpClient("gateway-asr");
class AsrGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  createJob(input) {
    return this.request("/v1/asr/jobs", { method: "POST", data: input });
  }
  getJob(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("无效的转写任务标识。");
    return this.request(`/v1/asr/jobs/${encodeURIComponent(id)}`);
  }
  async request(path, config = {}) {
    const connection = this.supervisor.getConnection();
    const response = await http$5.request({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${connection.token}`,
        ...config.headers
      },
      validateStatus: () => true
    });
    if (response.status >= 400) {
      throw new Error(response.data?.message ?? `转写服务请求失败（${response.status}）`);
    }
    return response.data;
  }
}
const STARTUP_TIMEOUT_MS$4 = 18e4;
const SHUTDOWN_TIMEOUT_MS$4 = 5e3;
const CONNECTION_RECOVERY_TIMEOUT_MS = 15e3;
const healthHttp = createLoggedHttpClient("gateway-health", { timeout: 1e3 }, { quiet: true });
function delay$5(milliseconds) {
  return new Promise((resolve2) => setTimeout(resolve2, milliseconds));
}
function forwardGatewayOutput(stream2, destination, label) {
  let pending = "";
  stream2.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) destination.write(`[${label}] ${line}
`);
  });
  stream2.on("end", () => {
    if (pending) destination.write(`[${label}] ${pending}
`);
  });
}
function isGatewayManifest(value) {
  if (!value || typeof value !== "object") return false;
  const manifest = value;
  return Number.isInteger(manifest.pid) && typeof manifest.baseUrl === "string" && typeof manifest.token === "string" && typeof manifest.startedAt === "string" && typeof manifest.version === "string";
}
function resolveGatewayPackageDirectory() {
  const candidates = [
    join(app.getAppPath(), "..", "gateway"),
    join(process.cwd(), "apps", "gateway")
  ];
  const directory = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
  if (!directory) {
    throw new Error(`NxCore Gateway package not found. Checked: ${candidates.join(", ")}`);
  }
  return directory;
}
class GatewaySupervisor {
  constructor(dataDirectory2, extraEnvironment = {}, options = {}) {
    this.dataDirectory = dataDirectory2;
    this.extraEnvironment = extraEnvironment;
    this.options = options;
  }
  child = null;
  connection = null;
  connectionRecovery = null;
  stopping = false;
  lastError = null;
  /** 子进程是否已就绪(spawn 后且拿到 manifest);getConnection 未启动会抛。 */
  isRunning() {
    return this.connection !== null;
  }
  async start() {
    if (this.connection) return this.connection;
    if (this.child) throw new Error(`${this.serviceLabel()} is already starting`);
    this.lastError = null;
    const gatewayDirectory = app.isPackaged ? join(process.resourcesPath, "gateway") : resolveGatewayPackageDirectory();
    const migrationsPath = join(gatewayDirectory, "drizzle");
    const manifestPath = this.runtimeManifestPath();
    const token = randomBytes(32).toString("base64url");
    await rm(manifestPath, { force: true });
    const command = app.isPackaged ? process.execPath : process.env.NXCORE_GATEWAY_PACKAGE_MANAGER ?? "pnpm";
    const extra = typeof this.extraEnvironment === "function" ? this.extraEnvironment() : this.extraEnvironment;
    const environment = {
      ...process.env,
      NXCORE_GATEWAY_TOKEN: token,
      ...extra,
      ...app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}
    };
    const gatewayArguments = [
      "--host",
      "127.0.0.1",
      "--port",
      app.isPackaged ? "0" : process.env[this.options.devPortEnvironment ?? "NXCORE_GATEWAY_DEV_PORT"] ?? "0",
      "--data-dir",
      this.dataDirectory,
      "--migrations-dir",
      migrationsPath
    ];
    const commandArguments2 = app.isPackaged ? [join(gatewayDirectory, this.options.packagedEntry ?? "serve.js"), ...gatewayArguments] : ["--dir", gatewayDirectory, this.options.devScript ?? "dev", "--", ...gatewayArguments];
    const detached = !app.isPackaged && process.platform !== "win32";
    const child = spawn(
      command,
      commandArguments2,
      {
        detached,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: !app.isPackaged && process.platform === "win32"
      }
    );
    this.child = child;
    this.stopping = false;
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    forwardGatewayOutput(child.stdout, process.stdout, this.options.logLabel ?? "gateway");
    forwardGatewayOutput(child.stderr, process.stderr, this.options.logLabel ?? "gateway");
    child.on("exit", (code, signal) => {
      this.child = null;
      this.connection = null;
      if (!this.stopping) {
        this.lastError = `${this.serviceLabel()} 进程已退出（code=${String(code)}, signal=${String(signal)}）`;
        console.error(this.lastError);
      }
    });
    try {
      const manifest = await this.waitUntilReady(child, manifestPath, token);
      this.connection = {
        pid: manifest.pid,
        baseUrl: manifest.baseUrl,
        token,
        version: manifest.version
      };
      return this.connection;
    } catch (error) {
      this.killChild(child, "SIGTERM", detached);
      this.child = null;
      this.lastError = error instanceof Error ? error.message : `${this.serviceLabel()} 启动失败`;
      throw error;
    }
  }
  async getStatus() {
    const connection = this.connection;
    if (!connection) {
      return {
        state: this.child ? "starting" : this.lastError ? "error" : "stopped",
        pid: null,
        baseUrl: null,
        version: null,
        message: this.lastError
      };
    }
    try {
      const parsed = JSON.parse(await readFile(this.runtimeManifestPath(), "utf8"));
      if (!isGatewayManifest(parsed) || parsed.token !== connection.token) {
        throw new Error(`${this.serviceLabel()} runtime manifest 无效`);
      }
      const response = await healthHttp.get(`${parsed.baseUrl}/v1/health/ready`, {
        validateStatus: () => true
      });
      if (response.status >= 400) {
        throw new Error(`${this.serviceLabel()} 健康检查失败（${response.status}）`);
      }
      this.connection = {
        pid: parsed.pid,
        baseUrl: parsed.baseUrl,
        token: connection.token,
        version: parsed.version
      };
      return {
        state: "ready",
        pid: parsed.pid,
        baseUrl: parsed.baseUrl,
        version: parsed.version,
        message: null
      };
    } catch (error) {
      return {
        state: "error",
        pid: connection.pid,
        baseUrl: connection.baseUrl,
        version: connection.version,
        message: error instanceof Error ? error.message : `${this.serviceLabel()} 当前不可用`
      };
    }
  }
  getConnection() {
    if (!this.connection) throw new Error(`${this.serviceLabel()} 尚未就绪。`);
    return this.connection;
  }
  async ensureConnection() {
    if (this.connection) return this.connection;
    if (this.stopping) throw new Error(`${this.serviceLabel()} 正在停止。`);
    if (this.connectionRecovery) return this.connectionRecovery;
    const startup = this.start();
    this.connectionRecovery = startup;
    try {
      return await startup;
    } finally {
      if (this.connectionRecovery === startup) this.connectionRecovery = null;
    }
  }
  async recoverConnection(staleConnection) {
    const current = this.connection;
    if (current && !this.isSameConnection(current, staleConnection)) return current;
    if (this.connectionRecovery) return this.connectionRecovery;
    const recovery = this.refreshConnection(staleConnection);
    this.connectionRecovery = recovery;
    try {
      return await recovery;
    } finally {
      if (this.connectionRecovery === recovery) this.connectionRecovery = null;
    }
  }
  async shutdown() {
    this.stopping = true;
    const child = this.child;
    this.connection = null;
    if (!child) return;
    await new Promise((resolve2) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve2();
      };
      const timeout = setTimeout(() => {
        this.killChild(child, "SIGKILL", !app.isPackaged && process.platform !== "win32");
        finish();
      }, SHUTDOWN_TIMEOUT_MS$4);
      child.once("exit", finish);
      if (!this.killChild(child, "SIGTERM", !app.isPackaged && process.platform !== "win32")) {
        finish();
      }
    });
    this.child = null;
    this.lastError = null;
    await rm(this.runtimeManifestPath(), { force: true });
  }
  async waitUntilReady(child, manifestPath, token) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS$4;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`${this.serviceLabel()} exited during startup with code ${String(child.exitCode)}`);
      }
      try {
        const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
        if (isGatewayManifest(parsed) && parsed.token === token) {
          const response = await healthHttp.get(`${parsed.baseUrl}/v1/health/ready`, {
            validateStatus: () => true
          });
          if (response.status < 400) return parsed;
        }
      } catch {
      }
      await delay$5(50);
    }
    throw new Error(
      `${this.serviceLabel()} did not become ready within ${STARTUP_TIMEOUT_MS$4}ms（首次启动需初始化数据库，可关闭应用后重试一次）`
    );
  }
  async refreshConnection(staleConnection) {
    const deadline = Date.now() + CONNECTION_RECOVERY_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      if (this.stopping) throw new Error(`${this.serviceLabel()} 正在停止。`);
      const current = this.connection;
      if (current && !this.isSameConnection(current, staleConnection)) return current;
      try {
        const parsed = JSON.parse(await readFile(this.runtimeManifestPath(), "utf8"));
        if (!isGatewayManifest(parsed) || parsed.token !== staleConnection.token) {
          throw new Error(`${this.serviceLabel()} runtime manifest 无效`);
        }
        const response = await healthHttp.get(`${parsed.baseUrl}/v1/health/ready`, {
          validateStatus: () => true
        });
        if (response.status >= 400) {
          throw new Error(`${this.serviceLabel()} 健康检查失败（${response.status}）`);
        }
        if (this.stopping) throw new Error(`${this.serviceLabel()} 正在停止。`);
        this.connection = {
          pid: parsed.pid,
          baseUrl: parsed.baseUrl,
          token: staleConnection.token,
          version: parsed.version
        };
        this.lastError = null;
        return this.connection;
      } catch (error) {
        lastError = error;
      }
      if (!this.child) {
        this.connection = null;
        return this.start();
      }
      await delay$5(50);
    }
    throw lastError instanceof Error ? lastError : new Error(`${this.serviceLabel()} 连接恢复失败`);
  }
  isSameConnection(left, right) {
    return left.baseUrl === right.baseUrl && left.token === right.token;
  }
  serviceLabel() {
    return this.options.logLabel ?? "NxCore Gateway";
  }
  runtimeManifestPath() {
    return join(this.dataDirectory, "runtime", "gateway.json");
  }
  killChild(child, signal, processGroup) {
    if (processGroup && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        return false;
      }
    }
    if (process.platform === "win32" && !app.isPackaged && child.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    }
    return child.kill(signal);
  }
}
const http$4 = createLoggedHttpClient("gateway-runtime-config");
class RuntimeConfigBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  get() {
    return this.request("/v1/runtime-config");
  }
  saveUser(config) {
    return this.request("/v1/runtime-config/user", { method: "PUT", data: config });
  }
  clearUser() {
    return this.request("/v1/runtime-config/user", { method: "DELETE" });
  }
  saveSaas(config) {
    return this.request("/v1/runtime-config/saas", { method: "PUT", data: { schemaVersion: 1, ...config } });
  }
  clearSaas() {
    return this.request("/v1/runtime-config/saas", { method: "DELETE" });
  }
  selectSource(source) {
    return this.request("/v1/runtime-config/source", { method: "PUT", data: { source } });
  }
  test() {
    return this.request("/v1/runtime-config/test", { method: "POST", data: {} });
  }
  injectMemory(config) {
    return this.request("/v1/memory/config", { method: "PUT", data: config });
  }
  disableMemory() {
    return this.request("/v1/memory/config", { method: "DELETE" });
  }
  async request(path, config = {}) {
    const connection = await this.supervisor.ensureConnection();
    const response = await http$4.request({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        // 无 body 不带 Content-Type：Fastify 5 对「JSON 头 + 空 body」直接
        // 400（FST_ERR_CTP_EMPTY_JSON_BODY），POST test / GET / DELETE 均无 body
        ...config.data ? { "Content-Type": "application/json" } : {},
        ...config.headers
      },
      validateStatus: () => true
    });
    if (response.status >= 400) throw new Error(response.data?.message ?? `运行时配置请求失败（${response.status}）`);
    return response.data;
  }
}
const OPTIONAL_STRING_KEYS = ["api", "reasoning"];
const OPTIONAL_NUMBER_KEYS = ["maxTokens", "contextWindow", "temperature"];
function envKey(key) {
  return key.replace(/([A-Z])/g, "_$1").toUpperCase();
}
function sectionEnv(section, prefix) {
  if (!section || typeof section !== "object") return {};
  const text2 = (key) => {
    const raw = section[key];
    return typeof raw === "string" ? raw.trim() : "";
  };
  if (!text2("provider") || !text2("model") || !text2("baseUrl") || !text2("apiKey")) return {};
  const env2 = {
    [`${prefix}PROVIDER`]: text2("provider"),
    [`${prefix}MODEL`]: text2("model"),
    [`${prefix}BASE_URL`]: text2("baseUrl"),
    [`${prefix}API_KEY`]: text2("apiKey")
  };
  for (const key of OPTIONAL_STRING_KEYS) {
    if (text2(key)) env2[`${prefix}${envKey(key)}`] = text2(key);
  }
  for (const key of OPTIONAL_NUMBER_KEYS) {
    const raw = section[key];
    if (typeof raw === "number" && Number.isFinite(raw)) env2[`${prefix}${envKey(key)}`] = String(raw);
  }
  return env2;
}
function cursorCompletionEnvFromConfig(config) {
  if (!config || typeof config !== "object") return {};
  return {
    ...sectionEnv(config.primary, "NXCORE_AI_"),
    ...sectionEnv(config.cursorCompletion, "NXCORE_CURSOR_COMPLETION_AI_")
  };
}
const NANGO_PORT = 3003;
const CONNECT_UI_PORT = 3009;
const BASE_URL = `http://127.0.0.1:${NANGO_PORT}`;
const STARTUP_TIMEOUT_MS$3 = 12e4;
const SHUTDOWN_TIMEOUT_MS$3 = 5e3;
function delay$4(milliseconds) {
  return new Promise((resolve2) => setTimeout(resolve2, milliseconds));
}
function isLoopbackNangoUrl(value) {
  try {
    const url = new URL(value);
    return url.port === String(NANGO_PORT) && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
async function probeUrl(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1e3) });
    return response.ok;
  } catch {
    return false;
  }
}
function probe() {
  return probeUrl(`${BASE_URL}/health`);
}
function nangoDataDirectory() {
  return join(app.getPath("userData"), "nango");
}
function nangoEncryptionKey() {
  const keyPath = join(nangoDataDirectory(), "encryption-key");
  if (existsSync(keyPath)) {
    const existing = readFileSync(keyPath, "utf8").trim();
    if (existing) return existing;
  }
  mkdirSync(nangoDataDirectory(), { recursive: true });
  const generated = randomBytes(32).toString("base64");
  writeFileSync(keyPath, generated + "\n", { mode: 384 });
  return generated;
}
function proxyUrlFromRules$1(rules) {
  for (const rule of rules.split(";")) {
    const match = /^\s*(PROXY|HTTP|HTTPS)\s+([^\s]+)\s*$/i.exec(rule);
    if (!match) continue;
    const protocol2 = match[1]?.toUpperCase() === "HTTPS" ? "https" : "http";
    try {
      const url = new URL(`${protocol2}://${match[2]}`);
      if (!url.hostname || !url.port) continue;
      return url.toString().replace(/\/$/, "");
    } catch {
    }
  }
  return null;
}
async function nangoProxyEnvironment() {
  const explicitHttps = process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim();
  const explicitHttp = process.env.HTTP_PROXY?.trim() || process.env.http_proxy?.trim();
  let proxyUrl = explicitHttps || explicitHttp || "";
  if (!proxyUrl) {
    try {
      proxyUrl = proxyUrlFromRules$1(await session.defaultSession.resolveProxy("https://oauth2.googleapis.com")) ?? "";
    } catch {
      return {};
    }
  }
  if (!proxyUrl) return {};
  console.info(`[nango] outbound proxy for provider OAuth: ${proxyUrl}`);
  const noProxyEntries = new Set(
    (process.env.NO_PROXY ?? process.env.no_proxy ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
  for (const loopback of ["127.0.0.1", "localhost", "::1"]) noProxyEntries.add(loopback);
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NANGO_OUTBOUND_PROXY: proxyUrl,
    NO_PROXY: [...noProxyEntries].join(",")
  };
}
class NangoSupervisor {
  child = null;
  connectUiChild = null;
  connection = null;
  stopping = false;
  lastError = null;
  runtimeState = "starting";
  async start() {
    if (this.connection) return this.connection;
    this.runtimeState = "starting";
    this.lastError = null;
    try {
      return await this.startInternal();
    } catch (error) {
      this.runtimeState = "error";
      this.lastError = error instanceof Error ? error.message : "Nango 启动失败";
      throw error;
    }
  }
  async startInternal() {
    if (process.env.NXCORE_NANGO_MANAGED === "false") {
      this.runtimeState = "disabled";
      return null;
    }
    const externalBaseUrl = process.env.NXCORE_NANGO_CONNECTOR_URL?.trim() || process.env.NXCORE_NANGO_URL?.trim();
    if (externalBaseUrl && !isLoopbackNangoUrl(externalBaseUrl)) {
      this.runtimeState = "ready";
      return null;
    }
    if (app.isPackaged) {
      this.runtimeState = "disabled";
      return null;
    }
    const nangoDirectory = join(app.getAppPath(), "..", "gateway", "src", "modules", "connector");
    if (await probe()) {
      this.connection = { baseUrl: BASE_URL, managed: false };
      this.runtimeState = "ready";
      console.info(`[nango] reusing existing instance at ${BASE_URL}`);
      void this.startConnectUi(nangoDirectory);
      return this.connection;
    }
    if (!existsSync(join(nangoDirectory, "package.json"))) {
      throw new Error(`Nango 子模块不存在: ${nangoDirectory}（试试 git submodule update --init）`);
    }
    const tsxCli = join(nangoDirectory, "node_modules", "tsx", "dist", "cli.mjs");
    if (!existsSync(tsxCli)) {
      throw new Error("Nango 依赖未安装:请在 apps/gateway/src/modules/connector 下执行 npm install");
    }
    const embeddedPostgresFixScript = join(
      nangoDirectory,
      "packages",
      "database",
      "scripts",
      "fix-embedded-pg-icu.mjs"
    );
    if (existsSync(embeddedPostgresFixScript)) {
      const fix = await this.run(
        process.execPath,
        nangoDirectory,
        [embeddedPostgresFixScript],
        3e4,
        { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      );
      if (fix !== 0) throw new Error(`embedded-postgres 动态库准备失败（exit=${String(fix)}）`);
    }
    const build = await this.run(
      "npm",
      nangoDirectory,
      ["exec", "--", "tsc", "-b", "packages/server/tsconfig.json"],
      3e5
    );
    if (build !== 0) throw new Error(`Nango 构建失败（exit=${build}）`);
    const webappImages = join(nangoDirectory, "packages", "webapp", "public", "images");
    const webappDistImages = join(nangoDirectory, "packages", "webapp", "dist", "images");
    if (existsSync(webappImages) && !existsSync(join(webappDistImages, "template-logos"))) {
      cpSync(webappImages, webappDistImages, { recursive: true });
    }
    const serverDirectory = join(nangoDirectory, "packages", "server");
    const child = spawn(
      process.execPath,
      [tsxCli, "-r", "dotenv/config", "lib/server.ts"],
      {
        cwd: serverDirectory,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          DOTENV_CONFIG_PATH: join(nangoDirectory, ".env"),
          NANGO_EMBEDDED_DB: "true",
          // ponytail: embedded postgres 固定 5433,但 utils 包的 zod env 默认 5432 且不感知
          // NANGO_EMBEDDED_DB(records 等包用它拼连接串),必须显式指定端口避免分叉。
          NANGO_DB_PORT: "5433",
          // ponytail: embedded DB 收进 userData/nango(默认落在仓库 server 目录里,
          // 清应用数据/换仓库都会让 DB 与加密 key 失配)。
          NANGO_EMBEDDED_DB_DIR: join(nangoDataDirectory(), "embedded-postgres"),
          // ponytail: OAuth 回调直连本机(默认会用 redirectmeto.com 跳板包一层,
          // Google 侧需登记跳板 URI;直连时登记 http://localhost:3003/oauth/callback 即可)。
          NANGO_SERVER_URL: `http://localhost:${NANGO_PORT}`,
          // ponytail: 关闭 dashboard 的 session 鉴权(自托管无鉴权模式),gateway 的
          // nango-bootstrap 依赖此模式经 /api/v1/environment/api-keys 自举 API key。
          // 公开 API 仍走 secretKeyAuth,实例只监听回环,风险可控。
          FLAG_AUTH_ENABLED: "false",
          // ponytail: keystore 的 DEK 缺失时创建 connect session(/connect/sessions)
          // 会因无法加密 private key 而 500;key 持久化在 userData,重启不变。
          NANGO_ENCRYPTION_KEY: nangoEncryptionKey(),
          // ponytail: OAuth token 交换等出站请求走系统代理(Node 不读 macOS 系统代理,
          // 直连 Google 在无代理网络下会 ETIMEDOUT 卡死授权回调)。
          ...await nangoProxyEnvironment(),
          SERVER_PORT: String(NANGO_PORT)
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
    this.child = child;
    this.stopping = false;
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => process.stdout.write(`[nango] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[nango] ${chunk}`));
    child.on("exit", (code, signal) => {
      this.child = null;
      if (!this.stopping) {
        this.lastError = `Nango 进程已退出（code=${String(code)}, signal=${String(signal)}）`;
        this.runtimeState = "error";
        console.error(this.lastError);
      }
    });
    try {
      await this.waitUntilReady(child);
      this.connection = { baseUrl: BASE_URL, managed: true };
      this.runtimeState = "ready";
      console.info(`[nango] managed instance ready at ${BASE_URL} (pid=${child.pid})`);
    } catch (error) {
      this.killChild(child, "SIGTERM");
      this.child = null;
      this.lastError = error instanceof Error ? error.message : "Nango 启动失败";
      throw error;
    }
    void this.startConnectUi(nangoDirectory);
    return this.connection;
  }
  getStatus() {
    return { state: this.runtimeState, message: this.lastError };
  }
  gatewayBaseUrl() {
    const configured2 = process.env.NXCORE_NANGO_CONNECTOR_URL?.trim() || process.env.NXCORE_NANGO_URL?.trim();
    if (process.env.NXCORE_NANGO_MANAGED === "false") return configured2 || null;
    if (configured2 && !isLoopbackNangoUrl(configured2)) return configured2;
    return app.isPackaged ? null : BASE_URL;
  }
  /** 授权页所需的 Connect UI(静态站,默认 3009)。失败不阻断,授权链接会打不开但 server 正常。 */
  async startConnectUi(nangoDirectory) {
    if (await probeUrl(`http://127.0.0.1:${CONNECT_UI_PORT}`)) {
      console.info(`[nango] reusing existing Connect UI at :${CONNECT_UI_PORT}`);
      return;
    }
    const connectUiDirectory = join(nangoDirectory, "packages", "connect-ui");
    try {
      if (!existsSync(join(connectUiDirectory, "dist", "index.html"))) {
        const build = await this.run("npm", nangoDirectory, ["run", "build", "-w", "@nangohq/connect-ui"], 3e5);
        if (build !== 0) throw new Error(`Connect UI 构建失败（exit=${build}）`);
      }
      const child = spawn(
        process.execPath,
        [
          join(nangoDirectory, "node_modules", "serve", "build", "main.js"),
          "-s",
          "dist",
          "-p",
          String(CONNECT_UI_PORT),
          "--no-clipboard"
        ],
        {
          cwd: connectUiDirectory,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        }
      );
      this.connectUiChild = child;
      child.stdin.end();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => process.stdout.write(`[nango-connect-ui] ${chunk}`));
      child.stderr.on("data", (chunk) => process.stderr.write(`[nango-connect-ui] ${chunk}`));
      child.on("exit", () => {
        this.connectUiChild = null;
      });
      const deadline = Date.now() + 3e4;
      while (Date.now() < deadline && await probeUrl(`http://127.0.0.1:${CONNECT_UI_PORT}`) === false) {
        if (child.exitCode !== null) break;
        await delay$4(300);
      }
      console.info(`[nango] Connect UI ready at :${CONNECT_UI_PORT} (pid=${child.pid})`);
    } catch (error) {
      console.warn("[nango] Connect UI 启动失败,第三方授权页将不可用:", error instanceof Error ? error.message : error);
    }
  }
  getConnection() {
    return this.connection;
  }
  async shutdown() {
    const child = this.child;
    const connectUi = this.connectUiChild;
    this.connection = null;
    this.stopping = true;
    this.runtimeState = "disabled";
    connectUi?.kill("SIGTERM");
    this.connectUiChild = null;
    if (!child) return;
    await new Promise((resolve2) => {
      const timeout = setTimeout(() => {
        this.killChild(child, "SIGKILL");
        resolve2();
      }, SHUTDOWN_TIMEOUT_MS$3);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve2();
      });
      if (!this.killChild(child, "SIGTERM")) resolve2();
    });
    this.child = null;
    this.lastError = null;
  }
  async waitUntilReady(child) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS$3;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Nango server exited during startup with code ${String(child.exitCode)}`);
      }
      if (await probe()) return;
      await delay$4(200);
    }
    throw new Error(`Nango server did not become ready within ${STARTUP_TIMEOUT_MS$3}ms`);
  }
  run(command, cwd, args, timeoutMs, env2 = process.env) {
    return new Promise((resolve2, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: env2,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32"
      });
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`命令超时: ${command} ${args.join(" ")}`));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => process.stdout.write(`[nango-build] ${chunk}`));
      child.stderr.on("data", (chunk) => process.stderr.write(`[nango-build] ${chunk}`));
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve2(code);
      });
    });
  }
  killChild(child, signal) {
    return child.kill(signal);
  }
}
const englishMessages = {
  "dialog.chooseFolder.title": "Choose a folder to connect",
  "dialog.chooseFolder.button": "Connect folder",
  "dialog.exportTranscript.title": "Export transcript",
  "dialog.exportTranscript.button": "Export",
  "dialog.exportTranscript.textFile": "Text file",
  "dialog.exportTranscript.defaultName": "Transcript",
  "dialog.exportPdf.title": "Export PDF",
  "dialog.exportPdf.button": "Export",
  "dialog.exportPdf.pdfDocument": "PDF document",
  "dialog.knowledgeMarkdown.title": "Choose Markdown files to classify",
  "dialog.importFiles.title": "Choose files or folders to add",
  "dialog.importFiles.documents": "Documents",
  "dialog.memoryMarkdown.title": "Choose Markdown files to import into memory",
  "error.requestFailed": "The request failed. Try again later.",
  "error.network.title": "Unable to connect to the local service",
  "error.network.message": 'Operation "{operation}" could not complete because EverRoom Gateway is unreachable. Make sure Gateway is running and try again.\nSource: {channel}',
  "error.network.agentSessions": "Load Agent sessions",
  "error.network.runtimeConfig": "Read runtime configuration",
  "error.network.gatewayStatus": "Read Gateway status",
  "error.network.memory": "Access memory service",
  "error.network.knowledge": "Access knowledge service",
  "error.network.document": "Read document",
  "error.network.files": "Read local files",
  "error.network.connectors": "Access connector service",
  "error.network.service": "Access local service",
  "error.rateLimited.title": "Operation will resume shortly",
  "error.rateLimited.message": "Too many requests. Try again later.",
  "error.screenshot.windowUnavailable": "The application window is unavailable.",
  "error.screenshot.captureFailed": "The application window could not be captured. Try again later.",
  "error.screenshot.empty": "The application window capture is empty. Try again later.",
  "error.screenshot.encodingFailed": "The application window capture could not be encoded. Try again later.",
  "error.screenshot.saveFailed": "The screenshot could not be saved. Check the folder permissions and available disk space.",
  "error.screenshot.invalidSource": "The screenshot request source could not be verified.",
  "error.pdf.invalidSource": "The PDF export request source could not be verified.",
  "error.pdf.invalidRequest": "The PDF export request is invalid.",
  "error.pdf.invalidFileName": "The PDF file name is invalid.",
  "error.pdf.invalidTitle": "The PDF document title is invalid.",
  "error.pdf.invalidContent": "The PDF document content is empty or too large.",
  "document.untitled": "Untitled document",
  "error.transcript.invalidSource": "The export request source could not be verified.",
  "error.transcript.invalidRequest": "The transcript export request is invalid.",
  "error.memory.fileTooLarge": "The file exceeds the 2 MB import limit ({size} MB)."
};
const chineseMessages = {
  "dialog.chooseFolder.title": "选择要连接的文件夹",
  "dialog.chooseFolder.button": "连接文件夹",
  "dialog.exportTranscript.title": "导出逐字稿",
  "dialog.exportTranscript.button": "导出",
  "dialog.exportTranscript.textFile": "文本文件",
  "dialog.exportTranscript.defaultName": "逐字稿",
  "dialog.exportPdf.title": "导出 PDF",
  "dialog.exportPdf.button": "导出",
  "dialog.exportPdf.pdfDocument": "PDF 文档",
  "dialog.knowledgeMarkdown.title": "选择要归类的 Markdown 文件",
  "dialog.importFiles.title": "选择要导入的文件或文件夹",
  "dialog.importFiles.documents": "文档",
  "dialog.memoryMarkdown.title": "选择要导入记忆的 Markdown 文件",
  "error.requestFailed": "请求失败，请稍后重试。",
  "error.network.title": "无法连接本地服务",
  "error.network.message": "操作“{operation}”未完成：无法连接 EverRoom Gateway。请确认 Gateway 正在运行后重试。\n错误来源：{channel}",
  "error.network.agentSessions": "加载 Agent 会话",
  "error.network.runtimeConfig": "读取运行时配置",
  "error.network.gatewayStatus": "读取 Gateway 状态",
  "error.network.memory": "访问记忆服务",
  "error.network.knowledge": "访问知识库",
  "error.network.document": "读取文档",
  "error.network.files": "读取本地文件",
  "error.network.connectors": "访问连接器服务",
  "error.network.service": "访问本地服务",
  "error.rateLimited.title": "操作稍后继续",
  "error.rateLimited.message": "请求过于频繁，请稍后重试。",
  "error.screenshot.windowUnavailable": "当前应用窗口不可用。",
  "error.screenshot.captureFailed": "应用窗口截图失败，请稍后重试。",
  "error.screenshot.empty": "应用窗口截图为空，请稍后重试。",
  "error.screenshot.encodingFailed": "应用窗口截图编码失败，请稍后重试。",
  "error.screenshot.saveFailed": "截图无法保存，请检查目录权限和磁盘空间。",
  "error.screenshot.invalidSource": "无法验证截图请求来源。",
  "error.pdf.invalidSource": "无法验证 PDF 导出请求来源。",
  "error.pdf.invalidRequest": "无效的 PDF 导出请求。",
  "error.pdf.invalidFileName": "无效的 PDF 文件名。",
  "error.pdf.invalidTitle": "无效的 PDF 文档标题。",
  "error.pdf.invalidContent": "PDF 文档内容为空或过大。",
  "document.untitled": "无标题文档",
  "error.transcript.invalidSource": "无法验证导出请求来源。",
  "error.transcript.invalidRequest": "无效的逐字稿导出请求。",
  "error.memory.fileTooLarge": "文件超过 2MB 导入上限（{size}MB）"
};
const DESKTOP_LOCALES = ["zh-CN", "en-US"];
const messages = {
  "zh-CN": chineseMessages,
  "en-US": englishMessages
};
function isDesktopLocale(value) {
  return typeof value === "string" && DESKTOP_LOCALES.includes(value);
}
function translateDesktopMessage(locale, key, values) {
  const message = messages[locale][key];
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
}
let currentLocale = "zh-CN";
function setDesktopLocale(locale) {
  if (isDesktopLocale(locale)) currentLocale = locale;
}
function getDesktopLocale() {
  return currentLocale;
}
function desktopText(key, values) {
  return translateDesktopMessage(currentLocale, key, values);
}
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
class MemoryGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  overview() {
    return this.request("/v1/memory/overview");
  }
  startOnboarding(input) {
    return this.request("/v1/memory/onboarding", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  listAtomic(options) {
    return this.request(`/v1/memory/atomic?${this.query(options)}`);
  }
  searchAtomic(query, limit = 10) {
    return this.request("/v1/memory/atomic/search", {
      method: "POST",
      body: JSON.stringify({ query, limit })
    });
  }
  updateAtomic(id, content, background) {
    return this.request(`/v1/memory/atomic/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ content, ...background !== void 0 ? { background } : {} })
    });
  }
  deleteAtomic(ids) {
    return this.request("/v1/memory/atomic", { method: "DELETE", body: JSON.stringify({ ids }) });
  }
  listScenarios(pathPrefix) {
    const query = pathPrefix ? `?${new URLSearchParams({ pathPrefix })}` : "";
    return this.request(`/v1/memory/scenario${query}`);
  }
  readScenario(path) {
    return this.request(`/v1/memory/scenario/content?${new URLSearchParams({ path })}`);
  }
  readCore() {
    return this.request("/v1/memory/core");
  }
  writeCore(content) {
    return this.request("/v1/memory/core", { method: "PUT", body: JSON.stringify({ content }) });
  }
  listConversations(options) {
    return this.request(`/v1/memory/conversation?${this.query(options)}`);
  }
  searchConversations(query, limit = 10, sessionId) {
    return this.request("/v1/memory/conversation/search", {
      method: "POST",
      body: JSON.stringify({ query, limit, ...sessionId ? { sessionId } : {} })
    });
  }
  deleteConversations(target) {
    return this.request("/v1/memory/conversation", { method: "DELETE", body: JSON.stringify(target) });
  }
  // ── md 文档一等来源（资产化 + /v3/document/* 代理） ──
  importMarkdown(input) {
    return this.request("/v1/memory/import/markdown", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  captureDocumentRewrite(input) {
    return this.request("/v1/memory/document-rewrite", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  captureSourceDocument(input) {
    return this.request("/v1/memory/source-document", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  listDocuments(limit = 50, offset = 0) {
    return this.request(`/v1/memory/documents?limit=${limit}&offset=${offset}`);
  }
  getDocument(id) {
    return this.request(`/v1/memory/documents/${encodeURIComponent(id)}`);
  }
  deleteDocument(id) {
    return this.request(`/v1/memory/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  atomicProvenance(id) {
    return this.request(`/v1/memory/atomic/${encodeURIComponent(id)}/provenance`);
  }
  /**
   * 主进程文件选择框（仅 .md）→ 读文本上行由渲染层走 importMarkdown。
   * 超过导入上限的文件直接报错跳过（不截断，避免半篇入库）。
   */
  async pickMarkdownFiles() {
    const picked = await dialog.showOpenDialog({
      title: desktopText("dialog.memoryMarkdown.title"),
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }]
    });
    if (picked.canceled || picked.filePaths.length === 0) return [];
    const results = [];
    for (const filePath of picked.filePaths) {
      const filename = filePath.split(/[\\/]/).pop() ?? filePath;
      try {
        const buffer = await readFile(filePath);
        if (buffer.byteLength > MAX_IMPORT_BYTES) {
          results.push({
            filename,
            error: desktopText("error.memory.fileTooLarge", {
              size: (buffer.byteLength / 1024 / 1024).toFixed(1)
            })
          });
          continue;
        }
        results.push({ filename, markdown: buffer.toString("utf8") });
      } catch (error) {
        results.push({ filename, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }
  query(options) {
    const params = new URLSearchParams();
    if ("type" in options && options.type) params.set("type", options.type);
    if ("sessionId" in options && options.sessionId) params.set("sessionId", options.sessionId);
    if ("sourceKind" in options && options.sourceKind) params.set("sourceKind", options.sourceKind);
    if (options.limit !== void 0) params.set("limit", String(options.limit));
    if (options.offset !== void 0) params.set("offset", String(options.offset));
    if (options.timeStart) params.set("timeStart", options.timeStart);
    if (options.timeEnd) params.set("timeEnd", options.timeEnd);
    return params.toString();
  }
  async request(path, init) {
    const connection = this.supervisor.getConnection();
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        // 无 body 不带 Content-Type：Fastify 5 对「JSON 头 + 空 body」直接
        // 400（FST_ERR_CTP_EMPTY_JSON_BODY），GET/DELETE 均无 body
        ...init?.body ? { "Content-Type": "application/json" } : {},
        ...init?.headers
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const code = typeof body?.error === "string" ? body.error : "";
      const message = typeof body?.message === "string" ? body.message : `记忆请求失败（${response.status}）`;
      throw new Error(code ? `[${code}] ${message}` : message);
    }
    return response.json();
  }
}
const PACKAGE_NAME$1 = "@tencentdb-agent-memory/knowledge-service";
const KNOWLEDGE_PORT = 8421;
const DEFAULT_BASE_URL$1 = `http://127.0.0.1:${KNOWLEDGE_PORT}`;
const SERVICE_ID = "everroom";
const TEAM_ID = "everroom";
const STARTUP_TIMEOUT_MS$2 = 12e4;
const SHUTDOWN_TIMEOUT_MS$2 = 5e3;
const DEFAULT_LLM_MAX_TOKENS = 16384;
function delay$3(milliseconds) {
  return new Promise((resolve2) => setTimeout(resolve2, milliseconds));
}
class KnowledgeServiceSupervisor {
  constructor(dataDirectory2) {
    this.dataDirectory = dataDirectory2;
  }
  child = null;
  connection = null;
  stopping = false;
  lastError = null;
  async start() {
    if (this.connection) return this.connection;
    if (process.env.NXCORE_KNOWLEDGE_MANAGED === "false" || process.env.NXCORE_KNOWLEDGE_ENABLED === "false") {
      return null;
    }
    const externalBaseUrl = process.env.NXCORE_KNOWLEDGE_BASE_URL?.trim();
    if (externalBaseUrl && externalBaseUrl !== DEFAULT_BASE_URL$1) return null;
    if (await this.probe()) {
      console.info(`[knowledge] reusing existing instance at ${DEFAULT_BASE_URL$1}`);
      this.connection = {
        baseUrl: DEFAULT_BASE_URL$1,
        serviceId: SERVICE_ID,
        teamId: TEAM_ID,
        managed: false
      };
      return this.connection;
    }
    const { packageDirectory, tsxEntryUrl } = this.resolvePackage();
    const dataDir = join(this.dataDirectory, "knowledge");
    await mkdir(dataDir, { recursive: true });
    const command = app.isPackaged ? process.execPath : process.env.NXCORE_KNOWLEDGE_NODE ?? "node";
    const serverEntry = join(packageDirectory, "src", "server.ts").replace(/\\/g, "/");
    const child = spawn(
      command,
      ["--import", tsxEntryUrl, serverEntry],
      {
        cwd: dataDir,
        env: {
          ...process.env,
          PORT: String(KNOWLEDGE_PORT),
          API_PREFIX: "/v3",
          KNOWLEDGE_DATA_DIR: dataDir,
          KNOWLEDGE_DB_PATH: join(dataDir, "knowledge.db"),
          KNOWLEDGE_PUBLIC_BASE_URL: `${DEFAULT_BASE_URL$1}/v3`,
          // 服务默认 debug;托管实例跟随桌面日志级别。
          LOG_LEVEL: process.env.NXCORE_KNOWLEDGE_LOG_LEVEL?.trim() ?? "info",
          ...this.llmEnvironment(),
          ...app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
    this.child = child;
    this.stopping = false;
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => process.stdout.write(`[knowledge] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[knowledge] ${chunk}`));
    child.on("exit", (code, signal) => {
      this.child = null;
      if (!this.stopping) {
        this.lastError = `Knowledge service 进程已退出（code=${String(code)}, signal=${String(signal)}）`;
        console.error(this.lastError);
      }
    });
    try {
      await this.waitUntilReady(child);
      console.info(`[knowledge] managed instance ready at ${DEFAULT_BASE_URL$1} (pid=${child.pid})`);
      this.connection = {
        baseUrl: DEFAULT_BASE_URL$1,
        serviceId: SERVICE_ID,
        teamId: TEAM_ID,
        managed: true
      };
      return this.connection;
    } catch (error) {
      this.killChild(child, "SIGTERM");
      this.child = null;
      this.lastError = error instanceof Error ? error.message : "Knowledge service 启动失败";
      throw error;
    }
  }
  getConnection() {
    return this.connection;
  }
  getLastError() {
    return this.lastError;
  }
  async shutdown() {
    const child = this.child;
    this.connection = null;
    if (!child) return;
    this.stopping = true;
    await new Promise((resolve2) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve2();
      };
      const timeout = setTimeout(() => {
        this.killChild(child, "SIGKILL");
        finish();
      }, SHUTDOWN_TIMEOUT_MS$2);
      child.once("exit", finish);
      if (!this.killChild(child, "SIGTERM")) finish();
    });
    this.child = null;
    this.lastError = null;
  }
  /** 把桌面的 NXCORE_AI_* 映射为 Knowledge Service 使用的 LLM_*(注意与 MemoryCore 的 TDAI_LLM_* 不同名)。 */
  llmEnvironment() {
    const environment = {
      // 脱离 Panel 直连 LLM 端点;回调默认即空,不通知 TMC。
      LLM_MODE: "custom"
    };
    const baseUrl = process.env.NXCORE_AI_BASE_URL?.trim();
    const apiKey = process.env.NXCORE_AI_API_KEY?.trim();
    const model = process.env.NXCORE_AI_MODEL?.trim();
    if (baseUrl) environment.LLM_BASE_URL = baseUrl;
    if (apiKey) environment.LLM_API_KEY = apiKey;
    if (model) environment.LLM_MODEL = model;
    if (process.env.NXCORE_AI_API === "anthropic-messages") environment.LLM_PROTOCOL = "anthropic";
    const raw = Number(process.env.NXCORE_KNOWLEDGE_LLM_MAX_TOKENS);
    const preferred = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LLM_MAX_TOKENS;
    environment.LLM_MAX_TOKENS = String(Math.min(Math.max(preferred, 1024), 65536));
    return environment;
  }
  async probe() {
    try {
      const response = await fetch(`${DEFAULT_BASE_URL$1}/health`, {
        signal: AbortSignal.timeout(1e3)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  async waitUntilReady(child) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS$2;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Knowledge service exited during startup with code ${String(child.exitCode)}${this.lastError ? `: ${this.lastError}` : ""}`
        );
      }
      if (await this.probe()) return;
      await delay$3(100);
    }
    throw new Error(`Knowledge service did not become ready within ${STARTUP_TIMEOUT_MS$2}ms`);
  }
  resolvePackage() {
    const override = process.env.NXCORE_KNOWLEDGE_SERVICE_DIR?.trim();
    const manifestPath = override ? join(override, "package.json") : createRequire(join(app.getAppPath(), "package.json")).resolve(`${PACKAGE_NAME$1}/package.json`);
    const packageRequire = createRequire(manifestPath);
    return {
      packageDirectory: dirname(manifestPath),
      tsxEntryUrl: pathToFileURL(packageRequire.resolve("tsx")).href
    };
  }
  killChild(child, signal) {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}
const PACKAGE_NAME = "@tencentdb-agent-memory/memory-tencentdb-v2";
const MEMORY_CORE_PORT = 8420;
const DEFAULT_BASE_URL = `http://127.0.0.1:${MEMORY_CORE_PORT}`;
const STARTUP_TIMEOUT_MS$1 = 12e4;
const SHUTDOWN_TIMEOUT_MS$1 = 5e3;
function memoryLogLevel() {
  const value = process.env.NXCORE_MEMORY_LOG_LEVEL?.trim().toLowerCase();
  return value === "debug" || value === "info" || value === "warn" || value === "error" || value === "off" ? value : "warn";
}
function writeMemoryCoreOutput(level, chunk, stream2) {
  if (level === "off") return;
  for (const line of chunk.split(/(?<=\n)/)) {
    if (!line) continue;
    const noisy = /\[observability\]|\[skill-perf\]|\[L1-count\]|REQUEST_(?:START|END)/i.test(line);
    if (noisy && level !== "debug") continue;
    const isError = /\b(?:ERROR|FATAL|WARN|warning|failed|failure|exception|unhandled)\b/i.test(line);
    if (level === "error" && !isError) continue;
    stream2.write(`[memory-core] ${line}`);
  }
}
function delay$2(milliseconds) {
  return new Promise((resolve2) => setTimeout(resolve2, milliseconds));
}
class MemoryCoreSupervisor {
  constructor(dataDirectory2) {
    this.dataDirectory = dataDirectory2;
  }
  child = null;
  connection = null;
  stopping = false;
  lastError = null;
  async start(options = {}) {
    if (this.connection) return this.connection;
    if (process.env.NXCORE_MEMORY_MANAGED === "false" || process.env.NXCORE_MEMORY_ENABLED === "false") {
      return null;
    }
    const externalBaseUrl = process.env.NXCORE_MEMORY_BASE_URL?.trim();
    if (externalBaseUrl && externalBaseUrl !== DEFAULT_BASE_URL) return null;
    if (await this.probe()) {
      this.connection = {
        baseUrl: DEFAULT_BASE_URL,
        apiKey: process.env.NXCORE_MEMORY_API_KEY?.trim() ?? "",
        managed: false
      };
      console.info(`[memory-core] reusing existing instance at ${DEFAULT_BASE_URL}`);
      return this.connection;
    }
    const apiKey = options.apiKey ?? randomBytes(24).toString("base64url");
    const entryPath = this.resolveEntry();
    await mkdir(this.dataDirectory, { recursive: true });
    const dataDir = join(this.dataDirectory, "memory");
    await mkdir(dataDir, { recursive: true });
    const logDirectory = process.env.LOG_PATH?.trim() || join(this.dataDirectory, "logs", "memory-core");
    await mkdir(logDirectory, { recursive: true });
    const command = app.isPackaged ? process.execPath : process.env.NXCORE_MEMORY_NODE ?? "node";
    const child = spawn(
      command,
      [entryPath],
      {
        cwd: dataDir,
        // detached 让子进程成为进程组组长：shutdown 可整组 kill（tsx wrapper
        // fork 的孙进程才不会残留占端口）。Electron 主进程退出不连带子进程
        // 组——退出清理仍靠 shutdown() 的显式调用。
        detached: true,
        env: {
          ...process.env,
          TDAI_GATEWAY_HOST: "127.0.0.1",
          TDAI_GATEWAY_PORT: String(MEMORY_CORE_PORT),
          TDAI_GATEWAY_API_KEY: apiKey,
          TDAI_DATA_DIR: dataDir,
          LOG_PATH: logDirectory,
          ...app.isPackaged ? { ELECTRON_RUN_AS_NODE: "1" } : {},
          ...this.llmEnvironment(),
          ...options.aiEnvironment ?? {}
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
    this.child = child;
    this.stopping = false;
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const configuredLogLevel = memoryLogLevel();
    child.stdout.on("data", (chunk) => writeMemoryCoreOutput(configuredLogLevel, chunk, process.stdout));
    child.stderr.on("data", (chunk) => writeMemoryCoreOutput(configuredLogLevel, chunk, process.stderr));
    child.on("exit", (code, signal) => {
      this.child = null;
      if (!this.stopping) {
        this.lastError = `MemoryCore 进程已退出（code=${String(code)}, signal=${String(signal)}）`;
        console.error(this.lastError);
      }
    });
    try {
      await this.waitUntilReady(child);
      this.connection = { baseUrl: DEFAULT_BASE_URL, apiKey, managed: true };
      console.info(`[memory-core] managed instance ready at ${DEFAULT_BASE_URL} (pid=${child.pid})`);
      return this.connection;
    } catch (error) {
      this.killChild(child, "SIGTERM");
      this.child = null;
      this.lastError = error instanceof Error ? error.message : "MemoryCore 启动失败";
      throw error;
    }
  }
  getConnection() {
    return this.connection;
  }
  /**
   * 重启托管实例以应用新的 AI 环境(MemoryCore 启动时解析配置,无热加载)。
   * 复用旧 apiKey,busy/外部/复用模式不重启。失败抛出,连接置空。
   */
  async restart(aiEnvironment) {
    const connection = this.connection;
    if (!connection?.managed) return connection;
    const apiKey = connection.apiKey;
    await this.shutdown();
    return this.start({ apiKey, aiEnvironment: aiEnvironment ?? void 0 });
  }
  getLastError() {
    return this.lastError;
  }
  async shutdown() {
    const child = this.child;
    this.connection = null;
    if (!child) return;
    this.stopping = true;
    const processGroupKill = () => {
      try {
        return process.kill(-child.pid, "SIGTERM");
      } catch {
        return this.killChild(child, "SIGTERM");
      }
    };
    await new Promise((resolve2) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve2();
      };
      const timeout = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
        }
        this.killChild(child, "SIGKILL");
        finish();
      }, SHUTDOWN_TIMEOUT_MS$1);
      child.once("exit", finish);
      if (!processGroupKill()) finish();
    });
    const deadline = Date.now() + 3e3;
    while (Date.now() < deadline && await this.probe()) await delay$2(100);
    this.child = null;
    this.lastError = null;
  }
  /**
   * 把桌面的 NXCORE_AI_* 映射为 MemoryCore 提炼管道使用的 TDAI_LLM_*。
   * embedding 不在此映射:TDAI_EMBEDDING_* 由 spawn 的 ...process.env 原样透传
   * （fork 侧 env > tdai-gateway.yaml > 默认），在根目录 .env 配即可生效。
   */
  llmEnvironment() {
    const environment = {};
    const baseUrl = process.env.NXCORE_AI_BASE_URL?.trim();
    const apiKey = process.env.NXCORE_AI_API_KEY?.trim();
    const model = process.env.NXCORE_AI_MODEL?.trim();
    if (baseUrl) environment.TDAI_LLM_BASE_URL = baseUrl;
    if (apiKey) environment.TDAI_LLM_API_KEY = apiKey;
    if (model) environment.TDAI_LLM_MODEL = model;
    const maxTokens = process.env.TDAI_LLM_MAX_TOKENS?.trim();
    if (maxTokens) environment.TDAI_LLM_MAX_TOKENS = maxTokens;
    return environment;
  }
  async probe() {
    try {
      const response = await fetch(`${DEFAULT_BASE_URL}/health`, {
        signal: AbortSignal.timeout(1e3)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  async waitUntilReady(child) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS$1;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `MemoryCore exited during startup with code ${String(child.exitCode)}${this.lastError ? `: ${this.lastError}` : ""}`
        );
      }
      if (await this.probe()) return;
      await delay$2(100);
    }
    throw new Error(`MemoryCore did not become ready within ${STARTUP_TIMEOUT_MS$1}ms`);
  }
  resolveEntry() {
    const override = process.env.NXCORE_MEMORY_CORE_DIR?.trim();
    if (override) return join(override, "bin", "memory-gateway.mjs");
    const baseRequire = createRequire(join(app.getAppPath(), "package.json"));
    return baseRequire.resolve(`${PACKAGE_NAME}/bin/memory-gateway.mjs`);
  }
  killChild(child, signal) {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}
function memoryCoreEmbeddingEnv(fields, dimensions) {
  const provider = fields.provider.trim() || "openai";
  return {
    TDAI_EMBEDDING_PROVIDER: provider,
    TDAI_EMBEDDING_BASE_URL: fields.baseUrl.trim(),
    TDAI_EMBEDDING_API_KEY: fields.apiKey.trim(),
    TDAI_EMBEDDING_MODEL: fields.model.trim(),
    TDAI_EMBEDDING_DIMENSIONS: String(dimensions)
  };
}
function embeddingFieldsFromConfig(config) {
  const knowledge = config?.knowledge;
  const embedding = knowledge && typeof knowledge === "object" && !Array.isArray(knowledge) ? knowledge.embedding : void 0;
  const value = embedding && typeof embedding === "object" && !Array.isArray(embedding) ? embedding : {};
  const text2 = (key) => {
    const raw = value[key];
    return typeof raw === "string" ? raw.trim() : "";
  };
  const fields = {
    provider: text2("provider"),
    model: text2("model"),
    baseUrl: text2("baseUrl"),
    apiKey: text2("apiKey")
  };
  if (!fields.model || !fields.baseUrl || !fields.apiKey) return null;
  return fields;
}
function memoryCoreLlmEnv(config) {
  const primary = config?.primary;
  const value = primary && typeof primary === "object" && !Array.isArray(primary) ? primary : {};
  const text2 = (key) => {
    const raw = value[key];
    return typeof raw === "string" ? raw.trim() : "";
  };
  const baseUrl = text2("baseUrl");
  const apiKey = text2("apiKey");
  const model = text2("model");
  if (!baseUrl || !apiKey || !model) return null;
  return {
    TDAI_LLM_BASE_URL: baseUrl,
    TDAI_LLM_API_KEY: apiKey,
    TDAI_LLM_MODEL: model
  };
}
function memoryCoreEnvironment(config, embeddingEnv) {
  const llmEnv = memoryCoreLlmEnv(config);
  if (llmEnv && embeddingEnv) return { ...llmEnv, ...embeddingEnv };
  return llmEnv ?? embeddingEnv;
}
const DOCUMENT_EVENT_CHANNEL = "documents:event";
const DOCUMENT_OPERATION_EVENT_CHANNEL = "documents:operation-changed";
const SAVE_RETRY_DELAYS_MS = [250, 500, 1e3, 1500];
function delay$1(milliseconds) {
  return new Promise((resolve2) => setTimeout(resolve2, milliseconds));
}
function isConnectionRefused(error) {
  if (!(error instanceof Error)) return false;
  const cause = error.cause;
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "ECONNREFUSED");
}
function isDocumentEventFrame(value) {
  if (!value || typeof value !== "object") return false;
  const frame = value;
  return frame.type === "document.event" && frame.protocol === 1 && Boolean(frame.event);
}
function operationIdFromDocumentEvent(frame) {
  if (frame.event.type !== "document.operation.changed") return null;
  const payload = frame.event.payload;
  if (!payload || typeof payload !== "object") return null;
  const value = payload;
  const operation = value.operation && typeof value.operation === "object" ? value.operation : null;
  const id = typeof operation?.id === "string" ? operation.id : typeof value.operationId === "string" ? value.operationId : "";
  return id.trim() || null;
}
function documentOperationListResult(result) {
  return result.operations;
}
class DocumentGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  subscriptions = /* @__PURE__ */ new Map();
  contentsLifecycle = new WebContentsLifecycle();
  list(roomId) {
    return this.request(`/v1/documents?${new URLSearchParams({ roomId })}`);
  }
  listTrash(roomId) {
    return this.request(`/v1/documents?${new URLSearchParams({ roomId, trashed: "true" })}`);
  }
  get(documentId) {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}`);
  }
  listBlocks(documentId) {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}/blocks`);
  }
  listBlockBacklinks(documentId, blockId) {
    const query = blockId ? `?${new URLSearchParams({ blockId })}` : "";
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}/backlinks${query}`);
  }
  listVersions(documentId) {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}/versions`);
  }
  restoreVersion(documentId, version, baseVersion) {
    return this.request(
      `/v1/documents/${encodeURIComponent(documentId)}/versions/${String(version)}/restore`,
      { method: "POST", body: JSON.stringify({ baseVersion }) },
      true
    );
  }
  resolveBlockReferences(input) {
    return this.request("/v1/document-blocks/resolve", { method: "POST", body: JSON.stringify(input) });
  }
  async listOperations(filters = {}) {
    const query = new URLSearchParams();
    if (filters.roomId) query.set("roomId", filters.roomId);
    if (filters.documentId) query.set("documentId", filters.documentId);
    if (filters.sessionId) query.set("sessionId", filters.sessionId);
    if (filters.status) query.set("status", filters.status);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const result = await this.request(
      `/v1/document-operations${suffix}`
    );
    return documentOperationListResult(result);
  }
  startOperation(input) {
    return this.request("/v1/document-operations", {
      method: "POST",
      body: JSON.stringify(input)
    }, true);
  }
  getOperation(operationId) {
    return this.request(`/v1/document-operations/${encodeURIComponent(operationId)}`);
  }
  executeOperationCommand(operationId, input) {
    return this.request(`/v1/document-operations/${encodeURIComponent(operationId)}/commands`, {
      method: "POST",
      body: JSON.stringify(input)
    }, true);
  }
  import(input) {
    return this.request("/v1/documents/import", { method: "POST", body: JSON.stringify(input) });
  }
  save(documentId, input) {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}`, {
      method: "PUT",
      body: JSON.stringify(input)
    }, true);
  }
  delete(documentId) {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
  }
  restore(documentId) {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}/restore`, { method: "POST" });
  }
  deletePermanently(documentId) {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}/permanent`, { method: "DELETE" });
  }
  emptyTrash(roomId) {
    return this.request(`/v1/documents/trash?${new URLSearchParams({ roomId })}`, { method: "DELETE" });
  }
  subscribe(contents, roomId) {
    let subscriptions = this.subscriptions.get(contents.id);
    if (!subscriptions) {
      subscriptions = /* @__PURE__ */ new Map();
      this.subscriptions.set(contents.id, subscriptions);
      this.contentsLifecycle.observe(contents, () => this.unsubscribe(contents.id));
    }
    if (subscriptions.has(roomId)) return;
    const subscription = {
      roomId,
      socket: this.openSocket(contents, roomId),
      closed: false,
      reconnectTimer: null
    };
    subscriptions.set(roomId, subscription);
  }
  unsubscribe(contentsId, roomId) {
    const subscriptions = this.subscriptions.get(contentsId);
    if (!subscriptions) return;
    const targets = roomId ? [subscriptions.get(roomId)].filter(Boolean) : [...subscriptions.values()];
    for (const subscription of targets) {
      subscription.closed = true;
      if (subscription.reconnectTimer) clearTimeout(subscription.reconnectTimer);
      subscription.socket.close();
      subscriptions.delete(subscription.roomId);
    }
    if (subscriptions.size === 0) this.subscriptions.delete(contentsId);
  }
  dispose() {
    for (const contentsId of [...this.subscriptions.keys()]) this.unsubscribe(contentsId);
  }
  openSocket(contents, roomId) {
    const connection = this.supervisor.getConnection();
    const url = new URL(connection.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/v1/documents/rooms/${encodeURIComponent(roomId)}/stream`;
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } });
    socket.on("message", (data) => {
      if (contents.isDestroyed()) return;
      try {
        const frame = JSON.parse(data.toString());
        if (isDocumentEventFrame(frame)) {
          contents.send(DOCUMENT_EVENT_CHANNEL, frame);
          const operationId = operationIdFromDocumentEvent(frame);
          if (operationId) contents.send(DOCUMENT_OPERATION_EVENT_CHANNEL, operationId);
        }
      } catch {
      }
    });
    socket.on("close", () => {
      const subscription = this.subscriptions.get(contents.id)?.get(roomId);
      if (!subscription || subscription.closed || contents.isDestroyed()) return;
      subscription.reconnectTimer = setTimeout(() => {
        const current = this.subscriptions.get(contents.id)?.get(roomId);
        if (!current || current.closed || contents.isDestroyed()) return;
        current.socket = this.openSocket(contents, roomId);
      }, 750);
    });
    socket.on("error", () => void 0);
    return socket;
  }
  async request(path, init, retryWhenUnavailable = false) {
    const connection = this.supervisor.getConnection();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${connection.token}`);
    if (init?.body !== void 0 && init.body !== null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    let response = null;
    for (let attempt = 0; response === null; attempt += 1) {
      try {
        response = await fetch(`${connection.baseUrl}${path}`, {
          ...init,
          headers
        });
      } catch (error) {
        const retryDelay = SAVE_RETRY_DELAYS_MS[attempt];
        if (!retryWhenUnavailable || !isConnectionRefused(error) || retryDelay === void 0) throw error;
        await delay$1(retryDelay);
      }
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message = typeof body?.message === "string" ? body.message : `文档请求失败（${response.status}）`;
      throw new Error(typeof body?.error === "string" ? `${body.error}: ${message}` : message);
    }
    if (response.status === 204) return void 0;
    return response.json();
  }
}
class KnowledgeGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  listRooms(origin2) {
    const query = origin2 ? `?${new URLSearchParams({ origin: origin2 })}` : "";
    return this.request(`/v1/knowledge/rooms${query}`);
  }
  upsertRoom(input) {
    return this.request("/v1/knowledge/rooms", { method: "POST", body: JSON.stringify(input) });
  }
  deleteRoom(roomId) {
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
  }
  getRoomContext(roomId) {
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/context`);
  }
  listWikiPages(roomId) {
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/wiki/pages`);
  }
  readWikiPage(roomId, ref2) {
    const encoded = ref2.split("/").map(encodeURIComponent).join("/");
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/wiki/pages/${encoded}`);
  }
  /** 全部 Room 的 wiki 映射（Wiki 应用清单）。 */
  listWikis() {
    return this.request("/v1/knowledge/wikis");
  }
  /** Room wiki 内链图谱（页面=节点、md 内链=边；无 wiki/失败为空图）。 */
  getWikiGraph(roomId) {
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/wiki/graph`);
  }
  /** 候选实体列表（按状态筛；ready = 首页推荐池）。 */
  listEntities(status) {
    return this.request(`/v1/knowledge/entities?${new URLSearchParams({ status })}`);
  }
  getEntity(entityId) {
    return this.request(`/v1/knowledge/entities/${encodeURIComponent(entityId)}`);
  }
  /** 手动转正：跳过阈值走晋升全流程（202 异步入队）。 */
  promoteEntity(entityId) {
    return this.request(`/v1/knowledge/entities/${encodeURIComponent(entityId)}/promote`, { method: "POST" });
  }
  suppressEntity(entityId) {
    return this.request(`/v1/knowledge/entities/${encodeURIComponent(entityId)}/suppress`, { method: "POST" });
  }
  restoreSuppressedEntity(entityId) {
    return this.request(`/v1/knowledge/entities/${encodeURIComponent(entityId)}/restore`, { method: "POST" });
  }
  /** 手动合并：from（路径）并入 targetId。 */
  mergeEntity(fromId, targetId) {
    return this.request(`/v1/knowledge/entities/${encodeURIComponent(fromId)}/merge`, {
      method: "POST",
      body: JSON.stringify({ targetId })
    });
  }
  /** 未识别资料手动挂实体（role=manual，+1.5 证据分）。 */
  attachDoc(sourceKind, sourceId, input) {
    return this.request(
      `/v1/knowledge/docs/${encodeURIComponent(sourceKind)}/${encodeURIComponent(sourceId)}/attach`,
      { method: "POST", body: JSON.stringify(input) }
    );
  }
  listUnmatched() {
    return this.request("/v1/knowledge/docs/unmatched");
  }
  listRecentDecisions(limit = 20) {
    return this.request(`/v1/knowledge/decisions?${new URLSearchParams({ limit: String(limit) })}`);
  }
  revertDecision(decisionId) {
    return this.request(`/v1/knowledge/route/${encodeURIComponent(decisionId)}/revert`, { method: "POST" });
  }
  uploadFile(input) {
    return this.request("/v1/knowledge/files", { method: "POST", body: JSON.stringify(input) });
  }
  /** Room 的上传文件清单（uploaded_files ⨝ 最新归属决策）。 */
  listRoomFiles(roomId) {
    return this.request(`/v1/knowledge/rooms/${encodeURIComponent(roomId)}/files`);
  }
  /** 文件当前解析产物的 markdown（渲染器预览用）。 */
  readFileMarkdown(fileId) {
    return this.request(`/v1/knowledge/files/${encodeURIComponent(fileId)}/markdown`);
  }
  /**
   * 在系统文件管理器中定位文件本体（对象库 files/sha256/…）。
   */
  async revealFile(fileId) {
    const { storagePath } = await this.request(
      `/v1/knowledge/files/${encodeURIComponent(fileId)}/storage`
    );
    shell.showItemInFolder(storagePath);
  }
  /**
   * 系统文件选择框 → 读文件 → 上传路由（用户主路径的入口）。
   * 首期仅接受 .md / .markdown；每份文件独立上传，失败互不影响。
   */
  async pickAndUploadFiles() {
    const picked = await dialog.showOpenDialog({
      title: desktopText("dialog.knowledgeMarkdown.title"),
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }]
    });
    if (picked.canceled || picked.filePaths.length === 0) return [];
    const results = [];
    for (const filePath of picked.filePaths) {
      const filename = filePath.split(/[\\/]/).pop() ?? filePath;
      try {
        const contentBase64 = (await readFile(filePath)).toString("base64");
        const uploaded = await this.uploadFile({ filename, contentBase64 });
        results.push({
          filename,
          title: uploaded.title,
          sourceId: uploaded.sourceId,
          deduped: uploaded.deduped
        });
      } catch (error) {
        results.push({ filename, title: filename, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }
  async request(path, init) {
    const connection = this.supervisor.getConnection();
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        // 无 body 不带 Content-Type：Fastify 5 对「JSON 头 + 空 body」的
        // POST 直接 400（FST_ERR_CTP_EMPTY_JSON_BODY），promote/revert 均无 body
        ...init?.body ? { "Content-Type": "application/json" } : {},
        ...init?.headers
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message = typeof body?.message === "string" && body.message ? body.message : typeof body?.error === "string" ? body.error : `知识服务请求失败（${response.status}）`;
      throw new Error(message);
    }
    if (response.status === 204) return void 0;
    return response.json();
  }
}
class McpGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  list() {
    return this.request("/v1/agent/mcp/servers");
  }
  save(servers) {
    return this.request("/v1/agent/mcp/servers", {
      method: "PUT",
      body: JSON.stringify({ servers })
    });
  }
  async request(path, init) {
    const connection = this.supervisor.getConnection();
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...init?.body ? { "Content-Type": "application/json" } : {},
        ...init?.headers
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message = typeof body?.message === "string" && body.message ? body.message : typeof body?.error === "string" ? body.error : `MCP 配置请求失败（${response.status}）`;
      throw new Error(message);
    }
    return response.json();
  }
}
const DEFAULT_IMPORT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".csv",
  ".doc",
  ".docx",
  ".docm",
  ".dot",
  ".dotx",
  ".dotm",
  ".html",
  ".htm",
  ".md",
  ".markdown",
  ".mdx",
  ".odt",
  ".ods",
  ".odp",
  ".pdf",
  ".pot",
  ".potx",
  ".potm",
  ".pps",
  ".ppsx",
  ".ppsm",
  ".ppt",
  ".pptx",
  ".pptm",
  ".rtf",
  ".sldx",
  ".sldm",
  ".text",
  ".txt",
  ".xls",
  ".xla",
  ".xlam",
  ".xlsb",
  ".xlsx",
  ".xlsm",
  ".xlt",
  ".xltx",
  ".xltm"
]);
function isSupportedImportFile(filePath, extensions) {
  return extensions.has(extname(filePath).toLowerCase());
}
async function collectDirectoryFiles(directory, extensions) {
  const rootPath = resolve(directory);
  const candidates = [];
  const visit = async (currentDirectory, isRoot = false) => {
    let entries;
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      if (isRoot) throw error;
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const filePath = resolve(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (isIgnoredLocalDirectory(entry.name)) continue;
        await visit(filePath);
      } else if (entry.isFile()) {
        if (isSupportedImportFile(filePath, extensions)) {
          candidates.push({ filePath, filename: relative(rootPath, filePath).split(sep).join("/") });
        }
      }
    }
  };
  await visit(rootPath, true);
  candidates.sort((left, right) => left.filename.localeCompare(right.filename));
  return { candidates };
}
async function collectImportPlan(selectedPaths, extensions = DEFAULT_IMPORT_EXTENSIONS) {
  const candidates = [];
  const seen = /* @__PURE__ */ new Set();
  for (const selectedPath of selectedPaths) {
    const resolvedPath = resolve(selectedPath);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    let selectedStat;
    try {
      selectedStat = await stat(resolvedPath);
    } catch {
      continue;
    }
    if (selectedStat.isDirectory()) {
      const plan = await collectDirectoryFiles(resolvedPath, extensions);
      candidates.push(...plan.candidates);
    } else if (selectedStat.isFile() && isSupportedImportFile(resolvedPath, extensions)) candidates.push({ filePath: resolvedPath, filename: basename(resolvedPath) });
  }
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [resolve(candidate.filePath), candidate])).values()];
  return {
    candidates: uniqueCandidates,
    highRiskFileCount: uniqueCandidates.filter((candidate) => !isLowRiskFileExtension(extname(candidate.filePath))).length
  };
}
class FilesGatewayBridge {
  constructor(supervisor, highRiskImports = null) {
    this.supervisor = supervisor;
    this.highRiskImports = highRiskImports;
    this.highRiskImports?.setManualResolver((batch, accepted) => this.resolveManualBatch(batch, accepted));
  }
  importProgressListeners = /* @__PURE__ */ new Set();
  onImportProgress(listener) {
    this.importProgressListeners.add(listener);
    return () => this.importProgressListeners.delete(listener);
  }
  list(limit = 100, offset = 0) {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return this.request(`/v1/files/catalog?${query}`);
  }
  catalog(limit = 100, offset = 0) {
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return this.request(`/v1/files/catalog?${query}`);
  }
  capabilities() {
    return this.request("/v1/files/capabilities");
  }
  get(fileId) {
    return this.request(`/v1/files/${encodeURIComponent(fileId)}`);
  }
  /** 文件当前解析产物的 markdown（渲染器预览用；未进过链路 404）。 */
  readMarkdown(fileId) {
    return this.request(`/v1/files/${encodeURIComponent(fileId)}/markdown`);
  }
  async readDataUrl(fileId) {
    const connection = this.supervisor.getConnection();
    const response = await fetch(`${connection.baseUrl}/v1/files/${encodeURIComponent(fileId)}/content`, {
      headers: { Authorization: `Bearer ${connection.token}` }
    });
    if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    const bytes = Buffer.from(await response.arrayBuffer());
    return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
  }
  rename(fileId, displayName) {
    return this.request(`/v1/file-entries/${encodeURIComponent(fileId)}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName })
    });
  }
  pinClusterTitle(clusterId, sharedTitle) {
    return this.request(`/v1/file-clusters/${encodeURIComponent(clusterId)}`, {
      method: "PATCH",
      body: JSON.stringify({ sharedTitle })
    });
  }
  delete(fileId) {
    return this.request(`/v1/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
  }
  /** 在系统文件管理器中定位文件本体（对象库 files/sha256/…）。 */
  async reveal(fileId) {
    const { storagePath } = await this.request(
      `/v1/files/${encodeURIComponent(fileId)}/storage`
    );
    shell.showItemInFolder(storagePath);
  }
  /** 使用操作系统为该文件类型配置的默认查看器打开文件本体。 */
  async openOriginal(fileId) {
    const { storagePath } = await this.request(
      `/v1/files/${encodeURIComponent(fileId)}/storage`
    );
    const error = await shell.openPath(storagePath);
    if (error) throw new Error(error);
  }
  /**
   * 统一导入（用户主路径）：系统选择框 → 逐文件 multipart 上传（唯一字节
   * 入口）→ ref 形态进引擎。失败互不影响，逐行回报。
   * roomId（Room 内上传）→ /v1/ingest 的显式归属：入口直达该 Room。
   */
  async pickAndImport(options) {
    const picked = await dialog.showOpenDialog({
      title: desktopText("dialog.importFiles.title"),
      // Allow the same import action to select individual files or directories.
      // Directories are expanded by importPathsOnce, so they retain the same
      // allowlist, ignored-directory rules, and high-risk review behavior.
      properties: ["openFile", "openDirectory", "multiSelections"],
      filters: [
        {
          name: desktopText("dialog.importFiles.documents"),
          extensions: [...DEFAULT_IMPORT_EXTENSIONS].map((extension) => extension.slice(1))
        }
      ]
    });
    if (picked.canceled || picked.filePaths.length === 0) return [];
    return this.importPathsOnce(picked.filePaths, options);
  }
  /**
   * 一次性手动采集：展开本次明确选择的文件/目录并导入。不会注册本地
   * 数据源或 watcher，后续文件变化也不会触发自动重扫。
   */
  async importPathsOnce(selectedPaths, options) {
    if (!Array.isArray(selectedPaths) || selectedPaths.length === 0) return [];
    const manualExtensions = new Set((await this.capabilities()).items.filter((item) => item.manualImport).map((item) => item.extension));
    const importPlan = await collectImportPlan(
      selectedPaths.filter((filePath) => typeof filePath === "string" && filePath.length > 0),
      manualExtensions
    );
    let candidates = importPlan.candidates;
    if (importPlan.highRiskFileCount > HIGH_RISK_FILE_BATCH_THRESHOLD && this.highRiskImports) {
      const lowRiskCandidates = candidates.filter((candidate) => isLowRiskFileExtension(extname(candidate.filePath)));
      const highRiskCandidates = candidates.filter((candidate) => !isLowRiskFileExtension(extname(candidate.filePath)));
      await this.highRiskImports.enqueueManual({
        files: highRiskCandidates,
        ...options?.pipelines ? { pipelines: options.pipelines } : {},
        ...options?.roomId ? { roomId: options.roomId } : {}
      }, basename(resolve(selectedPaths[0])));
      candidates = lowRiskCandidates;
    }
    return this.importCandidates(candidates, options);
  }
  async resolveManualBatch(batch, accepted) {
    if (!accepted) return { accepted: false, imported: 0, failed: 0 };
    const outcomes = await this.importCandidates(batch.files, {
      ...batch.pipelines ? { pipelines: batch.pipelines } : {},
      ...batch.roomId ? { roomId: batch.roomId } : {}
    });
    return {
      accepted: true,
      imported: outcomes.filter((outcome) => outcome.fileId !== null).length,
      failed: outcomes.filter((outcome) => outcome.error !== null).length
    };
  }
  async importCandidates(candidates, options) {
    const outcomes = [];
    const batchId = randomUUID();
    let succeeded = 0;
    let failed = 0;
    this.emitImportProgress({ batchId, status: "started", total: candidates.length, completed: 0, filename: null, succeeded, failed });
    for (const { filePath, filename } of candidates) {
      this.emitImportProgress({ batchId, status: "file-started", total: candidates.length, completed: outcomes.length, filename, succeeded, failed });
      try {
        const uploaded = await this.importPath({
          filePath,
          sourceKind: "manual-upload",
          sourceKey: `manual:${randomUUID()}`,
          originalName: basename(filePath),
          relativePath: filename,
          ...options?.pipelines ? { pipelines: options.pipelines } : {},
          ...options?.roomId ? { roomId: options.roomId } : {}
        });
        outcomes.push({
          filename,
          fileId: uploaded.fileEntryId,
          eventId: null,
          dataType: null,
          deduped: uploaded.versionDeduped,
          pipelines: options?.pipelines ?? null,
          memoryResult: null,
          routeJobId: uploaded.jobId,
          error: null
        });
        succeeded += 1;
      } catch (error) {
        outcomes.push({
          filename,
          fileId: null,
          eventId: null,
          dataType: null,
          deduped: false,
          pipelines: null,
          memoryResult: null,
          routeJobId: null,
          error: error instanceof Error ? error.message : String(error)
        });
        failed += 1;
      }
      this.emitImportProgress({ batchId, status: "file-completed", total: candidates.length, completed: outcomes.length, filename, succeeded, failed });
    }
    this.emitImportProgress({ batchId, status: "completed", total: candidates.length, completed: outcomes.length, filename: null, succeeded, failed });
    return outcomes;
  }
  emitImportProgress(event) {
    for (const listener of this.importProgressListeners) listener(event);
  }
  async importLocalFile(input) {
    return this.importPath({ ...input, sourceKind: "local-folder" });
  }
  async importConnectorFile(input) {
    return this.importPath({ ...input, sourceKind: "connector" });
  }
  async importPath(input) {
    const before = await stat(input.filePath);
    const buffer = await readFile(input.filePath);
    const after = await stat(input.filePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("文件在导入过程中发生变化，请稍后重试。");
    }
    const form = new FormData();
    form.append("metadata", JSON.stringify({
      sourceKind: input.sourceKind,
      sourceKey: input.sourceKey,
      originalName: input.originalName,
      ...input.localSourceId ? { localSourceId: input.localSourceId } : {},
      ...input.localItemId ? { localItemId: input.localItemId } : {},
      ...input.provider ? { provider: input.provider } : {},
      ...input.connectionId ? { connectionId: input.connectionId } : {},
      ...input.sourceUri ? { sourceUri: input.sourceUri } : {},
      ...input.relativePath ? { relativePath: input.relativePath } : {},
      sourceModifiedAt: input.sourceModifiedAt ?? after.mtime.toISOString(),
      ...input.pipelines ? { pipelines: input.pipelines } : {},
      ...input.roomId ? { roomId: input.roomId } : {}
    }));
    form.append("file", new Blob([new Uint8Array(buffer)]), input.originalName);
    const connection = this.supervisor.getConnection();
    const response = await fetch(`${connection.baseUrl}/v1/file-imports`, {
      method: "POST",
      headers: { Authorization: `Bearer ${connection.token}` },
      body: form
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(typeof body?.error === "string" ? body.error : `文件上传失败（${response.status}）`);
    }
    return response.json();
  }
  async request(path, init) {
    const connection = this.supervisor.getConnection();
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...init?.body ? { "Content-Type": "application/json" } : {},
        ...init?.headers
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message = typeof body?.message === "string" && body.message ? body.message : typeof body?.error === "string" ? body.error : `文件服务请求失败（${response.status}）`;
      throw new Error(message);
    }
    if (response.status === 204) return void 0;
    return response.json();
  }
}
class IngestGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  listEvents(query) {
    const params = new URLSearchParams();
    if (query.limit !== void 0) params.set("limit", String(query.limit));
    if (query.offset !== void 0) params.set("offset", String(query.offset));
    if (query.sourceKind) params.set("sourceKind", query.sourceKind);
    if (query.sourceId) params.set("sourceId", query.sourceId);
    const suffix = params.size > 0 ? `?${params}` : "";
    return this.request(`/v1/ingest${suffix}`);
  }
  /** 过滤规则文档（用户偏好段 + 系统洞察段）。 */
  getFilterRules() {
    return this.request("/v1/ingest/filter/rules");
  }
  /** 只重写用户偏好段（系统洞察段由洞察 job 维护，用户只读）。 */
  updateFilterPreference(content) {
    return this.request("/v1/ingest/filter/rules/preference", {
      method: "PUT",
      body: JSON.stringify({ content })
    });
  }
  /** 误杀恢复：filtered 事件重新放行三链路扇出（同时落 reinstated_at 精确标记）。 */
  reinstateEvent(eventId) {
    return this.request(`/v1/ingest/${encodeURIComponent(eventId)}/reinstate`, { method: "POST" });
  }
  /** 事件归一化产物全文（台账详情查看——被过滤条目"到底拦了什么"）。 */
  getEventContent(eventId) {
    return this.request(`/v1/ingest/${encodeURIComponent(eventId)}/content`);
  }
  async request(path, init) {
    const connection = this.supervisor.getConnection();
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...init?.body ? { "Content-Type": "application/json" } : {},
        ...init?.headers
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message = typeof body?.message === "string" && body.message ? body.message : typeof body?.error === "string" ? body.error : `理解引擎请求失败（${response.status}）`;
      throw new Error(message);
    }
    if (response.status === 204) return void 0;
    return response.json();
  }
}
class ContextRoomGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  list() {
    return this.request("/v1/context-rooms");
  }
  create(input) {
    return this.request("/v1/context-rooms", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }
  syncSnapshot(input) {
    return this.request("/v1/context-rooms/snapshot", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  }
  async request(path, init) {
    const connection = this.supervisor.getConnection();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${connection.token}`);
    if (init?.body !== void 0 && init.body !== null) headers.set("Content-Type", "application/json");
    const response = await fetch(`${connection.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : `Room 请求失败（${response.status}）`;
      throw new Error(message);
    }
    return response.json();
  }
}
class CliConnectorSyncGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  status() {
    return this.request("/v1/cli-connectors/sync/status");
  }
  accounts() {
    return this.request("/v1/cli-connectors/accounts");
  }
  promptProfiles() {
    return this.request("/v1/cli-connectors/prompt-profiles");
  }
  jobs() {
    return this.request("/v1/cli-connectors/sync/jobs");
  }
  createJob(input) {
    return this.request("/v1/cli-connectors/sync/jobs", { method: "POST", body: JSON.stringify(input) });
  }
  updateJob(id, input) {
    return this.request(`/v1/cli-connectors/sync/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
  }
  runJob(id) {
    return this.request(`/v1/cli-connectors/sync/jobs/${encodeURIComponent(id)}/run`, { method: "POST" });
  }
  setJobPaused(id, paused, configVersion) {
    return this.request(`/v1/cli-connectors/sync/jobs/${encodeURIComponent(id)}/${paused ? "pause" : "resume"}`, {
      method: "POST",
      body: JSON.stringify({ configVersion })
    });
  }
  archiveJob(id, configVersion) {
    return this.request(`/v1/cli-connectors/sync/jobs/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({ configVersion })
    });
  }
  runs(jobId) {
    return this.request(`/v1/cli-connectors/sync/jobs/${encodeURIComponent(jobId)}/runs`);
  }
  quarantine(runId) {
    return this.request(`/v1/cli-connectors/sync/runs/${encodeURIComponent(runId)}/quarantine`);
  }
  data(query) {
    const params = new URLSearchParams();
    if (query.service) params.set("service", query.service);
    if (query.dataset) params.set("dataset", query.dataset);
    if (query.query) params.set("query", query.query);
    if (query.limit !== void 0) params.set("limit", String(query.limit));
    if (query.offset !== void 0) params.set("offset", String(query.offset));
    if (query.includeExpired !== void 0) params.set("includeExpired", String(query.includeExpired));
    return this.request(`/v1/cli-connectors/data?${params}`);
  }
  record(id) {
    return this.request(`/v1/cli-connectors/data/${encodeURIComponent(id)}`);
  }
  ingestRecords(recordIds) {
    return this.request("/v1/cli-connectors/data/ingest", {
      method: "POST",
      body: JSON.stringify({ recordIds })
    });
  }
  async request(path, init) {
    const connection = this.supervisor.getConnection();
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...init?.body !== void 0 && init.body !== null ? { "Content-Type": "application/json" } : {},
        ...init?.headers
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message = typeof body?.message === "string" ? body.message : `连接器请求失败（${response.status}）`;
      throw new Error(message);
    }
    return response.json();
  }
}
const REALITY_PROTOCOL_VERSION = 1;
function isRealitySocketFrame(value) {
  if (!value || typeof value !== "object") return false;
  const frame = value;
  if (frame.protocol !== REALITY_PROTOCOL_VERSION) return false;
  if (frame.type === "ready") return true;
  if (frame.type !== "event.updated" || !frame.change || typeof frame.change !== "object") return false;
  const change = frame.change;
  return Boolean(
    change.event && typeof change.event === "object" && typeof change.event.id === "string" && Number.isInteger(change.version)
  );
}
const REALITY_EVENT_CHANNEL = "reality:event";
const http$3 = createLoggedHttpClient("gateway-reality", { timeout: 1e4 }, { quiet: true });
const RECOVERABLE_CONNECTION_ERROR_CODES$1 = /* @__PURE__ */ new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ERR_SOCKET_CLOSED",
  // gateway 在 knowledge ingest 高峰期事件循环被同步任务卡住时，表现为 loopback 连接超时
  "ETIMEDOUT"
]);
function isRecoverableConnectionError$1(error) {
  if (!isAxiosError(error)) return false;
  if (error.code && RECOVERABLE_CONNECTION_ERROR_CODES$1.has(error.code)) return true;
  return typeof error.message === "string" && /socket hang up/i.test(error.message);
}
class RealityGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  subscriptions = /* @__PURE__ */ new Map();
  contentsLifecycle = new WebContentsLifecycle();
  listEvents(filters = {}) {
    return this.request("/v1/reality/events", { params: filters });
  }
  getEvent(id) {
    return this.request(`/v1/reality/events/${this.id(id)}`);
  }
  createEvent(input) {
    return this.request("/v1/reality/events", { method: "POST", data: input });
  }
  finishCapture(id, input) {
    return this.request(`/v1/reality/events/${this.id(id)}/capture-finished`, {
      method: "POST",
      data: input
    });
  }
  importEvent(input) {
    return this.request(`/v1/reality/events/${this.id(input.id)}/import`, {
      method: "PUT",
      data: input
    });
  }
  applyAsr(id, job) {
    return this.request(`/v1/reality/events/${this.id(id)}/asr`, {
      method: "POST",
      data: this.asrInput(job)
    });
  }
  applyAsrByJob(job) {
    return this.request(`/v1/reality/asr-jobs/${encodeURIComponent(job.id)}`, {
      method: "POST",
      data: this.asrInput(job)
    });
  }
  updateTranscript(id, input) {
    return this.request(`/v1/reality/events/${this.id(id)}/transcript`, {
      method: "PATCH",
      data: input
    });
  }
  addMarker(id, input) {
    return this.request(`/v1/reality/events/${this.id(id)}/markers`, {
      method: "POST",
      data: input
    });
  }
  setImportant(id, important) {
    return this.request(`/v1/reality/events/${this.id(id)}/important`, {
      method: "PATCH",
      data: { important }
    });
  }
  confirm(id) {
    return this.request(`/v1/reality/events/${this.id(id)}/confirm`, { method: "POST", data: {} });
  }
  async discard(id) {
    await this.request(`/v1/reality/events/${this.id(id)}`, { method: "DELETE" });
  }
  fail(id, error) {
    return this.request(`/v1/reality/events/${this.id(id)}/fail`, {
      method: "POST",
      data: { error }
    });
  }
  async readAudio(id) {
    const response = await this.rawRequest(`/v1/reality/events/${this.id(id)}/audio`, {
      responseType: "arraybuffer"
    });
    return new Uint8Array(response);
  }
  subscribe(contents) {
    this.unsubscribe(contents.id);
    const subscription = {
      socket: this.openSocket(contents),
      closed: false,
      reconnectTimer: null
    };
    this.subscriptions.set(contents.id, subscription);
    this.contentsLifecycle.observe(contents, () => this.unsubscribe(contents.id));
  }
  unsubscribe(contentsId) {
    const subscription = this.subscriptions.get(contentsId);
    if (!subscription) return;
    subscription.closed = true;
    if (subscription.reconnectTimer) clearTimeout(subscription.reconnectTimer);
    subscription.socket.close();
    this.subscriptions.delete(contentsId);
  }
  dispose() {
    for (const id of [...this.subscriptions.keys()]) this.unsubscribe(id);
  }
  openSocket(contents) {
    const connection = this.supervisor.getConnection();
    const url = new URL(connection.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/reality/stream";
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } });
    socket.on("message", (data) => {
      if (contents.isDestroyed()) return;
      try {
        const frame = JSON.parse(data.toString());
        if (isRealitySocketFrame(frame)) contents.send(REALITY_EVENT_CHANNEL, frame);
      } catch {
      }
    });
    socket.on("close", () => {
      const subscription = this.subscriptions.get(contents.id);
      if (!subscription || subscription.closed || contents.isDestroyed()) return;
      subscription.reconnectTimer = setTimeout(() => {
        const current = this.subscriptions.get(contents.id);
        if (!current || current.closed || contents.isDestroyed()) return;
        current.socket = this.openSocket(contents);
      }, 1e3);
    });
    socket.on("error", () => void 0);
    return socket;
  }
  asrInput(job) {
    return {
      jobId: job.id,
      source: job.source,
      status: job.status,
      result: job.result,
      error: job.error,
      resultVersion: Math.max(1, Date.parse(job.updatedAt))
    };
  }
  async request(path, config = {}) {
    return this.rawRequest(path, config);
  }
  async rawRequest(path, config = {}) {
    const connection = this.supervisor.getConnection();
    try {
      return await this.rawRequestWithConnection(connection, path, config);
    } catch (error) {
      if (!isRecoverableConnectionError$1(error)) throw error;
      const recoveredConnection = await this.supervisor.recoverConnection(connection);
      return this.rawRequestWithConnection(recoveredConnection, path, config);
    }
  }
  async rawRequestWithConnection(connection, path, config) {
    const response = await http$3.request({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...config.headers
      },
      validateStatus: () => true
    });
    if (response.status >= 400) {
      throw new Error(
        typeof response.data?.message === "string" ? response.data.message : `现实感知请求失败（${response.status}）`
      );
    }
    return response.data;
  }
  id(value) {
    if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error("无效的现实感知事件标识。");
    return encodeURIComponent(value);
  }
}
class PerceptionGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  getSettings() {
    return this.request("/v1/perception/settings");
  }
  async updateCapture(input) {
    const current = await this.getSettings();
    return this.request("/v1/perception/settings", {
      method: "PATCH",
      body: JSON.stringify({
        configVersion: current.configVersion,
        ...input.enabled === void 0 ? {} : { captureEnabled: input.enabled },
        ...input.intervalMs === void 0 ? {} : { captureIntervalSeconds: Math.round(input.intervalMs / 1e3) }
      })
    });
  }
  async updateOnlineVlm(enabled, configVersion) {
    try {
      return await this.request("/v1/perception/settings", {
        method: "PATCH",
        body: JSON.stringify({ onlineVlmEnabled: enabled, configVersion })
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("perception_settings_conflict")) throw error;
      const current = await this.getSettings();
      return this.request("/v1/perception/settings", {
        method: "PATCH",
        body: JSON.stringify({ onlineVlmEnabled: enabled, configVersion: current.configVersion })
      });
    }
  }
  listNodes(query = {}) {
    const params = new URLSearchParams();
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    if (query.kind) params.set("kind", query.kind);
    if (query.status) params.set("status", query.status);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`/v1/perception/nodes${suffix}`);
  }
  getNode(id) {
    return this.request(`/v1/perception/nodes/${encodeURIComponent(id)}`);
  }
  retryNode(id) {
    return this.request(`/v1/perception/nodes/${encodeURIComponent(id)}/retry`, { method: "POST" });
  }
  deleteNode(id, deleteAssets = false) {
    return this.request(`/v1/perception/nodes/${encodeURIComponent(id)}?deleteAssets=${String(deleteAssets)}`, {
      method: "DELETE"
    });
  }
  async request(path, init) {
    const connection = await this.supervisor.ensureConnection();
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...init?.body ? { "Content-Type": "application/json" } : {}
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const code = typeof body?.error === "string" ? body.error : "";
      throw new Error(code === "vlm_not_configured" ? "请先配置在线视觉模型后再开启视觉理解。" : typeof body?.message === "string" ? body.message : code || `感知设置请求失败（${String(response.status)}）`);
    }
    return response.json();
  }
}
const RECOVERABLE_CONNECTION_ERROR_CODES = /* @__PURE__ */ new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ERR_SOCKET_CLOSED"
]);
function isRecoverableConnectionError(error) {
  if (!(error instanceof Error)) return false;
  const cause = error.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = cause.code;
    if (typeof code === "string" && RECOVERABLE_CONNECTION_ERROR_CODES.has(code)) return true;
  }
  return error instanceof TypeError && /fetch failed|network|socket/i.test(error.message);
}
class DiaryGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  settings() {
    return this.request("/v1/diary/settings");
  }
  updateSettings(input) {
    return this.request("/v1/diary/settings", { method: "PATCH", body: JSON.stringify(input) });
  }
  generate(date) {
    return this.request(`/v1/diary/days/${encodeURIComponent(date)}/generate`, { method: "POST" });
  }
  run(id) {
    return this.request(`/v1/diary/runs/${encodeURIComponent(id)}`);
  }
  activeRun() {
    return this.request("/v1/diary/runs/active");
  }
  days(start, end) {
    return this.request(`/v1/diary/days?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  }
  day(date) {
    return this.requestMaybe(`/v1/diary/days/${encodeURIComponent(date)}`, void 0, true);
  }
  async request(path, init) {
    return this.requestMaybe(path, init, false);
  }
  async requestMaybe(path, init, allowNotFound) {
    const connection = await this.supervisor.ensureConnection();
    try {
      return await this.requestWithConnection(connection, path, init, allowNotFound);
    } catch (error) {
      if (!isRecoverableConnectionError(error)) throw error;
      const recoveredConnection = await this.supervisor.recoverConnection(connection);
      return this.requestWithConnection(recoveredConnection, path, init, allowNotFound);
    }
  }
  async requestWithConnection(connection, path, init, allowNotFound) {
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...init?.body ? { "Content-Type": "application/json" } : {}
      }
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : `日记请求失败（${String(response.status)}）`);
    }
    return response.json();
  }
}
const http$2 = createLoggedHttpClient("gateway-agent-scheduler", void 0, { quiet: true });
class AgentSchedulerGatewayBridge {
  constructor(supervisor) {
    this.supervisor = supervisor;
  }
  list() {
    return this.request("/v1/agent/schedules");
  }
  create(input) {
    return this.request("/v1/agent/schedules", { method: "POST", data: input });
  }
  update(id, input) {
    return this.request(`/v1/agent/schedules/${encodeURIComponent(id)}`, { method: "PATCH", data: input });
  }
  runNow(id) {
    return this.request(`/v1/agent/schedules/${encodeURIComponent(id)}/run`, { method: "POST", data: {} });
  }
  remove(id) {
    return this.request(`/v1/agent/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  async request(path, config = {}) {
    const connection = await this.supervisor.ensureConnection();
    const hasBody = config.data !== void 0 && config.data !== null;
    const data = hasBody && typeof config.data === "object" && !(config.data instanceof FormData) ? JSON.stringify(config.data) : config.data;
    const response = await http$2.request({
      url: `${connection.baseUrl}${path}`,
      ...config,
      ...hasBody ? { data } : {},
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...hasBody ? { "Content-Type": "application/json" } : {},
        ...config.headers
      },
      validateStatus: () => true
    });
    if (response.status >= 400) {
      throw new Error(
        typeof response.data?.message === "string" ? response.data.message : typeof response.data?.error === "string" ? response.data.error : typeof response.data === "string" ? response.data : `Agent 定时任务请求失败（${response.status}）`
      );
    }
    if (response.status === 204) return void 0;
    return response.data;
  }
}
const http$1 = createLoggedHttpClient("gateway-connectors");
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const FAULT_POINTS = /* @__PURE__ */ new Set(["before_page_commit", "after_page_commit_before_cursor_cas", "rate_limited", "cursor_expired"]);
class NangoConnectorGatewayBridge {
  constructor(supervisor, openExternal = async () => {
    throw new Error("无法打开授权页面。");
  }) {
    this.supervisor = supervisor;
    this.openExternal = openExternal;
  }
  async status() {
    const status = await this.request("/v1/nango-connectors/status");
    return { ...status, scopes: status.scopes.map((scope) => this.sanitizeScope(scope)) };
  }
  registerConnection(input) {
    if (!["gmail", "outlook", "google-docs", "notion", "google-calendar"].includes(input.provider)) throw new Error("不支持的连接提供方。");
    if (!input.nangoConfigKey.trim() || !input.nangoConnectionId.trim()) throw new Error("连接配置不能为空。");
    return this.request("/v1/nango-connectors/connections", { method: "POST", data: { ...input, nangoConfigKey: input.nangoConfigKey.trim(), nangoConnectionId: input.nangoConnectionId.trim() } });
  }
  async startAuthorization(provider) {
    if (!["gmail", "outlook", "google-docs", "notion", "google-calendar"].includes(provider)) throw new Error("不支持的连接提供方。");
    const result = await this.request(
      "/v1/nango-connectors/authorizations",
      { method: "POST", data: { provider } }
    );
    const authorizationUrl = new URL(result.authorizationUrl);
    if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") {
      throw new Error("Nango 返回了不安全的授权地址。");
    }
    await this.openExternal(authorizationUrl.toString());
    return {
      id: result.id,
      provider: result.provider,
      status: result.status,
      expiresAt: result.expiresAt,
      connection: result.connection,
      error: result.error
    };
  }
  authorizationStatus(id) {
    return this.request(`/v1/nango-connectors/authorizations/${this.id(id)}`);
  }
  async disableConnection(id) {
    await this.request(`/v1/nango-connectors/connections/${this.id(id)}/disable`, { method: "POST", data: {} });
  }
  async enableConnection(id) {
    await this.request(`/v1/nango-connectors/connections/${this.id(id)}/enable`, { method: "POST", data: {} });
  }
  async purgeConnection(id) {
    await this.request(`/v1/nango-connectors/connections/${this.id(id)}`, { method: "DELETE" });
  }
  triggerSync(id, mode) {
    if (!["full", "incremental", "rebuild"].includes(mode)) throw new Error("无效的同步模式。");
    return this.request(`/v1/nango-connectors/scopes/${this.id(id)}/sync`, { method: "POST", data: { mode } });
  }
  cancelRun(id) {
    return this.request(`/v1/nango-connectors/runs/${this.id(id)}/cancel`, { method: "POST", data: {} });
  }
  async scopes(connectionId) {
    const scopes = await this.request("/v1/nango-connectors/scopes", { params: connectionId ? { connectionId: this.id(connectionId) } : void 0 });
    return scopes.map((scope) => this.sanitizeScope(scope));
  }
  runs(connectionId) {
    return this.request("/v1/nango-connectors/runs", { params: connectionId ? { connectionId: this.id(connectionId) } : void 0 });
  }
  async mail(query = {}) {
    const all3 = query.connectionId ? [this.id(query.connectionId)] : (await this.status()).connections.filter((item) => !query.provider || item.provider === query.provider).map((item) => this.id(item.id));
    const limit = Math.min(200, Math.max(1, query.limit ?? 100));
    const pages = await Promise.all(all3.map(
      (id) => this.request(`/v1/nango-connectors/connections/${id}/messages`, { params: { limit: 500, ...query.provider ? { provider: query.provider } : {}, ...query.offset ? { offset: query.offset } : {} } })
    ));
    const search = query.search?.trim().toLocaleLowerCase();
    const messages2 = pages.flatMap((page) => Array.isArray(page) ? page : page.items ?? []).filter((item) => !search || `${item.subject ?? ""} ${item.snippet ?? ""}`.toLocaleLowerCase().includes(search));
    return messages2.slice(0, limit);
  }
  failures(query = {}) {
    return this.request("/v1/nango-connectors/failures", { params: query });
  }
  documents(connectionId) {
    return this.request(`/v1/nango-connectors/connections/${this.id(connectionId)}/documents`);
  }
  document(connectionId, documentId) {
    return this.request(`/v1/nango-connectors/connections/${this.id(connectionId)}/documents/${this.id(documentId)}`);
  }
  async records(connectionId, type2, page = {}) {
    if (type2 !== "mail" && type2 !== "calendar") throw new Error("无效的数据记录类型。");
    const result = await this.request(`/v1/nango-connectors/connections/${this.id(connectionId)}/records`, { params: { type: type2, ...page } });
    return Array.isArray(result) ? result : result.items ?? [];
  }
  armFault(point) {
    if (!FAULT_POINTS.has(point)) throw new Error("无效的故障注入点。");
    return this.request("/v1/nango-connectors/debug/faults", { method: "POST", data: { point } });
  }
  async request(path, config = {}) {
    const connection = this.supervisor.getConnection();
    const response = await http$1.request({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: { Authorization: `Bearer ${connection.token}`, ...config.headers },
      validateStatus: () => true
    });
    if (response.status >= 400) {
      const message = typeof response.data?.message === "string" ? response.data.message : `连接器请求失败（${response.status}）`;
      throw new Error(message.slice(0, 500));
    }
    return response.data;
  }
  id(value) {
    if (!ID_PATTERN.test(value)) throw new Error("无效的连接器标识。");
    return encodeURIComponent(value);
  }
  sanitizeScope(scope) {
    return { ...scope, sourceCursor: null };
  }
}
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;
function extensionForMimeType(mimeType) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("mp4")) return ".m4a";
  if (normalized.includes("ogg")) return ".ogg";
  return ".webm";
}
function requireRecordingId(value) {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/i.test(value)) {
    throw new Error("无效的录音标识。");
  }
  return value;
}
class RecordingStore {
  constructor(directory) {
    this.directory = directory;
  }
  recordings = /* @__PURE__ */ new Map();
  async begin(mimeType) {
    if (typeof mimeType !== "string" || mimeType.length > 100) throw new Error("无效的录音格式。");
    await mkdir(this.directory, { recursive: true });
    const id = randomUUID();
    const fileName = `${id}${extensionForMimeType(mimeType)}`;
    const handle2 = await open(join(this.directory, fileName), "wx");
    this.recordings.set(id, { handle: handle2, fileName, size: 0, writes: Promise.resolve() });
    return { id };
  }
  async append(idValue, chunkValue) {
    const id = requireRecordingId(idValue);
    const recording = this.recordings.get(id);
    if (!recording) throw new Error("录音不存在或已经结束。");
    if (!(chunkValue instanceof Uint8Array)) throw new Error("无效的录音数据。");
    if (chunkValue.byteLength === 0) return;
    if (chunkValue.byteLength > MAX_CHUNK_BYTES) throw new Error("单个录音数据块过大。");
    if (recording.size + chunkValue.byteLength > MAX_RECORDING_BYTES) throw new Error("录音文件过大。");
    const chunk = Buffer.from(chunkValue.buffer, chunkValue.byteOffset, chunkValue.byteLength);
    recording.size += chunk.byteLength;
    recording.writes = recording.writes.then(async () => {
      await recording.handle.write(chunk);
    });
    await recording.writes;
  }
  async finish(idValue) {
    const id = requireRecordingId(idValue);
    const recording = this.recordings.get(id);
    if (!recording) throw new Error("录音不存在或已经结束。");
    this.recordings.delete(id);
    await recording.writes;
    await recording.handle.close();
    if (recording.size === 0) {
      await rm(join(this.directory, recording.fileName), { force: true });
      throw new Error("没有录到音频，请重试。");
    }
    return { filePath: recording.fileName };
  }
  async cancel(idValue) {
    const id = requireRecordingId(idValue);
    const recording = this.recordings.get(id);
    if (!recording) return;
    this.recordings.delete(id);
    await recording.writes.catch(() => void 0);
    await recording.handle.close().catch(() => void 0);
    await rm(join(this.directory, recording.fileName), { force: true });
  }
  async dispose() {
    await Promise.allSettled([...this.recordings.keys()].map((id) => this.cancel(id)));
  }
}
const everroomFullLogo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABAAAAAB1CAYAAADQvZPiAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAOdEVYdFNvZnR3YXJlAEZpZ21hnrGWYwAAKd9JREFUeAHt3d1uXMexL/CqHn7IjoNwAzFJIBcZPYEXeXYAibTh4ROYwk6uNXqADVFPIOoJRJ0cbJw7je8PIOkJRCKWYiA2NX4Cjy82QMkH8BhIIInD6dpda4YSJVEfJFf16jXr/wskyoZjmuTM6q6q7ir+z+4DIZgYQ6Gl/1pa7RIAAESzmF1oimv8SJAOod74Tz1h6YfNzk/OS29I0j2gc91+d7tPAAAANTNFMDlErv3X0ucI/gEAAJia4z81mfR/gWNqhA8NGtDC0kpIDFCXvex4Otj+ufsPrJ8AADDxkACYECz+xv9e+mKLAAAA4P2YQ2IgJAkcrzuaOUwIbIsf3EIyAAAAJpUjqDwRuhWC/00CAACA08kTAtx2bubR/NLqo0+zlTYBAABMGCQAKi5sVrr/Z2l1gwAAAKAQzJQ5x7cXllZ+RCIAAAAmCRIAlca9feFLBAAAAMVjbr5MBPwpIwAAgIpDAqCyuDcQXvu/Sxd7BAAAAHbyRMDMo4Xl1ZsEAABQYUgAVNRQ5BKCfwAAgKg29DSAjn0kAACACkICoIrycX+r6FAMAAAQG3NT2N3/NFvBlQAAAKgcJAAqRsf9/XXpc4z7AwAAKMuoN8CjxWz1MgEAAFQIEgAVgnF/AAAA6RBHHSQBAACgSpAAqAiM+wMAAEiPd7SF6wAAAFAVSABUAsb9AQAApIiJ5hzTHTQGBACAKkACIHkY9wcAAJC0vDFg4zYBAAAkDgmAxGHcHwAAQAUwtRayi7iqBwAASUMCIGUY9wcAAFAZ4tz1uaw1RwAAAIlCAiBRGPcHAABQLdoPYNYNrhMAAECikABIEMb9AQAAVNYGGgICAECqkABIDMb9AQAAVJt3rk0AAAAJQgIgKRj3BwAAUH18Fb0AAAAgRUgAJAPj/gAAACbBqBfA8zYBAAAkZoogCaNxfys9AgAAeCvpPd59eJ7ghcULo/v2jaGbG/hGk2SYhQC8FcLwL6lM4r4Kv6OZLwAAJAUJgBTk4/4+x7g/AACAE9r79tvekb/UtfSu/mExazXJ7beEWLvyNyk2ppZeA+h3t/sEAACQCFwBKBnG/QEAABRvr7vd29t92GE/vRZW21tUgpnG8xYBAAAkBAmAEmHcHwAAgC1NBDze/WaDiW9QZCLcIgAAgIQgAVASjPsDAACIZ2/3m83w4RpFxFxyHwIAAIDXIAFQCoz7AwAAiO3x7oMtEfqaImGhDOMAAQAgJUgARIdxfwAAAGX5WKb19F20xnzTtN8kAACARCABENlo3B+CfwAAgDL08q78Eu0UQNhpZQQAAJAIJABiysf9rWLcHwAAQInYu7sUiSPBFQAAAEgGEgCRYNwfAABAGs7RlCbjo1wDEOLPCAAAIBFTBOZ03N9fMe4PJsSoodWzufDwaOpfM7kmVRST9H34xTTsD+g3vX5+NBgAJp1eA1hYWu2FhwCO55/CXHahqR91HXDEcyHJkdwph8Pnu/75IPzI+91vewRmDvcG0zQMr4fGXKp7AyHf04/6mgipwD7WfagjJACM6bi/vy6tmI77+332ecs5f5kM7fuZa3V8SM5nX6yTG35Fhp7sPrxCCfo0+1PYGE9nen+Vif7IwrpRniMehEW+QZOBx19Jg2ZpQCEg0Nd417P8QJ66DfLbeyVvGj/NVtrsCKPEiH7S39hLX8LGTeigh6QNnEV4Hf0Qnm3mCYDwOc5TBWlAN0XPsgZx5h03X6wDPEr+HsWUIn6xUunHheVV/aHnz3jhPDEQnvPSdSTdsp/zVaLJn2lyrcO9AUn+2mi+3Bukvj9oHPl9tO7rmhK+hr6u/WGN2db15efuPyp5ZTfsGbKwZ7hKUCnhNfgrj0+lidc9ju9pccrqdYgEgKk44/4+oanuUxrcJ0Mzbl8335tUM8z+Zvi9SWZkhxLx++xCi51bd5IfV9VN3qsVnTR3eMUafc2tUNHSzU14IDfC5mCl55nukR90ytgQMHMrfOtNE3yV4jh/KTLN5Embee2rwtILC+a9FBI2UCHhdRPjwSbMv6MK0IB/hp63xIVnjvCXzIPsMEx6cV+06uvA+Bk/eorQuj5PwsY7f84Lh8QAniNv0L2BJoGInRZDJm9vEL6ew0TgaO3nq7q+jBNG25oUEO/v/v/ut9tUASFwnHPUaBNUytG3EecP3FEy7ejrUJNT+zS7XUThg/+z+0AIDMQd9xcymPfDq6dFRsKLpP9k98G/UY1o9Z+dv0OGwtbjyt7uww6V4LC645y7HDZ7628s6vAGkbBBFLn1czfezywEuB1mJAA+1OHPKPYmfjFUxcQ1fiRz0nu8+7CSFeXULCxf3Ahb/ptkLt2fma4Ds/S8nQd3hnuIyhEpNfFbtiMFgcvYG4wJ9YXlLnm596T792hNRE8qT9i4hmlREMollL8Ovz7L6xAJACNDoaWYHf8Xs89D1l5M3/AhA3op5Yde0ayTKmVtCvV4WEhzt7Gwn4FuDoVuxEgEIAFwSuFnFJIBHUf+6xiJACQAqufT5ZV2qPjdJnPp/czyIIEb1+m4ii68oozEbxlGJ0D2rzLzBl4T76HrC9O28/5GaqdFkACokTPsRTEFwEIJ4/72ut9shwe26edkdrW5U7SYtZr21RC5RRHpoqBJDef4Udj0XsUCfwbMzfB9vD2/vHJ7cdwMCxITfkbseFPY3dc+CgQANJ9dXNd1IA8QdI3DOvBeIQGb6fN+YWnlx/ls5fqkPfN1v6OJ5lk3+EWfmXhNfABdX4jbmvTVfcCoZxJAZOO9qD6bTvpcmhqIQyWhYLGO/b8uZKjvMbHdQyhsFvSkQZ5smHCeB5vW19rYS5TTFH8IFf8D5ps43lm8fAPALrwvLqzhzmiidIFk0mTNl3VtZgrwouKPdeD0NOhj2hRx7ZAI6DzpPrxBFaaBv+51hAeX69Dix4ruA9jNtMMa00nxRADUQHg2CTc0Qbn5oc+lqbKCVSjex35m66kbaJXeLHs7dH49fNimCRcWQ9Ou60LSeWy8SIzudg6uHzgynUJRe+HB67nxaD774sqT7t9qc0WmanSTNsv7SNZArWiQFwK82wj8CzROBISqWzvWVbCi6UmG8LrYYFT7CzM+EdBeWF7deu6nbyDZDLHpCZ7w3qYPSQLgCsAE6eUPG/maDIUH3OXRrNfJlR8XPmbMUZGcc6Y/J632zPLgESH4jyIkjOa0YeRitoq7+inLs+TuPq5tgMpHl0UgzKUEAgvZxQ3RdQDBv40KXgXTE4HzS6uPcNTf1EZINj/SE7MEEFmeBFhefW9vGyQAJgx7Z1qB1EBnxu1PdFDpmK+TIR01tPed3TWKhWz15vh+Z5MgKnHUwaKfuNGJjTuTnsiE92OKEwCxyK8Ukb628ya2zt1EkGdvfBXsfurPfk0IHTh+pD0NCGxpstnJfT1pQQCRhbWt/b7XHhIAEya/ny/WR/R5YpsBauXcvPovNs3/Xm76UPUvk3dyBxXmtOkGeNYNsDGrO+HPaMLokf9ZVP3jSzjg073BfBYqgi7GyEs4ikM1Vvdl2BNAbPrae9ep1Ck9ukRQCPGkY2JKnxfLwjeEpUVGtGoyqc0AHTfaZEp6e7vF3xcc3/NE1T8B+v4QbuhzdY0gZRvz2Rc76NtQY5EqoUIUYTzkKIEd1oE7qPqX5yR3cGPIR/uFvQGq/iUKyTih/OoZ+s9AVN7RVnjd7Rz3upvSo0sEheAQdKfwBtfAfGF5Ve8cmm0CQoJBs9zbNEHGQbTpHW4x+J4h+E9QWPD1uOXj7t+3CNLl/O2wQd5Gs6b6yU97UbRA+Scy9mmo9DhHHYLS8egObvPJ7oMrVCLsDRKiJ0SQBIDI3lWQwhWAIiXUYEqsZ8znIwEn60iTjCYomNIRMVQgLPDpEueu45552urQ0wSOZ3/a6wgW05OBCP7Tk9/B/YBGXFawN0gQmtBCGcYj3F//20gAFC2RBlM6EjB8MK1qeefaNEmE1smQiNwrMvOLBT5tCC6rgq8iUVMv+uy0HvV6VEg2mK3F2tUdwX+aPqQRlwV9nvnRVZAmQVqQBIASjE9tvwIJAAN5gyl9+JYoHwkoskOmJmfjHGX0X8MVehwcC3wFCH9FkDQkaurH0/7lmM/OZwdTJicANJFxwFzqXgPeLW8Cl12M+nyZpcF13PlPWJ4EaKD/GsRzzCkAJACshG92mce/8v8EKTbgfOPfHzbOs+55myaAYzae3y69Ikf/aVUBC3z69GeEsYBVMLmTTeBVWjHPZ6BHomNfrXpM4ARYRTh3MxQZoqzX+YkDTAJKn/YJWl7FVAaIZuj8K6eckQAwVNbxr0NRRgKKq3yFU6so1iOTwmuhsLv/eloh5gYWzub1hy6k53CyCcFE0+A/VMzvU0xic/8/31sg+K8Mx2R+NTS/2oK9QZVsYN2BWJheLXQiAWBsPBKmvLmw7O+Rpbc0l6gSz4NNMiTai8H7bSqAbiAcM+aXV0h4yOIaQAV451sEE0uPYefBf+QReeH9X/hVPAR6FcTcnHUD07U7PxEClSKcT6JBDxow93qhY4rA3PgO2K9ljAT7yM92no4WHYwEPEaM0X/hO3S3qOZ/M7R/VTcSVL6fwsK1HX74vbDB7Xlu9B1LZUapiR9m4fvYinNHn5u6wGPUXNpYOFpTOIhHx/01uHHd+pTXWxWU/D0qoUDvh7AOdFNcB7zwHMtB0xM3w39bFt7hnxFR2YFWqPheuGUxBi5GH6MP1A8P0x0v1GsQjU6/ONejBOhrwslwzhM18yuUkr8mmlSmsJ+b4bwHzSYBGBM31KtI2/pnJABice7mYrb6y173wdcUkTYDnF9eucVkWDUOG6uqBjhD2m85zYsZKmr0X56scLanFd5NdsJ3qvPMz9ydgGB2O/zaGn9PdTPdJEPn6ODFQzc9/hq7humYshPxvhk2aq2wQdOAvEmRCHpqTARdi6boWebIfcma5Csr8KfR/f/HBQd7JQd6fclPFU7d3R82tqu2Diz+++etoffrYc3XxG+TSvC2mdxnMToZOCjxZKA2nJa7PBOKHd9Wa8Z9fgXU7beEqB02syUlgflqSAx1LBJDFtgPz5f535ondV3DLAkairZrRfbset3ihQtNOphq5oUo4vWYrzsJe6vwIS9GIwEQkXe0FRbvH37uPoy62daRgE+Nj56Nu2hvUsXYH6eXnaIelHpVwTZVcax+SB7deuantiaxgr3X3e6FDcCadRLgaNY1NRr8Wy52p9TR3xaXV9oySl42ydjoeNyFZvqbMG4uLK8KWQhVO6q2OeJBqPI2KAVO5BYVrKQrYBOxDoyfc/prI+az5RXja5N5j6aClHcyMBQFnNvc++7BNlWU7gFotN50NBmQ77OYjE+FvkrXHu+cvhavEEy8cZJMf21TxEKUCq/tzw7/jARARPomD6u3zv9cirnJ1FMAC0ur27aVkLyL9iZVyHz2xXpIZTbJEFMx85njXFV4XVjcvW9XJSt9WroBWFi+GDbqzqwjrx5DJTixvd2HnWbWuvt01O3cvELvG6yfo0d1haZyxSr4+H851X+59dzPbE5aAlifLeFDJyTTtHhhek3ydUVfm2TmNkWkJ1tCIupalQP/44yTAe2w39qMFZAdCgm29lzWuoargvUzft2dn19a7dgnn15eSUUTwMg0CSDsNAnQpIhYuLAu9Mf++8PXNZ9drFS3c2ZvPPpLeuNNxplZNyo8xrXHuw9bkx78H9JeGWQovD9+R3AqmsD8SKb1yGyPjLEgAIZiCEnhR3rtx9W+oq9HYcM6sDHJQcnj3Qdb7KeXKGbiLxRjPs3+VEhCM35SSG7tD6fXEjw1VhgNyMLr4nwIyk33za8bn6SFmvpYpvXn3yNj5+hZnuxEAqAMzE1NAsTs/JkfN2MyvXrA7CozSzvG6D9dKKkgIYCMdkeISa7opohqpDfa4P5ERsLP7zzBqenPhz2bH48UYnRjhkKIp0KP/+dz5KP1M5Ae++HSJAd5R2nAF5IAa+EBEO16JrvpQgomISkUbd+lAfGkJ4SO2tv9ZjNuEoArs4eG4sXa59DUVFM/IAFQlrzz5yBqEiDsSGwbEFZoJGCMijp7uUsFGF1ViJbhv1bUqYXKEfqRIFnjO7OmG08pv0s4TACt/hfd64eZI1UHNfj3a3U5/XVIkwCxThqNnD3YGyeFojQv1UBYA2KqmZhJgNfHtEH9jPc5ZsWoo5AAKJGOIZlxA7N7x68bH3M23UAPna/ENQDrinqRxz+Zh22KYJTdr1flH6pGTJOYuKoBRShq8stRsU6BCTeu1S34PzSqwOVJAPMKdxHBnnPaud5evp+pYfB/SL92EbItoI155yP3eoL0FFM8fB8kAEoWFoH2wvJqlCTA6Jiz9QaaL0c91XAKMe7MOeeK+z5zjBEh2q/gm02qN1R/E+cp3hFdgNORwue869irGKfANNB78v3fomw+U6UnAcS7KN3Yz1wwkTh7A4uEVtXEup+tY+FS30ODrVj7HCQA0rAxn61EGe3D3pku7prVTr2RifUYJe2QW9TdyXzjFyEwDT+3Wi/wTV1wMQc+eewb6JAMCZOedsyngjWci3CyDoHeoSfdkAQR+7GtYQP+FZ3SuI+R+Zqle4O6ngg5Kj8dQmL+/tA99Dk6wF6kxsT7HkWABEAi2PFmjCRAfr/EfGFLt5FJjEpKkbOfI238dmp773/sX7Rv+n0WIQSuBfA0wPcRkqV3500apAl/RsaY3NcI9F6ynpw0/izN006EGtJ+i8wVN8loEuTfiwiJoapcpYVqQwIgIZoEWMxWze//xBgJmGojE8eNNpkqeMGMsvGjDtWYVlIinArpEQBMMru78zG6//uDDsELcYolGuy5Fp0CM7fIWN1PBh6L/T0y5iLs+wCQAEiMOOpYB89RummzRLnScBIa6DGTaYJFqOANg/2owlpn+PWunefBHfNTIeH7TAAwkSwbqI6vgZkSkXuo/h8jQrAXnOq4dwjO7YNE77cJXhGjmbbgOiJEgARAgryTO/l4F0NS4Iz6Y+UjAU93tM2KuIH51YQi71BavwZU4QmLCtGN9SwPHnGExRYnAAAmk/V4tIZj8+eTY6p147+3GQd7pvgUTX7j9KyRHSSF3qS9AETINDE0OkWb1v4ZJs8UQXL0zR+CkjvhAWA2i/djP7P1dBQQmzWY8861w4dNSoXQun5z7f710nlc4M+LqdHM+4EaYuHm/PLKbaoT4Sy8DLSBUrROu24o6F4PMGHizEbnJllDpfdYGuwtLK1um57Ek5OfPvsnPcsa1CBbgqTQWwjLtk68IkPjqyEdAjCCBECqmJtC7r5VEkAXtvml1Xu2R+L56lzW2jJpinRClRv9l/8LhxlZZixU2Niw9edITfQvV3qopABMFO0Ifm1v90GHrOl9YMvENVP3MZ5PbxWCvZ2wRrbIyGG19yRrhKPpOfPigGsgaf0WjZAwE2ebgMmLFACGcAUgZSEJ4Llxx2omqBPukCFd2Gbd8zYlwDEbN1cMQV5Bo/9e/iu5SVB5db5mATBpNGBmP1yK1juF6TxZ8vITwdt5+0B4SO5ke7y8OGCr8P3MBBkna6wLW38kAENIACRO7yfPapMyA1G63Io79Zzboozn5bbIkEW3XMYCMBHCQ3aHAKDq+nrk/8n3D5Yin+gxXQeYZZvgrRwN7Cvh7oT3+Y2LA5rkIng3Edt1XejfCMAQEgBVEILX+eVVm3va1l1u82aA5Y4E9DzYJEOimWCbO5TR7qiDDX1tYI4yQLVpf5dR1f+bTYqoaXT67yg0KH23GNVeR3Kin7N1cYBFfiV4N+P3TSj+YRQgmEICoCLCA789n60UPlovzkiT8kYCxhj9p81yTCpCjDtg1YdGSgAV1fckt0Lgf/7J7sMrZfTx+BftN8mY40bpPXoqwDQgFuKkkv2ecALg/TDaF6oNCYAKYcebRScB8pEmEUYCzkWoZBxnSPstMlbk6L/X4ARAxRm+NgDAhB7t9dee++nzP+8+3CizgaeQt18DDg56BO8m9CPZOmlF3/R1wfb32yvPExt/j7hJAIYwBaBiNAmwkF389XH371tUkPFIQNMq/Yzb36ASRgI6ZuPTB5iVC8creiwkAJjoC/t7LNR97mc7KUytiekZnUOw9156JD6haTlsez+cSfCaeA/2jX7I8BNAVSEBUEXO3VzMVn/Z6z4oZOxclFm3xFcpcgJgPvtiPTylm2SIjea06t3PpzQgqCrpofoPkK4Q5FyhGb+99229k3R1S3ichoRqb52G5dpXt6vP06DfINtRgACWkACoKO9o69Ns5Yefuw8LuavFwjeEpUVGdCTgfHZx/Un379HuRDP7q2RKelYN3p7RsznC4lJZOhUCJ0PAgjaWdI4v0YQRT+vhd+Nn9kuhdtd8knjwz841CQBqaTG70MQ+AqwgAVBRGlCT4/vhAVHISCIdCbjwv1a7YXdpNl+W2enmLkoCQJv/CQ9aZMhi9B9Un44K29t90CEAA3o8d++7B9s0YZpZq/vUDbRha5TeJ+F9ej2snx1ssAEAoG6QAKgwTQIIO00CrBWyiRH/NZEzSwAcjgTUZAMZ09F/5kf2bEb/QYWNgv9vNglMfELnus9o/woZYe96BKXQq2iLyyvXhNhm5O0xhBv6udYoUbhnDFBfSE6CJSQAqo65KeTuz2WtpbPe5dORgONmgGYVmKHz6+HDNhkLwf+XZMi6wZs++BeWVwmqA8G/vd7oGdchmEh6pWphafWybT+aI8Ln+TRbaf/ctbnKdVa4Z5wGJplLqgkgAMAZYQzgJAhJgBke3D/rqL3R5loKaSz4NiFIumw9ElA3dOETNcmQc870+wSV0teGYgj+Ac5O+9FQROz4ZlljalOg94wJ3oN/RzUSUh1NgndCfw6oOiQAJgQzZTNucJPOyHvb6ppeWxiPBDRjPfpPmLp739lfYyDM4q0A2WE/XLJqBglQN3pFTISiJVh1TZo1HoN7WkwOa0AarBNEP53onxb6hQxJpD4cVebyUyF2BPs/MDYlJGhkNkFC9Ts7y2QA/f9WeSTg77MLLfPqv8gtiuNXwkKcqBD4O7c5ic3YAMr2sUxvPOXBVxTv+bexmH1+L0Z/mpNokO+L8RUA32Dt+9MjeDtOriJuGhyGpFitTjycDjfJkDZ7JQBDU092H24SwBExRgJaNQN03GiTKbvRf29+qpDlZ/ojQSr6nuTrhnN3EfgD2NHraPPLK7e0Uz9F4ln0BN0SJSRGLxgWHPd+l2bWmntKA+tqb++E//xPph0JmO2aQU8Kfd/YtoU42akQgBPCFQB4wzgwN80+hgRD4Rs7Hf3HTJfJkERoYHjkc/1AULYfQtB/ix2vPffT53/efbgR6foHQK2NixM9ikSv0S1kF02vp52S6VrsiZsEb/VPemYeDIekcu8k/zyzcXUYSaEPwKbFGRFcAQBbmAIAxxINeiyrL/lIwAvNIseciBtcJWPO+2hXZkaLPDoPGzqSYZdeSEr1RLjfIOo2GtT912Cmd9bJGgBweuz5iji5T5GIc9fDunQ3qfFbEpIgITlBRpzwZwRv1XD21fDhgT/ROuPDGmVZvRud0ix2fzZJ8lMhPDB9XQjjWg7YQgIAjvWxn9l6OgqozY6+eefaVGQvAKF1y3jZevTf66wXeSXsLz35/u93CQAgMXoazb4nzUsa+IR1Sa8CXKJE6Emw8N9lFmyEQCPTKQhIdr6FcMs6D3/Svk3sG/1QjSBLQ+dahJGrx9JTIdbjOV0oShCAoamndzaaBGY+urTVowrK72Aurd6zPVLPV8PGY6uIjcckjv5reNcL1S+yJLq5IUICAACSxDJ9RXjwI0XCxOtWPWpOg9mH4NCZrcOa9DhHB5pg2CZ4E/OXZEinCtEJORp0rZtDhteFft0dgjfY95rSMYONUzfzBvgQU95ztIW1bsajjNpUUU64IyymG49Z97wd/rhFZ+SYTe/+583/Ijd+O0dT3ac0IEths6vftxTvvQIA0F53uze/vHIjZkNAYX87JKeXUqiKi5/qsXm1168TEgBvyKcKWU+i8HLiZm/j5pD62jT8b+P18B64hpMhbxonR0w9O5hCAgBMoQmgERG59cmfb7apwvIKiBhvCsR9RWekzf+sj4iGB370cZm90cJr2gn2cCIDAQAkSq+kUcy52MzNGbefRGL0Y2pskzFNBOs1AIJXRKn0smzTaYjskCHdG8zQ8xbBK2KMmtZTIUi8gDUkAAx4Lzc++fPWRFRVw+Jke+w9bwZ4tgDU82CTDEnYeD7zM6Uckxexr8pYTGQAACjKOBkaNQmrJw60ERqVLFYieHwaD8ZiTBVSpz7qfdrEwUk+BTvzxspV02Bnv7cXQfUfzCEBUDAN/n/7l61NmhDnRoFvsiMB4yzScresbKxEWOSLSMIAAFh6vPtgiyTuMXXhxm1KgtgnoIUR7B1hXVhQWlw47VhZ9hHuiGNv8IrRaVM+86nV92K5RwDGkAAo0KQF/0qrDzoSkCyFRea0xw+HtN8iYzFH/73uN5FOHuAUAACkjoXjPovD2pQ3mC2ZePtrAHrtYSG7iH4wFK/6f5Zj/OMmleaFCc9ykyAnPIgyktQNcQIA7CEBUJBJDP4Pje9fmjrtfUvH1o2hZKfMWbj58c8YVa+w0cXmDwBSpkHPuLluNOz4Ztn348d9AMyDPXEuiWsPZdKfdbRAj882gSe8F8wrxSERkmFvQDSfrVy3vvs/Uu6eE+oDCYAChAr5lUkN/lWcIPTkxw/nsy/WrR/InMIYHPZRjoPp5i9UuzICAEiUk+lNitgQcHQ/flDqCanxGmxeFdSvVdjdr3NDwFkaRAr0SCtH23QGOqmJYnDuZp2vAuheMyQCNymCJPacUAtIAJyRBv+f/MdWhyac9dFL3XjMZxfXT/T/YW98Z1F6e7sPO1Syj/xshyLQn0GoSNypewUIANKlYwHNr6W9aaPsACja9QedgBAq4HVMAuRVXhdnLK6I3DtrpTfWNQDlndypY4HgD+FrDnvNeL1AzpgUAvhQSACcFlPfe1mrQ/CvYowEPEnH2Ukd/XecaNcAVNj8aQUIJwEAIFXja2k9iqjsu9Axgz099j3L+4/qkgzWZMd8tno7VpU356RDBYiVDNMCQfj+3K/TdYBPs9XLB8z3wxcfJRkWfpYdHP+HWJAAOI0Q/AvL2m//srVNdWJ9FP0EHWdjdOhNKRMbtflVSAI4x4/yaggAQGI0Kcqer1BEKdyFjnry4WUyuE0TTCu8euKBHbUpGuk9+f7vhTT4jdGj6ZAmAfQ6wMLy6s1JTg5pQmghW73pHHViBf/KORe1vwnUGxIAJxQ2AT0N/j+5tFW7Lp3jo+imFYih8x90DSAsRF+SodQysTFOYLxOqyELSys/nvRqBgCAtTKeiWU3yRsHe/FG0o6SwbcXllbv/z670KIJchjkHYRktyZ3KKIiTxfmk5oiN8YMNiY1OaRf0ywPHsW6CvKS7Jx2JCTAaSABcAIa/HNNg3+VH0UnMV1omPjy++4e5ouOcZMe8RT7jul7RR+BlX9SbrJzdzQRoN939AcAgFRMiVyjiLQC6kMFlEoSZSzvcZhaDde4r4mAqq8DmshYWF65E4K8H+MHear43kLjxphxvUgOhSLB8srtT7M/Vfba4Fx4PeuJx/D6/kW/pmhNII8I+6xNAohoiuCDHAb/H13a6lGNeU8d58is+d644/IvC8urVBZh6v7cfZhckkcrXmGB2rbufXAsXeyZbgs1aH5ptSssO85Lb0jSPcjv4p7r9/MEEQBAHP8dntMLy5+HgFiMG8K+FJLU63pVbXwnPzo9BfDUDfTrjd+kL6w9jrml64CuRZ7lB/ay7Un6ug70Ezo1p0HdNA3nmKaaYV/RDBHWV+FvZy+OdDOVwqK3kDbGjP0+eEGLBERtdjPtkAzo6f4pvCZ2dG/ANOwP6De9VPYGo+LSs7kZ4kxfE+L4s1BYaZUR8B8V9lP3Hn/3YJsAIkIC4AMg+H9JA+PSgtBInEhy1f9DWvE6YH5EJdLjkmETnOkQ40b460b+dwdUZtImNaFKd+PJ7sNNAgBTH/mpzRAQX6aIAbGwvx2CiaUyAhs9BRCetRpEltqUME8GUAieHF89XAfSWwMalBINjh9/bzNZqIz3wRtGyYBmeE2sj77zDR2rmNDrYkBHXxP84rdyuaGvTWNFSAeuALwHgv83lXIUPZo0Rv+9jVa8NLgkAAAYX02LPLFFR+W5/dI27Y93H2zF7n8AZ+eGw0tkpJT3AZxZKKbcQOd/KAMSAO8Qgv/uRyxLCP5fFXMcUWxC6W+q8sqyUC37UAAAvK6MgDhs3EttCMgyrVMQcO2qImIEevn7gKSQ6QIQgxacvtkkgBIgAfAW4+B/jS9tYYE9RimNiCJw3lcigx42f1pJwGsTAIDKOZkm3LhNJdF73+zjNkGE08mnCkUK9D7yM5oY6hEkTsL7168RQEmQADiGjlRB8P9u0ccRRZDa6L930c2feBd1DjYAQKpGJ9MiVz+ZWgvZxdKuAux1H3a0skyQMOnt+5loiRq9CjDlBQWCxIXk4TUc/YcyIQHwGg3+P/nzzTaC/3eLMRIwNudcpb6eJ92/6WYXFSAAgIBHgVbUtVucu/6+0bWWtLJcwhx4+CCjKm/sZpF5ryAUCJKlSbsn3/8NVzWgVEgAHCEitzT4J/gg7N0EPcCkt/ddOWOdzkLv/KECBAAwPhkV+XraeHTtdSrRk0cP2kgCpGYU/JdV5dUCAXtBEiAxeS8I3PuHBCABMOa93Pjkz1sYxXEC+ZHLCelEzBXunquLCZIAAAAvrqf1KK6NxezzFpUISYCUlBv8H8qviCAJkAwE/5ASJABoFPz/9i9bmwQnxjwJ1wCk98zPVPo0w3hRiX78FQAgJXo9TbyLfjXKs9ykkmkSAMngcglTN4Xg/5AmAaa8LBEaA5apzyRXEPxDSmqfAEDwfzbnRoFzpYNOHf0X+46ehfw6gJ/GQg8AtZb3R4k9FpApK7Mh4KHRiTDBiMBSyK394XQywf8h7QkQ9gbacb5HEJn0QgJmbW/3YYcAElLrBACC/7PLqy0VHwlYldF/H2I0Gmp6DUdBAaDOShkL6Nz1xexCk0qmwQaSwVFpsuXa492HG6kWE3RvEIoE53FCJCa59dzPLGkChgASU9sEQAharyD4L8b4zmVFyc6kjWLRhX50FFQwDxgAamk0FpCjNwQUbtymBLwW8OE0gBnZYT9c0hN4VAH5CRE/fZ6wNzAkPXa8lnJCCKCWCQAN/j/5j60OQSHykYAVbQYYNmwdmlBaBULGHwDq6iM/tUmxg1+mVtkNAY8aB3xLOBVWrPyu/yjIa1WtiPAyOYQiQcH6ut/Sqn8Vp0pBvdQrAcDU917WEPwXr4zjlmcnvTrcyzrM+GMDCAB10htV3+JfBWB/ey5rzVEiXpwKwzpwZnngHwLnJ98/qHyQN74qsjYuEvQITmsc+E+f1/0Wqv5QBfVJAITgX1jWfvuXrW2CwlVxJGCVR/+d1NENILL+AFAX+dFsobh3cJmbM24/ubHCxyQCegQfSHa04p8H/hNUONDXhAatOBFwKgj8obKmqAaYqedZLn1yaQuNOCyxvxdySi2qCu+3qWZ0safRtYfO4r9/3vJDaYf3x5fhr5sEADCBWPhaKADcp4hCYKANATspHg8frwNt/fPi8ko7VLXXQ2n7K4LXhKCf3PYzP7VVh+BunNjo/OFPK9nggDewNzhW35N83XDuLo75Q5VNfAJAg38Olf8Q/PcITH3kZztP3eB6+GMyRx/fRkg6jyes+d9JjRcv/UWaDBh6v+6IW+EvPyMAgAmhJ9QWlla39X4+RTRuCLhGCTsM+vTKwkxj2AqJ8XUdaUj1XAf6IVu0QyLbPCN3976t5x7hv/+Rd61v65/zQoH3LSZ97/CXVEuy44m6CPphkkx0AuAw+P8IwX8Uet9yYXlVj9Und/TxdeKp0qMLi3Y0GaAbwXNTB5n4YRbeRK2wi20SkgKlCc+wUHninwiqIMbPCa+FU2CZviI8uEsxE9RM5xez1ct73QfJ37sfV7jvjn/RYtZq+kZYA2SY5QmByVsHftI+QHlgp78a1B0HvnDE0b2B0oTAy72BvpdYXxPJF30+kL4HfhL2XRZt8tjoPjuY6lbt9AeTy78OmlD4+gr6PP/8fxsdmlDhgb6J4B+gGIeJAS8852Q45w+PBrI0CV4zdffJ93+7SwAAE2TxwoUmHUw1dR1gOWgK8ZyE5SEkKtMMAoV7TKJ3tfueG303Peg+e3auj/vaxTncG+R/4X0z+b1BeE3oB0d6PbjRn3bD3rDh+3U98QH19D9119TuZCJ6zgAAAABJRU5ErkJggg==";
const REFRESH_TOKEN_KEY = "everroom:saas:refresh-token";
const DEVICE_KEY_KEY = "everroom:saas:device-key";
const ACCOUNT_PROFILE_KEY = "everroom:saas:account-profile";
const REQUEST_TIMEOUT_MS = 15e3;
const UPLOAD_TIMEOUT_MS = 5 * 6e4;
const OIDC_LOGIN_TIMEOUT_MS = 3 * 6e4;
const SUBSCRIPTION_CACHE_TTL_MS = 6e4;
const SUBSCRIPTION_RETRY_DELAY_MS = 3e4;
const http = createLoggedHttpClient("saas", { timeout: REQUEST_TIMEOUT_MS });
const OIDC_CALLBACK_URL = "everroom://auth/callback";
const OIDC_LOOPBACK_PORT = Number.parseInt(env("NXCORE_LOGTO_LOOPBACK_PORT", "53837"), 10) || 53837;
const OIDC_LOOPBACK_HOST = "127.0.0.1";
const OIDC_LOOPBACK_PATH = "/auth/callback";
const OIDC_LOOPBACK_REDIRECT_URI = `http://${OIDC_LOOPBACK_HOST}:${OIDC_LOOPBACK_PORT}${OIDC_LOOPBACK_PATH}`;
function loopbackCallbackPage(request, response, handler) {
  const callback = new URL(request.url ?? "/", `http://${request.headers.host ?? OIDC_LOOPBACK_HOST}`);
  const failed = callback.searchParams.has("error") || !callback.searchParams.has("code");
  response.writeHead(failed ? 400 : 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"
  });
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EverRoom · ${failed ? "Sign-in incomplete" : "Signed in"}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; min-height: 100vh; display: grid; place-items: center; background: #f7f8fa; color: #202124; }
    main { width: min(420px, calc(100vw - 40px)); padding: 36px 34px 32px; border: 1px solid #e5e7eb; border-radius: 14px; background: #fff; box-shadow: 0 18px 48px rgba(16, 24, 40, .08); text-align: center; }
    .brand { display: inline-flex; align-items: center; justify-content: center; }
    .brand img { display: block; width: 164px; height: auto; }
    .status { width: 52px; height: 52px; margin: 34px auto 20px; display: grid; place-items: center; border-radius: 50%; background: ${failed ? "#fff1f0" : "#edf8f1"}; color: ${failed ? "#d92d20" : "#15803d"}; font-size: 25px; font-weight: 700; }
    h1 { margin: 0; font-size: 22px; line-height: 1.3; letter-spacing: -.025em; }
    p { margin: 10px 0 0; color: #667085; font-size: 14px; line-height: 1.6; }
    .hint { margin-top: 24px; padding-top: 18px; border-top: 1px solid #f0f1f3; color: #98a2b3; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <div class="brand">
      <img src="${everroomFullLogo}" alt="EverRoom">
    </div>
    <div class="status" aria-hidden="true">${failed ? "!" : "&#10003;"}</div>
    <h1>${failed ? "Sign-in incomplete" : "You are signed in"}</h1>
    <p>${failed ? "Return to EverRoom and try signing in again." : "Your account is connected. You can continue in EverRoom."}</p>
    ${failed ? '<div class="hint">Return to EverRoom to try again</div>' : '<div class="hint">Redirecting to the EverRoom website in <span id="redirect-countdown">5</span> seconds</div>'}
  </main>
  ${failed ? "" : `<script>
    (() => {
      const target = 'https://r.nxcore.ai';
      let seconds = 5;
      const countdown = document.getElementById('redirect-countdown');
      const timer = setInterval(() => {
        seconds -= 1;
        if (countdown) countdown.textContent = String(seconds);
        if (seconds <= 0) {
          clearInterval(timer);
          window.location.replace(target);
        }
      }, 1000);
    })();
  <\/script>`}
</body>
</html>`);
  setImmediate(() => handler(callback));
}
function startLoopbackCallbackServer(waiter) {
  return new Promise((resolveStart, rejectStart) => {
    let settled = false;
    const server = createServer((request, response) => {
      loopbackCallbackPage(request, response, (callback) => {
        if (settled) return;
        settled = true;
        waiter.accept(callback);
      });
    });
    server.once("error", rejectStart);
    server.listen({ port: OIDC_LOOPBACK_PORT, host: OIDC_LOOPBACK_HOST, exclusive: true }, () => {
      server.off("error", rejectStart);
      server.on("error", () => void 0);
      server.unref();
      resolveStart(server);
    });
  });
}
class SaasRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "SaasRequestError";
  }
}
function isSaasRateLimitError(error) {
  return error instanceof SaasRequestError && error.status === 429;
}
function saasErrorMessage(response) {
  if (response.status === 429) return "请求过于频繁，请稍后重试。";
  const body = response.data;
  return body?.detail ?? body?.message ?? `SaaS 请求失败（${response.status}）`;
}
function env(name, fallback) {
  return process.env[name]?.trim() || fallback;
}
function normalizeSaasApiUrl(value) {
  const url = new URL(value.trim());
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/api/v1";
  return url.toString().replace(/\/+$/, "");
}
function randomBase64Url(size = 32) {
  return randomBytes(size).toString("base64url");
}
function decodeJwtPayload(token) {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Logto 返回了无效的 ID Token。");
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Logto 返回了无效的 ID Token。");
  }
}
class SaasClient {
  constructor(credentials, electronApp, recordingsDirectory, openExternal) {
    this.credentials = credentials;
    this.electronApp = electronApp;
    this.recordingsDirectory = recordingsDirectory;
    this.openExternal = openExternal;
    this.baseUrl = normalizeSaasApiUrl(env("NXCORE_SAAS_API_URL", "http://127.0.0.1:4100/api/v1"));
    this.logtoIssuer = env("NXCORE_LOGTO_ISSUER", "https://auth.nxcore.ai/oidc").replace(/\/+$/, "");
    this.logtoAppId = env("NXCORE_LOGTO_APP_ID", "typreqzzbz3anel9aq1z8");
    this.connectorIds = {
      google: env("NXCORE_LOGTO_GOOGLE_CONNECTOR_ID", "ylj6cyoz9kqpgpqgh3st8"),
      apple: env("NXCORE_LOGTO_APPLE_CONNECTOR_ID", "aei6v6kjlpauhod1r7f82")
    };
  }
  accessToken = null;
  account = null;
  subscription = null;
  subscriptionLoadedAt = 0;
  subscriptionRetryAfter = 0;
  subscriptionPromise = null;
  initializePromise = null;
  pendingOidcLogin = null;
  loopbackRedirectSupported = null;
  loopbackServer = null;
  baseUrl;
  logtoIssuer;
  logtoAppId;
  connectorIds;
  initialize() {
    this.initializePromise ??= this.restoreSession();
    return this.initializePromise;
  }
  async status(refreshSubscription = false) {
    await this.initialize();
    if (this.account) {
      try {
        await this.loadSubscription(refreshSubscription);
      } catch (error) {
        if (refreshSubscription) throw error;
      }
    }
    return this.currentStatus();
  }
  async listDevices() {
    await this.initialize();
    this.requireLogin();
    return this.request("/app/devices");
  }
  async getRuntimeConfig() {
    await this.initialize();
    return this.request("/app/runtime-config");
  }
  async reportAgentStatus(input) {
    await this.initialize();
    if (!this.account || !this.accessToken) return false;
    await this.request("/app/agent/status", { method: "PUT", data: input });
    return true;
  }
  async agentStreamCredentials() {
    await this.initialize();
    if (!this.account || !this.accessToken) return null;
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/app/agent/stream`;
    return { url: url.toString(), accessToken: this.accessToken, deviceId: this.account.device.id };
  }
  async login(identifier, password) {
    await this.initialize();
    if (!identifier.trim() || !password) throw new Error("请输入账号和密码。");
    const data = await this.publicRequest("/app/auth/password-login", {
      method: "POST",
      data: {
        identifier: identifier.trim(),
        password,
        ...await this.deviceDetails()
      }
    });
    await this.acceptSession(data);
    await this.loadSubscription();
    return this.currentStatus();
  }
  async loginWithOidc(provider) {
    await this.initialize();
    this.cancelOidcLogin("新的登录请求已开始。");
    const state = randomBase64Url();
    const nonce = randomBase64Url();
    const codeVerifier = randomBase64Url(64);
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const redirectUri = await this.resolveOidcRedirectUri();
    const authorizationUrl = new URL(`${this.logtoIssuer}/auth`);
    authorizationUrl.searchParams.set("client_id", this.logtoAppId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", "openid email name");
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("direct_sign_in", `social:${this.connectorIds[provider]}`);
    const result = new Promise((resolveLogin, rejectLogin) => {
      const timeout = setTimeout(() => {
        if (this.pendingOidcLogin?.state !== state) return;
        this.pendingOidcLogin = null;
        this.stopLoopbackServer();
        rejectLogin(new Error("浏览器登录等待超时，请重试。"));
      }, OIDC_LOGIN_TIMEOUT_MS);
      this.pendingOidcLogin = {
        state,
        nonce,
        codeVerifier,
        redirectUri,
        resolve: resolveLogin,
        reject: rejectLogin,
        timeout
      };
    });
    if (redirectUri === OIDC_LOOPBACK_REDIRECT_URI) {
      try {
        await this.listenOidcLoopback();
      } catch (error) {
        this.cancelOidcLogin("无法启动本地回调监听。");
        throw error;
      }
    }
    try {
      await this.openExternal(authorizationUrl.toString());
    } catch (error) {
      this.cancelOidcLogin("无法打开系统浏览器。");
      throw error;
    }
    return result;
  }
  /**
   * Logto 后台注册了固定端口回环 redirect_uri 才走 HTTP 回调(每次登录探测一次并缓存),
   * 否则回退到 everroom:// 自定义协议,保证未配置时登录流程不被破坏。
   */
  async resolveOidcRedirectUri() {
    if (this.loopbackRedirectSupported !== null) {
      return this.loopbackRedirectSupported ? OIDC_LOOPBACK_REDIRECT_URI : OIDC_CALLBACK_URL;
    }
    try {
      const probe2 = await http.get(`${this.logtoIssuer}/auth`, {
        params: {
          client_id: this.logtoAppId,
          redirect_uri: OIDC_LOOPBACK_REDIRECT_URI,
          response_type: "code",
          scope: "openid email name",
          code_challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          code_challenge_method: "S256",
          state: "probe",
          nonce: "probe"
        },
        validateStatus: () => true,
        maxRedirects: 0
      });
      this.loopbackRedirectSupported = probe2.status !== 400;
    } catch {
      this.loopbackRedirectSupported = false;
    }
    return this.loopbackRedirectSupported ? OIDC_LOOPBACK_REDIRECT_URI : OIDC_CALLBACK_URL;
  }
  async listenOidcLoopback() {
    this.stopLoopbackServer();
    const server = await startLoopbackCallbackServer({
      accept: (callback) => this.handleOidcCallback(callback.toString()),
      finish: () => this.stopLoopbackServer()
    });
    this.loopbackServer = server;
  }
  stopLoopbackServer() {
    const server = this.loopbackServer;
    this.loopbackServer = null;
    if (!server) return;
    server.close(() => void 0);
    server.closeIdleConnections();
  }
  handleOidcCallback(rawUrl) {
    let callback;
    try {
      callback = new URL(rawUrl);
    } catch {
      return false;
    }
    const isLoopback2 = callback.protocol === "http:" && callback.hostname === OIDC_LOOPBACK_HOST;
    if (!isLoopback2 && (callback.protocol !== "everroom:" || callback.hostname !== "auth" || callback.pathname !== "/callback")) return false;
    const pending = this.pendingOidcLogin;
    if (!pending) return true;
    if (callback.searchParams.get("state") !== pending.state) {
      this.rejectOidcLogin(pending, new Error("登录状态校验失败，请重新登录。"));
      return true;
    }
    const oidcError = callback.searchParams.get("error");
    if (oidcError) {
      const description = callback.searchParams.get("error_description");
      const rejectedScope = callback.searchParams.get("scope");
      const message = description || `Logto 登录失败（${oidcError}）。`;
      this.rejectOidcLogin(
        pending,
        new Error(rejectedScope ? `${message}（被拒绝的 scope: ${rejectedScope}）` : message)
      );
      return true;
    }
    const code = callback.searchParams.get("code");
    if (!code) {
      this.rejectOidcLogin(pending, new Error("Logto 登录回调缺少授权码。"));
      return true;
    }
    this.stopLoopbackServer();
    void this.completeOidcLogin(code, pending);
    return true;
  }
  cancelOidcLogin(message = "登录已取消。") {
    const pending = this.pendingOidcLogin;
    if (pending) this.rejectOidcLogin(pending, new Error(message));
  }
  async logout() {
    await this.initialize();
    this.cancelOidcLogin();
    this.stopLoopbackServer();
    const refreshToken = await this.credentials.getPlainText(REFRESH_TOKEN_KEY);
    if (refreshToken) {
      await this.publicRequest("/app/auth/logout", {
        method: "POST",
        data: { refreshToken }
      }).catch(() => void 0);
    }
    this.accessToken = null;
    this.account = null;
    this.subscription = null;
    this.subscriptionLoadedAt = 0;
    this.subscriptionRetryAfter = 0;
    this.subscriptionPromise = null;
    await this.credentials.delete(REFRESH_TOKEN_KEY);
    await this.credentials.delete(ACCOUNT_PROFILE_KEY);
    return this.currentStatus();
  }
  async createAsrJob(input) {
    this.requireLogin();
    const filePath = this.resolveRecording(input.filePath);
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0) throw new Error("录音文件不存在或为空。");
    const contentHash = await this.hashFile(filePath);
    const recordingId = input.recordingId ?? randomUUID();
    const job = await this.request("/app/asr-jobs", {
      method: "POST",
      data: {
        deviceId: this.account.device.id,
        recordingId,
        originPlatform: "desktop",
        fileName: basename(filePath),
        mimeType: this.mimeType(filePath),
        fileSize: info.size,
        contentHash,
        estimatedDurationMs: Math.max(1e3, input.durationMs ?? 1e3),
        idempotencyKey: `recording:${recordingId}:asr:${input.retryToken ?? "v1"}`,
        languageHints: input.languageHints ?? [],
        diarizationEnabled: input.diarizationEnabled,
        ...input.contextPrompt ? { contextPrompt: input.contextPrompt } : {}
      }
    });
    if (job.status === "awaiting_upload") {
      const authorization = await this.request(
        `/app/asr-jobs/${this.requireCloudJobId(job.id)}/upload-authorization`,
        { method: "POST" }
      );
      await this.upload(filePath, info.size, authorization);
      const queued = await this.request(
        `/app/asr-jobs/${this.requireCloudJobId(job.id)}/upload-complete`,
        { method: "POST", data: { objectKey: authorization.objectKey } }
      );
      return this.normalizeJob(queued);
    }
    return this.normalizeJob(job);
  }
  async getAsrJob(prefixedId) {
    const id = this.cloudId(prefixedId);
    const job = await this.request(`/app/asr-jobs/${id}`);
    if (job.status === "completed") {
      const result = await this.request(
        `/app/asr-jobs/${id}/result`
      );
      job.transcript = result.rawTranscript;
      job.segments = result.segments;
      job.insights = result.insights;
    }
    return this.normalizeJob(job);
  }
  async registerKeyAgreement(publicKey) {
    await this.request("/app/keyring/device", {
      method: "PUT",
      data: { algorithm: "X25519", publicKey }
    });
  }
  async getKeyring() {
    return this.request("/app/keyring");
  }
  async bootstrapKeyring(input) {
    await this.request("/app/keyring/bootstrap", { method: "POST", data: input });
  }
  async putDeviceKeyPackage(targetDeviceId, input) {
    await this.request(`/app/keyring/devices/${encodeURIComponent(targetDeviceId)}/package`, {
      method: "PUT",
      data: input
    });
  }
  async createPairingSession() {
    const result = await this.request("/app/keyring/pairing-sessions", { method: "POST" });
    return { ...result, origin: new URL(this.baseUrl).origin };
  }
  async getPairingSession(id) {
    return this.request(`/app/keyring/pairing-sessions/${encodeURIComponent(id)}`);
  }
  async approvePairingSession(id) {
    return this.request(`/app/keyring/pairing-sessions/${encodeURIComponent(id)}/approve`, { method: "POST" });
  }
  async packagePairingSession(id, input) {
    return this.request(`/app/keyring/pairing-sessions/${encodeURIComponent(id)}/package`, { method: "PUT", data: input });
  }
  async listPrivateRecords(cursor) {
    const result = await this.requestWithMeta(`/app/private-records?cursor=${Math.max(0, Math.floor(cursor))}`);
    return {
      records: result.data,
      nextCursor: typeof result.meta?.nextCursor === "number" ? result.meta.nextCursor : cursor
    };
  }
  async getPrivateRecord(recordId) {
    return this.request(`/app/private-records/${encodeURIComponent(recordId)}`);
  }
  listSummaryTags() {
    return this.request("/app/summary-tags");
  }
  async replaceSummaryTags(summaryRecordId, tags) {
    await this.request(`/app/summaries/${encodeURIComponent(summaryRecordId)}/tags`, {
      method: "PUT",
      data: {
        tags: tags.map((tag) => ({
          ...tag.id ? { id: tag.id } : {},
          kind: tag.kind,
          label: tag.label,
          ...tag.entityType ? { entityType: tag.entityType } : {},
          ...tag.subject ? { subject: tag.subject } : {},
          ...tag.predicate ? { predicate: tag.predicate } : {},
          ...tag.object ? { object: tag.object } : {},
          ...tag.confidence !== void 0 ? { confidence: tag.confidence } : {},
          ...tag.evidence !== void 0 ? { evidence: tag.evidence } : {}
        }))
      }
    });
  }
  async renameSummaryTag(tagId, label) {
    await this.request(`/app/summary-tags/${encodeURIComponent(tagId)}`, { method: "PUT", data: { label } });
  }
  async mergeSummaryTag(targetTagId, sourceTagId) {
    await this.request(`/app/summary-tags/${encodeURIComponent(targetTagId)}/merge`, { method: "POST", data: { sourceTagId } });
  }
  async putPrivateRecord(recordId, input) {
    return this.request(`/app/private-records/${encodeURIComponent(recordId)}`, {
      method: "PUT",
      data: input
    });
  }
  async createPrivateAudio(input) {
    return this.request("/app/private-audio", { method: "POST", data: input });
  }
  async authorizePrivateAudioUpload(id) {
    return this.request(`/app/private-audio/${encodeURIComponent(id)}/upload-authorization`, { method: "POST" });
  }
  async completePrivateAudioUpload(id) {
    return this.request(`/app/private-audio/${encodeURIComponent(id)}/upload-complete`, { method: "POST" });
  }
  async listPrivateAudio(cursor) {
    const result = await this.requestWithMeta(`/app/private-audio?cursor=${Math.max(0, Math.floor(cursor))}`);
    return { assets: result.data, nextCursor: typeof result.meta?.nextCursor === "number" ? result.meta.nextCursor : cursor };
  }
  async authorizePrivateAudioDownload(id) {
    return this.request(`/app/private-audio/${encodeURIComponent(id)}/download-authorization`, { method: "POST" });
  }
  async deletePrivateAudio(id) {
    await this.request(`/app/private-audio/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  async authorizePrivateAudioChunk(id, index, input) {
    return this.request(`/app/private-audio/${encodeURIComponent(id)}/chunks/${index}/upload-authorization`, { method: "POST", data: { chunkIndex: index, ...input } });
  }
  async completePrivateAudioChunk(id, index) {
    await this.request(`/app/private-audio/${encodeURIComponent(id)}/chunks/${index}/upload-complete`, { method: "POST" });
  }
  async authorizePrivateAudioChunkDownload(id, index) {
    return this.request(`/app/private-audio/${encodeURIComponent(id)}/chunks/${index}/download-authorization`, { method: "POST" });
  }
  async completePrivateAudioChunks(id) {
    return this.request(`/app/private-audio/${encodeURIComponent(id)}/chunks-complete`, { method: "POST" });
  }
  async registerProcessorDevice() {
    await this.request("/app/processing/device", {
      method: "PUT",
      data: { capabilities: ["transcription.summary.v1"], maxConcurrency: 1 }
    });
  }
  async claimProcessingJob() {
    return this.request("/app/processing/jobs/claim", { method: "POST", data: {} });
  }
  async startProcessingJob(jobId, leaseToken) {
    return this.request(`/app/processing/jobs/${encodeURIComponent(jobId)}/start`, {
      method: "POST",
      data: { leaseToken }
    });
  }
  async renewProcessingJob(jobId, leaseToken) {
    return this.request(`/app/processing/jobs/${encodeURIComponent(jobId)}/renew`, {
      method: "POST",
      data: { leaseToken }
    });
  }
  async completeProcessingJob(jobId, input) {
    await this.request(`/app/processing/jobs/${encodeURIComponent(jobId)}/complete`, {
      method: "POST",
      data: input
    });
  }
  async failProcessingJob(jobId, input) {
    await this.request(`/app/processing/jobs/${encodeURIComponent(jobId)}/fail`, {
      method: "POST",
      data: input
    });
  }
  async reprocessTranscriptionSummary(input) {
    await this.request("/app/processing/jobs/reprocess", { method: "POST", data: input });
  }
  async acknowledgeSync(cursor) {
    await this.request("/app/sync/ack", {
      method: "POST",
      data: { deviceId: this.account.device.id, cursor: Math.max(0, Math.floor(cursor)) }
    });
  }
  async restoreSession() {
    const refreshToken = await this.credentials.getPlainText(REFRESH_TOKEN_KEY);
    if (!refreshToken) return;
    try {
      await this.refresh(refreshToken);
      await this.loadSubscription();
    } catch (error) {
      if (error instanceof SaasRequestError && (error.status === 401 || error.status === 403)) {
        await this.credentials.delete(REFRESH_TOKEN_KEY);
      } else {
        console.warn("Unable to restore EverRoom SaaS session; keeping the refresh token for retry.");
      }
    }
  }
  async completeOidcLogin(code, pending) {
    try {
      const tokenResponse = await http.post(`${this.logtoIssuer}/token`, new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.logtoAppId,
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier
      }), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        validateStatus: () => true
      });
      const token = tokenResponse.data;
      if (tokenResponse.status >= 400 || !token?.id_token) {
        throw new Error(token?.error_description || token?.error || "Logto 未返回 ID Token。");
      }
      if (this.pendingOidcLogin !== pending) return;
      const claims = this.validateIdToken(token.id_token, pending.nonce);
      const data = await this.publicRequest("/app/auth/oidc/logto", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.id_token}` },
        data: await this.deviceDetails()
      });
      if (this.pendingOidcLogin !== pending) return;
      if (claims.email_verified === true && typeof claims.email === "string") {
        data.user.email = claims.email;
      }
      if (typeof claims.name === "string" && claims.name.trim()) data.user.name = claims.name.trim();
      await this.acceptSession(data);
      await this.loadSubscription();
      this.resolveOidcLogin(pending, this.currentStatus());
    } catch (error) {
      this.rejectOidcLogin(
        pending,
        error instanceof Error ? error : new Error("OIDC 登录失败。")
      );
    }
  }
  validateIdToken(idToken, nonce) {
    const claims = decodeJwtPayload(idToken);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.logtoIssuer || !audiences.includes(this.logtoAppId)) {
      throw new Error("Logto ID Token 的签发方或应用不匹配。");
    }
    if (claims.nonce !== nonce) throw new Error("Logto ID Token 的 nonce 校验失败。");
    if (typeof claims.exp !== "number" || claims.exp * 1e3 <= Date.now()) {
      throw new Error("Logto ID Token 已过期。");
    }
    return claims;
  }
  resolveOidcLogin(pending, status) {
    if (this.pendingOidcLogin !== pending) return;
    clearTimeout(pending.timeout);
    this.pendingOidcLogin = null;
    this.stopLoopbackServer();
    pending.resolve(status);
  }
  rejectOidcLogin(pending, error) {
    if (this.pendingOidcLogin !== pending) return;
    clearTimeout(pending.timeout);
    this.pendingOidcLogin = null;
    this.stopLoopbackServer();
    pending.reject(error);
  }
  currentStatus() {
    return {
      authenticated: Boolean(this.accessToken && this.account),
      apiBaseUrl: this.baseUrl,
      ...this.account ? { user: this.account.user, device: this.account.device } : {},
      ...this.subscription ? { subscription: this.subscription } : {}
    };
  }
  async upload(filePath, size, authorization) {
    const response = await http.put(authorization.uploadUrl, createReadStream(filePath), {
      headers: { ...authorization.headers, "Content-Length": String(size) },
      timeout: UPLOAD_TIMEOUT_MS,
      maxBodyLength: Number.POSITIVE_INFINITY,
      validateStatus: () => true
    });
    if (response.status >= 400) throw new Error(`OSS 上传失败（${response.status}）`);
  }
  async refresh(refreshToken) {
    const data = await this.publicRequest("/app/auth/refresh", {
      method: "POST",
      data: { refreshToken }
    });
    await this.acceptSession(data);
  }
  async acceptSession(data) {
    const storedProfile = await this.credentials.getPlainText(ACCOUNT_PROFILE_KEY);
    if (storedProfile) {
      try {
        const profile = JSON.parse(storedProfile);
        if (profile.userId === data.user.id) {
          const { userId: _, ...userProfile } = profile;
          data.user = { ...userProfile, ...data.user };
        }
      } catch {
      }
    }
    this.accessToken = data.accessToken;
    this.account = data;
    this.subscription = null;
    this.subscriptionLoadedAt = 0;
    this.subscriptionRetryAfter = 0;
    this.subscriptionPromise = null;
    await this.credentials.setPlainText(REFRESH_TOKEN_KEY, data.refreshToken);
    await this.credentials.setPlainText(ACCOUNT_PROFILE_KEY, JSON.stringify({
      userId: data.user.id,
      email: data.user.email,
      phone: data.user.phone,
      name: data.user.name
    }));
  }
  async loadSubscription(force = false) {
    if (!force && this.subscription && Date.now() - this.subscriptionLoadedAt < SUBSCRIPTION_CACHE_TTL_MS) return;
    if (!force && Date.now() < this.subscriptionRetryAfter) return;
    if (this.subscriptionPromise) return this.subscriptionPromise;
    this.subscriptionPromise = (async () => {
      try {
        const subscription = await this.request("/app/subscription");
        const quotaSeconds = Math.max(0, subscription.entitlements?.asrSecondsPerPeriod ?? 0);
        const usedSeconds = Math.max(0, subscription.usedSeconds);
        this.subscription = {
          status: subscription.status,
          planCode: subscription.planCode,
          planName: subscription.planName,
          periodStart: subscription.periodStart,
          periodEnd: subscription.periodEnd,
          quotaSeconds,
          usedSeconds,
          remainingSeconds: Math.max(0, quotaSeconds - usedSeconds)
        };
        this.subscriptionLoadedAt = Date.now();
        this.subscriptionRetryAfter = 0;
      } catch (error) {
        this.subscriptionRetryAfter = Date.now() + SUBSCRIPTION_RETRY_DELAY_MS;
        throw error;
      }
    })().finally(() => {
      this.subscriptionPromise = null;
    });
    return this.subscriptionPromise;
  }
  async deviceDetails() {
    return {
      deviceKey: await this.deviceKey(),
      deviceName: hostname() || "EverRoom Desktop",
      platform: process.platform === "win32" ? "Windows" : "macOS",
      appVersion: this.electronApp.getVersion()
    };
  }
  async deviceKey() {
    const existing = await this.credentials.getPlainText(DEVICE_KEY_KEY);
    if (existing) return existing;
    const value = randomUUID();
    await this.credentials.setPlainText(DEVICE_KEY_KEY, value);
    return value;
  }
  async request(path, config = {}) {
    this.requireLogin();
    let response = await this.send(path, config, this.accessToken);
    if (response.status === 401) {
      const refreshToken = await this.credentials.getPlainText(REFRESH_TOKEN_KEY);
      if (!refreshToken) throw new Error("登录已过期，请重新登录。");
      await this.refresh(refreshToken);
      response = await this.send(path, config, this.accessToken);
    }
    return this.unwrap(response);
  }
  async requestWithMeta(path, config = {}) {
    this.requireLogin();
    let response = await this.send(path, config, this.accessToken);
    if (response.status === 401) {
      const refreshToken = await this.credentials.getPlainText(REFRESH_TOKEN_KEY);
      if (!refreshToken) throw new Error("登录已过期，请重新登录。");
      await this.refresh(refreshToken);
      response = await this.send(path, config, this.accessToken);
    }
    const body = response.data;
    if (response.status >= 400) {
      throw new SaasRequestError(saasErrorMessage(response), response.status);
    }
    if (!body || typeof body !== "object" || !("data" in body)) throw new Error("SaaS 返回了无效响应。");
    return { data: body.data, meta: body.meta };
  }
  async publicRequest(path, config) {
    return this.unwrap(await this.send(path, config));
  }
  send(path, config, token) {
    return http.request({
      url: `${this.baseUrl}${path}`,
      ...config,
      headers: {
        Accept: "application/json",
        ...token ? { Authorization: `Bearer ${token}` } : {},
        ...config.headers
      },
      validateStatus: () => true
    });
  }
  unwrap(response) {
    const body = response.data;
    if (response.status >= 400) {
      throw new SaasRequestError(saasErrorMessage(response), response.status);
    }
    if (!body || typeof body !== "object" || !("data" in body)) {
      throw new Error("SaaS 返回了无效响应。");
    }
    return body.data;
  }
  requireLogin() {
    if (!this.accessToken || !this.account) {
      throw new Error("请先登录 EverRoom，或切换为本地自有配置。");
    }
  }
  resolveRecording(fileName) {
    const candidate = isAbsolute(fileName) ? fileName : join(this.recordingsDirectory, fileName);
    const resolved = resolve(candidate);
    const fromRoot = relative(resolve(this.recordingsDirectory), resolved);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new Error("录音文件不在允许的目录中。");
    }
    return resolved;
  }
  hashFile(filePath) {
    return new Promise((resolveHash, reject) => {
      const hash2 = createHash("sha256");
      const stream2 = createReadStream(filePath);
      stream2.on("data", (chunk) => hash2.update(chunk));
      stream2.on("error", reject);
      stream2.on("end", () => resolveHash(hash2.digest("hex")));
    });
  }
  mimeType(filePath) {
    const types = {
      ".m4a": "audio/mp4",
      ".mp4": "video/mp4",
      ".webm": "audio/webm",
      ".ogg": "audio/ogg",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".flac": "audio/flac",
      ".aac": "audio/aac"
    };
    return types[extname(filePath).toLowerCase()] ?? "audio/webm";
  }
  cloudId(value) {
    if (!value.startsWith("saas:")) throw new Error("无效的云端转写任务标识。");
    return this.requireCloudJobId(value.slice(5));
  }
  requireCloudJobId(value) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error("无效的云端转写任务标识。");
    }
    return encodeURIComponent(value);
  }
  normalizeJob(job) {
    const terminal = /* @__PURE__ */ new Set(["completed", "failed", "cancelled"]);
    return {
      id: `saas:${job.id}`,
      source: "saas",
      provider: job.provider,
      status: job.status === "completed" ? "completed" : job.status === "failed" ? "failed" : job.status === "cancelled" || job.status === "expired" ? "cancelled" : terminal.has(job.status) ? "failed" : "running",
      fileName: job.fileName,
      languageHints: [],
      diarizationEnabled: true,
      contextPrompt: "",
      result: job.status === "completed" && job.transcript ? {
        transcript: job.transcript,
        segments: job.segments ?? [],
        ...job.insights ? { insights: job.insights } : {}
      } : null,
      error: job.errorMessage ?? job.errorCode ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }
}
const HEARTBEAT_INTERVAL_MS = 15e3;
const TERMINAL_EVENTS$1 = /* @__PURE__ */ new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted"
]);
class AgentStatusReporter {
  constructor(client) {
    this.client = client;
  }
  activeRuns = /* @__PURE__ */ new Map();
  timer = null;
  lastError = null;
  reportInFlight = null;
  reportPending = false;
  endpointUnavailable = false;
  endpointRetryAt = 0;
  sessionsProvider = null;
  setSessionsProvider(provider) {
    this.sessionsProvider = provider;
    void this.report();
  }
  start() {
    if (this.timer) return;
    void this.report();
    this.timer = setInterval(() => void this.report(), HEARTBEAT_INTERVAL_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  reset() {
    this.activeRuns.clear();
    this.lastError = null;
    this.endpointUnavailable = false;
    this.endpointRetryAt = 0;
    void this.report();
  }
  trackRun(run) {
    if (!["accepted", "running"].includes(run.status)) return;
    this.lastError = null;
    this.activeRuns.set(run.id, {
      sessionId: run.sessionId,
      runId: run.id,
      taskTitle: run.prompt.trim().slice(0, 240),
      activeSince: run.startedAt ?? run.createdAt
    });
    void this.report();
  }
  trackEvent(event) {
    if (!TERMINAL_EVENTS$1.has(event.type)) return;
    const tracked = this.activeRuns.get(event.runId);
    if (!tracked && this.lastError?.runId === event.runId) return;
    const finished = tracked ?? {
      sessionId: event.sessionId,
      runId: event.runId,
      taskTitle: "",
      activeSince: event.occurredAt
    };
    this.activeRuns.delete(event.runId);
    this.lastError = event.type === "run.failed" ? finished : null;
    void this.report();
  }
  reportNow() {
    void this.report();
  }
  report() {
    if (this.endpointUnavailable && Date.now() < this.endpointRetryAt) return Promise.resolve();
    if (this.endpointUnavailable) this.endpointUnavailable = false;
    if (this.reportInFlight) {
      this.reportPending = true;
      return this.reportInFlight;
    }
    const active = [...this.activeRuns.values()].at(-1);
    const current = active ?? this.lastError;
    const report = async () => {
      let sessions;
      if (this.sessionsProvider) {
        try {
          sessions = (await this.sessionsProvider()).map((session2) => ({
            ...session2,
            messages: session2.messages
          }));
        } catch {
        }
      }
      await this.client.reportAgentStatus({
        state: active ? "running" : this.lastError ? "error" : "idle",
        ...current?.sessionId ? { sessionId: current.sessionId } : {},
        ...current?.runId ? { runId: current.runId } : {},
        ...current?.taskTitle ? { taskTitle: current.taskTitle } : {},
        ...active?.activeSince ? { activeSince: active.activeSince } : {},
        ...sessions ? { sessions } : {}
      });
    };
    this.reportInFlight = report().then(() => void 0).catch((error) => {
      if (error instanceof SaasRequestError && error.status === 404) {
        this.endpointUnavailable = true;
        this.endpointRetryAt = Date.now() + 6e4;
      }
    }).finally(() => {
      this.reportInFlight = null;
      if (this.reportPending) {
        this.reportPending = false;
        queueMicrotask(() => void this.report());
      }
    });
    return this.reportInFlight;
  }
}
const RECONNECT_DELAY_MS = 2e3;
const TERMINAL_EVENTS = /* @__PURE__ */ new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted"
]);
class RemoteAgentCommandClient {
  constructor(saas, bridge) {
    this.saas = saas;
    this.bridge = bridge;
    this.bridge.setEventObserver((event) => this.onAgentEvent(event));
  }
  socket = null;
  reconnectTimer = null;
  stopped = true;
  runToCommand = /* @__PURE__ */ new Map();
  runQueues = /* @__PURE__ */ new Map();
  activeSessions = /* @__PURE__ */ new Set();
  seenCommands = /* @__PURE__ */ new Set();
  cancelledCommands = /* @__PURE__ */ new Set();
  completionWaiters = /* @__PURE__ */ new Map();
  commandToRun = /* @__PURE__ */ new Map();
  start() {
    this.stopped = false;
    void this.connect();
  }
  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }
  async connect() {
    if (this.stopped || this.socket) return;
    const credentials = await this.saas.agentStreamCredentials().catch(() => null);
    if (!credentials || this.stopped) return;
    const socket = new WebSocket(credentials.url, { headers: { Authorization: `Bearer ${credentials.accessToken}` } });
    this.socket = socket;
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: credentials.deviceId }));
    });
    socket.on("message", (data) => void this.handleMessage(data.toString()));
    socket.on("close", () => this.scheduleReconnect(socket));
    socket.on("error", () => void 0);
  }
  scheduleReconnect(socket) {
    if (this.socket === socket) this.socket = null;
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }
  async handleMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.type !== "command" || !frame.command) return;
    const command = frame.command;
    if (Date.parse(command.expiresAt) <= Date.now()) {
      this.sendTransition(command.commandId, "expired");
      return;
    }
    try {
      if (command.type === "agent.run") {
        if (this.seenCommands.has(command.commandId)) return;
        this.seenCommands.add(command.commandId);
        const sessionKey = typeof command.payload.sessionId === "string" && command.payload.sessionId ? command.payload.sessionId : `remote:${command.commandId}`;
        const queue = this.runQueues.get(sessionKey) ?? [];
        queue.push(command);
        this.runQueues.set(sessionKey, queue);
        void this.drainSession(sessionKey);
      } else {
        const targetCommandId = String(command.payload.commandId ?? "");
        const runId = typeof command.payload.runId === "string" && command.payload.runId ? command.payload.runId : void 0;
        const sessionId = typeof command.payload.sessionId === "string" && command.payload.sessionId ? command.payload.sessionId : void 0;
        if (targetCommandId) this.cancelledCommands.add(targetCommandId);
        const queued = sessionId ? this.runQueues.get(sessionId) : void 0;
        const queuedIndex = queued?.findIndex((item) => item.commandId === targetCommandId) ?? -1;
        if (queued && queuedIndex >= 0) {
          queued.splice(queuedIndex, 1);
          this.sendTransition(targetCommandId, "cancelled");
          this.cancelledCommands.delete(targetCommandId);
        } else if (targetCommandId) {
          const knownRunId = runId ?? this.commandToRun.get(targetCommandId);
          if (knownRunId) await this.bridge.cancelRemoteRun(targetCommandId, knownRunId, sessionId);
        }
        this.sendTransition(command.commandId, "cancelled", runId);
      }
    } catch (error) {
      this.sendTransition(command.commandId, "failed", void 0, error instanceof Error ? error.message : String(error));
    }
  }
  async drainSession(sessionKey) {
    if (this.activeSessions.has(sessionKey)) return;
    this.activeSessions.add(sessionKey);
    try {
      const queue = this.runQueues.get(sessionKey);
      while (queue?.length) {
        const command = queue.shift();
        try {
          await this.executeRun(command);
        } catch (error) {
          this.sendTransition(command.commandId, "failed", void 0, error instanceof Error ? error.message : String(error));
        }
      }
      if (queue?.length === 0) this.runQueues.delete(sessionKey);
    } finally {
      this.activeSessions.delete(sessionKey);
    }
  }
  async executeRun(command) {
    const sessionId = typeof command.payload.sessionId === "string" ? command.payload.sessionId : void 0;
    if (this.cancelledCommands.has(command.commandId)) {
      this.sendTransition(command.commandId, "cancelled");
      this.cancelledCommands.delete(command.commandId);
      return;
    }
    if (Date.parse(command.expiresAt) <= Date.now()) {
      this.sendTransition(command.commandId, "expired");
      return;
    }
    const run = await this.bridge.startRemoteRun({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      prompt: String(command.payload.prompt ?? ""),
      title: typeof command.payload.title === "string" ? command.payload.title : void 0,
      sessionId
    });
    this.runToCommand.set(run.id, command.commandId);
    this.commandToRun.set(command.commandId, run.id);
    if (this.cancelledCommands.has(command.commandId)) {
      await this.bridge.cancelRemoteRun(command.commandId, run.id, sessionId).catch(() => void 0);
      this.sendTransition(command.commandId, "cancelled", run.id);
      this.runToCommand.delete(run.id);
      this.commandToRun.delete(command.commandId);
      this.cancelledCommands.delete(command.commandId);
      return;
    }
    this.sendTransition(command.commandId, "accepted", run.id);
    this.sendTransition(command.commandId, "running", run.id);
    if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
      this.sendTransition(command.commandId, run.status === "completed" ? "completed" : run.status === "cancelled" ? "cancelled" : "failed", run.id, run.error ?? void 0);
      this.runToCommand.delete(run.id);
      this.commandToRun.delete(command.commandId);
      return;
    }
    await new Promise((resolve2) => this.completionWaiters.set(run.id, resolve2));
  }
  onAgentEvent(event) {
    const commandId = this.runToCommand.get(event.runId);
    if (!commandId || !TERMINAL_EVENTS.has(event.type)) return;
    const status = event.type === "run.completed" ? "completed" : event.type === "run.cancelled" ? "cancelled" : "failed";
    this.sendTransition(commandId, status, event.runId, event.type === "run.failed" ? String(event.payload?.message ?? "Agent failed") : void 0);
    this.runToCommand.delete(event.runId);
    this.commandToRun.delete(commandId);
    this.completionWaiters.get(event.runId)?.();
    this.completionWaiters.delete(event.runId);
  }
  sendTransition(commandId, status, runId, error) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "transition", commandId, status, ...runId ? { runId } : {}, ...error ? { error: error.slice(0, 500) } : {} }));
  }
}
class AsrCoordinator {
  constructor(local, cloud, reality, audioSync, transcriptionSync) {
    this.local = local;
    this.cloud = cloud;
    this.reality = reality;
    this.audioSync = audioSync;
    this.transcriptionSync = transcriptionSync;
  }
  async createJob(input) {
    if (input.recordingId && this.audioSync) {
      try {
        await this.audioSync.upload(input.filePath, input.recordingId, Math.max(0, input.durationMs ?? 0), "audio/mp4");
      } catch (error) {
        console.warn("Private audio sync deferred", error);
      }
    }
    const job = input.mode === "cloud" ? await this.cloud.createAsrJob(input) : { ...await this.local.createJob({ filePath: input.filePath, languageHints: input.languageHints, diarizationEnabled: input.diarizationEnabled, ...input.contextPrompt ? { contextPrompt: input.contextPrompt } : {} }), source: "local" };
    if (input.recordingId) {
      const event = await this.reality.applyAsr(input.recordingId, job);
      await this.publish(event, job);
    }
    return job;
  }
  async getJob(id) {
    const job = id.startsWith("saas:") ? await this.cloud.getAsrJob(id) : { ...await this.local.getJob(id), source: "local" };
    const event = await this.reality.applyAsrByJob(job).catch(() => void 0);
    if (event) await this.publish(event, job);
    return job;
  }
  async publish(event, job) {
    if (job.status !== "completed" || !job.result || !this.transcriptionSync) return;
    await this.transcriptionSync.publishLocalTranscription(event, job.result, job.provider).catch((error) => {
      console.warn("Private transcription source publication deferred", error);
    });
  }
}
function summaryDetailMinimum(transcriptLength) {
  if (transcriptLength > 5e3) return { overview: 600, keyPoints: 10 };
  if (transcriptLength > 1500) return { overview: 500, keyPoints: 7 };
  if (transcriptLength > 300) return { overview: 180, keyPoints: 4 };
  return null;
}
const UUID_PATTERN$1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function metadata(record) {
  return record.metadata ?? {};
}
function metadataString(record, key) {
  const value = metadata(record)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function validIso(value, fallback) {
  const date = new Date(value ?? fallback);
  const fallbackDate = new Date(fallback);
  return (Number.isNaN(date.getTime()) ? fallbackDate : date).toISOString();
}
function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}
function representativeTags(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const tag = item;
    if (tag.kind !== "entity" && tag.kind !== "fact" || typeof tag.label !== "string" || !tag.label.trim()) return [];
    const common2 = {
      ...typeof tag.id === "string" ? { id: tag.id } : {},
      kind: tag.kind,
      label: tag.label.trim(),
      ...typeof tag.normalizedKey === "string" ? { normalizedKey: tag.normalizedKey } : {},
      ...typeof tag.confidence === "number" ? { confidence: tag.confidence } : {},
      ...typeof tag.evidence === "string" ? { evidence: tag.evidence } : {},
      ...typeof tag.occurrenceCount === "number" ? { occurrenceCount: tag.occurrenceCount } : {}
    };
    if (tag.kind === "entity") {
      return [{ ...common2, ...typeof tag.entityType === "string" ? { entityType: tag.entityType } : {} }];
    }
    return [{
      ...common2,
      ...typeof tag.subject === "string" ? { subject: tag.subject } : {},
      ...typeof tag.predicate === "string" ? { predicate: tag.predicate } : {},
      ...typeof tag.object === "string" ? { object: tag.object } : {}
    }];
  });
}
function importedInsights(record, transcript) {
  const value = record ? metadata(record).summary : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const summary = value;
  const title = typeof summary.title === "string" ? summary.title.trim() : "";
  const overview = typeof summary.overview === "string" ? summary.overview.trim() : "";
  const keyPoints = stringArray(summary.keyPoints);
  const decisions = stringArray(summary.decisions);
  const unresolvedQuestions = stringArray(summary.unresolvedQuestions);
  const topics = stringArray(summary.topics);
  const eventTypes = ["MEETING", "WORK", "MEAL", "SOCIAL", "LEARNING", "CHITCHAT", "OTHER"];
  const eventType = eventTypes.includes(summary.eventType) ? summary.eventType : "OTHER";
  const tags = representativeTags(summary.representativeTags);
  const actionItems = Array.isArray(summary.actionItems) ? summary.actionItems.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const action = item;
    if (typeof action.text !== "string" || !action.text.trim()) return [];
    const details = [
      typeof action.owner === "string" && action.owner.trim() ? `负责人：${action.owner.trim()}` : "",
      typeof action.dueDate === "string" && action.dueDate.trim() ? `截止：${action.dueDate.trim()}` : ""
    ].filter(Boolean);
    return [`${action.text.trim()}${details.length ? `（${details.join("；")}）` : ""}`];
  }) : [];
  if (!title && !overview && !keyPoints.length && !decisions.length && !actionItems.length && !topics.length) return void 0;
  const firstSentence = transcript.split(/(?<=[。！？!?])|\n+/).map((item) => item.trim()).find(Boolean) ?? "";
  return {
    source: "generated",
    eventType,
    currentTopic: topics[0] || title || firstSentence.replace(/[。！？!?]$/, "").slice(0, 50) || null,
    summary: overview || null,
    keyPoints,
    decisions,
    actionItems,
    people: tags.filter((tag) => tag.kind === "entity" && tag.entityType === "person").map((tag) => tag.label),
    projects: tags.filter((tag) => tag.kind === "entity" && tag.entityType === "project").map((tag) => tag.label),
    unresolvedQuestions,
    representativeTags: tags,
    summaryRecordId: record?.recordId
  };
}
function hasMeaningfulSummary(record, source) {
  const value = record ? metadata(record).summary : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value;
  const title = typeof summary.title === "string" ? summary.title.trim() : "";
  const structurallyValid = Boolean(
    title && title !== "后台转写总结" && typeof summary.overview === "string" && summary.overview.trim() && stringArray(summary.keyPoints).length
  );
  if (!structurallyValid || !source) return structurallyValid;
  const transcriptLength = source.transcript.trim().length;
  const overviewLength = summary.overview.trim().length;
  const keyPointCount = stringArray(summary.keyPoints).length;
  const minimum = summaryDetailMinimum(transcriptLength);
  return !minimum || overviewLength >= minimum.overview && keyPointCount >= minimum.keyPoints;
}
function speakerId(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : null;
}
function toImportedRealityEvent(source, summary) {
  const sourceMetadata = metadata(source);
  const id = metadataString(source, "eventId") ?? source.recordId;
  if (!UUID_PATTERN$1.test(id)) return null;
  const startedAt = validIso(metadataString(source, "startedAt"), source.createdAt);
  const durationMs = typeof sourceMetadata.durationMillis === "number" && Number.isFinite(sourceMetadata.durationMillis) ? Math.max(0, Math.round(sourceMetadata.durationMillis)) : Math.max(0, Date.parse(metadataString(source, "endedAt") ?? source.updatedAt) - Date.parse(startedAt));
  const endedAt = metadataString(source, "endedAt") ? validIso(metadataString(source, "endedAt"), source.updatedAt) : new Date(Date.parse(startedAt) + durationMs).toISOString();
  const transcriptLines = Array.isArray(sourceMetadata.transcriptLines) ? sourceMetadata.transcriptLines : [];
  const normalizedLines = transcriptLines.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const line = value;
    if (typeof line.text !== "string" || !line.text.trim()) return [];
    return [{
      text: line.text.trim(),
      beginTime: typeof line.startOffsetMillis === "number" ? Math.max(0, line.startOffsetMillis) : 0,
      speakerId: speakerId(line.speaker)
    }];
  });
  const transcript = normalizedLines.map((line) => line.text).join("\n") || source.transcript.trim().replace(/^#\s*转写结果\s*/u, "");
  const transcriptSegments = normalizedLines.length ? normalizedLines.map((line, index) => ({
    ...line,
    endTime: Math.max(line.beginTime, normalizedLines[index + 1]?.beginTime ?? durationMs)
  })) : source.segments.map((segment) => ({
    text: segment.text,
    beginTime: Math.max(0, segment.beginTime),
    endTime: Math.max(segment.beginTime, segment.endTime),
    speakerId: segment.speakerId
  }));
  const insights = importedInsights(summary, transcript);
  const summaryTitle = summary && metadata(summary).summary && typeof metadata(summary).summary === "object" ? metadata(summary).summary.title : null;
  const title = typeof summaryTitle === "string" && summaryTitle.trim() ? summaryTitle.trim().slice(0, 120) : insights?.currentTopic?.slice(0, 120) || "iPhone 录音";
  const resultVersion = Math.max(
    1,
    Date.parse(source.updatedAt) || source.revision,
    summary ? Date.parse(summary.updatedAt) || summary.revision : 0
  );
  const captureDevice = sourceMetadata.captureDevice;
  const normalizedCaptureDevice = captureDevice && typeof captureDevice === "object" && !Array.isArray(captureDevice) && typeof captureDevice.id === "string" && typeof captureDevice.name === "string" && ["desktop", "iphone", "watch"].includes(String(captureDevice.kind)) ? captureDevice : { id: "synced-iphone", name: "iPhone", kind: "iphone" };
  const audioSource = sourceMetadata.audioSource === "system" ? "system" : "microphone";
  return {
    id,
    title,
    captureDevice: normalizedCaptureDevice,
    audioSource,
    durationMs,
    transcript,
    transcriptSegments,
    ...insights ? { insights } : {},
    resultVersion,
    startedAt,
    endedAt
  };
}
function parsePlaintext(recordId, plaintext, envelope) {
  let value;
  try {
    value = JSON.parse(plaintext.toString("utf8"));
  } catch {
    value = { transcript: plaintext.toString("utf8") };
  }
  const object = value && typeof value === "object" ? value : { transcript: String(value ?? "") };
  if (object.kind !== void 0 && !["everroom.transcription", "everroom.transcription-source", "everroom.transcription-summary"].includes(String(object.kind))) throw new Error(`转写记录 ${recordId} 的类型无效。`);
  if (object.eventId !== void 0 && object.eventId !== null && (typeof object.eventId !== "string" || !UUID_PATTERN$1.test(object.eventId))) {
    throw new Error(`转写记录 ${recordId} 的事件标识无效。`);
  }
  if (object.eventId === null || object.eventId === void 0) object.eventId = recordId;
  const transcriptLines = Array.isArray(object.transcriptLines) ? object.transcriptLines : [];
  const transcript = typeof object.transcript === "string" ? object.transcript : typeof object.rawTranscript === "string" ? object.rawTranscript : typeof object.detailMarkdown === "string" ? object.detailMarkdown : object.summary && typeof object.summary === "object" && typeof object.summary.overview === "string" ? object.summary.overview : transcriptLines.map((line) => line && typeof line === "object" && typeof line.text === "string" ? line.text : "").filter(Boolean).join("\n");
  const segments = Array.isArray(object.segments) ? object.segments.filter((segment) => {
    if (!segment || typeof segment !== "object") return false;
    const item = segment;
    return typeof item.text === "string" && typeof item.beginTime === "number" && typeof item.endTime === "number";
  }).map((segment) => ({
    text: segment.text,
    beginTime: segment.beginTime,
    endTime: segment.endTime,
    speakerId: typeof segment.speakerId === "number" ? segment.speakerId : null
  })) : [];
  const { transcript: _transcript, rawTranscript: _rawTranscript, segments: _segments, ...metadata2 } = object;
  return {
    recordId,
    revision: envelope.revision,
    createdAt: envelope.createdAt,
    updatedAt: envelope.updatedAt,
    transcript,
    segments,
    ...Object.keys(metadata2).length ? { metadata: metadata2 } : {}
  };
}
class PrivateTranscriptionSyncService {
  constructor(filePath, client, keyring, reality) {
    this.filePath = filePath;
    this.client = client;
    this.keyring = keyring;
    this.reality = reality;
  }
  loaded = false;
  state = { accounts: {} };
  syncing = null;
  /**
   * 物化闸门（可选）：materialize 写 Reality/MemoryCore 前等待其放行。
   * 用途：首登设备上云端历史转写若先于记忆引导的 overview 判定写入
   * MemoryCore L0，会被误判「已完成记忆设置」跳过引导——由桌面主进程
   * 注入「等记忆引导结束」的 gate。null/未设 = 不拦截。
   */
  materializeGate = null;
  setMaterializeGate(gate) {
    this.materializeGate = gate;
  }
  async initialize() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed.accounts && typeof parsed.accounts === "object") this.state = { accounts: parsed.accounts };
    } catch {
    }
  }
  async keyringStatus() {
    const account = await this.client.status();
    if (!account.authenticated || !account.user) {
      return { enabled: false, reason: "请先登录 EverRoom。", initialized: false, umkId: null, activeVersion: null, deviceStatus: "unregistered", verificationCode: null };
    }
    return { enabled: true, initialized: false, umkId: null, activeVersion: null, deviceStatus: "ready", verificationCode: null };
  }
  async createPairingSession() {
    const account = await this.client.status();
    if (!account.authenticated || !account.user) throw new Error("请先登录 EverRoom。");
    return this.keyring.createPairingSession(this.client, account.user.id);
  }
  async getPairingSession(id) {
    return this.client.getPairingSession(id);
  }
  async approvePairingSession(id) {
    const account = await this.client.status();
    if (!account.authenticated || !account.user) throw new Error("请先登录 EverRoom。");
    return this.keyring.approvePairingSession(this.client, account.user.id, id);
  }
  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.performSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }
  async publishLocalTranscription(event, result, provider) {
    await this.initialize();
    const account = await this.client.status();
    if (!account.authenticated || !account.user) throw new Error("请先登录 EverRoom。");
    const recordId = event.id;
    const transcriptLines = result.segments.length ? result.segments.map((segment) => ({
      speaker: segment.speakerId === null ? "发言人" : `发言人 ${segment.speakerId}`,
      startOffsetMillis: segment.beginTime,
      text: segment.text
    })) : [{ speaker: "发言人", startOffsetMillis: 0, text: result.transcript }];
    const payload = {
      kind: "everroom.transcription-source",
      schemaVersion: 3,
      eventId: recordId,
      startedAt: event.startedAt,
      endedAt: event.endedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      durationMillis: event.durationMs,
      provider,
      captureDevice: event.captureDevice,
      audioSource: event.audioSource,
      detailMarkdown: `# 转写结果

${result.transcript}`,
      transcriptLines,
      completedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const input = {
      recordType: "transcription_source",
      schemaVersion: 3,
      payload,
      expectedRevision: 0
    };
    const current = this.state.accounts[account.user.id] ?? { cursor: 0, records: {} };
    current.pendingSources ??= {};
    current.pendingSources[recordId] = { recordId, input, queuedAt: (/* @__PURE__ */ new Date()).toISOString() };
    this.state.accounts[account.user.id] = current;
    await this.persist();
    await this.flushPendingSources();
  }
  async flushPendingSources() {
    await this.initialize();
    const account = await this.client.status();
    if (!account.authenticated || !account.user) return;
    const current = this.state.accounts[account.user.id];
    if (!current?.pendingSources) return;
    for (const pending of Object.values(current.pendingSources)) {
      try {
        await this.client.putPrivateRecord(pending.recordId, pending.input);
        delete current.pendingSources[pending.recordId];
      } catch (error) {
        if (error instanceof Error && /revision mismatch.*actual [1-9]/i.test(error.message)) {
          delete current.pendingSources[pending.recordId];
          continue;
        }
        throw error;
      }
    }
    await this.persist();
  }
  async reconcileLocalTranscriptions() {
    await this.initialize();
    const account = await this.client.status();
    if (!account.authenticated || !account.user) return 0;
    const current = this.state.accounts[account.user.id] ?? { cursor: 0, records: {} };
    this.state.accounts[account.user.id] = current;
    const events = await this.reality.listEvents();
    let queued = 0;
    for (const event of events) {
      if (event.captureDevice.kind !== "desktop" || !event.transcript.trim()) continue;
      const existing = current.records[event.id];
      if (existing && metadataString(existing, "kind") === "everroom.transcription-source") continue;
      if (current.pendingSources?.[event.id]) continue;
      await this.publishLocalTranscription(event, {
        transcript: event.transcript,
        segments: event.transcriptSegments.map((segment) => ({
          text: segment.text,
          beginTime: segment.beginTime,
          endTime: segment.endTime,
          speakerId: segment.speakerId
        }))
      }, event.asrSource ?? "unknown");
      queued += 1;
    }
    return queued;
  }
  async list() {
    await this.initialize();
    const account = await this.client.status();
    if (!account.authenticated || !account.user) return [];
    return Object.values(this.state.accounts[account.user.id]?.records ?? {}).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  listTags() {
    return this.client.listSummaryTags();
  }
  async replaceSummaryTags(summaryRecordId, tags) {
    await this.client.replaceSummaryTags(summaryRecordId, tags);
    await this.sync();
  }
  async renameTag(tagId, label) {
    await this.client.renameSummaryTag(tagId, label);
    await this.sync();
  }
  async mergeTag(targetTagId, sourceTagId) {
    await this.client.mergeSummaryTag(targetTagId, sourceTagId);
    await this.sync();
  }
  async eventIdForSegment(segmentId) {
    const records = await this.list();
    for (const record of records) {
      const lines = metadata(record).transcriptLines;
      if (!Array.isArray(lines)) continue;
      if (lines.some((line) => line && typeof line === "object" && line.segmentId === segmentId)) return metadataString(record, "eventId") ?? record.recordId;
    }
    return null;
  }
  async materializeCached() {
    await this.initialize();
    const account = await this.client.status();
    if (!account.authenticated || !account.user) return;
    const current = this.state.accounts[account.user.id];
    if (!current) return;
    await this.materialize(current);
    await this.persist();
  }
  async performSync() {
    await this.initialize();
    const account = await this.client.status();
    if (!account.authenticated || !account.user) throw new Error("请先登录 EverRoom。");
    const userId = account.user.id;
    const status = { enabled: true, initialized: false, umkId: null, activeVersion: null, deviceStatus: "ready", verificationCode: null };
    const current = this.state.accounts[userId] ?? { cursor: 0, records: {} };
    let cursor = current.cursor;
    let synced = 0;
    let removed = 0;
    for (; ; ) {
      const page = await this.client.listPrivateRecords(cursor);
      if (!page.records.length) break;
      for (const envelope of page.records) {
        if (envelope.operation === "delete") {
          if (current.records[envelope.recordId]) removed += 1;
          delete current.records[envelope.recordId];
          cursor = Math.max(cursor, envelope.cursor);
          continue;
        }
        current.records[envelope.recordId] = this.readRecord(envelope);
        synced += 1;
        cursor = Math.max(cursor, envelope.cursor);
      }
      if (page.nextCursor <= cursor && page.records.length < 200) break;
      if (page.nextCursor <= cursor && page.records.length >= 200) break;
      cursor = Math.max(cursor, page.nextCursor);
      if (page.records.length < 200) break;
    }
    current.cursor = cursor;
    this.state.accounts[userId] = current;
    await this.persist();
    await this.materialize(current);
    await this.persist();
    if (cursor > 0) await this.client.acknowledgeSync(cursor);
    return { status, cursor, synced, removed, records: Object.values(current.records).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) };
  }
  readRecord(envelope) {
    if (!envelope.payload) throw new Error(`转写记录 ${envelope.recordId} 缺少明文内容。`);
    return parsePlaintext(
      envelope.recordId,
      Buffer.from(JSON.stringify(envelope.payload), "utf8"),
      envelope
    );
  }
  async materialize(current) {
    await this.materializeGate?.();
    const materialized = current.materialized ?? {};
    const invalidSummaryReports = current.invalidSummaryReports ?? {};
    const summaries = /* @__PURE__ */ new Map();
    for (const record of Object.values(current.records)) {
      if (metadataString(record, "kind") !== "everroom.transcription-summary") continue;
      const sourceRecordId = metadataString(record, "sourceRecordId");
      if (sourceRecordId) summaries.set(sourceRecordId, record);
    }
    const activeEventIds = /* @__PURE__ */ new Set();
    for (const source of Object.values(current.records)) {
      if (metadataString(source, "kind") === "everroom.transcription-summary") continue;
      const candidateSummary = summaries.get(source.recordId);
      const summary = hasMeaningfulSummary(candidateSummary, source) ? candidateSummary : void 0;
      if (candidateSummary && !summary && !invalidSummaryReports[candidateSummary.recordId]) {
        const sourceContentHash = metadataString(candidateSummary, "sourceContentHash");
        const sourceRevision = metadata(candidateSummary).sourceRevision;
        if (sourceContentHash && typeof sourceRevision === "number") {
          await this.client.reprocessTranscriptionSummary({
            sourceRecordId: source.recordId,
            sourceRevision,
            sourceContentHash,
            reason: "invalid_summary"
          });
          invalidSummaryReports[candidateSummary.recordId] = (/* @__PURE__ */ new Date()).toISOString();
        }
      }
      const input = toImportedRealityEvent(source, summary);
      if (!input) continue;
      activeEventIds.add(input.id);
      const fingerprint = `${source.revision}:${source.updatedAt}:${summary?.revision ?? 0}:${summary?.updatedAt ?? ""}:${summary ? "valid" : "missing"}`;
      if (materialized[input.id] === fingerprint) continue;
      await this.reality.importEvent(input);
      materialized[input.id] = fingerprint;
    }
    for (const eventId of Object.keys(materialized)) {
      if (activeEventIds.has(eventId)) continue;
      await this.reality.discard(eventId).catch(() => void 0);
      delete materialized[eventId];
    }
    for (const recordId of Object.keys(invalidSummaryReports)) {
      if (current.records[recordId]) continue;
      delete invalidSummaryReports[recordId];
    }
    current.materialized = materialized;
    current.invalidSummaryReports = invalidSummaryReports;
  }
  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.state), { mode: 384 });
    await chmod(this.filePath, 384);
  }
}
const DEFAULT_INTERVAL_MS = 15e3;
class PrivateSyncScheduler {
  constructor(sync, intervalMs = DEFAULT_INTERVAL_MS, onCompleted) {
    this.sync = sync;
    this.intervalMs = intervalMs;
    this.onCompleted = onCompleted;
  }
  timer = null;
  running = null;
  authenticated = false;
  setAuthenticated(authenticated) {
    this.authenticated = authenticated;
    if (authenticated) {
      this.start();
      void this.run();
    } else {
      this.stop();
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.authenticated = false;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run(), this.intervalMs);
  }
  async run() {
    if (!this.authenticated || this.running) return;
    this.running = this.sync.sync();
    try {
      const result = await this.running;
      this.onCompleted?.(result);
    } catch {
    } finally {
      this.running = null;
    }
  }
}
const POLL_INTERVAL_MS = 5e3;
const LEASE_RENEW_INTERVAL_MS = 45e3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class TranscriptionProcessingCoordinator {
  constructor(filePath, client, keyring, agent2, sync) {
    this.filePath = filePath;
    this.client = client;
    this.keyring = keyring;
    this.agent = agent2;
    this.sync = sync;
  }
  state = { version: 1, jobs: {} };
  loaded = false;
  running = false;
  stopped = true;
  timer = null;
  registeredKey = null;
  async initialize() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8"));
      if (value.version === 1 && value.jobs && typeof value.jobs === "object") {
        this.state = { version: 1, jobs: value.jobs };
      }
    } catch {
    }
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }
  /** Wake the processor immediately after login or a new source publication. */
  wake() {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.tick();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      await this.processOne();
    } catch (error) {
      console.warn("Background transcription processing tick failed.", error);
    } finally {
      this.running = false;
      if (!this.stopped) this.timer = setTimeout(() => void this.tick(), POLL_INTERVAL_MS);
    }
  }
  async processOne() {
    await this.initialize();
    const account = await this.client.status();
    if (!account.authenticated || !account.user || !account.device) return;
    const registrationKey = `${account.user.id}:${account.device.id}`;
    if (this.registeredKey !== registrationKey) {
      this.registeredKey = null;
      await this.client.registerProcessorDevice();
      this.registeredKey = registrationKey;
    }
    try {
      await this.sync?.reconcileLocalTranscriptions();
      await this.sync?.flushPendingSources();
      await this.sync?.sync();
    } catch (error) {
      console.warn("Background transcription sync deferred while processing.", error);
    }
    let claim;
    try {
      claim = await this.client.claimProcessingJob();
    } catch (error) {
      this.registeredKey = null;
      throw error;
    }
    if (!claim) return;
    const { job, leaseToken } = claim;
    const stored = this.state.jobs[job.id];
    const reusable = stored && stored.sourceRecordId === job.sourceRecordId && stored.sourceRevision === job.sourceRevision && stored.sourceContentHash === job.sourceContentHash ? stored.result : void 0;
    this.state.jobs[job.id] = {
      sourceRecordId: job.sourceRecordId,
      sourceRevision: job.sourceRevision,
      sourceContentHash: job.sourceContentHash,
      ...reusable ? { result: reusable } : {},
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await this.persist();
    let resultReady = Boolean(reusable);
    try {
      await this.client.startProcessingJob(job.id, leaseToken);
      const renewTimer = setInterval(() => {
        void this.client.renewProcessingJob(job.id, leaseToken).catch((error) => {
          console.warn(`Unable to renew processing lease ${job.id}.`, error);
        });
      }, LEASE_RENEW_INTERVAL_MS);
      try {
        if (!reusable) {
          const envelope = await this.client.getPrivateRecord(job.sourceRecordId);
          const source = this.readSource(envelope, job);
          const transcript = transcriptText(source);
          const response = await this.agent.summarizeTranscription({
            jobId: job.id,
            sourceRecordId: job.sourceRecordId,
            transcript,
            language: getDesktopLocale()
          });
          const summary = parseSummary(response.content, transcript);
          const result2 = createSummary(job, summary);
          this.state.jobs[job.id].result = result2;
          this.state.jobs[job.id].updatedAt = (/* @__PURE__ */ new Date()).toISOString();
          await this.persist();
          resultReady = true;
        }
      } finally {
        clearInterval(renewTimer);
      }
      const result = this.state.jobs[job.id]?.result;
      if (!result) throw new Error("processing_result_missing");
      await this.client.completeProcessingJob(job.id, { ...result, leaseToken });
      delete this.state.jobs[job.id];
      await this.persist();
      try {
        await this.sync?.sync();
      } catch (error) {
        console.warn("Completed transcription summary sync deferred.", error);
      }
    } catch (error) {
      if (!resultReady) {
        await this.client.failProcessingJob(job.id, {
          leaseToken,
          errorCode: errorCode(error),
          errorClass: isPermanent(error) ? "permanent" : "retryable"
        }).catch(() => void 0);
      }
      throw error;
    }
  }
  readSource(envelope, job) {
    if (envelope.recordType !== "transcription_source") throw new Error("invalid_source_record_type");
    if (envelope.recordId !== job.sourceRecordId || envelope.revision !== job.sourceRevision || envelope.contentHash !== job.sourceContentHash) {
      throw new Error("source_revision_changed");
    }
    const value = envelope.payload;
    if (!value || value.kind !== "everroom.transcription-source" || value.schemaVersion !== 3 || typeof value.eventId !== "string" || !UUID_PATTERN.test(value.eventId)) {
      throw new Error("invalid_transcription_source");
    }
    return value;
  }
  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.state), { mode: 384 });
    await chmod(this.filePath, 384);
  }
}
function transcriptText(source) {
  const lines = (source.transcriptLines ?? []).filter((line) => typeof line?.text === "string" && Boolean(line.text.trim())).map((line) => {
    const seconds = Math.max(0, Math.floor((line.startOffsetMillis ?? 0) / 1e3));
    const timestamp2 = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    return `[${timestamp2}] ${line.speaker?.trim() || "发言人"}：${line.text.trim()}`;
  });
  const text2 = lines.join("\n") || source.detailMarkdown?.trim() || "";
  if (!text2) throw new Error("empty_transcription_source");
  const maxBytes = 19e5;
  if (Buffer.byteLength(text2, "utf8") <= maxBytes) return text2;
  const marker = "\n\n[转写中间过长，已省略]\n\n";
  const availableBytes = maxBytes - Buffer.byteLength(marker, "utf8");
  let headChars = Math.floor(text2.length * 0.65);
  let tailChars = Math.floor(text2.length * 0.35);
  while (Buffer.byteLength(text2.slice(0, headChars), "utf8") + Buffer.byteLength(text2.slice(-tailChars), "utf8") > availableBytes) {
    headChars = Math.floor(headChars * 0.95);
    tailChars = Math.floor(tailChars * 0.95);
  }
  return `${text2.slice(0, headChars)}${marker}${text2.slice(-tailChars)}`;
}
function parseSummary(raw, transcript) {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error("invalid_agent_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_agent_summary");
  const object = value;
  const eventTypes = ["MEETING", "WORK", "MEAL", "SOCIAL", "LEARNING", "CHITCHAT", "OTHER"];
  const eventType = eventTypes.includes(object.eventType) ? object.eventType : "OTHER";
  const string = (key, max2) => {
    if (typeof object[key] !== "string") throw new Error(`invalid_agent_${key}`);
    return object[key].trim().slice(0, max2);
  };
  const strings = (key, maxItems) => {
    if (!Array.isArray(object[key]) || !object[key].every((item) => typeof item === "string")) throw new Error(`invalid_agent_${key}`);
    return object[key].slice(0, maxItems).map((item) => item.trim().slice(0, 1e3)).filter(Boolean);
  };
  if (!Array.isArray(object.actionItems)) throw new Error("invalid_agent_actionItems");
  const actionItems = object.actionItems.slice(0, 50).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid_agent_actionItem");
    const action = item;
    if (typeof action.text !== "string") throw new Error("invalid_agent_actionItem_text");
    if (action.owner !== null && typeof action.owner !== "string") throw new Error("invalid_agent_actionItem_owner");
    if (action.dueDate !== null && typeof action.dueDate !== "string") throw new Error("invalid_agent_actionItem_dueDate");
    return {
      text: action.text.trim().slice(0, 1e3),
      owner: typeof action.owner === "string" ? action.owner.trim().slice(0, 200) || null : null,
      dueDate: typeof action.dueDate === "string" ? action.dueDate.trim().slice(0, 100) || null : null
    };
  }).filter((item) => item.text);
  const representativeTags2 = object.representativeTags === void 0 ? [] : parseRepresentativeTags(object.representativeTags);
  const summary = {
    eventType,
    title: string("title", 200),
    overview: string("overview", 5e3),
    keyPoints: strings("keyPoints", 50),
    decisions: strings("decisions", 50),
    actionItems,
    unresolvedQuestions: object.unresolvedQuestions === void 0 ? [] : strings("unresolvedQuestions", 50),
    topics: strings("topics", 30),
    representativeTags: representativeTags2
  };
  if (!summary.title || summary.title === "后台转写总结" || !summary.overview || !summary.keyPoints.length) {
    throw new Error("empty_agent_summary");
  }
  const transcriptLength = transcript.trim().length;
  const minimum = summaryDetailMinimum(transcriptLength);
  if (minimum && (summary.overview.length < minimum.overview || summary.keyPoints.length < minimum.keyPoints)) {
    throw new Error("incomplete_agent_summary");
  }
  return summary;
}
function parseRepresentativeTags(value) {
  if (!Array.isArray(value)) throw new Error("invalid_agent_representativeTags");
  return value.slice(0, 12).map((item) => {
    if (typeof item === "string") {
      const label = item.trim().slice(0, 200);
      if (!label) throw new Error("invalid_agent_representativeTag_label");
      return {
        kind: "entity",
        label,
        entityType: "other",
        confidence: 0.5,
        evidence: label
      };
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid_agent_representativeTag");
    const tag = item;
    if (tag.kind !== "entity" && tag.kind !== "fact") throw new Error("invalid_agent_representativeTag_kind");
    if (typeof tag.label !== "string" || !tag.label.trim()) throw new Error("invalid_agent_representativeTag_label");
    if (typeof tag.confidence !== "number" || !Number.isFinite(tag.confidence)) throw new Error("invalid_agent_representativeTag_confidence");
    if (typeof tag.evidence !== "string") throw new Error("invalid_agent_representativeTag_evidence");
    const common2 = {
      kind: tag.kind,
      label: tag.label.trim().slice(0, 200),
      confidence: Math.max(0, Math.min(1, tag.confidence)),
      evidence: tag.evidence.trim().slice(0, 1e3)
    };
    if (tag.kind === "entity") {
      const entityTypes = ["person", "organization", "project", "product", "place", "other"];
      const normalizedType = typeof tag.entityType === "string" ? tag.entityType.trim().toLowerCase() : "";
      const entityType = entityTypes.includes(normalizedType) ? normalizedType : "other";
      return { ...common2, kind: "entity", entityType };
    }
    if (typeof tag.subject !== "string" || typeof tag.predicate !== "string" || typeof tag.object !== "string") {
      throw new Error("invalid_agent_representativeTag_fact");
    }
    const subject = tag.subject.trim().slice(0, 200);
    const predicate = tag.predicate.trim().slice(0, 200);
    const factObject = tag.object.trim().slice(0, 500);
    if (!subject || !predicate || !factObject) throw new Error("invalid_agent_representativeTag_fact");
    return { ...common2, kind: "fact", subject, predicate, object: factObject };
  });
}
function createSummary(job, summary) {
  const resultRecordId = randomUUID();
  const payload = {
    kind: "everroom.transcription-summary",
    schemaVersion: 1,
    workflow: job.workflow,
    workflowVersion: job.workflowVersion,
    sourceRecordId: job.sourceRecordId,
    sourceRevision: job.sourceRevision,
    sourceContentHash: job.sourceContentHash,
    summary,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  return {
    resultRecordId,
    payload
  };
}
function errorCode(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "processing_failed";
}
function isPermanent(error) {
  return error instanceof Error && /invalid_source|invalid_transcription|empty_transcription|source_revision/.test(error.message);
}
const AUDIO_CHUNK_SIZE = 4 * 1024 * 1024;
function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
class PrivateAudioSyncService {
  constructor(client, keyring, recordingsDirectory, queueFile) {
    this.client = client;
    this.keyring = keyring;
    this.recordingsDirectory = recordingsDirectory;
    this.queueFile = queueFile;
  }
  eventResolver = null;
  setEventResolver(resolver) {
    this.eventResolver = resolver;
  }
  async drainPending() {
    let pending = [];
    try {
      pending = JSON.parse(await readFile(this.queueFile, "utf8"));
    } catch {
      return;
    }
    const remaining = [];
    for (const item of pending) {
      try {
        await this.upload(item.filePath, item.recordingId, item.durationMs, item.mimeType, false);
      } catch {
        remaining.push(item);
      }
    }
    await mkdir(dirname(this.queueFile), { recursive: true });
    await writeFile(this.queueFile, JSON.stringify(remaining), { mode: 384 });
  }
  async list(cursor = 0) {
    const page = await this.client.listPrivateAudio(cursor);
    if (!this.eventResolver) return page;
    return { ...page, assets: await Promise.all(page.assets.map(async (asset) => ({ ...asset, eventId: asset.eventId && asset.eventId !== asset.recordingId ? asset.eventId : await this.eventResolver(asset.recordingId) ?? asset.eventId }))) };
  }
  async downloadById(assetId, outputPath) {
    const page = await this.list(0);
    const asset = page.assets.find((item) => item.id === assetId);
    if (!asset) throw new Error("音频资产不存在。");
    return this.download(asset, outputPath);
  }
  async read(assetId) {
    const page = await this.list(0);
    const asset = page.assets.find((item) => item.id === assetId && item.status === "uploaded");
    if (!asset) throw new Error("音频资产不存在或尚未上传完成。");
    const outputPath = join(this.recordingsDirectory, `.synced-${asset.id}`);
    try {
      await this.download(asset, outputPath);
      return { bytes: new Uint8Array(await readFile(outputPath)), mimeType: asset.mimeType };
    } finally {
      await rm(outputPath, { force: true }).catch(() => void 0);
    }
  }
  async upload(filePath, recordingId, durationMs, mimeType, enqueueOnFailure = true) {
    const account = await this.client.status();
    if (!account.authenticated || !account.user) throw new Error("请先登录后同步录音。");
    const resolvedPath = isAbsolute(filePath) ? filePath : join(this.recordingsDirectory, filePath);
    const plain = await readFile(resolvedPath);
    if (!plain.length) throw new Error("录音文件为空。");
    const chunks = [];
    for (let offset = 0, index = 0; offset < plain.length; offset += AUDIO_CHUNK_SIZE, index += 1) {
      const piece = plain.subarray(offset, Math.min(plain.length, offset + AUDIO_CHUNK_SIZE));
      chunks.push(piece);
    }
    const asset = await this.client.createPrivateAudio({
      recordingId,
      fileName: basename(resolvedPath),
      mimeType,
      durationMs,
      fileSize: plain.length,
      contentHash: hash(plain),
      chunkCount: chunks.length,
      chunkSize: AUDIO_CHUNK_SIZE
    });
    try {
      for (let index = 0, plainOffset = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const plainSize = Math.min(AUDIO_CHUNK_SIZE, plain.length - plainOffset);
        plainOffset += plainSize;
        const authorization = await this.client.authorizePrivateAudioChunk(asset.id, index, { fileSize: plainSize, contentHash: hash(chunk) });
        await axios.put(authorization.uploadUrl, chunk, { headers: { ...authorization.headers, "Content-Length": String(chunk.length) }, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 5 * 6e4 });
        await this.client.completePrivateAudioChunk(asset.id, index);
      }
      return await this.client.completePrivateAudioChunks(asset.id);
    } catch (error) {
      if (enqueueOnFailure) await this.enqueue({ filePath, recordingId, durationMs, mimeType });
      throw error;
    }
  }
  async enqueue(item) {
    let pending = [];
    try {
      pending = JSON.parse(await readFile(this.queueFile, "utf8"));
    } catch {
    }
    if (!pending.some((entry) => entry.recordingId === item.recordingId)) pending.push(item);
    await mkdir(dirname(this.queueFile), { recursive: true });
    await writeFile(this.queueFile, JSON.stringify(pending), { mode: 384 });
  }
  async download(asset, outputPath) {
    const account = await this.client.status();
    if (!account.authenticated || !account.user) throw new Error("请先登录后下载录音。");
    const chunks = [];
    const count = asset.chunkCount ?? 1;
    const chunked = !asset.objectKey;
    for (let index = 0; index < count; index += 1) {
      const authorization = chunked ? await this.client.authorizePrivateAudioChunkDownload(asset.id, index) : await this.client.authorizePrivateAudioDownload(asset.id);
      const response = await axios.get(authorization.downloadUrl, { responseType: "arraybuffer", timeout: 5 * 6e4 });
      chunks.push(Buffer.from(response.data));
    }
    const plain = Buffer.concat(chunks);
    if (hash(plain) !== asset.contentHash) throw new Error("音频完整性校验失败。");
    await writeFile(outputPath, plain, { mode: 384 });
    return outputPath;
  }
}
const SCREENSHOT_DEFAULT_INTERVAL_MS = 3e5;
const SCREENSHOT_MIN_INTERVAL_MS = 3e4;
const SCREENSHOT_MAX_INTERVAL_MS = 36e5;
function normalizeIntervalMs(value) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : SCREENSHOT_DEFAULT_INTERVAL_MS;
  return Math.min(SCREENSHOT_MAX_INTERVAL_MS, Math.max(SCREENSHOT_MIN_INTERVAL_MS, numeric));
}
function getScreenshotDirectory() {
  const configured2 = process.env.NXCORE_SCREENSHOT_DIR?.trim();
  if (configured2) return configured2;
  if (!app.isPackaged) return join(app.getAppPath(), "..", "..", "screenshots");
  return join(app.getPath("userData"), "screenshots");
}
function sanitizeFileTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}
function calculateDHash(image) {
  const sample = image.resize({ width: 9, height: 8, quality: "best" });
  const pixels = sample.toBitmap();
  let hash2 = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = (y * 9 + x) * 4;
      const right = left + 4;
      const leftBrightness = pixels[left] + pixels[left + 1] + pixels[left + 2];
      const rightBrightness = pixels[right] + pixels[right + 1] + pixels[right + 2];
      hash2 = hash2 << 1n | (leftBrightness > rightBrightness ? 1n : 0n);
    }
  }
  return hash2.toString(16).padStart(16, "0");
}
async function captureCurrentWindow(window2 = BrowserWindow.getAllWindows()[0] ?? null) {
  if (!window2 || window2.isDestroyed() || window2.webContents.isDestroyed()) {
    return { ok: false, code: "window-unavailable", message: desktopText("error.screenshot.windowUnavailable") };
  }
  let image;
  try {
    image = await window2.webContents.capturePage();
  } catch {
    return { ok: false, code: "capture-failed", message: desktopText("error.screenshot.captureFailed") };
  }
  if (image.isEmpty()) {
    return { ok: false, code: "capture-failed", message: desktopText("error.screenshot.empty") };
  }
  const size = image.getSize();
  const perceptualHash = calculateDHash(image);
  let jpeg;
  try {
    jpeg = image.toJPEG(82);
  } catch {
    return { ok: false, code: "capture-failed", message: desktopText("error.screenshot.encodingFailed") };
  }
  if (!jpeg.byteLength) {
    return { ok: false, code: "capture-failed", message: desktopText("error.screenshot.empty") };
  }
  const capturedAt = /* @__PURE__ */ new Date();
  const fileName = `EverRoom-window-${sanitizeFileTimestamp(capturedAt)}-${randomUUID()}.jpg`;
  const directory = getScreenshotDirectory();
  const filePath = join(directory, fileName);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, jpeg, { flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch {
    await unlink(temporaryPath).catch(() => void 0);
    return { ok: false, code: "save-failed", message: desktopText("error.screenshot.saveFailed") };
  }
  return {
    ok: true,
    filePath,
    fileName,
    width: size.width,
    height: size.height,
    bytes: jpeg.byteLength,
    capturedAt: capturedAt.toISOString(),
    perceptualHash
  };
}
function createWindowScreenshotScheduler(capture = () => captureCurrentWindow(), timerApi = globalThis, onCaptured) {
  let enabled = false;
  let intervalMs = SCREENSHOT_DEFAULT_INTERVAL_MS;
  let timer = null;
  let inFlight = null;
  let lastResult = null;
  const clearScheduledTimer = () => {
    if (timer) timerApi.clearTimeout(timer);
    timer = null;
  };
  const getStatus = () => ({ enabled, intervalMs, lastResult });
  const scheduleNext = () => {
    if (!enabled || timer || inFlight) return;
    timer = timerApi.setTimeout(() => {
      timer = null;
      void runCapture();
    }, intervalMs);
  };
  const runCapture = async () => {
    if (!enabled || inFlight) return;
    const current = capture().then(async (result) => {
      lastResult = result;
      if (result.ok) await Promise.resolve(onCaptured?.(result)).catch(() => void 0);
    }).catch(() => {
      lastResult = { ok: false, code: "capture-failed", message: desktopText("error.screenshot.captureFailed") };
    });
    inFlight = current;
    try {
      await current;
    } finally {
      inFlight = null;
      scheduleNext();
    }
  };
  return {
    start: async (nextIntervalMs) => {
      if (inFlight) await inFlight;
      clearScheduledTimer();
      enabled = true;
      intervalMs = normalizeIntervalMs(nextIntervalMs);
      await runCapture();
      return getStatus();
    },
    updateInterval: (nextIntervalMs) => {
      intervalMs = normalizeIntervalMs(nextIntervalMs);
      clearScheduledTimer();
      scheduleNext();
      return getStatus();
    },
    stop: () => {
      clearScheduledTimer();
      enabled = false;
      return getStatus();
    },
    getStatus
  };
}
class ScreenshotOutbox {
  constructor(statePath, getSupervisor) {
    this.statePath = statePath;
    this.getSupervisor = getSupervisor;
  }
  items = [];
  initialized = false;
  operation = Promise.resolve();
  timer = null;
  async initialize() {
    if (this.initialized) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8"));
      this.items = Array.isArray(parsed) ? parsed.filter(isOutboxItem) : [];
    } catch {
      this.items = [];
    }
    this.initialized = true;
    this.timer = setInterval(() => void this.flush(), 15e3);
    this.timer.unref?.();
    void this.flush();
  }
  async enqueue(result) {
    if (!result.perceptualHash) throw new Error("Screenshot perceptual hash is missing");
    const perceptualHash = result.perceptualHash;
    await this.initialize();
    await this.serial(async () => {
      if (this.items.some((item) => item.filePath === result.filePath)) return;
      this.items.push({
        id: randomUUID(),
        filePath: result.filePath,
        fileName: result.fileName,
        width: result.width,
        height: result.height,
        capturedAt: result.capturedAt,
        perceptualHash
      });
      await this.persist();
    });
    void this.flush();
  }
  flush() {
    return this.serial(async () => {
      const supervisor = this.getSupervisor();
      if (!supervisor || this.items.length === 0) return;
      let connection;
      try {
        connection = await supervisor.ensureConnection();
      } catch {
        return;
      }
      while (this.items[0]) {
        const item = this.items[0];
        try {
          if (!item.uploadedFileId) {
            const bytes = await readFile(item.filePath);
            const upload = await fetch(`${connection.baseUrl}/v1/files`, {
              method: "POST",
              headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                filename: item.fileName,
                contentBase64: bytes.toString("base64"),
                mime: "image/jpeg",
                assetKind: "screenshot",
                originChannel: "everroom-window-capture",
                visibility: "private",
                capturedAt: item.capturedAt
              })
            });
            if (!upload.ok) throw new Error(`Screenshot upload failed (${String(upload.status)})`);
            const uploaded = await upload.json();
            if (typeof uploaded.id !== "string") throw new Error("Screenshot upload returned no file id");
            item.uploadedFileId = uploaded.id;
            await this.persist();
          }
          const observation = await fetch(`${connection.baseUrl}/v1/perception/visual-observations`, {
            method: "POST",
            headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              fileId: item.uploadedFileId,
              kind: "screenshot",
              capturedAt: item.capturedAt,
              perceptualHash: item.perceptualHash,
              width: item.width,
              height: item.height
            })
          });
          if (!observation.ok) throw new Error(`Screenshot observation failed (${String(observation.status)})`);
          this.items.shift();
          await this.persist();
          await unlink(item.filePath).catch(() => void 0);
        } catch {
          return;
        }
      }
    });
  }
  async dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.operation;
  }
  serial(action) {
    const next = this.operation.then(action, action);
    this.operation = next.catch(() => void 0);
    return next;
  }
  async persist() {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.items), { flag: "wx", mode: 384 });
      await rename(temporary, this.statePath);
    } finally {
      await unlink(temporary).catch(() => void 0);
    }
  }
}
function isOutboxItem(value) {
  if (!value || typeof value !== "object") return false;
  const row = value;
  return ["id", "filePath", "fileName", "capturedAt", "perceptualHash"].every((key) => typeof row[key] === "string") && typeof row.width === "number" && typeof row.height === "number" && (row.uploadedFileId === void 0 || typeof row.uploadedFileId === "string");
}
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}
function createDocumentPdfHtml({ title, contentHtml, locale = "zh-CN" }) {
  const safeTitle = escapeHtml(title.trim() || translateDesktopMessage(locale, "document.untitled"));
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob: https: http: nxcore-document-asset:">
  <meta name="color-scheme" content="light">
  <title>${safeTitle}</title>
  <style>
    @page {
      size: A4;
      margin: 18mm 16mm 20mm;
    }

    *, *::before, *::after {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      background: #ffffff;
      color: #25282d;
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
      font-size: 10.5pt;
      line-height: 1.75;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }

    body {
      min-width: 0;
    }

    .document {
      width: 100%;
      margin: 0;
      background: #ffffff;
    }

    .document-title {
      margin: 0 0 10mm;
      color: #17191d;
      font-size: 24pt;
      font-weight: 700;
      line-height: 1.25;
      overflow-wrap: anywhere;
      break-after: avoid-page;
    }

    .document-content > :first-child {
      margin-top: 0;
    }

    .document-content > :last-child {
      margin-bottom: 0;
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      color: #17191d;
      font-weight: 650;
      line-height: 1.35;
      break-after: avoid-page;
      page-break-after: avoid;
    }

    h1 { margin: 9mm 0 3.5mm; font-size: 20pt; }
    h2 { margin: 7mm 0 3mm; font-size: 15.5pt; }
    h3 { margin: 6mm 0 2.5mm; font-size: 13pt; }
    h4 { margin: 5mm 0 2mm; font-size: 11.5pt; }
    h5 { margin: 4mm 0 2mm; font-size: 10.5pt; }
    h6 { margin: 4mm 0 2mm; font-size: 9.5pt; }

    p {
      margin: 0 0 3.2mm;
      orphans: 3;
      widows: 3;
    }

    strong { font-weight: 700; }
    s { text-decoration-thickness: 1px; }

    ul,
    ol {
      margin: 0 0 4mm;
      padding-left: 7mm;
    }

    li {
      margin: 0.8mm 0;
      orphans: 2;
      widows: 2;
    }

    li > p {
      margin-bottom: 1.2mm;
    }

    ul[data-type='taskList'] {
      padding-left: 0;
      list-style: none;
    }

    ul[data-type='taskList'] li {
      display: grid;
      grid-template-columns: 5mm minmax(0, 1fr);
      column-gap: 2mm;
      align-items: start;
    }

    ul[data-type='taskList'] li > label {
      display: block;
      line-height: 1.75;
    }

    ul[data-type='taskList'] input[type='checkbox'] {
      width: 3.5mm;
      height: 3.5mm;
      margin: 1.2mm 0 0;
      accent-color: #3d6fa8;
    }

    ul[data-type='taskList'] li > div {
      min-width: 0;
    }

    ul[data-type='taskList'] li[data-checked='true'] > div {
      color: #717780;
      text-decoration: line-through;
    }

    blockquote {
      margin: 5mm 0;
      padding: 1mm 0 1mm 4mm;
      border-left: 1.2mm solid #c8d0da;
      color: #555b64;
    }

    blockquote > :last-child {
      margin-bottom: 0;
    }

    code {
      padding: 0.35mm 1.1mm;
      border-radius: 1mm;
      background: #f0f2f4;
      color: #25282d;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 0.9em;
    }

    pre {
      margin: 5mm 0;
      padding: 4mm 4.5mm;
      border: 0.25mm solid #d8dde3;
      border-radius: 1.5mm;
      background: #f4f5f7;
      color: #202329;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 8.5pt;
      line-height: 1.58;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      break-inside: auto;
      page-break-inside: auto;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }

    pre code {
      padding: 0;
      border-radius: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      white-space: inherit;
    }

    .tableWrapper {
      width: 100%;
      margin: 5mm 0;
      overflow: visible;
    }

    table {
      width: 100%;
      margin: 5mm 0;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 9pt;
    }

    .tableWrapper table {
      margin: 0;
    }

    thead {
      display: table-header-group;
    }

    tr,
    img {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    th,
    td {
      min-width: 0;
      padding: 2.2mm 2.6mm;
      border: 0.25mm solid #cfd5dc;
      vertical-align: top;
      text-align: left;
      overflow-wrap: anywhere;
    }

    th {
      background: #edf0f3;
      color: #202329;
      font-weight: 700;
    }

    th > p,
    td > p {
      margin: 0;
    }

    img {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 5mm auto;
      object-fit: contain;
    }

    hr {
      margin: 7mm 0;
      border: 0;
      border-top: 0.25mm solid #cfd5dc;
    }

    a {
      color: #285f99;
      text-decoration: underline;
      text-decoration-thickness: 0.2mm;
      text-underline-offset: 0.5mm;
      overflow-wrap: anywhere;
    }

    a[href^='everroom://'] {
      color: #3d5875;
      text-decoration-style: dotted;
    }

    [data-document-block-reference] {
      margin: 4mm 0;
      padding: 3mm 3.5mm;
      border-left: 1mm solid #91a4b8;
      background: #f2f4f6;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    [data-document-block-reference] strong,
    [data-document-block-reference] small {
      display: block;
    }

    [data-document-block-reference] small {
      margin-top: 0.8mm;
      color: #606873;
      font-size: 9pt;
    }

    [data-placeholder]::before,
    .is-empty::before {
      content: none !important;
    }
  </style>
</head>
<body>
  <main class="document">
    <h1 class="document-title">${safeTitle}</h1>
    <article class="document-content">${contentHtml}</article>
  </main>
</body>
</html>`;
}
const DOCUMENT_PDF_EXPORT_CHANNEL = "documents:export-pdf";
const MAX_PDF_HTML_BYTES = 8 * 1024 * 1024;
const MAX_PDF_TITLE_LENGTH = 120;
function pdfExportInput(input) {
  if (!input || typeof input !== "object") throw new Error(desktopText("error.pdf.invalidRequest"));
  const value = input;
  if (typeof value.fileName !== "string") throw new Error(desktopText("error.pdf.invalidFileName"));
  if (typeof value.title !== "string" || value.title.length > MAX_PDF_TITLE_LENGTH) {
    throw new Error(desktopText("error.pdf.invalidTitle"));
  }
  if (typeof value.html !== "string" || !value.html.trim() || Buffer.byteLength(value.html, "utf8") > MAX_PDF_HTML_BYTES) {
    throw new Error(desktopText("error.pdf.invalidContent"));
  }
  const safeName = basename(value.fileName).replace(/[\\/:*?"<>|]/g, "-").replace(/[.\s]+$/g, "").trim().slice(0, 180);
  const fileName = safeName || desktopText("document.untitled");
  return {
    fileName: fileName.toLowerCase().endsWith(".pdf") ? fileName : `${fileName}.pdf`,
    title: value.title.trim() || desktopText("document.untitled"),
    html: value.html
  };
}
async function waitForDocumentAssets(window2) {
  await window2.webContents.executeJavaScript(`
    Promise.race([
      Promise.all([
        document.fonts.ready,
        ...Array.from(document.images, (image) => image.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              image.addEventListener('load', resolve, { once: true })
              image.addEventListener('error', resolve, { once: true })
            })),
      ]),
      new Promise((resolve) => setTimeout(resolve, 10000)),
    ]).then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  `, true);
}
async function renderPdf(input) {
  const printWindow = new BrowserWindow({
    show: false,
    width: 794,
    height: 1123,
    backgroundColor: "#ffffff",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  printWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  try {
    const documentHtml = createDocumentPdfHtml({
      title: input.title,
      contentHtml: input.html,
      locale: getDesktopLocale()
    });
    const dataUrl = `data:text/html;base64,${Buffer.from(documentHtml, "utf8").toString("base64")}`;
    await printWindow.loadURL(dataUrl);
    await waitForDocumentAssets(printWindow);
    return await printWindow.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      generateTaggedPDF: true,
      generateDocumentOutline: true
    });
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}
function registerDocumentPdfExportHandler() {
  ipcMain.handle(
    DOCUMENT_PDF_EXPORT_CHANNEL,
    async (event, input) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.isDestroyed() || event.sender.isDestroyed()) {
        throw new Error(desktopText("error.pdf.invalidSource"));
      }
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error(desktopText("error.pdf.invalidSource"));
      }
      const validatedInput = pdfExportInput(input);
      const selection = await dialog.showSaveDialog(owner, {
        title: desktopText("dialog.exportPdf.title"),
        defaultPath: validatedInput.fileName,
        buttonLabel: desktopText("dialog.exportPdf.button"),
        filters: [{ name: desktopText("dialog.exportPdf.pdfDocument"), extensions: ["pdf"] }],
        properties: ["showOverwriteConfirmation", "createDirectory"]
      });
      if (selection.canceled || !selection.filePath) return { canceled: true };
      const filePath = selection.filePath.toLowerCase().endsWith(".pdf") ? selection.filePath : `${selection.filePath}.pdf`;
      const pdf = await renderPdf(validatedInput);
      await writeFile(filePath, pdf);
      return {
        canceled: false,
        filePath,
        fileName: basename(filePath)
      };
    }
  );
}
const SYSTEM_CLIPBOARD_WRITE_TEXT_CHANNEL = "system-clipboard:write-text";
const MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024;
function validatedClipboardText(value) {
  if (typeof value !== "string") throw new Error("无效的剪贴板文本。");
  if (Buffer.byteLength(value, "utf8") > MAX_CLIPBOARD_TEXT_BYTES) {
    throw new Error("剪贴板文本过大。");
  }
  return value;
}
function registerSystemClipboardHandler() {
  ipcMain.handle(SYSTEM_CLIPBOARD_WRITE_TEXT_CHANNEL, (event, value) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || event.sender.isDestroyed()) {
      throw new Error("无法验证剪贴板写入来源。");
    }
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error("无法验证剪贴板写入来源。");
    }
    clipboard.writeText(validatedClipboardText(value));
  });
}
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Embedder-Policy": ["require-corp"],
  "Cross-Origin-Opener-Policy": ["same-origin"]
};
function isRendererResourceUrl(url, rendererUrl) {
  if (!rendererUrl) return url.startsWith("file://");
  try {
    return new URL(url).origin === new URL(rendererUrl).origin;
  } catch {
    return false;
  }
}
function installCrossOriginIsolation(session2, rendererUrl) {
  session2.webRequest.onHeadersReceived((details, callback) => {
    if (!isRendererResourceUrl(details.url, rendererUrl)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        ...CROSS_ORIGIN_ISOLATION_HEADERS
      }
    });
  });
}
const DOCUMENT_ASSET_SCHEME = "nxcore-document-asset";
const MIME_EXTENSIONS = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};
const EXTENSION_MIME_TYPES = Object.fromEntries(
  Object.entries(MIME_EXTENSIONS).map(([mimeType, extension]) => [extension, mimeType])
);
function assertNoEmbeddedDocumentImages(content) {
  if (!content || typeof content !== "object") return;
  if (Array.isArray(content)) {
    for (const item of content) assertNoEmbeddedDocumentImages(item);
    return;
  }
  const node2 = content;
  if (node2.type === "image" && node2.attrs && typeof node2.attrs === "object") {
    const src2 = node2.attrs.src;
    if (typeof src2 === "string" && src2.startsWith("data:image/")) {
      throw new Error("图片必须先保存到本地，不能嵌入文档数据库。");
    }
  }
  for (const value of Object.values(content)) assertNoEmbeddedDocumentImages(value);
}
function documentKey(documentId) {
  const normalized = documentId.trim();
  if (!normalized || normalized.length > 128) throw new Error("无效的文档标识。");
  return createHash("sha256").update(normalized).digest("hex");
}
function imageBytes(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("无效的图片数据。");
}
function hasExpectedSignature(mimeType, bytes) {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  }
  if (mimeType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  if (bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") return false;
  const brandLimit = Math.min(bytes.length, 32);
  for (let offset = 8; offset + 4 <= brandLimit; offset += 4) {
    if (["avif", "avis"].includes(bytes.subarray(offset, offset + 4).toString("ascii"))) return true;
  }
  return false;
}
function assetRequest(urlValue) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    return null;
  }
  if (url.protocol !== `${DOCUMENT_ASSET_SCHEME}:` || url.hostname !== "local") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [key, fileName] = parts;
  if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9-]{36}\.(?:avif|gif|jpg|png|webp)$/.test(fileName)) {
    return null;
  }
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1);
  const mimeType = EXTENSION_MIME_TYPES[extension];
  return mimeType ? { documentKey: key, fileName, mimeType } : null;
}
class DocumentAssetStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }
  async initialize() {
    await mkdir(this.rootDirectory, { recursive: true });
  }
  async storeImage(documentId, input) {
    const mimeType = input?.mimeType;
    if (typeof mimeType !== "string" || !Object.hasOwn(MIME_EXTENSIONS, mimeType)) {
      throw new Error("不支持这种图片格式。");
    }
    const bytes = imageBytes(input.bytes);
    if (!bytes.length) throw new Error("图片内容为空。");
    if (bytes.length > 20 * 1024 * 1024) throw new Error("图片不能超过 20 MB。");
    if (!hasExpectedSignature(mimeType, bytes)) throw new Error("图片内容与文件格式不匹配。");
    const key = documentKey(documentId);
    const assetId = randomUUID();
    const fileName = `${assetId}.${MIME_EXTENSIONS[mimeType]}`;
    const directory = join(this.rootDirectory, key);
    const filePath = join(directory, fileName);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx", mode: 384 });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => void 0);
      throw error;
    }
    return {
      assetId,
      src: `${DOCUMENT_ASSET_SCHEME}://local/${key}/${fileName}`,
      mimeType,
      bytes: bytes.length
    };
  }
  async response(url) {
    const request = assetRequest(url);
    if (!request) return new Response("Not found", { status: 404 });
    try {
      const bytes = await readFile(join(this.rootDirectory, request.documentKey, request.fileName));
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Cache-Control": "private, max-age=31536000, immutable",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Content-Type": request.mimeType,
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }
  async deleteDocument(documentId) {
    await rm(join(this.rootDirectory, documentKey(documentId)), { recursive: true, force: true });
  }
}
const DEFAULT_TIMEOUT_MS = 12e4;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
function requireText(value, label, maxLength = 200) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label}长度必须在 1 到 ${maxLength} 个字符之间。`);
  }
  return normalized;
}
function requireIdentifier(value, label) {
  const normalized = requireText(value, label, 128);
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new Error(`${label}格式无效。`);
  return normalized;
}
function commandArguments(command) {
  switch (command.kind) {
    case "search":
      return ["connector", "search", "--json", "--", requireText(command.query, "搜索内容")];
    case "schema": {
      const actionId = requireText(command.actionId, "Action ID", 257);
      const [service, ...actionParts] = actionId.split(".");
      requireIdentifier(service ?? "", "Service");
      requireIdentifier(actionParts.join("."), "Action");
      return ["connector", "schema", actionId, ...command.refresh ? ["--refresh"] : []];
    }
    case "run": {
      const service = requireIdentifier(command.service, "Service");
      const action = requireIdentifier(command.action, "Action");
      const input = JSON.stringify(command.input);
      if (Buffer.byteLength(input) > 256 * 1024) throw new Error("Action 输入不能超过 256 KiB。");
      return [
        "connector",
        "run",
        service,
        "--action",
        action,
        "--data",
        input,
        ...command.connectionName ? ["--connection-name", requireText(command.connectionName, "连接名称", 128)] : [],
        ...command.dryRun ? ["--dry-run"] : [],
        "--json"
      ];
    }
    case "apps":
      return [
        "connector",
        "apps",
        ...command.service ? [requireIdentifier(command.service, "Service")] : [],
        "--json"
      ];
  }
}
function displayCommand(arguments_) {
  const hiddenInput = arguments_.map((argument, index) => arguments_[index - 1] === "--data" ? "<json>" : argument);
  return `oo ${hiddenInput.join(" ")}`;
}
function parseJsonOutput(output) {
  const normalized = output.trim();
  if (!normalized) return null;
  try {
    return JSON.parse(normalized);
  } catch {
    throw new Error("EverRoom CLI 返回了无法解析的 JSON。");
  }
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function redactText(value, secret) {
  return secret ? value.split(secret).join("<redacted>") : value;
}
function redactValue(value, secret) {
  if (!secret) return value;
  if (typeof value === "string") return redactText(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      redactValue(item, secret)
    ]));
  }
  return value;
}
function createStreamRedactor(secret) {
  let pending = "";
  return {
    push(chunk) {
      if (!secret) return chunk;
      const combined = pending + chunk;
      let splitAt = Math.max(0, combined.length - Math.max(0, secret.length - 1));
      const crossingMatch = combined.lastIndexOf(secret, Math.max(0, splitAt - 1));
      if (crossingMatch >= 0 && crossingMatch + secret.length > splitAt) splitAt = crossingMatch;
      pending = combined.slice(splitAt);
      return redactText(combined.slice(0, splitAt), secret);
    },
    flush() {
      const output = redactText(pending, secret);
      pending = "";
      return output;
    }
  };
}
class OoCliBridge {
  constructor(options) {
    this.options = options;
  }
  listeners = /* @__PURE__ */ new Set();
  active = /* @__PURE__ */ new Map();
  initialized = false;
  onCommand(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  gatewayEnvironment() {
    return {
      NXCORE_CLI_CONNECTOR_URL: this.options.baseUrl,
      ...this.options.runtimeToken ? { NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN: this.options.runtimeToken } : {},
      NXCORE_CLI_CONNECTOR_CONFIG_DIR: this.options.configDirectory,
      NXCORE_CLI_CONNECTOR_DATA_DIR: this.options.dataDirectory,
      NXCORE_CLI_CONNECTOR_CLI_PATH: this.options.executable
    };
  }
  environment() {
    return this.gatewayEnvironment();
  }
  async status() {
    await this.initialize();
    const [gateway, cli] = await Promise.all([this.gatewayStatus(), this.cliStatus()]);
    return {
      baseUrl: this.options.baseUrl,
      managed: this.options.managed ?? false,
      gatewayPid: this.options.gatewayPid ?? null,
      gatewayVersion: this.options.gatewayVersion ?? null,
      runtimeTokenConfigured: Boolean(this.options.runtimeToken),
      ...gateway,
      ...cli
    };
  }
  async execute(input) {
    await this.initialize();
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(input.requestId)) throw new Error("无效的命令请求标识。");
    if (this.active.has(input.requestId)) throw new Error("该命令正在运行。");
    const arguments_ = commandArguments(input.command);
    return this.run(input.requestId, input.command.kind, arguments_);
  }
  cancel(requestId) {
    const child = this.active.get(requestId);
    if (!child) return false;
    child.kill("SIGTERM");
    return true;
  }
  shutdown() {
    for (const child of this.active.values()) child.kill("SIGTERM");
    this.active.clear();
    this.listeners.clear();
  }
  async initialize() {
    if (this.initialized) return;
    await Promise.all([
      mkdir(this.options.configDirectory, { recursive: true }),
      mkdir(this.options.dataDirectory, { recursive: true })
    ]);
    this.initialized = true;
  }
  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
  processEnvironment() {
    return {
      ...this.options.environment ?? process.env,
      OO_CONNECTOR_URL: this.options.baseUrl,
      ...this.options.runtimeToken ? { OO_CONNECTOR_TOKEN: this.options.runtimeToken } : {},
      OO_CONFIG_DIR: this.options.configDirectory,
      OO_DATA_DIR: this.options.dataDirectory,
      NO_COLOR: "1"
    };
  }
  async gatewayStatus() {
    try {
      const response = await fetch(new URL("/v1/health", this.options.baseUrl), {
        headers: this.options.runtimeToken ? { authorization: `Bearer ${this.options.runtimeToken}` } : void 0,
        signal: AbortSignal.timeout(2500)
      });
      if (response.status === 401) {
        return { gatewayState: "unauthorized", gatewayMessage: "Runtime Token 未被网关接受。" };
      }
      if (!response.ok) {
        return { gatewayState: "unreachable", gatewayMessage: `健康检查返回 HTTP ${response.status}。` };
      }
      const payload = await response.json().catch(() => null);
      if (payload?.success !== true || payload.data?.ok !== true) {
        return { gatewayState: "unreachable", gatewayMessage: "目标服务不是兼容的 EverRoom 连接器网关。" };
      }
      return { gatewayState: "ready", gatewayMessage: null };
    } catch (error) {
      return { gatewayState: "unreachable", gatewayMessage: errorText(error) };
    }
  }
  async cliStatus() {
    try {
      const result = await this.runProbe(["version", "--json"], 5e3);
      const payload = parseJsonOutput(result.stdout);
      return {
        cliState: "ready",
        cliVersion: typeof payload?.version === "string" ? payload.version : null,
        cliPath: this.options.executable,
        cliMessage: null
      };
    } catch (error) {
      const message = errorText(error);
      return {
        cliState: /ENOENT|not found/i.test(message) ? "missing" : "error",
        cliVersion: null,
        cliPath: this.options.executable,
        cliMessage: message
      };
    }
  }
  runProbe(arguments_, timeoutMs) {
    return new Promise((resolve2, reject) => {
      const child = spawn(this.options.executable, [...this.options.argumentPrefix ?? [], ...arguments_], {
        env: this.processEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      child.stdin.end();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve2({ stdout, stderr });
        else reject(new Error(
          redactText(stderr.trim(), this.options.runtimeToken) || `EverRoom CLI 退出码为 ${String(code)}。`
        ));
      });
    });
  }
  run(requestId, kind, arguments_) {
    const command = displayCommand(arguments_);
    const startedAt = /* @__PURE__ */ new Date();
    this.emit({ type: "started", requestId, kind, command, timestamp: startedAt.toISOString() });
    return new Promise((resolve2, reject) => {
      const child = spawn(this.options.executable, [...this.options.argumentPrefix ?? [], ...arguments_], {
        env: this.processEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.active.set(requestId, child);
      child.stdin.end();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      const stdoutRedactor = createStreamRedactor(this.options.runtimeToken);
      const stderrRedactor = createStreamRedactor(this.options.runtimeToken);
      const emitOutput = (stream2, text2) => {
        if (text2) this.emit({
          type: "output",
          requestId,
          stream: stream2,
          text: text2,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
      };
      const finish = (error, exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.active.delete(requestId);
        emitOutput("stdout", stdoutRedactor.flush());
        emitOutput("stderr", stderrRedactor.flush());
        const finishedAt = /* @__PURE__ */ new Date();
        const durationMs = finishedAt.getTime() - startedAt.getTime();
        this.emit({
          type: "finished",
          requestId,
          exitCode,
          durationMs,
          timestamp: finishedAt.toISOString()
        });
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve2({
            requestId,
            kind,
            command,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs,
            exitCode,
            data: redactValue(parseJsonOutput(stdout), this.options.runtimeToken),
            stderr: redactText(stderr.trim(), this.options.runtimeToken)
          });
        } catch (parseError) {
          reject(parseError);
        }
      };
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error("EverRoom CLI 执行超时。"), 124);
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const append2 = (stream2, chunk) => {
        if (settled) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill("SIGTERM");
          finish(new Error("EverRoom CLI 输出超过 4 MiB 限制。"), 125);
          return;
        }
        if (stream2 === "stdout") stdout += chunk;
        else stderr += chunk;
        emitOutput(
          stream2,
          (stream2 === "stdout" ? stdoutRedactor : stderrRedactor).push(chunk)
        );
      };
      child.stdout.on("data", (chunk) => append2("stdout", chunk));
      child.stderr.on("data", (chunk) => append2("stderr", chunk));
      child.once("error", (error) => finish(error, 127));
      child.once("close", (code, signal) => {
        const exitCode = code ?? (signal ? 130 : 1);
        finish(exitCode === 0 ? null : new Error(
          redactText(stderr.trim(), this.options.runtimeToken) || `EverRoom CLI 执行失败（${exitCode}）。`
        ), exitCode);
      });
    });
  }
}
const DEFAULT_PORT = 3e3;
const STARTUP_TIMEOUT_MS = 6e4;
const SHUTDOWN_TIMEOUT_MS = 5e3;
function delay(milliseconds) {
  return new Promise((resolve2) => setTimeout(resolve2, milliseconds));
}
function isManagedSecrets(value) {
  if (!value || typeof value !== "object") return false;
  const secrets = value;
  return secrets.version === 1 && typeof secrets.encryptionKey === "string" && secrets.encryptionKey.length >= 32 && typeof secrets.adminToken === "string" && secrets.adminToken.length >= 32 && typeof secrets.runtimeToken === "string" && secrets.runtimeToken.length >= 32 && Number.isInteger(secrets.port) && Number(secrets.port) > 0 && Number(secrets.port) <= 65535;
}
function normalizedBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NXCORE_CLI_CONNECTOR_URL 必须是有效的 HTTP(S) 地址。");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback) || url.username || url.password || url.search || url.hash) {
    throw new Error("EverRoom 连接器外部地址必须使用 HTTPS；HTTP 仅允许回环地址。");
  }
  return url.toString().replace(/\/$/, "");
}
function proxyUrlFromRules(rules) {
  for (const rule of rules.split(";")) {
    const match = /^\s*(PROXY|HTTP|HTTPS)\s+([^\s]+)\s*$/i.exec(rule);
    if (!match) continue;
    const protocol2 = match[1]?.toUpperCase() === "HTTPS" ? "https" : "http";
    try {
      const url = new URL(`${protocol2}://${match[2]}`);
      if (!url.hostname || !url.port) continue;
      return url.toString().replace(/\/$/, "");
    } catch {
    }
  }
  return null;
}
function noProxyWithLoopback(value) {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const normalized = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const loopback of ["127.0.0.1", "localhost", "::1"]) {
    if (!normalized.has(loopback)) entries.push(loopback);
  }
  return entries.join(",");
}
function nodeOptionsWithEnvProxyWarningDisabled(value) {
  const option = "--disable-warning=UNDICI-EHPA";
  if (value?.includes(option)) return value;
  return [value?.trim(), option].filter(Boolean).join(" ");
}
function forwardOutput(stream2, destination) {
  let pending = "";
  stream2.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) destination.write(`[open-connector] ${line}
`);
  });
  stream2.on("end", () => {
    if (pending) destination.write(`[open-connector] ${pending}
`);
  });
}
class OpenConnectorSupervisor {
  constructor(dataDirectory2, options = {}) {
    this.dataDirectory = dataDirectory2;
    this.options = options;
  }
  child = null;
  connection = null;
  starting = false;
  stopping = false;
  lastError = null;
  async start() {
    if (this.connection) return this.connection;
    if (this.starting || this.child) throw new Error("EverRoom 连接器正在启动。");
    this.starting = true;
    this.lastError = null;
    try {
      if (this.environment().NXCORE_CLI_CONNECTOR_MANAGED === "false") {
        const baseUrl2 = normalizedBaseUrl(
          this.environment().NXCORE_CLI_CONNECTOR_URL?.trim() || "http://127.0.0.1:34217"
        );
        this.connection = {
          baseUrl: baseUrl2,
          runtimeToken: this.configuredRuntimeToken(),
          adminToken: this.environment().NXCORE_CLI_CONNECTOR_ADMIN_TOKEN?.trim() || void 0,
          managed: false,
          pid: null,
          version: null
        };
        return this.connection;
      }
      const runtimeDirectory = this.resolveRuntimeDirectory();
      const manifest = JSON.parse(await readFile(join(runtimeDirectory, "package.json"), "utf8"));
      const version = typeof manifest.version === "string" ? manifest.version : null;
      const secrets = await this.loadOrCreateSecrets();
      const runtimeDataDirectory = join(this.dataDirectory, "runtime-data");
      await mkdir(runtimeDataDirectory, { recursive: true, mode: 448 });
      await chmod(runtimeDataDirectory, 448).catch(() => void 0);
      const port = await this.resolvePort(secrets.port, secrets.runtimeToken);
      if (port !== secrets.port) {
        secrets.port = port;
        await this.writeSecrets(secrets);
      }
      const baseUrl = `http://127.0.0.1:${port}`;
      const publicOrigin = `http://localhost:${port}`;
      const existing = await this.probe(baseUrl, secrets.runtimeToken);
      if (existing) {
        this.connection = {
          baseUrl,
          runtimeToken: secrets.runtimeToken,
          adminToken: secrets.adminToken,
          managed: true,
          pid: null,
          version
        };
        console.info(`[open-connector] reusing EverRoom runtime at ${baseUrl}`);
        return this.connection;
      }
      const packaged = this.options.packaged ?? app.isPackaged;
      const command = this.options.command ?? (packaged ? process.execPath : this.environment().NXCORE_CLI_CONNECTOR_NODE?.trim() || "node");
      const proxyEnvironment = await this.resolveProxyEnvironment();
      const child = spawn(command, [join(runtimeDirectory, "src", "server", "index.ts")], {
        cwd: runtimeDirectory,
        env: {
          ...this.environment(),
          ...proxyEnvironment,
          NODE_ENV: "production",
          HOST: "127.0.0.1",
          PORT: String(port),
          OOMOL_CONNECT_ORIGIN: publicOrigin,
          OOMOL_CONNECT_DATA_DIR: runtimeDataDirectory,
          OOMOL_CONNECT_ENCRYPTION_KEY: secrets.encryptionKey,
          OOMOL_CONNECT_ADMIN_TOKEN: secrets.adminToken,
          OOMOL_CONNECT_RUNTIME_TOKEN: secrets.runtimeToken,
          OOMOL_CONNECT_LOG_LEVEL: this.environment().OOMOL_CONNECT_LOG_LEVEL?.trim() || "info",
          ...packaged ? { ELECTRON_RUN_AS_NODE: "1" } : {}
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      this.child = child;
      this.stopping = false;
      child.stdin.end();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      forwardOutput(child.stdout, process.stdout);
      forwardOutput(child.stderr, process.stderr);
      child.on("exit", (code, signal) => {
        this.child = null;
        this.connection = null;
        if (!this.stopping) {
          this.lastError = `EverRoom 连接器进程已退出（code=${String(code)}, signal=${String(signal)}）`;
          console.error(this.lastError);
        }
      });
      await this.waitUntilReady(child, baseUrl, secrets.runtimeToken);
      this.connection = {
        baseUrl,
        runtimeToken: secrets.runtimeToken,
        adminToken: secrets.adminToken,
        managed: true,
        pid: child.pid ?? null,
        version
      };
      console.info(`[open-connector] managed runtime ready at ${baseUrl} (pid=${String(child.pid)})`);
      return this.connection;
    } catch (error) {
      const child = this.child;
      if (child) this.killChild(child, "SIGTERM");
      this.child = null;
      this.connection = null;
      this.lastError = error instanceof Error ? error.message : "EverRoom 连接器启动失败";
      throw error;
    } finally {
      this.starting = false;
    }
  }
  getConnection() {
    return this.connection;
  }
  getStatus() {
    const connection = this.connection;
    if (connection) {
      return {
        state: "ready",
        baseUrl: connection.baseUrl,
        managed: connection.managed,
        pid: connection.pid,
        version: connection.version,
        message: null
      };
    }
    return {
      state: this.starting || this.child ? "starting" : this.lastError ? "error" : "stopped",
      baseUrl: null,
      managed: this.environment().NXCORE_CLI_CONNECTOR_MANAGED !== "false",
      pid: null,
      version: null,
      message: this.lastError
    };
  }
  async shutdown() {
    const child = this.child;
    this.connection = null;
    if (!child) return;
    this.stopping = true;
    await new Promise((resolve2) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve2();
      };
      const timeout = setTimeout(() => {
        this.killChild(child, "SIGKILL");
        finish();
      }, SHUTDOWN_TIMEOUT_MS);
      child.once("exit", finish);
      if (!this.killChild(child, "SIGTERM")) finish();
    });
    this.child = null;
    this.stopping = false;
  }
  environment() {
    return this.options.environment ?? process.env;
  }
  configuredRuntimeToken() {
    return this.environment().NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN?.trim() || this.environment().OOMOL_CONNECT_RUNTIME_TOKEN?.trim() || void 0;
  }
  async resolveProxyEnvironment() {
    const environment = this.environment();
    const explicitHttpProxy = environment.HTTP_PROXY ?? environment.http_proxy;
    const explicitHttpsProxy = environment.HTTPS_PROXY ?? environment.https_proxy;
    const explicitAllProxy = environment.ALL_PROXY ?? environment.all_proxy;
    const common2 = {
      NODE_USE_ENV_PROXY: environment.NODE_USE_ENV_PROXY?.trim() || "1",
      NODE_OPTIONS: nodeOptionsWithEnvProxyWarningDisabled(environment.NODE_OPTIONS),
      NO_PROXY: noProxyWithLoopback(environment.NO_PROXY ?? environment.no_proxy)
    };
    if (explicitHttpProxy?.trim() || explicitHttpsProxy?.trim() || explicitAllProxy?.trim()) {
      const fallbackProxy = explicitHttpsProxy?.trim() || explicitHttpProxy?.trim();
      return {
        ...common2,
        ...fallbackProxy ? {
          HTTP_PROXY: explicitHttpProxy?.trim() || fallbackProxy,
          HTTPS_PROXY: explicitHttpsProxy?.trim() || fallbackProxy
        } : {}
      };
    }
    try {
      const resolveProxy = this.options.proxyResolver ?? ((url) => session.defaultSession.resolveProxy(url));
      const proxyUrl = proxyUrlFromRules(await resolveProxy("https://oauth2.googleapis.com"));
      if (!proxyUrl) return {};
      console.info("[open-connector] using the desktop system proxy for provider requests");
      return {
        ...common2,
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl
      };
    } catch {
      return {};
    }
  }
  resolveRuntimeDirectory() {
    const configured2 = this.options.runtimeDirectory ?? this.environment().NXCORE_CLI_CONNECTOR_RUNTIME_DIR?.trim();
    const packaged = this.options.packaged ?? app.isPackaged;
    const candidates = [
      configured2,
      packaged ? join(process.resourcesPath, "open-connector") : void 0,
      join(app.getAppPath(), "build", "open-connector")
    ].filter((candidate) => Boolean(candidate));
    const directory = candidates.find((candidate) => existsSync(join(candidate, "src", "server", "index.ts")) && existsSync(join(candidate, "catalog", "apps")) && existsSync(join(candidate, "dist", "web", "index.html")));
    if (!directory) {
      throw new Error(`EverRoom 连接器运行时未准备。已检查：${candidates.join(", ")}`);
    }
    return directory;
  }
  async loadOrCreateSecrets() {
    await mkdir(this.dataDirectory, { recursive: true, mode: 448 });
    await chmod(this.dataDirectory, 448).catch(() => void 0);
    try {
      const parsed = JSON.parse(await readFile(this.secretsPath(), "utf8"));
      if (isManagedSecrets(parsed)) return parsed;
    } catch {
    }
    const configuredPort = Number(this.environment().NXCORE_CLI_CONNECTOR_PORT ?? DEFAULT_PORT);
    const secrets = {
      version: 1,
      encryptionKey: randomBytes(32).toString("base64url"),
      adminToken: randomBytes(32).toString("base64url"),
      runtimeToken: this.configuredRuntimeToken() ?? randomBytes(32).toString("base64url"),
      port: Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535 ? configuredPort : DEFAULT_PORT
    };
    await this.writeSecrets(secrets);
    return secrets;
  }
  async writeSecrets(secrets) {
    const temporaryPath = `${this.secretsPath()}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(secrets, null, 2)}
`, { mode: 384 });
    await rename(temporaryPath, this.secretsPath());
    await chmod(this.secretsPath(), 384).catch(() => void 0);
  }
  secretsPath() {
    return join(this.dataDirectory, "managed-runtime.json");
  }
  async resolvePort(preferredPort, runtimeToken) {
    if (await this.probe(`http://127.0.0.1:${preferredPort}`, runtimeToken)) return preferredPort;
    if (await this.portAvailable(preferredPort)) return preferredPort;
    return this.availablePort();
  }
  portAvailable(port) {
    return new Promise((resolve2) => {
      const server = createServer$1();
      server.unref();
      server.once("error", () => resolve2(false));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.close(() => resolve2(true));
      });
    });
  }
  availablePort() {
    return new Promise((resolve2, reject) => {
      const server = createServer$1();
      server.unref();
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("无法分配 EverRoom 连接器本地端口。"));
          return;
        }
        server.close((error) => error ? reject(error) : resolve2(address.port));
      });
    });
  }
  async probe(baseUrl, runtimeToken) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`, {
        headers: { authorization: `Bearer ${runtimeToken}` },
        signal: AbortSignal.timeout(1e3)
      });
      if (!response.ok) return false;
      const payload = await response.json();
      return payload.success === true && payload.data?.ok === true;
    } catch {
      return false;
    }
  }
  async waitUntilReady(child, baseUrl, runtimeToken) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`EverRoom 连接器启动期间退出（code=${String(child.exitCode)}）。`);
      }
      if (await this.probe(baseUrl, runtimeToken)) return;
      await delay(100);
    }
    throw new Error(`EverRoom 连接器未能在 ${STARTUP_TIMEOUT_MS}ms 内就绪。`);
  }
  killChild(child, signal) {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}
const DESKTOP_PAGE_MODE_ENV = "NXCORE_DESKTOP_PAGE_MODE";
function resolveDesktopPageMode(value) {
  return value?.trim().toLowerCase() === "connectors" ? "connectors" : "sources";
}
const APP_NAME = "EverRoom";
function loadPackagedEnvironment() {
  if (!app.isPackaged) return;
  try {
    const values = JSON.parse(readFileSync(join(process.resourcesPath, "packaged-env.json"), "utf8"));
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === "string" && !process.env[name]) process.env[name] = value;
    }
  } catch (error) {
    console.warn("Packaged environment file unavailable; using process environment.", error);
  }
}
loadPackagedEnvironment();
const desktopPageMode = resolveDesktopPageMode(process.env[DESKTOP_PAGE_MODE_ENV]);
async function rateLimitAware(operation) {
  try {
    return await operation();
  } catch (error) {
    if (!isSaasRateLimitError(error)) throw error;
    return { __everroomRateLimited: true, message: error.message };
  }
}
const appDataDirectory = app.getPath("appData");
const dataDirectory = process.env.NXCORE_DATA_DIR?.trim() || join(appDataDirectory, APP_NAME);
app.setPath("userData", dataDirectory);
app.setName(APP_NAME);
if (app.isPackaged) {
  const esbuildExecutable = process.platform === "win32" ? "esbuild.exe" : join("bin", "esbuild");
  process.env.ESBUILD_BINARY_PATH = join(
    process.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@esbuild",
    `${process.platform}-${process.arch}`,
    esbuildExecutable
  );
}
configureDesktopLogger(dataDirectory);
configureSentry(app.getVersion(), app.isPackaged);
if (process.platform === "darwin") process.title = APP_NAME;
protocol.registerSchemesAsPrivileged([{
  scheme: DOCUMENT_ASSET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
const SOURCE_CHANNELS = {
  list: "sources:list",
  listFiles: "sources:list-files",
  listEvidence: "sources:list-evidence",
  previewFile: "sources:preview-file",
  searchEvidence: "sources:search-evidence",
  changed: "sources:changed",
  showFile: "sources:show-file",
  addLocalFolder: "sources:add-local-folder",
  listDefaultLocalFolders: "sources:list-default-local-folders",
  connectDefaultLocalFolders: "sources:connect-default-local-folders",
  addGitHub: "sources:add-github",
  addGoogleDocs: "sources:add-google-docs",
  addNotion: "sources:add-notion",
  sync: "sources:sync",
  setPaused: "sources:set-paused",
  disconnect: "sources:disconnect"
};
const GATEWAY_CHANNELS = {
  status: "gateway:status"
};
const RUNTIME_CONFIG_CHANNELS = {
  get: "runtime-config:get",
  saveUser: "runtime-config:save-user",
  clearUser: "runtime-config:clear-user",
  refreshSaas: "runtime-config:refresh-saas",
  clearSaas: "runtime-config:clear-saas",
  selectSource: "runtime-config:select-source",
  test: "runtime-config:test"
};
const CONNECTOR_CHANNELS = {
  runtimeStatus: "nango-connector:runtime-status",
  status: "nango-connector:status",
  startAuthorization: "nango-connector:start-authorization",
  authorizationStatus: "nango-connector:authorization-status",
  registerConnection: "nango-connector:register-connection",
  disableConnection: "nango-connector:disable-connection",
  enableConnection: "nango-connector:enable-connection",
  purgeConnection: "nango-connector:purge-connection",
  triggerSync: "nango-connector:trigger-sync",
  cancelRun: "nango-connector:cancel-run",
  listScopes: "nango-connector:list-scopes",
  listRuns: "nango-connector:list-runs",
  listMail: "nango-connector:list-mail",
  listFailures: "nango-connector:list-failures",
  listDocuments: "nango-connector:list-documents",
  readDocument: "nango-connector:read-document",
  listRecords: "nango-connector:list-records",
  armFault: "nango-connector:arm-fault"
};
const OPEN_CONNECTOR_CHANNELS = {
  status: "open-connector:status",
  execute: "open-connector:execute",
  cancel: "open-connector:cancel",
  openConsole: "open-connector:open-console"
};
const CONNECTOR_SYNC_CHANNELS = {
  status: "connector-sync:status",
  accounts: "connector-sync:accounts",
  promptProfiles: "connector-sync:prompt-profiles",
  jobs: "connector-sync:jobs",
  createJob: "connector-sync:create-job",
  updateJob: "connector-sync:update-job",
  runJob: "connector-sync:run-job",
  setJobPaused: "connector-sync:set-job-paused",
  archiveJob: "connector-sync:archive-job",
  runs: "connector-sync:runs",
  quarantine: "connector-sync:quarantine",
  data: "connector-sync:data",
  record: "connector-sync:record"
};
const CONTEXT_ROOM_CHANNELS = {
  list: "context-rooms:list",
  create: "context-rooms:create",
  syncSnapshot: "context-rooms:sync-snapshot"
};
const AGENT_CHANNELS = {
  getStatus: "agent:get-status",
  getUsage: "agent:get-usage",
  listSessions: "agent:list-sessions",
  createSession: "agent:create-session",
  createSessionLink: "agent:create-session-link",
  listSessionLinks: "agent:list-session-links",
  markSessionLinkReturned: "agent:mark-session-link-returned",
  updateSession: "agent:update-session",
  deleteSession: "agent:delete-session",
  getSession: "agent:get-session",
  getEvents: "agent:get-events",
  startRun: "agent:start-run",
  submitPendingIntent: "agent:submit-pending-intent",
  cancelRun: "agent:cancel-run",
  subscribe: "agent:subscribe",
  unsubscribe: "agent:unsubscribe"
};
const CURSOR_COMPLETION_AGENT_CHANNELS = {
  createSession: "cursor-completion-agent:create-session",
  deleteSession: "cursor-completion-agent:delete-session",
  getEvents: "cursor-completion-agent:get-events",
  startRun: "cursor-completion-agent:start-run",
  cancelRun: "cursor-completion-agent:cancel-run"
};
const DOCUMENT_CHANNELS = {
  list: "documents:list",
  listTrash: "documents:list-trash",
  get: "documents:get",
  listBlocks: "documents:list-blocks",
  listBlockBacklinks: "documents:list-block-backlinks",
  listVersions: "documents:list-versions",
  restoreVersion: "documents:restore-version",
  resolveBlockReferences: "documents:resolve-block-references",
  listOperations: "documents:list-operations",
  startOperation: "documents:start-operation",
  getOperation: "documents:get-operation",
  executeOperationCommand: "documents:execute-operation-command",
  storeImage: "documents:store-image",
  import: "documents:import",
  save: "documents:save",
  delete: "documents:delete",
  restore: "documents:restore",
  deletePermanently: "documents:delete-permanently",
  emptyTrash: "documents:empty-trash",
  subscribe: "documents:subscribe",
  unsubscribe: "documents:unsubscribe"
};
const ASR_CHANNELS = {
  requestMicrophoneAccess: "asr:request-microphone-access",
  openMicrophoneSettings: "asr:open-microphone-settings",
  openSystemAudioSettings: "asr:open-system-audio-settings",
  beginRecording: "asr:begin-recording",
  appendRecording: "asr:append-recording",
  finishRecording: "asr:finish-recording",
  cancelRecording: "asr:cancel-recording",
  createJob: "asr:create-job",
  getJob: "asr:get-job"
};
const PRIVATE_AUDIO_CHANNELS = {
  list: "private-audio:list",
  download: "private-audio:download",
  read: "private-audio:read"
};
const REALITY_CHANNELS = {
  listEvents: "reality:list-events",
  getEvent: "reality:get-event",
  createEvent: "reality:create-event",
  finishCapture: "reality:finish-capture",
  updateTranscript: "reality:update-transcript",
  addMarker: "reality:add-marker",
  setImportant: "reality:set-important",
  confirm: "reality:confirm",
  discard: "reality:discard",
  fail: "reality:fail",
  readAudio: "reality:read-audio",
  exportTranscript: "reality:export-transcript",
  subscribe: "reality:subscribe",
  unsubscribe: "reality:unsubscribe"
};
const ACCOUNT_CHANNELS = {
  status: "account:status",
  devices: "account:devices",
  login: "account:login",
  oidcLogin: "account:oidc-login",
  oidcCancel: "account:oidc-cancel",
  logout: "account:logout",
  keyringStatus: "account:keyring-status",
  createPairingSession: "account:create-pairing-session",
  getPairingSession: "account:get-pairing-session",
  approvePairingSession: "account:approve-pairing-session"
};
const TRANSCRIPTION_CHANNELS = {
  syncPrivate: "transcription:sync-private",
  listPrivate: "transcription:list-private",
  listTags: "transcription:list-tags",
  replaceSummaryTags: "transcription:replace-summary-tags",
  renameTag: "transcription:rename-tag",
  mergeTag: "transcription:merge-tag"
};
const MEMORY_CHANNELS = {
  overview: "memory:overview",
  startOnboarding: "memory:onboarding:start",
  /** 渲染层记忆引导结束（完成/跳过/放行）→ 解除云端同步延迟。 */
  onboardingFinished: "memory:onboarding-finished",
  listAtomic: "memory:list-atomic",
  searchAtomic: "memory:search-atomic",
  updateAtomic: "memory:update-atomic",
  deleteAtomic: "memory:delete-atomic",
  listScenarios: "memory:list-scenarios",
  readScenario: "memory:read-scenario",
  readCore: "memory:read-core",
  writeCore: "memory:write-core",
  listConversations: "memory:list-conversations",
  searchConversations: "memory:search-conversations",
  deleteConversations: "memory:delete-conversations",
  importMarkdown: "memory:import-markdown",
  pickMarkdownFiles: "memory:pick-markdown-files",
  listDocuments: "memory:documents:list",
  getDocument: "memory:documents:get",
  deleteDocument: "memory:documents:delete",
  atomicProvenance: "memory:atomic-provenance",
  captureDocumentRewrite: "memory:capture-document-rewrite"
};
const MCP_CHANNELS = {
  listServers: "mcp:servers:list",
  saveServers: "mcp:servers:save"
};
const KNOWLEDGE_CHANNELS = {
  listRooms: "knowledge:rooms:list",
  getRoomContext: "knowledge:rooms:context",
  upsertRoom: "knowledge:rooms:upsert",
  deleteRoom: "knowledge:rooms:delete",
  listWikiPages: "knowledge:wiki:pages",
  readWikiPage: "knowledge:wiki:page-read",
  listWikis: "knowledge:wikis:list",
  getWikiGraph: "knowledge:wiki:graph",
  listEntities: "knowledge:entities:list",
  getEntity: "knowledge:entities:get",
  promoteEntity: "knowledge:entities:promote",
  suppressEntity: "knowledge:entities:suppress",
  restoreSuppressedEntity: "knowledge:entities:restore",
  mergeEntity: "knowledge:entities:merge",
  listUnmatched: "knowledge:unmatched:list",
  attachDoc: "knowledge:docs:attach",
  listRecentDecisions: "knowledge:decisions:list",
  revertDecision: "knowledge:route:revert",
  listRoomFiles: "knowledge:files:list",
  readFileMarkdown: "knowledge:files:markdown",
  revealFile: "knowledge:files:reveal"
};
const FILES_CHANNELS = {
  list: "files:list",
  get: "files:get",
  readMarkdown: "files:read-markdown",
  readDataUrl: "files:read-data-url",
  rename: "files:rename",
  pinClusterTitle: "files:pin-cluster-title",
  delete: "files:delete",
  reveal: "files:reveal",
  openOriginal: "files:open-original",
  pickAndImport: "files:pick-and-import",
  importPathsOnce: "files:import-paths-once",
  importProgress: "files:import-progress",
  listHighRiskReviews: "files:high-risk-reviews:list",
  resolveHighRiskReview: "files:high-risk-reviews:resolve",
  highRiskReviewsChanged: "files:high-risk-reviews:changed"
};
const INGEST_CHANNELS = {
  listEvents: "ingest:events:list",
  getFilterRules: "ingest:filter-rules:get",
  updateFilterPreference: "ingest:filter-rules:update-preference",
  reinstateEvent: "ingest:events:reinstate",
  getEventContent: "ingest:events:content"
};
const SCREEN_CAPTURE_CHANNELS = {
  captureCurrentWindow: "screen-capture:capture-current-window",
  start: "screen-capture:start",
  updateInterval: "screen-capture:update-interval",
  stop: "screen-capture:stop",
  status: "screen-capture:status"
};
const PERCEPTION_CHANNELS = {
  settings: "perception:settings",
  updateOnlineVlm: "perception:update-online-vlm",
  nodes: "perception:nodes",
  node: "perception:node",
  retry: "perception:retry",
  delete: "perception:delete"
};
const DIARY_CHANNELS = {
  settings: "diary:settings",
  updateSettings: "diary:update-settings",
  generate: "diary:generate",
  run: "diary:run",
  activeRun: "diary:active-run",
  days: "diary:days",
  day: "diary:day"
};
const AGENT_SCHEDULER_CHANNELS = {
  list: "agent-scheduler:list",
  create: "agent-scheduler:create",
  update: "agent-scheduler:update",
  remove: "agent-scheduler:remove",
  runNow: "agent-scheduler:run-now"
};
const handlerRegistry = /* @__PURE__ */ new Map();
let resolveServicesReady = null;
let rejectServicesReady = null;
const servicesReady = new Promise((resolve2, reject) => {
  resolveServicesReady = resolve2;
  rejectServicesReady = reject;
});
servicesReady.catch(() => {
});
function handle(channel, handler) {
  handlerRegistry.set(channel, handler);
}
function handleGroup(channels, handlers) {
  for (const key of Object.keys(channels)) {
    handle(channels[key], handlers[key]);
  }
}
function installIpcRouters() {
  const channelGroups = [
    SOURCE_CHANNELS,
    GATEWAY_CHANNELS,
    RUNTIME_CONFIG_CHANNELS,
    OPEN_CONNECTOR_CHANNELS,
    CONNECTOR_SYNC_CHANNELS,
    CONTEXT_ROOM_CHANNELS,
    AGENT_CHANNELS,
    CURSOR_COMPLETION_AGENT_CHANNELS,
    DOCUMENT_CHANNELS,
    ASR_CHANNELS,
    PRIVATE_AUDIO_CHANNELS,
    REALITY_CHANNELS,
    ACCOUNT_CHANNELS,
    TRANSCRIPTION_CHANNELS,
    MEMORY_CHANNELS,
    KNOWLEDGE_CHANNELS,
    MCP_CHANNELS,
    FILES_CHANNELS,
    INGEST_CHANNELS,
    SCREEN_CAPTURE_CHANNELS,
    PERCEPTION_CHANNELS,
    DIARY_CHANNELS,
    AGENT_SCHEDULER_CHANNELS
  ];
  for (const group of channelGroups) {
    for (const channel of Object.values(group)) {
      ipcMain.handle(channel, (event, ...args) => {
        const handler = handlerRegistry.get(channel);
        if (handler) return handler(event, ...args);
        return servicesReady.then(() => {
          const ready = handlerRegistry.get(channel);
          if (!ready) throw new Error(`服务尚未提供 ${channel}。`);
          return ready(event, ...args);
        });
      });
    }
  }
}
let localDataService = null;
let gatewaySupervisor = null;
let runtimeConfigBridge = null;
let cursorCompletionSupervisor = null;
let ooCliBridge = null;
let openConnectorSupervisor = null;
let openConnectorConsoleWindow = null;
let memoryCoreSupervisor = null;
let nangoSupervisor = null;
let knowledgeServiceSupervisor = null;
let agentGatewayBridge = null;
let cursorCompletionAgentBridge = null;
let documentGatewayBridge = null;
let realityGatewayBridge = null;
let perceptionGatewayBridge = null;
let diaryGatewayBridge = null;
let agentSchedulerGatewayBridge = null;
let connectorGatewayBridge = null;
let recordingStore = null;
let privateAudioSync = null;
let saasClient = null;
let agentStatusReporter = null;
let remoteAgentCommandClient = null;
let privateTranscriptionSync = null;
let privateSyncScheduler = null;
let transcriptionProcessingCoordinator = null;
let shutdownStarted = false;
const queuedProtocolUrls = [];
let screenshotOutbox = null;
const captureAndQueueCurrentWindow = async () => {
  const result = await captureCurrentWindow();
  if (result.ok) await screenshotOutbox?.enqueue(result).catch(() => void 0);
  return result;
};
const screenshotScheduler = createWindowScreenshotScheduler(captureAndQueueCurrentWindow);
function logRendererRequestError(input) {
  if (!input || typeof input !== "object") return;
  const value = input;
  if (typeof value.channel !== "string" || typeof value.message !== "string") return;
  const channel = value.channel.slice(0, 120);
  const message = value.message.slice(0, 2e3);
  const notice = value.severity === "notice";
  logDesktop("renderer", notice ? "warn" : "error", { event: notice ? "renderer.request.notice" : "renderer.request.error", channel, message });
}
ipcMain.on("app:request-error", (_event, input) => logRendererRequestError(input));
ipcMain.on("app:set-locale", (_event, locale) => setDesktopLocale(locale));
function logRendererDiagnostic(input) {
  if (!input || typeof input !== "object") return;
  const value = input;
  if (value.module !== "document-cursor-completion") return;
  if (value.level !== "info" && value.level !== "warn" && value.level !== "error") return;
  if (!value.event || typeof value.event !== "object" || Array.isArray(value.event)) return;
  try {
    const serialized = JSON.stringify(value.event);
    if (serialized.length > 16e3) return;
    logDocumentCursorCompletion(value.level, JSON.parse(serialized));
  } catch {
  }
}
ipcMain.on("app:diagnostic-log", (_event, input) => logRendererDiagnostic(input));
function focusMainWindow() {
  const window2 = BrowserWindow.getAllWindows()[0];
  if (!window2 || window2.isDestroyed()) return;
  if (window2.isMinimized()) window2.restore();
  window2.show();
  window2.focus();
}
function handleProtocolUrl(url) {
  if (!url.startsWith(OIDC_CALLBACK_URL)) return;
  if (saasClient) saasClient.handleOidcCallback(url);
  else queuedProtocolUrls.push(url);
  focusMainWindow();
}
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});
if (hasSingleInstanceLock) {
  app.on("second-instance", (_event, argv) => {
    const protocolUrl = argv.find((argument) => argument.startsWith(OIDC_CALLBACK_URL));
    if (protocolUrl) handleProtocolUrl(protocolUrl);
    else focusMainWindow();
  });
}
function requireSourceId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) {
    throw new Error("无效的数据源标识。");
  }
  return value;
}
function requireSearchQuery(value) {
  if (typeof value !== "string") throw new Error("无效的搜索内容。");
  const query = value.trim();
  if (query.length < 1 || query.length > 200) throw new Error("请输入 1 到 200 个字符。");
  return query;
}
function registerSourceHandlers(service, credentials) {
  service.onChanged((event) => {
    for (const window2 of BrowserWindow.getAllWindows()) {
      if (!window2.isDestroyed()) window2.webContents.send(SOURCE_CHANNELS.changed, event);
    }
  });
  handle(SOURCE_CHANNELS.list, () => service.listSources());
  handle(
    SOURCE_CHANNELS.listFiles,
    (_event, id) => service.listFiles(requireSourceId(id))
  );
  handle(
    SOURCE_CHANNELS.listEvidence,
    (_event, id, fileId) => service.listEvidence(requireSourceId(id), requireSourceId(fileId))
  );
  handle(
    SOURCE_CHANNELS.previewFile,
    (_event, id, fileId) => service.previewFile(requireSourceId(id), requireSourceId(fileId))
  );
  handle(
    SOURCE_CHANNELS.searchEvidence,
    (_event, query, id) => {
      const sourceId = id === void 0 ? null : requireSourceId(id);
      return service.searchEvidence(requireSearchQuery(query), sourceId);
    }
  );
  handle(
    SOURCE_CHANNELS.showFile,
    (_event, id, fileId) => {
      const location = service.getSourceItemLocation(
        requireSourceId(id),
        requireSourceId(fileId)
      );
      if (location.kind === "local") shell.showItemInFolder(location.value);
      else void shell.openExternal(location.value);
    }
  );
  const showFolderDialog = (event, options) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (parent && !parent.isDestroyed()) return dialog.showOpenDialog(parent, options);
    return dialog.showOpenDialog(options);
  };
  handle(SOURCE_CHANNELS.addLocalFolder, async (event) => {
    const result = await showFolderDialog(event, {
      title: desktopText("dialog.chooseFolder.title"),
      buttonLabel: desktopText("dialog.chooseFolder.button"),
      properties: ["openDirectory", "createDirectory"]
    });
    const rootPath = result.filePaths[0];
    return result.canceled || !rootPath ? null : service.addLocalFolder(rootPath);
  });
  handle(SOURCE_CHANNELS.listDefaultLocalFolders, () => {
    const sources = service.listSources().filter((source) => source.kind === "local-folder");
    const normalize = (value) => value.replace(/[\\/]+$/, "").toLowerCase();
    return ["documents", "desktop"].map((folder) => {
      const expected = normalize(app.getPath(folder));
      return {
        folder,
        connected: sources.some((source) => {
          if (source.status === "disconnected" || normalize(source.rootPath) !== expected) return false;
          try {
            accessSync(source.rootPath, constants.R_OK);
            return true;
          } catch {
            return false;
          }
        })
      };
    });
  });
  handle(SOURCE_CHANNELS.connectDefaultLocalFolders, async (_event, folders) => {
    if (!Array.isArray(folders)) throw new Error("无效的默认文件夹配置。");
    if (folders.some((folder) => folder !== "documents" && folder !== "desktop")) {
      throw new Error("无效的默认文件夹配置。");
    }
    const selected = [...new Set(folders)];
    const results = [];
    for (const folder of selected) {
      try {
        const rootPath = app.getPath(folder);
        await access(rootPath, constants.R_OK);
        await service.addLocalFolder(rootPath);
        results.push({ folder, connected: true });
      } catch (error) {
        results.push({ folder, connected: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  });
  handle(SOURCE_CHANNELS.addGitHub, async (_event, input) => {
    if (!input || typeof input !== "object") throw new Error("无效的 GitHub 配置。");
    const value = input;
    if (typeof value.repository !== "string" || !value.repository.trim()) throw new Error("请输入 GitHub 仓库。");
    if (value.token !== void 0 && typeof value.token !== "string") throw new Error("GitHub Token 格式无效。");
    const tokenCredentialKey = value.token?.trim() ? await credentials.set(value.token.trim()) : void 0;
    const config = {
      repository: value.repository.trim(),
      branch: typeof value.branch === "string" && value.branch.trim() ? value.branch.trim() : void 0,
      syncIssues: value.syncIssues !== false,
      tokenCredentialKey
    };
    return service.addConnection("github", config.repository, config);
  });
  handle(SOURCE_CHANNELS.addGoogleDocs, async (_event, input) => {
    if (!input || typeof input !== "object") throw new Error("无效的 Google Docs 配置。");
    const value = input;
    if (!Array.isArray(value.documentIds) || value.documentIds.length < 1 || value.documentIds.length > 100) throw new Error("请至少提供一个 Google Docs 文档 ID。");
    if (typeof value.token !== "string" || !value.token.trim()) throw new Error("Google Docs access token 不能为空。");
    const tokenCredentialKey = await credentials.set(value.token.trim());
    const config = { documentIds: value.documentIds.map((id) => String(id).trim()).filter(Boolean), tokenCredentialKey };
    return service.addConnection("google-docs", "Google Docs", config);
  });
  handle(SOURCE_CHANNELS.addNotion, async (_event, input) => {
    if (!input || typeof input !== "object") throw new Error("无效的 Notion 配置。");
    const value = input;
    if (!Array.isArray(value.pageIds) || value.pageIds.length < 1 || value.pageIds.length > 100) throw new Error("请至少提供一个 Notion 页面 ID。");
    if (typeof value.token !== "string" || !value.token.trim()) throw new Error("Notion integration token 不能为空。");
    const tokenCredentialKey = await credentials.set(value.token.trim());
    const config = { pageIds: value.pageIds.map((id) => String(id).trim()).filter(Boolean), tokenCredentialKey };
    return service.addConnection("notion", "Notion", config);
  });
  handle(SOURCE_CHANNELS.sync, (_event, id) => service.sync(requireSourceId(id)));
  handle(
    SOURCE_CHANNELS.setPaused,
    (_event, id, paused) => {
      if (typeof paused !== "boolean") throw new Error("无效的暂停状态。");
      return service.setPaused(requireSourceId(id), paused);
    }
  );
  handle(
    SOURCE_CHANNELS.disconnect,
    (_event, id, deleteLocalData) => {
      if (typeof deleteLocalData !== "boolean") throw new Error("无效的清理选项。");
      return service.disconnect(requireSourceId(id), deleteLocalData);
    }
  );
}
function registerGatewayHandlers() {
  handle(GATEWAY_CHANNELS.status, () => gatewaySupervisor ? gatewaySupervisor.getStatus() : { state: "starting", pid: null, baseUrl: null, version: null, message: null });
  ipcMain.handle(CONNECTOR_CHANNELS.runtimeStatus, () => nangoSupervisor?.getStatus() ?? { state: "starting", message: null });
}
function registerRuntimeConfigHandlers(client) {
  handle(RUNTIME_CONFIG_CHANNELS.get, () => runtimeConfigBridge?.get());
  handle(RUNTIME_CONFIG_CHANNELS.saveUser, async (_event, input) => {
    const snapshot = await runtimeConfigBridge?.saveUser(input);
    if (snapshot) void syncManagedChildProcesses(snapshot);
    return runtimeConfigBridge?.get();
  });
  handle(RUNTIME_CONFIG_CHANNELS.clearUser, async () => {
    const snapshot = await runtimeConfigBridge?.clearUser();
    if (snapshot) void syncManagedChildProcesses(snapshot);
    return runtimeConfigBridge?.get();
  });
  handle(RUNTIME_CONFIG_CHANNELS.refreshSaas, async () => {
    const config = await client.getRuntimeConfig();
    const snapshot = await runtimeConfigBridge?.saveSaas(config.config);
    if (snapshot) void syncManagedChildProcesses(snapshot);
    return runtimeConfigBridge?.get();
  });
  handle(RUNTIME_CONFIG_CHANNELS.clearSaas, async () => {
    const snapshot = await runtimeConfigBridge?.clearSaas();
    if (snapshot) void syncManagedChildProcesses(snapshot);
    return runtimeConfigBridge?.get();
  });
  handle(RUNTIME_CONFIG_CHANNELS.test, () => runtimeConfigBridge?.test());
  handle(RUNTIME_CONFIG_CHANNELS.selectSource, async (_event, source) => {
    if (source !== "user" && source !== "saas" && source !== "default") throw new Error("无效的运行时配置来源。");
    const snapshot = await runtimeConfigBridge?.selectSource(source);
    if (snapshot) void syncManagedChildProcesses(snapshot);
    return runtimeConfigBridge?.get();
  });
}
let memoryCoreAiEnvApplied = null;
async function syncMemoryCoreEnvironment(snapshot) {
  const bridge = runtimeConfigBridge;
  try {
    const supervisor = memoryCoreSupervisor;
    const initialConnection = supervisor?.getConnection() ?? null;
    if (!supervisor || !initialConnection) {
      const externalMemory = process.env.NXCORE_MEMORY_ENABLED?.trim() !== "false" && (process.env.NXCORE_MEMORY_MANAGED?.trim() === "false" || Boolean(process.env.NXCORE_MEMORY_BASE_URL?.trim() && process.env.NXCORE_MEMORY_BASE_URL.trim() !== "http://127.0.0.1:8420"));
      if (!externalMemory) await bridge?.disableMemory().catch(() => void 0);
      return;
    }
    const fields = embeddingFieldsFromConfig(snapshot.config);
    let embeddingEnv = null;
    let applyAiEnvironment = true;
    if (fields) {
      const result = await bridge?.test();
      if (!result?.embedding?.valid || !result.embedding.dimensions) {
        console.warn("[memory-core] embedding config saved but /embeddings test failed; keeping current env");
        applyAiEnvironment = false;
      } else {
        embeddingEnv = memoryCoreEmbeddingEnv(fields, result.embedding.dimensions);
      }
    }
    const nextEnv = memoryCoreEnvironment(snapshot.config, embeddingEnv);
    const nextJson = nextEnv ? JSON.stringify(nextEnv) : null;
    if (applyAiEnvironment && initialConnection.managed && nextJson !== memoryCoreAiEnvApplied) {
      const restarted = await supervisor.restart(nextEnv);
      if (!restarted?.managed) {
        console.warn("[memory-core] instance at 8420 is not managed by this app; ai env NOT applied (stray process?)");
      } else {
        memoryCoreAiEnvApplied = nextJson;
        console.info(`[memory-core] ai env ${nextEnv ? "applied" : "cleared"} (instance restarted)`);
      }
    }
    const connection = supervisor.getConnection();
    if (!connection) {
      await bridge?.disableMemory().catch(() => void 0);
      return;
    }
    const runtimeMemory = snapshot.config.memory && typeof snapshot.config.memory === "object" ? snapshot.config.memory : {};
    const runtimeMemoryPlaceholders = {
      serviceId: "everroom",
      teamId: "everroom",
      agentId: "everroom",
      userId: "local-user"
    };
    const envText = (name, fallback) => process.env[name]?.trim() || fallback;
    const text2 = (name, fallback) => {
      const value = runtimeMemory[name];
      const normalized = typeof value === "string" ? value.trim() : "";
      return normalized && normalized !== runtimeMemoryPlaceholders[name] ? normalized : fallback;
    };
    const integer = (name, fallback) => {
      const value = runtimeMemory[name];
      if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
      const parsed = Number.parseInt(process.env[name] ?? "", 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
    };
    const memoryConfig = {
      enabled: true,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      serviceId: text2("serviceId", envText("NXCORE_MEMORY_SERVICE_ID", "everroom")),
      teamId: text2("teamId", envText("NXCORE_MEMORY_TEAM_ID", "everroom")),
      agentId: text2("agentId", envText("NXCORE_MEMORY_AGENT_ID", "pi-agent")),
      userId: text2("userId", envText("NXCORE_MEMORY_USER_ID", "local-user")),
      recallLimit: integer("NXCORE_MEMORY_RECALL_LIMIT", 5),
      charBudget: integer("NXCORE_MEMORY_CHAR_BUDGET", 2e3)
    };
    const timeoutMs = runtimeMemory.timeoutMs;
    if (typeof timeoutMs === "number" && Number.isInteger(timeoutMs) && timeoutMs >= 100) {
      memoryConfig.timeoutMs = timeoutMs;
    }
    await bridge?.injectMemory(memoryConfig);
  } catch (error) {
    console.error("[memory-core] failed to sync ai env:", error);
    await bridge?.disableMemory().catch(() => void 0);
  }
}
let cursorCompletionAiEnv = {};
let cursorCompletionAiEnvApplied = JSON.stringify({});
async function syncCursorCompletionEnvironment(snapshot) {
  try {
    const nextEnv = cursorCompletionEnvFromConfig(snapshot.config);
    const nextJson = JSON.stringify(nextEnv);
    cursorCompletionAiEnv = nextEnv;
    if (nextJson === cursorCompletionAiEnvApplied) return;
    cursorCompletionAiEnvApplied = nextJson;
    if (cursorCompletionSupervisor?.isRunning()) await cursorCompletionSupervisor.shutdown();
    console.info(`[cursor-completion] ai env ${Object.keys(nextEnv).length ? "updated" : "cleared"} (instance will respawn on demand)`);
  } catch (error) {
    console.error("[cursor-completion] failed to sync ai env:", error);
  }
}
let managedChildSyncQueue = Promise.resolve();
async function syncManagedChildProcesses(snapshot) {
  const run = managedChildSyncQueue.then(async () => {
    await syncMemoryCoreEnvironment(snapshot);
    await syncCursorCompletionEnvironment(snapshot);
  });
  managedChildSyncQueue = run.catch(() => void 0);
  return run;
}
function registerConnectorHandlers(bridge) {
  ipcMain.handle(CONNECTOR_CHANNELS.status, () => bridge.status());
  ipcMain.handle(CONNECTOR_CHANNELS.startAuthorization, (_event, provider) => bridge.startAuthorization(provider));
  ipcMain.handle(CONNECTOR_CHANNELS.authorizationStatus, (_event, id) => bridge.authorizationStatus(id));
  ipcMain.handle(CONNECTOR_CHANNELS.registerConnection, (_event, input) => bridge.registerConnection(input));
  ipcMain.handle(CONNECTOR_CHANNELS.disableConnection, (_event, id) => bridge.disableConnection(id));
  ipcMain.handle(CONNECTOR_CHANNELS.enableConnection, (_event, id) => bridge.enableConnection(id));
  ipcMain.handle(CONNECTOR_CHANNELS.purgeConnection, (_event, id) => bridge.purgeConnection(id));
  ipcMain.handle(CONNECTOR_CHANNELS.triggerSync, (_event, id, mode) => bridge.triggerSync(id, mode));
  ipcMain.handle(CONNECTOR_CHANNELS.cancelRun, (_event, id) => bridge.cancelRun(id));
  ipcMain.handle(CONNECTOR_CHANNELS.listScopes, (_event, connectionId) => bridge.scopes(connectionId));
  ipcMain.handle(CONNECTOR_CHANNELS.listRuns, (_event, connectionId) => bridge.runs(connectionId));
  ipcMain.handle(CONNECTOR_CHANNELS.listMail, (_event, query) => bridge.mail(query));
  ipcMain.handle(CONNECTOR_CHANNELS.listFailures, (_event, query) => bridge.failures(query));
  ipcMain.handle(CONNECTOR_CHANNELS.listDocuments, (_event, connectionId) => bridge.documents(connectionId));
  ipcMain.handle(CONNECTOR_CHANNELS.readDocument, (_event, connectionId, documentId) => bridge.document(connectionId, documentId));
  ipcMain.handle(CONNECTOR_CHANNELS.listRecords, (_event, connectionId, type2) => bridge.records(connectionId, type2));
  ipcMain.handle(CONNECTOR_CHANNELS.armFault, (_event, point) => {
    if (process.env.NXCORE_CONNECTOR_DEBUG_FAULTS !== "1") throw new Error("故障注入未启用。");
    return bridge.armFault(point);
  });
}
function resolveOoCliExecutable() {
  const configured2 = process.env.NXCORE_OO_CLI_PATH?.trim();
  if (configured2) return configured2;
  const executableName = process.platform === "win32" ? "oo.exe" : "oo";
  const packagedCandidates = [
    join(process.resourcesPath, "oo", `${process.platform}-${process.arch}`, executableName),
    join(process.resourcesPath, "oo", executableName),
    join(app.getAppPath(), "build", "oo", `${process.platform}-${process.arch}`, executableName)
  ];
  return packagedCandidates.find((candidate) => existsSync(candidate)) ?? "oo";
}
function createOoCliBridge(connection) {
  const root = join(dataDirectory, "open-connector");
  return new OoCliBridge({
    executable: resolveOoCliExecutable(),
    baseUrl: connection.baseUrl,
    runtimeToken: connection.runtimeToken,
    managed: connection.managed,
    gatewayPid: connection.pid,
    gatewayVersion: connection.version,
    configDirectory: join(root, "oo-config"),
    dataDirectory: join(root, "oo-data")
  });
}
function attachOpenConnectorBridge(bridge) {
  bridge.onCommand((frame) => {
    for (const window2 of BrowserWindow.getAllWindows()) {
      if (!window2.isDestroyed()) window2.webContents.send("open-connector:event", frame);
    }
  });
}
function openConnectorExternalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") void shell.openExternal(url.toString());
  } catch {
  }
}
async function openConnectorManagementConsole() {
  const connection = openConnectorSupervisor?.getConnection();
  if (!connection) throw new Error("OpenConnector 尚未就绪。");
  if (!connection.managed || !connection.adminToken) {
    await shell.openExternal(`${connection.baseUrl}/`);
    return;
  }
  if (openConnectorConsoleWindow && !openConnectorConsoleWindow.isDestroyed()) {
    openConnectorConsoleWindow.show();
    openConnectorConsoleWindow.focus();
    return;
  }
  const origin2 = new URL(connection.baseUrl).origin;
  const window2 = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: "OpenConnector 管理台",
    backgroundColor: "#ffffff",
    webPreferences: {
      partition: "persist:everroom-open-connector-console",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  openConnectorConsoleWindow = window2;
  window2.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`${origin2}/*`] },
    (details, callback) => callback({
      requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${connection.adminToken}` }
    })
  );
  window2.webContents.setWindowOpenHandler(({ url }) => {
    openConnectorExternalUrl(url);
    return { action: "deny" };
  });
  window2.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === origin2) return;
    event.preventDefault();
    openConnectorExternalUrl(url);
  });
  window2.once("ready-to-show", () => window2.show());
  window2.once("closed", () => {
    if (openConnectorConsoleWindow === window2) openConnectorConsoleWindow = null;
  });
  await window2.loadURL(`${connection.baseUrl}/`);
}
function registerOpenConnectorHandlers() {
  handle(OPEN_CONNECTOR_CHANNELS.status, () => {
    if (desktopPageMode !== "connectors") {
      return {
        baseUrl: "",
        managed: false,
        gatewayPid: null,
        gatewayVersion: null,
        gatewayState: "unreachable",
        gatewayMessage: "连接器页面未启用。",
        runtimeTokenConfigured: false,
        cliState: "missing",
        cliVersion: null,
        cliPath: resolveOoCliExecutable(),
        cliMessage: "连接器页面未启用。"
      };
    }
    if (ooCliBridge) return ooCliBridge.status();
    const status = openConnectorSupervisor?.getStatus();
    return {
      baseUrl: status?.baseUrl ?? "",
      managed: status?.managed ?? true,
      gatewayPid: status?.pid ?? null,
      gatewayVersion: status?.version ?? null,
      gatewayState: status?.state === "starting" || !status ? "starting" : "unreachable",
      gatewayMessage: status?.message ?? null,
      runtimeTokenConfigured: false,
      cliState: "checking",
      cliVersion: null,
      cliPath: resolveOoCliExecutable(),
      cliMessage: null
    };
  });
  handle(OPEN_CONNECTOR_CHANNELS.execute, (_event, input) => {
    if (!ooCliBridge) throw new Error("OpenConnector 尚未就绪。");
    if (!input || typeof input !== "object") throw new Error("无效的 OpenConnector 命令。");
    return ooCliBridge.execute(input);
  });
  handle(OPEN_CONNECTOR_CHANNELS.cancel, (_event, requestId) => {
    if (!ooCliBridge) return false;
    if (typeof requestId !== "string") throw new Error("无效的命令请求标识。");
    return ooCliBridge.cancel(requestId);
  });
  handle(OPEN_CONNECTOR_CHANNELS.openConsole, () => openConnectorManagementConsole());
}
function registerContextRoomHandlers(bridge) {
  handle(CONTEXT_ROOM_CHANNELS.list, () => bridge.list());
  handle(CONTEXT_ROOM_CHANNELS.create, (_event, input) => bridge.create(input));
  handle(CONTEXT_ROOM_CHANNELS.syncSnapshot, (_event, input) => bridge.syncSnapshot(input));
}
function registerConnectorSyncHandlers(bridge) {
  handle(CONNECTOR_SYNC_CHANNELS.status, () => bridge.status());
  handle(CONNECTOR_SYNC_CHANNELS.accounts, () => bridge.accounts());
  handle(CONNECTOR_SYNC_CHANNELS.promptProfiles, () => bridge.promptProfiles());
  handle(CONNECTOR_SYNC_CHANNELS.jobs, () => bridge.jobs());
  handle(CONNECTOR_SYNC_CHANNELS.createJob, (_event, input) => bridge.createJob(input));
  handle(CONNECTOR_SYNC_CHANNELS.updateJob, (_event, id, input) => bridge.updateJob(id, input));
  handle(CONNECTOR_SYNC_CHANNELS.runJob, (_event, id) => bridge.runJob(id));
  handle(CONNECTOR_SYNC_CHANNELS.setJobPaused, (_event, id, paused, configVersion) => bridge.setJobPaused(id, paused, configVersion));
  handle(CONNECTOR_SYNC_CHANNELS.archiveJob, (_event, id, configVersion) => bridge.archiveJob(id, configVersion));
  handle(CONNECTOR_SYNC_CHANNELS.runs, (_event, jobId) => bridge.runs(jobId));
  handle(CONNECTOR_SYNC_CHANNELS.quarantine, (_event, runId) => bridge.quarantine(runId));
  handle(CONNECTOR_SYNC_CHANNELS.data, (_event, query) => bridge.data(query));
  handle(CONNECTOR_SYNC_CHANNELS.record, (_event, id) => bridge.record(id));
}
function registerAgentHandlers(bridge) {
  handle(AGENT_CHANNELS.getStatus, () => bridge.getStatus());
  handle(AGENT_CHANNELS.getUsage, (_event, range2) => bridge.getUsage(range2));
  handle(AGENT_CHANNELS.listSessions, (_event, pageLabel, roomId) => bridge.listSessions(pageLabel, roomId));
  handle(AGENT_CHANNELS.createSession, (_event, input) => bridge.createSession(input));
  handle(AGENT_CHANNELS.createSessionLink, (_event, input) => bridge.createSessionLink(input));
  handle(AGENT_CHANNELS.listSessionLinks, (_event, sessionId) => bridge.listSessionLinks(sessionId));
  handle(AGENT_CHANNELS.markSessionLinkReturned, (_event, linkId) => bridge.markSessionLinkReturned(linkId));
  handle(AGENT_CHANNELS.updateSession, (_event, sessionId, input) => bridge.updateSession(sessionId, input));
  handle(AGENT_CHANNELS.deleteSession, (_event, sessionId) => bridge.deleteSession(sessionId));
  handle(AGENT_CHANNELS.getSession, (_event, sessionId) => bridge.getSession(sessionId));
  handle(AGENT_CHANNELS.getEvents, (_event, sessionId, runId, afterSeq) => bridge.getEvents(sessionId, runId, afterSeq));
  handle(AGENT_CHANNELS.startRun, (_event, sessionId, input) => bridge.startRun(sessionId, input));
  handle(AGENT_CHANNELS.submitPendingIntent, (_event, intentId, input) => bridge.submitPendingIntent(intentId, input));
  handle(AGENT_CHANNELS.cancelRun, (_event, runId) => bridge.cancelRun(runId));
  handle(AGENT_CHANNELS.subscribe, (event, sessionId) => bridge.subscribe(event.sender, sessionId));
  handle(AGENT_CHANNELS.unsubscribe, (event) => bridge.unsubscribe(event.sender.id));
}
function registerCursorCompletionAgentHandlers(bridge) {
  handleGroup(CURSOR_COMPLETION_AGENT_CHANNELS, {
    createSession: (_event, input) => bridge.createSession(input),
    deleteSession: (_event, sessionId) => bridge.deleteSession(sessionId),
    getEvents: (_event, sessionId, runId, afterSeq) => bridge.getEvents(sessionId, runId, afterSeq),
    startRun: (_event, sessionId, input) => bridge.startRun(sessionId, input),
    cancelRun: (_event, runId) => bridge.cancelRun(runId)
  });
}
function registerDocumentHandlers(bridge, assets) {
  handleGroup(DOCUMENT_CHANNELS, {
    list: (_event, roomId) => bridge.list(roomId),
    listTrash: (_event, roomId) => bridge.listTrash(roomId),
    get: (_event, documentId) => bridge.get(documentId),
    listBlocks: (_event, documentId) => bridge.listBlocks(documentId),
    listBlockBacklinks: (_event, documentId, blockId) => bridge.listBlockBacklinks(documentId, blockId),
    listVersions: (_event, documentId) => bridge.listVersions(documentId),
    restoreVersion: (_event, documentId, version, baseVersion) => bridge.restoreVersion(documentId, version, baseVersion),
    resolveBlockReferences: (_event, input) => bridge.resolveBlockReferences(input),
    listOperations: (_event, filters) => bridge.listOperations(filters),
    startOperation: (_event, input) => {
      assertNoEmbeddedDocumentImages(input);
      return bridge.startOperation(input);
    },
    getOperation: (_event, operationId) => bridge.getOperation(operationId),
    executeOperationCommand: (_event, operationId, input) => bridge.executeOperationCommand(operationId, input),
    storeImage: (_event, documentId, input) => assets.storeImage(documentId, input),
    import: (_event, input) => {
      assertNoEmbeddedDocumentImages(input?.contentJson);
      return bridge.import(input);
    },
    save: (_event, documentId, input) => {
      assertNoEmbeddedDocumentImages(input?.contentJson);
      return bridge.save(documentId, input);
    },
    delete: (_event, documentId) => bridge.delete(documentId),
    restore: (_event, documentId) => bridge.restore(documentId),
    deletePermanently: async (_event, documentId) => {
      await bridge.deletePermanently(documentId);
      await assets.deleteDocument(documentId).catch((error) => {
        console.error("Failed to delete local document assets", { documentId, error });
      });
    },
    emptyTrash: async (_event, roomId) => {
      const trashed = await bridge.listTrash(roomId);
      await bridge.emptyTrash(roomId);
      await Promise.all(trashed.map((document2) => assets.deleteDocument(document2.id).catch((error) => {
        console.error("Failed to delete local document assets", { documentId: document2.id, error });
      })));
    },
    subscribe: (event, roomId) => bridge.subscribe(event.sender, roomId),
    unsubscribe: (event, roomId) => bridge.unsubscribe(event.sender.id, roomId)
  });
}
function registerMcpHandlers(bridge) {
  handle(MCP_CHANNELS.listServers, () => bridge.list());
  handle(MCP_CHANNELS.saveServers, (_event, servers) => bridge.save(servers));
}
function registerKnowledgeHandlers(bridge) {
  handle(KNOWLEDGE_CHANNELS.listRooms, (_event, origin2) => bridge.listRooms(origin2));
  handle(KNOWLEDGE_CHANNELS.getRoomContext, (_event, roomId) => bridge.getRoomContext(roomId));
  handle(KNOWLEDGE_CHANNELS.upsertRoom, (_event, input) => bridge.upsertRoom(input));
  handle(KNOWLEDGE_CHANNELS.deleteRoom, (_event, roomId) => bridge.deleteRoom(roomId));
  handle(KNOWLEDGE_CHANNELS.listWikiPages, (_event, roomId) => bridge.listWikiPages(roomId));
  handle(KNOWLEDGE_CHANNELS.readWikiPage, (_event, roomId, ref2) => bridge.readWikiPage(roomId, ref2));
  handle(KNOWLEDGE_CHANNELS.listWikis, () => bridge.listWikis());
  handle(KNOWLEDGE_CHANNELS.getWikiGraph, (_event, roomId) => bridge.getWikiGraph(roomId));
  handle(KNOWLEDGE_CHANNELS.listEntities, (_event, status) => bridge.listEntities(status));
  handle(KNOWLEDGE_CHANNELS.getEntity, (_event, entityId) => bridge.getEntity(entityId));
  handle(KNOWLEDGE_CHANNELS.promoteEntity, (_event, entityId) => bridge.promoteEntity(entityId));
  handle(KNOWLEDGE_CHANNELS.suppressEntity, (_event, entityId) => bridge.suppressEntity(entityId));
  handle(KNOWLEDGE_CHANNELS.restoreSuppressedEntity, (_event, entityId) => bridge.restoreSuppressedEntity(entityId));
  handle(KNOWLEDGE_CHANNELS.mergeEntity, (_event, fromId, targetId) => bridge.mergeEntity(fromId, targetId));
  handle(KNOWLEDGE_CHANNELS.listUnmatched, () => bridge.listUnmatched());
  handle(KNOWLEDGE_CHANNELS.attachDoc, (_event, sourceKind, sourceId, input) => bridge.attachDoc(sourceKind, sourceId, input));
  handle(KNOWLEDGE_CHANNELS.listRecentDecisions, (_event, limit) => bridge.listRecentDecisions(limit));
  handle(KNOWLEDGE_CHANNELS.revertDecision, (_event, decisionId) => bridge.revertDecision(decisionId));
  handle(KNOWLEDGE_CHANNELS.listRoomFiles, (_event, roomId) => bridge.listRoomFiles(roomId));
  handle(KNOWLEDGE_CHANNELS.readFileMarkdown, (_event, fileId) => bridge.readFileMarkdown(fileId));
  handle(KNOWLEDGE_CHANNELS.revealFile, (_event, fileId) => bridge.revealFile(fileId));
}
function registerFilesHandlers(bridge, highRiskImports) {
  highRiskImports.onChanged(() => {
    for (const window2 of BrowserWindow.getAllWindows()) {
      if (!window2.isDestroyed()) window2.webContents.send(FILES_CHANNELS.highRiskReviewsChanged);
    }
  });
  handle(FILES_CHANNELS.list, (_event, limit, offset) => bridge.list(limit, offset));
  handle(FILES_CHANNELS.get, (_event, fileId) => bridge.get(fileId));
  handle(FILES_CHANNELS.readMarkdown, (_event, fileId) => bridge.readMarkdown(fileId));
  handle(FILES_CHANNELS.readDataUrl, (_event, fileId) => bridge.readDataUrl(fileId));
  handle(FILES_CHANNELS.rename, (_event, fileId, displayName) => bridge.rename(fileId, displayName));
  handle(FILES_CHANNELS.pinClusterTitle, (_event, clusterId, sharedTitle) => bridge.pinClusterTitle(clusterId, sharedTitle));
  handle(FILES_CHANNELS.delete, (_event, fileId) => bridge.delete(fileId));
  handle(FILES_CHANNELS.reveal, (_event, fileId) => bridge.reveal(fileId));
  handle(FILES_CHANNELS.openOriginal, (_event, fileId) => bridge.openOriginal(fileId));
  bridge.onImportProgress((event) => {
    for (const window2 of BrowserWindow.getAllWindows()) {
      if (!window2.isDestroyed()) window2.webContents.send(FILES_CHANNELS.importProgress, event);
    }
  });
  handle(
    FILES_CHANNELS.pickAndImport,
    (_event, options) => bridge.pickAndImport(options)
  );
  handle(
    FILES_CHANNELS.importPathsOnce,
    (_event, paths, options) => bridge.importPathsOnce(paths, options)
  );
  handle(FILES_CHANNELS.listHighRiskReviews, () => ({ items: highRiskImports.list() }));
  handle(
    FILES_CHANNELS.resolveHighRiskReview,
    (_event, id, accepted) => {
      if (typeof id !== "string" || id.length < 1 || id.length > 100 || typeof accepted !== "boolean") {
        throw new Error("无效的高风险文件确认请求。");
      }
      return highRiskImports.resolve(id, accepted);
    }
  );
}
function registerIngestHandlers(bridge) {
  handle(
    INGEST_CHANNELS.listEvents,
    (_event, query) => bridge.listEvents(query)
  );
  handle(INGEST_CHANNELS.getFilterRules, () => bridge.getFilterRules());
  handle(
    INGEST_CHANNELS.updateFilterPreference,
    (_event, content) => bridge.updateFilterPreference(content)
  );
  handle(INGEST_CHANNELS.reinstateEvent, (_event, eventId) => bridge.reinstateEvent(eventId));
  handle(INGEST_CHANNELS.getEventContent, (_event, eventId) => bridge.getEventContent(eventId));
}
function registerAsrHandlers(store, coordinator) {
  handle(ASR_CHANNELS.requestMicrophoneAccess, async () => {
    if (process.platform !== "darwin") return true;
    const status = systemPreferences.getMediaAccessStatus("microphone");
    if (status === "granted") return true;
    if (status === "denied" || status === "restricted") return false;
    return systemPreferences.askForMediaAccess("microphone");
  });
  handle(ASR_CHANNELS.openMicrophoneSettings, () => {
    if (process.platform !== "darwin") throw new Error("麦克风隐私设置仅适用于 macOS。");
    return shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    );
  });
  handle(ASR_CHANNELS.openSystemAudioSettings, () => {
    if (process.platform !== "darwin") throw new Error("系统音频录制设置仅适用于 macOS。");
    return shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    );
  });
  handle(ASR_CHANNELS.beginRecording, (_event, mimeType) => store.begin(mimeType));
  handle(ASR_CHANNELS.appendRecording, (_event, id, chunk) => store.append(id, chunk));
  handle(ASR_CHANNELS.finishRecording, (_event, id) => store.finish(id));
  handle(ASR_CHANNELS.cancelRecording, (_event, id) => store.cancel(id));
  handle(ASR_CHANNELS.createJob, (_event, input) => rateLimitAware(() => coordinator.createJob(input)));
  handle(ASR_CHANNELS.getJob, (_event, id) => rateLimitAware(() => coordinator.getJob(id)));
}
function registerPrivateAudioHandlers(service) {
  handle(PRIVATE_AUDIO_CHANNELS.list, (_event, cursor) => rateLimitAware(() => service.list(cursor ?? 0)));
  handle(PRIVATE_AUDIO_CHANNELS.download, (_event, assetId, outputPath) => rateLimitAware(() => service.downloadById(assetId, outputPath)));
  handle(PRIVATE_AUDIO_CHANNELS.read, (_event, assetId) => rateLimitAware(() => service.read(assetId)));
}
let cloudMaterializeGateOpen = false;
const cloudMaterializeWaiters = [];
const CLOUD_MATERIALIZE_GATE_TIMEOUT_MS = 5 * 6e4;
function openCloudMaterializeGate() {
  if (cloudMaterializeGateOpen) return;
  cloudMaterializeGateOpen = true;
  for (const release of cloudMaterializeWaiters.splice(0)) release();
}
async function waitForCloudMaterializeGate() {
  if (cloudMaterializeGateOpen) return;
  const timeout = new Promise((resolve2) => {
    setTimeout(() => {
      if (!cloudMaterializeGateOpen) {
        console.warn("[private-sync] cloud materialize gate timed out; proceeding");
        openCloudMaterializeGate();
      }
      resolve2();
    }, CLOUD_MATERIALIZE_GATE_TIMEOUT_MS);
  });
  const gate = new Promise((resolve2) => cloudMaterializeWaiters.push(resolve2));
  await Promise.race([gate, timeout]);
}
function registerMemoryHandlers(bridge) {
  handle(MEMORY_CHANNELS.overview, () => bridge.overview());
  ipcMain.on(MEMORY_CHANNELS.onboardingFinished, () => openCloudMaterializeGate());
  handle(MEMORY_CHANNELS.startOnboarding, (_event, input) => bridge.startOnboarding(input));
  handle(MEMORY_CHANNELS.listAtomic, (_event, options) => bridge.listAtomic(options));
  handle(MEMORY_CHANNELS.searchAtomic, (_event, query, limit) => bridge.searchAtomic(query, limit));
  handle(
    MEMORY_CHANNELS.updateAtomic,
    (_event, id, content, background) => bridge.updateAtomic(id, content, background)
  );
  handle(MEMORY_CHANNELS.deleteAtomic, (_event, ids) => bridge.deleteAtomic(ids));
  handle(MEMORY_CHANNELS.listScenarios, (_event, pathPrefix) => bridge.listScenarios(pathPrefix));
  handle(MEMORY_CHANNELS.readScenario, (_event, path) => bridge.readScenario(path));
  handle(MEMORY_CHANNELS.readCore, () => bridge.readCore());
  handle(MEMORY_CHANNELS.writeCore, (_event, content) => bridge.writeCore(content));
  handle(
    MEMORY_CHANNELS.listConversations,
    (_event, options) => bridge.listConversations(options)
  );
  handle(
    MEMORY_CHANNELS.searchConversations,
    (_event, query, limit, sessionId) => bridge.searchConversations(query, limit, sessionId)
  );
  handle(
    MEMORY_CHANNELS.deleteConversations,
    (_event, target) => bridge.deleteConversations(target)
  );
  handle(
    MEMORY_CHANNELS.importMarkdown,
    (_event, input) => bridge.importMarkdown(input)
  );
  handle(MEMORY_CHANNELS.pickMarkdownFiles, () => bridge.pickMarkdownFiles());
  handle(
    MEMORY_CHANNELS.listDocuments,
    (_event, limit, offset) => bridge.listDocuments(limit, offset)
  );
  handle(MEMORY_CHANNELS.getDocument, (_event, id) => bridge.getDocument(id));
  handle(MEMORY_CHANNELS.deleteDocument, (_event, id) => bridge.deleteDocument(id));
  handle(MEMORY_CHANNELS.atomicProvenance, (_event, id) => bridge.atomicProvenance(id));
  handle(
    MEMORY_CHANNELS.captureDocumentRewrite,
    (_event, input) => bridge.captureDocumentRewrite(input)
  );
}
function registerRealityHandlers(bridge) {
  handle(REALITY_CHANNELS.listEvents, (_event, filters) => bridge.listEvents(filters));
  handle(REALITY_CHANNELS.getEvent, (_event, id) => bridge.getEvent(id));
  handle(REALITY_CHANNELS.createEvent, (_event, input) => bridge.createEvent(input));
  handle(REALITY_CHANNELS.finishCapture, (_event, id, input) => bridge.finishCapture(id, input));
  handle(REALITY_CHANNELS.updateTranscript, (_event, id, input) => bridge.updateTranscript(id, input));
  handle(REALITY_CHANNELS.addMarker, (_event, id, input) => bridge.addMarker(id, input));
  handle(REALITY_CHANNELS.setImportant, (_event, id, important) => bridge.setImportant(id, important));
  handle(REALITY_CHANNELS.confirm, (_event, id) => bridge.confirm(id));
  handle(REALITY_CHANNELS.discard, (_event, id) => bridge.discard(id));
  handle(REALITY_CHANNELS.fail, (_event, id, error) => bridge.fail(id, error));
  handle(REALITY_CHANNELS.readAudio, (_event, id) => bridge.readAudio(id));
  handle(REALITY_CHANNELS.exportTranscript, async (event, input) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || event.sender.isDestroyed()) throw new Error(desktopText("error.transcript.invalidSource"));
    if (!input || typeof input !== "object" || typeof input.content !== "string") {
      throw new Error(desktopText("error.transcript.invalidRequest"));
    }
    const defaultTranscriptName = desktopText("dialog.exportTranscript.defaultName");
    const rawName = typeof input.fileName === "string" ? input.fileName : `${defaultTranscriptName}.txt`;
    const fileName = rawName.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 180) || defaultTranscriptName;
    const selection = await dialog.showSaveDialog(owner, {
      title: desktopText("dialog.exportTranscript.title"),
      defaultPath: fileName.toLowerCase().endsWith(".txt") ? fileName : `${fileName}.txt`,
      buttonLabel: desktopText("dialog.exportTranscript.button"),
      filters: [{ name: desktopText("dialog.exportTranscript.textFile"), extensions: ["txt"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"]
    });
    if (selection.canceled || !selection.filePath) return { canceled: true };
    await writeFile(selection.filePath, input.content, "utf8");
    return { canceled: false, filePath: selection.filePath };
  });
  handle(REALITY_CHANNELS.subscribe, (event) => bridge.subscribe(event.sender));
  handle(REALITY_CHANNELS.unsubscribe, (event) => bridge.unsubscribe(event.sender.id));
}
async function syncAccountMonitoring(status) {
  const account = await status;
  syncSentryAccount(account);
  return account;
}
function registerAccountHandlers(client, onAccountChanged) {
  handle(ACCOUNT_CHANNELS.status, (_event, refreshSubscription) => rateLimitAware(async () => {
    const account = await syncAccountMonitoring(client.status(refreshSubscription === true));
    onAccountChanged?.(account);
    return account;
  }));
  handle(ACCOUNT_CHANNELS.devices, () => rateLimitAware(() => client.listDevices()));
  handle(ACCOUNT_CHANNELS.login, (_event, input) => {
    if (!input || typeof input !== "object") throw new Error("无效的登录信息。");
    const value = input;
    if (typeof value.identifier !== "string" || typeof value.password !== "string") {
      throw new Error("请输入账号和密码。");
    }
    const identifier = value.identifier;
    const password = value.password;
    return rateLimitAware(async () => {
      const account = await syncAccountMonitoring(client.login(identifier, password));
      onAccountChanged?.(account);
      return account;
    });
  });
  handle(ACCOUNT_CHANNELS.oidcLogin, (_event, provider) => {
    if (provider !== "apple" && provider !== "google") throw new Error("不支持的登录方式。");
    return rateLimitAware(async () => {
      const account = await syncAccountMonitoring(client.loginWithOidc(provider));
      onAccountChanged?.(account);
      return account;
    });
  });
  handle(ACCOUNT_CHANNELS.oidcCancel, () => client.cancelOidcLogin());
  handle(ACCOUNT_CHANNELS.logout, () => rateLimitAware(async () => {
    const account = await syncAccountMonitoring(client.logout());
    onAccountChanged?.(account);
    return account;
  }));
}
function registerPrivateTranscriptionHandlers(sync, onCompleted) {
  handle(ACCOUNT_CHANNELS.keyringStatus, () => rateLimitAware(() => sync.keyringStatus()));
  handle(ACCOUNT_CHANNELS.createPairingSession, () => rateLimitAware(() => sync.createPairingSession()));
  handle(ACCOUNT_CHANNELS.getPairingSession, (_event, id) => {
    if (typeof id !== "string") throw new Error("无效的配对会话。");
    return rateLimitAware(() => sync.getPairingSession(id));
  });
  handle(ACCOUNT_CHANNELS.approvePairingSession, (_event, id) => {
    if (typeof id !== "string") throw new Error("无效的配对会话。");
    return rateLimitAware(() => sync.approvePairingSession(id));
  });
  handle(TRANSCRIPTION_CHANNELS.syncPrivate, () => rateLimitAware(async () => {
    const result = await sync.sync();
    onCompleted?.({ completedAt: (/* @__PURE__ */ new Date()).toISOString() });
    return result;
  }));
  handle(TRANSCRIPTION_CHANNELS.listPrivate, () => sync.list());
  handle(TRANSCRIPTION_CHANNELS.listTags, () => rateLimitAware(() => sync.listTags()));
  handle(TRANSCRIPTION_CHANNELS.replaceSummaryTags, (_event, summaryRecordId, tags) => rateLimitAware(() => sync.replaceSummaryTags(summaryRecordId, tags)));
  handle(TRANSCRIPTION_CHANNELS.renameTag, (_event, tagId, label) => rateLimitAware(() => sync.renameTag(tagId, label)));
  handle(TRANSCRIPTION_CHANNELS.mergeTag, (_event, targetTagId, sourceTagId) => rateLimitAware(() => sync.mergeTag(targetTagId, sourceTagId)));
}
function registerScreenCaptureHandlers() {
  const isAuthorized = (event) => {
    const window2 = BrowserWindow.getAllWindows()[0];
    return Boolean(
      window2 && !window2.isDestroyed() && !window2.webContents.isDestroyed() && event.sender === window2.webContents
    );
  };
  handle(SCREEN_CAPTURE_CHANNELS.captureCurrentWindow, async (event) => {
    if (!isAuthorized(event)) {
      return { ok: false, code: "window-unavailable", message: desktopText("error.screenshot.invalidSource") };
    }
    return captureAndQueueCurrentWindow();
  });
  handle(SCREEN_CAPTURE_CHANNELS.start, async (event, intervalMs) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus();
    const status = await screenshotScheduler.start(typeof intervalMs === "number" ? intervalMs : NaN);
    await perceptionGatewayBridge?.updateCapture({ enabled: true, intervalMs: status.intervalMs }).catch(() => void 0);
    return status;
  });
  handle(SCREEN_CAPTURE_CHANNELS.updateInterval, async (event, intervalMs) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus();
    const status = screenshotScheduler.updateInterval(typeof intervalMs === "number" ? intervalMs : NaN);
    await perceptionGatewayBridge?.updateCapture({ intervalMs: status.intervalMs }).catch(() => void 0);
    return status;
  });
  handle(SCREEN_CAPTURE_CHANNELS.stop, async (event) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus();
    const status = screenshotScheduler.stop();
    await perceptionGatewayBridge?.updateCapture({ enabled: false }).catch(() => void 0);
    return status;
  });
  handle(SCREEN_CAPTURE_CHANNELS.status, (event) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus();
    return screenshotScheduler.getStatus();
  });
}
function registerPerceptionAndDiaryHandlers() {
  handle(PERCEPTION_CHANNELS.settings, () => {
    if (!perceptionGatewayBridge) throw new Error("现实感知服务尚未就绪。");
    return perceptionGatewayBridge.getSettings();
  });
  handle(PERCEPTION_CHANNELS.updateOnlineVlm, (_event, enabled, configVersion) => {
    if (!perceptionGatewayBridge || typeof enabled !== "boolean" || typeof configVersion !== "number") {
      throw new Error("感知设置参数无效。");
    }
    return perceptionGatewayBridge.updateOnlineVlm(enabled, configVersion);
  });
  handle(PERCEPTION_CHANNELS.nodes, (_event, query) => {
    if (!perceptionGatewayBridge) throw new Error("现实感知服务尚未就绪。");
    return perceptionGatewayBridge.listNodes(query && typeof query === "object" ? query : {});
  });
  handle(PERCEPTION_CHANNELS.node, (_event, id) => {
    if (!perceptionGatewayBridge || typeof id !== "string") throw new Error("感知节点参数无效。");
    return perceptionGatewayBridge.getNode(id);
  });
  handle(PERCEPTION_CHANNELS.retry, (_event, id) => {
    if (!perceptionGatewayBridge || typeof id !== "string") throw new Error("感知节点参数无效。");
    return perceptionGatewayBridge.retryNode(id);
  });
  handle(PERCEPTION_CHANNELS.delete, (_event, id, deleteAssets) => {
    if (!perceptionGatewayBridge || typeof id !== "string") throw new Error("感知节点参数无效。");
    return perceptionGatewayBridge.deleteNode(id, deleteAssets === true);
  });
  handle(DIARY_CHANNELS.settings, () => {
    if (!diaryGatewayBridge) throw new Error("日记服务尚未就绪。");
    return diaryGatewayBridge.settings();
  });
  handle(DIARY_CHANNELS.updateSettings, (_event, input) => {
    if (!diaryGatewayBridge || !input || typeof input !== "object") throw new Error("日记设置参数无效。");
    return diaryGatewayBridge.updateSettings(input);
  });
  handle(DIARY_CHANNELS.generate, async (_event, date) => {
    if (!diaryGatewayBridge || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("日记日期参数无效。");
    }
    logLocalDesktop("diary", "info", { event: "diary.generate.requested", date });
    try {
      const result = await diaryGatewayBridge.generate(date);
      logLocalDesktop("diary", "info", { event: "diary.generate.accepted", date, runId: result.runId });
      return result;
    } catch (error) {
      logLocalDesktop("diary", "error", {
        event: "diary.generate.rejected",
        date,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  });
  handle(DIARY_CHANNELS.run, (_event, id) => {
    if (!diaryGatewayBridge || typeof id !== "string" || id.length < 1 || id.length > 100) {
      throw new Error("日记运行参数无效。");
    }
    return diaryGatewayBridge.run(id);
  });
  handle(DIARY_CHANNELS.activeRun, () => {
    if (!diaryGatewayBridge) throw new Error("日记服务尚未就绪。");
    return diaryGatewayBridge.activeRun();
  });
  handle(DIARY_CHANNELS.days, (_event, start, end) => {
    if (!diaryGatewayBridge || typeof start !== "string" || typeof end !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new Error("日记日期范围参数无效。");
    }
    return diaryGatewayBridge.days(start, end);
  });
  handle(DIARY_CHANNELS.day, (_event, date) => {
    if (!diaryGatewayBridge || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("日记日期参数无效。");
    }
    return diaryGatewayBridge.day(date);
  });
  handle(AGENT_SCHEDULER_CHANNELS.list, () => {
    if (!agentSchedulerGatewayBridge) throw new Error("Agent 定时任务服务尚未就绪。");
    return agentSchedulerGatewayBridge.list();
  });
  handle(AGENT_SCHEDULER_CHANNELS.create, (_event, input) => {
    if (!agentSchedulerGatewayBridge || !input || typeof input !== "object") throw new Error("Agent 定时任务参数无效。");
    return agentSchedulerGatewayBridge.create(input);
  });
  handle(AGENT_SCHEDULER_CHANNELS.update, (_event, id, input) => {
    if (!agentSchedulerGatewayBridge || typeof id !== "string" || !input || typeof input !== "object") throw new Error("Agent 定时任务参数无效。");
    return agentSchedulerGatewayBridge.update(id, input);
  });
  handle(AGENT_SCHEDULER_CHANNELS.runNow, (_event, id) => {
    if (!agentSchedulerGatewayBridge || typeof id !== "string") throw new Error("Agent 定时任务参数无效。");
    return agentSchedulerGatewayBridge.runNow(id);
  });
  handle(AGENT_SCHEDULER_CHANNELS.remove, (_event, id) => {
    if (!agentSchedulerGatewayBridge || typeof id !== "string") throw new Error("Agent 定时任务参数无效。");
    return agentSchedulerGatewayBridge.remove(id);
  });
}
function createWindow() {
  const window2 = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: "Everroom",
    backgroundColor: "#f5f5f5",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 17 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  installCrossOriginIsolation(window2.webContents.session, process.env.ELECTRON_RENDERER_URL);
  window2.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Failed to load preload script: ${preloadPath}`, error);
  });
  window2.webContents.session.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    return permission === "media" && details.mediaType === "audio";
  });
  window2.webContents.session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== "media" || !("mediaTypes" in details)) {
      callback(false);
      return;
    }
    callback(details.mediaTypes?.includes("audio") ?? false);
  });
  if (process.platform === "darwin") {
    window2.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      const respond = (streams) => {
        try {
          callback(streams);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.info(`macOS system audio capture request ended: ${message}`);
        }
      };
      if (request.frame !== window2.webContents.mainFrame || !request.audioRequested || !request.videoRequested) {
        respond({});
        return;
      }
      try {
        void desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 }
        }).then(
          (sources) => {
            const source = sources[0];
            if (!source || window2.isDestroyed()) respond({});
            else respond({ video: source, audio: "loopback" });
          },
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.info(`macOS system audio capture permission was not granted: ${message}`);
            respond({});
          }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.info(`macOS system audio capture permission was not granted: ${message}`);
        respond({});
      }
    });
  }
  window2.once("ready-to-show", () => window2.show());
  window2.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window2.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window2.loadFile(join(__dirname, "../renderer/index.html"));
  }
}
if (hasSingleInstanceLock) app.whenReady().then(async () => {
  nativeTheme.themeSource = "light";
  if (process.defaultApp && process.argv[1] && process.platform !== "darwin") {
    app.setAsDefaultProtocolClient("everroom", process.execPath, [app.getAppPath()]);
  } else {
    app.setAsDefaultProtocolClient("everroom");
  }
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(join(app.getAppPath(), "build/icon.png"));
  }
  const documentAssets = new DocumentAssetStore(join(dataDirectory, "document-assets"));
  await documentAssets.initialize().catch((error) => {
    console.error("Failed to initialize local document assets", error);
  });
  screenshotOutbox = new ScreenshotOutbox(
    join(dataDirectory, "perception", "screenshot-outbox.json"),
    () => gatewaySupervisor
  );
  await screenshotOutbox.initialize();
  protocol.handle(DOCUMENT_ASSET_SCHEME, (request) => documentAssets.response(request.url));
  installIpcRouters();
  registerSystemClipboardHandler();
  registerGatewayHandlers();
  registerOpenConnectorHandlers();
  createWindow();
  const connectorPageEnabled = desktopPageMode === "connectors";
  const configuredNangoUrl = process.env.NXCORE_NANGO_CONNECTOR_URL?.trim() || process.env.NXCORE_NANGO_URL?.trim() || "";
  const configuredNangoSecret = process.env.NXCORE_NANGO_CONNECTOR_SECRET?.trim() || process.env.NXCORE_NANGO_SECRET?.trim() || "";
  const nangoSecretIsUuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(configuredNangoSecret);
  try {
    if (connectorPageEnabled) {
      openConnectorSupervisor = new OpenConnectorSupervisor(join(dataDirectory, "open-connector"));
      const openConnector = await openConnectorSupervisor.start().catch((error) => {
        console.error("Managed OpenConnector failed to start; connector tools stay disabled.", error);
        return null;
      });
      if (openConnector) {
        ooCliBridge = createOoCliBridge(openConnector);
        attachOpenConnectorBridge(ooCliBridge);
      }
    }
    memoryCoreSupervisor = new MemoryCoreSupervisor(dataDirectory);
    const memoryCore = await memoryCoreSupervisor.start().catch((error) => {
      console.error("Managed MemoryCore failed to start; memory stays disabled.", error);
      return null;
    });
    if (!connectorPageEnabled) {
      nangoSupervisor = new NangoSupervisor();
      void nangoSupervisor.start().catch((error) => {
        console.error("Managed Nango failed to start; data source connectors stay disabled.", error);
        return null;
      });
    }
    knowledgeServiceSupervisor = new KnowledgeServiceSupervisor(dataDirectory);
    const knowledge = await knowledgeServiceSupervisor.start().catch((error) => {
      console.error("Managed Knowledge service failed to start; wiki tools stay disabled.", error);
      return null;
    });
    const nangoUrl = connectorPageEnabled ? "" : nangoSupervisor?.gatewayBaseUrl() ?? configuredNangoUrl;
    const nangoSecret = nangoUrl && nangoSupervisor && !nangoSecretIsUuidV4 ? randomUUID() : nangoUrl ? configuredNangoSecret : "";
    const nangoBootstrapPending = nangoUrl && nangoSupervisor && !nangoSecretIsUuidV4 ? "1" : "0";
    gatewaySupervisor = new GatewaySupervisor(
      dataDirectory,
      {
        // packaged app 无 .env，gateway 默认 agentRuntime=fake（假流式响应）；
        // 显式注入 pi——AI 四要素由 runtime config 兜底（降级启动到配置完成）。
        NXCORE_AGENT_RUNTIME: "pi",
        ...ooCliBridge ? ooCliBridge.environment() : {},
        NXCORE_CLI_CONNECTOR_AGENT_MODE: ooCliBridge ? "local" : "direct",
        NXCORE_CLI_CONNECTOR_SYNC_ENABLED: ooCliBridge ? "true" : "false",
        ...memoryCore ? {
          NXCORE_MEMORY_ENABLED: "true",
          NXCORE_MEMORY_BASE_URL: memoryCore.baseUrl,
          NXCORE_MEMORY_API_KEY: memoryCore.apiKey
        } : {},
        NXCORE_NANGO_CONNECTOR_URL: nangoUrl,
        NXCORE_NANGO_CONNECTOR_SECRET: nangoSecret,
        NXCORE_NANGO_BOOTSTRAP_PENDING: nangoBootstrapPending,
        NXCORE_NANGO_URL: nangoUrl,
        NXCORE_NANGO_SECRET: nangoSecret,
        ...knowledge ? {
          NXCORE_KNOWLEDGE_ENABLED: "true",
          NXCORE_KNOWLEDGE_BASE_URL: knowledge.baseUrl,
          NXCORE_KNOWLEDGE_SERVICE_ID: knowledge.serviceId,
          NXCORE_KNOWLEDGE_TEAM_ID: knowledge.teamId,
          // Room 级 wiki 模式（docs/room-wiki-plan.md）：wiki 由 gateway 按
          // Room 懒创建并随会话解析，桌面端不再注入全局 wiki_id。
          NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED: "true"
        } : {}
      }
    );
    const gateway = await gatewaySupervisor.start();
    console.info(`NxCore Gateway ready at ${gateway.baseUrl} (pid=${gateway.pid})`);
    void screenshotOutbox.flush();
    perceptionGatewayBridge = new PerceptionGatewayBridge(gatewaySupervisor);
    runtimeConfigBridge = new RuntimeConfigBridge(gatewaySupervisor);
    void runtimeConfigBridge.get().then((snapshot) => syncManagedChildProcesses(snapshot)).catch((error) => console.warn("[managed-children] startup runtime-config sync skipped:", error));
    diaryGatewayBridge = new DiaryGatewayBridge(gatewaySupervisor);
    agentSchedulerGatewayBridge = new AgentSchedulerGatewayBridge(gatewaySupervisor);
    registerPerceptionAndDiaryHandlers();
    const perceptionSettings = await perceptionGatewayBridge.getSettings().catch(() => null);
    if (perceptionSettings?.captureEnabled) {
      await screenshotScheduler.start(perceptionSettings.captureIntervalSeconds * 1e3);
    } else if (perceptionSettings) {
      screenshotScheduler.updateInterval(perceptionSettings.captureIntervalSeconds * 1e3);
    }
    cursorCompletionSupervisor = new GatewaySupervisor(
      join(dataDirectory, "cursor-completion-service"),
      // getter：惰性 respawn 时重新求值，拿到最新 runtime config 派生的 AI env。
      () => ({
        NXCORE_MEMORY_ENABLED: "false",
        NXCORE_AGENT_RUNTIME: "pi",
        ...cursorCompletionAiEnv
      }),
      {
        devScript: "dev:cursor-completion",
        packagedEntry: "cursor-completion-serve.js",
        logLabel: "cursor-completion",
        devPortEnvironment: "NXCORE_CURSOR_COMPLETION_DEV_PORT"
      }
    );
    registerContextRoomHandlers(new ContextRoomGatewayBridge(gatewaySupervisor));
    registerConnectorSyncHandlers(new CliConnectorSyncGatewayBridge(gatewaySupervisor));
    realityGatewayBridge = new RealityGatewayBridge(gatewaySupervisor);
    registerRealityHandlers(realityGatewayBridge);
    connectorGatewayBridge = new NangoConnectorGatewayBridge(gatewaySupervisor, (url) => shell.openExternal(url));
    registerConnectorHandlers(connectorGatewayBridge);
    registerMemoryHandlers(new MemoryGatewayBridge(gatewaySupervisor));
    documentGatewayBridge = new DocumentGatewayBridge(gatewaySupervisor);
    registerDocumentHandlers(documentGatewayBridge, documentAssets);
    registerDocumentPdfExportHandler();
    registerKnowledgeHandlers(new KnowledgeGatewayBridge(gatewaySupervisor));
    registerMcpHandlers(new McpGatewayBridge(gatewaySupervisor));
    const highRiskImports = new HighRiskImportCoordinator(join(dataDirectory, "high-risk-imports.json"));
    await highRiskImports.initialize();
    const filesGatewayBridge = new FilesGatewayBridge(gatewaySupervisor, highRiskImports);
    registerFilesHandlers(filesGatewayBridge, highRiskImports);
    registerIngestHandlers(new IngestGatewayBridge(gatewaySupervisor));
    const credentials = new CredentialStore(join(app.getPath("userData"), "credentials.json"));
    await credentials.initialize();
    const recordingsDirectory = join(dataDirectory, "recordings");
    recordingStore = new RecordingStore(recordingsDirectory);
    saasClient = new SaasClient(credentials, app, recordingsDirectory, (url) => shell.openExternal(url));
    void saasClient.initialize();
    agentStatusReporter = new AgentStatusReporter(saasClient);
    agentGatewayBridge = new AgentGatewayBridge(gatewaySupervisor, agentStatusReporter);
    agentStatusReporter.setSessionsProvider(async () => (await agentGatewayBridge.listAllSessionSnapshots()).map((snapshot) => ({
      ...snapshot.session,
      activeRun: snapshot.activeRun,
      lastEventSeq: snapshot.lastEventSeq,
      messages: snapshot.messages.slice(-120)
    })));
    remoteAgentCommandClient = new RemoteAgentCommandClient(saasClient, agentGatewayBridge);
    registerAgentHandlers(agentGatewayBridge);
    cursorCompletionAgentBridge = new AgentGatewayBridge(cursorCompletionSupervisor);
    registerCursorCompletionAgentHandlers(cursorCompletionAgentBridge);
    agentStatusReporter.start();
    const keyring = new AccountKeyringService(join(dataDirectory, "account-keyring.json"));
    privateAudioSync = new PrivateAudioSyncService(saasClient, keyring, recordingsDirectory, join(dataDirectory, "private-audio-sync.json"));
    void privateAudioSync.drainPending().catch(() => void 0);
    privateTranscriptionSync = new PrivateTranscriptionSyncService(
      join(dataDirectory, "private-transcription-sync.json"),
      saasClient,
      keyring,
      realityGatewayBridge
    );
    await privateTranscriptionSync.initialize();
    privateTranscriptionSync.setMaterializeGate(waitForCloudMaterializeGate);
    const publishSyncCompleted = () => {
      const event = { completedAt: (/* @__PURE__ */ new Date()).toISOString() };
      for (const target of BrowserWindow.getAllWindows()) {
        if (!target.isDestroyed() && !target.webContents.isDestroyed()) {
          target.webContents.send("transcription:sync-completed", event);
        }
      }
    };
    privateSyncScheduler = new PrivateSyncScheduler(privateTranscriptionSync, 15e3, publishSyncCompleted);
    const initialAccount = await saasClient.status().catch(() => null);
    if (initialAccount?.authenticated) {
      void saasClient.getRuntimeConfig().then(async (config) => {
        const snapshot = await runtimeConfigBridge?.saveSaas(config.config);
        if (snapshot) await syncManagedChildProcesses(snapshot);
      }).catch((error) => {
        if (error instanceof SaasRequestError && (error.status === 401 || error.status === 403)) {
          void runtimeConfigBridge?.clearSaas().then((snapshot) => snapshot ? syncManagedChildProcesses(snapshot) : void 0).catch(() => void 0);
        } else {
          console.warn("Unable to restore SaaS runtime config", error);
        }
      });
    }
    privateSyncScheduler.setAuthenticated(Boolean(initialAccount?.authenticated));
    if (initialAccount?.authenticated) remoteAgentCommandClient.start();
    privateAudioSync.setEventResolver((recordingId) => privateTranscriptionSync.eventIdForSegment(recordingId));
    void privateTranscriptionSync?.materializeCached().catch((error) => {
      console.warn("Unable to import cached private transcriptions into Reality.", error);
    });
    transcriptionProcessingCoordinator = new TranscriptionProcessingCoordinator(
      join(dataDirectory, "transcription-processing-state.json"),
      saasClient,
      keyring,
      agentGatewayBridge,
      privateTranscriptionSync
    );
    await transcriptionProcessingCoordinator.initialize();
    transcriptionProcessingCoordinator.start();
    if (process.platform !== "darwin") {
      const startupProtocolUrl = process.argv.find((argument) => argument.startsWith(OIDC_CALLBACK_URL));
      if (startupProtocolUrl) queuedProtocolUrls.push(startupProtocolUrl);
    }
    for (const url of queuedProtocolUrls.splice(0)) saasClient.handleOidcCallback(url);
    let lastAccountId = initialAccount?.user?.id ?? null;
    registerAccountHandlers(saasClient, (account) => {
      if (account.authenticated) {
        void saasClient?.getRuntimeConfig().then(async (config) => {
          const snapshot = await runtimeConfigBridge?.saveSaas(config.config);
          if (snapshot) await syncManagedChildProcesses(snapshot);
        }).catch((error) => {
          if (error instanceof SaasRequestError && (error.status === 401 || error.status === 403)) {
            void runtimeConfigBridge?.clearSaas().then((snapshot) => snapshot ? syncManagedChildProcesses(snapshot) : void 0).catch(() => void 0);
          } else console.warn("Unable to refresh SaaS runtime config", error);
        });
      } else {
        void runtimeConfigBridge?.clearSaas().then((snapshot) => snapshot ? syncManagedChildProcesses(snapshot) : void 0).catch(() => void 0);
      }
      privateSyncScheduler?.setAuthenticated(account.authenticated);
      if (!account.authenticated) {
        remoteAgentCommandClient?.stop();
        agentStatusReporter?.reset();
        lastAccountId = null;
      } else {
        if (lastAccountId !== account.user?.id) agentStatusReporter?.reset();
        lastAccountId = account.user?.id ?? null;
        remoteAgentCommandClient?.start();
        agentStatusReporter?.reportNow();
        transcriptionProcessingCoordinator?.wake();
      }
    });
    registerRuntimeConfigHandlers(saasClient);
    registerPrivateTranscriptionHandlers(privateTranscriptionSync, publishSyncCompleted);
    registerAsrHandlers(recordingStore, new AsrCoordinator(new AsrGatewayBridge(gatewaySupervisor), saasClient, realityGatewayBridge, privateAudioSync, privateTranscriptionSync));
    registerPrivateAudioHandlers(privateAudioSync);
    registerScreenCaptureHandlers();
    const fileCapabilities = await filesGatewayBridge.capabilities().catch((error) => {
      console.warn("Unable to load file capabilities; automatic local scanning stays disabled.", error);
      return { items: [] };
    });
    const autoScanExtensions = new Set(fileCapabilities.items.filter((item) => item.autoScan && LOCAL_AUTO_SCAN_EXTENSIONS.has(item.extension.toLowerCase())).map((item) => item.extension.toLowerCase()));
    const connectorImportExtensions = new Set(fileCapabilities.items.filter((item) => item.connectorImport).map((item) => item.extension.toLowerCase()));
    const connectors = new ConnectorRegistry().register(new LocalFolderConnector(autoScanExtensions)).register(new GitHubConnector((key) => credentials.get(key))).register(new GoogleDocsConnector((key) => credentials.get(key))).register(new NotionConnector((key) => credentials.get(key)));
    localDataService = new LocalDataService(
      dataDirectory,
      connectors,
      filesGatewayBridge,
      autoScanExtensions,
      connectorImportExtensions,
      highRiskImports
    );
    await localDataService.initialize();
    registerSourceHandlers(localDataService, credentials);
    resolveServicesReady?.();
  } catch (error) {
    rejectServicesReady?.(error instanceof Error ? error : new Error(String(error)));
    privateSyncScheduler?.stop();
    privateSyncScheduler = null;
    const service = localDataService;
    localDataService = null;
    await service?.shutdown();
    agentGatewayBridge?.dispose();
    agentGatewayBridge = null;
    remoteAgentCommandClient?.stop();
    remoteAgentCommandClient = null;
    agentStatusReporter?.stop();
    agentStatusReporter = null;
    cursorCompletionAgentBridge?.dispose();
    cursorCompletionAgentBridge = null;
    documentGatewayBridge?.dispose();
    documentGatewayBridge = null;
    realityGatewayBridge?.dispose();
    realityGatewayBridge = null;
    perceptionGatewayBridge = null;
    diaryGatewayBridge = null;
    agentSchedulerGatewayBridge = null;
    connectorGatewayBridge = null;
    await recordingStore?.dispose();
    recordingStore = null;
    await gatewaySupervisor?.shutdown();
    gatewaySupervisor = null;
    await cursorCompletionSupervisor?.shutdown();
    cursorCompletionSupervisor = null;
    await memoryCoreSupervisor?.shutdown();
    memoryCoreSupervisor = null;
    await knowledgeServiceSupervisor?.shutdown();
    knowledgeServiceSupervisor = null;
    console.error("Failed to initialize Everroom desktop services", error);
    app.quit();
    return;
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  const service = localDataService;
  const gateway = gatewaySupervisor;
  const connectorCli = ooCliBridge;
  const connectorRuntime = openConnectorSupervisor;
  const connectorConsole = openConnectorConsoleWindow;
  const cursorCompletion = cursorCompletionSupervisor;
  const memoryCore = memoryCoreSupervisor;
  const nango = nangoSupervisor;
  const knowledgeService = knowledgeServiceSupervisor;
  const agentBridge = agentGatewayBridge;
  const statusReporter = agentStatusReporter;
  const remoteCommands = remoteAgentCommandClient;
  const cursorCompletionBridge = cursorCompletionAgentBridge;
  const documentBridge = documentGatewayBridge;
  const realityBridge = realityGatewayBridge;
  const recordings = recordingStore;
  const pendingScreenshots = screenshotOutbox;
  const cloud = saasClient;
  const privateSync = privateSyncScheduler;
  localDataService = null;
  gatewaySupervisor = null;
  ooCliBridge = null;
  openConnectorSupervisor = null;
  openConnectorConsoleWindow = null;
  cursorCompletionSupervisor = null;
  memoryCoreSupervisor = null;
  nangoSupervisor = null;
  knowledgeServiceSupervisor = null;
  agentGatewayBridge = null;
  agentStatusReporter = null;
  remoteAgentCommandClient = null;
  cursorCompletionAgentBridge = null;
  documentGatewayBridge = null;
  realityGatewayBridge = null;
  perceptionGatewayBridge = null;
  diaryGatewayBridge = null;
  agentSchedulerGatewayBridge = null;
  connectorGatewayBridge = null;
  recordingStore = null;
  saasClient = null;
  screenshotOutbox = null;
  screenshotScheduler.stop();
  privateSyncScheduler = null;
  privateSync?.stop();
  if (connectorConsole && !connectorConsole.isDestroyed()) connectorConsole.destroy();
  connectorCli?.shutdown();
  agentBridge?.dispose();
  statusReporter?.stop();
  remoteCommands?.stop();
  cursorCompletionBridge?.dispose();
  documentBridge?.dispose();
  realityBridge?.dispose();
  cloud?.cancelOidcLogin("EverRoom 正在退出。");
  void Promise.allSettled([
    service?.shutdown(),
    recordings?.dispose(),
    pendingScreenshots?.dispose(),
    gateway?.shutdown(),
    connectorRuntime?.shutdown(),
    cursorCompletion?.shutdown(),
    memoryCore?.shutdown(),
    nango?.shutdown(),
    knowledgeService?.shutdown()
  ]).then(() => flushDesktopLogs()).finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
