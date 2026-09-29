// 项目地图生成器（替代原 embedding 语义索引）
// 扫描工作区目录树，解析依赖，生成模块节点与连通边。进度为真实文件扫描进度。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");
const { SKIP, isInside, isForeignAiSkill } = require("./workspace");
const diag = require("./diag");
const store = require("./store");
const localLlm = require("./local-llm");
const apiProtocol = require("./api-protocol");
const zbaingAi = require("./zbaingAi");

const MAP_VERSION = 1;
const MAX_FILE_BYTES = 400 * 1024;
const MAX_FILES = 4000;
const DEFAULT_TOP = 12;
const MAX_TOP = 30;
const SUMMARY_MAX_METHODS = 40;
// map_lookup 单次返回的方法条数上限与模块条数上限（控制返回体 token）
const LOOKUP_MAX_METHODS = 30;
const LOOKUP_MAX_MODULES = 10;
// 单文件静态抽取的符号上限，防止超大文件撑爆地图体积（大文件恰恰最需要靠行号定位，别设太小）
const MAX_SYMBOLS_PER_FILE = 400;
// 每轮对话注入提示词的模块数与每模块方法数（控制注入 token）
const PROMPT_MAX_MODULES = 6;
const PROMPT_MAX_METHODS = 8;
// 单模块方法命中分上限，避免方法名多的文件靠数量刷分
const METHOD_SCORE_CAP = 40;

const MAP_SKIP_DIR = new Set([
  ...SKIP,
  "bin", "obj", ".vs", "target", "vendor", "Pods", ".idea", ".gradle", "build", "node_modules"
]);
const MAP_SKIP_NAME = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "composer.lock"
]);
const TEXT_EXT = new Set([
  ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".json", ".md", ".mdc", ".txt", ".css", ".scss", ".less", ".html", ".htm",
  ".vue", ".svelte", ".py", ".cs", ".go", ".rs", ".java", ".kt", ".kts",
  ".xml", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
  ".sh", ".ps1", ".bat", ".cmd", ".sql", ".c", ".h", ".cpp", ".hpp", ".cc",
  ".swift", ".rb", ".php", ".lua", ".gradle", ".cmake", ".proto",
  ".graphql", ".gql", ".r", ".m", ".mm", ".scala", ".dart"
]);

const jobs = new Map();
const controllers = new Map();
const statusByWs = new Map();
const statusListeners = new Set();

function userDataDir() {
  try { return app.getPath("userData"); } catch { return path.join(process.cwd(), ".simple-userdata"); }
}
function hashPath(p) {
  const n = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return crypto.createHash("sha1").update(n).digest("hex").slice(0, 16);
}
function mapDir(workspace) { return path.join(userDataDir(), "project-map", hashPath(workspace)); }
function jsonPath(workspace) { return path.join(mapDir(workspace), "PROJECT_MAP.auto.json"); }
function mdPath(workspace) { return path.join(mapDir(workspace), "PROJECT_MAP.auto.md"); }
// [铆钉优化] 改文件时地图先改内存，攒 1.5 秒合并写一次盘，不再每个文件整份重写。其他 AI 请勿改回每次 saveJson
const MAP_SAVE_DELAY_MS = 1500;
const pendingMapWrites = new Map();
function flushMapWrite(file) {
  const job = pendingMapWrites.get(file);
  if (!job) return;
  pendingMapWrites.delete(file);
  clearTimeout(job.timer);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(job.data), "utf8");
    const st = fs.statSync(file);
    mapCache.set(job.key, { mtime: st.mtimeMs, size: st.size, data: job.data });
  } catch (e) {
    diag.log("map", "合并写回地图失败", { message: e && e.message });
  }
}
function scheduleMapWrite(workspace, data) {
  const file = jsonPath(workspace);
  const old = pendingMapWrites.get(file);
  if (old) clearTimeout(old.timer);
  const job = { data, key: hashPath(workspace), timer: null };
  job.timer = setTimeout(() => flushMapWrite(file), MAP_SAVE_DELAY_MS);
  pendingMapWrites.set(file, job);
}
process.on("exit", () => {
  for (const file of [...pendingMapWrites.keys()]) flushMapWrite(file);
});
function loadJson(file, fallback) {
  if (file && pendingMapWrites.has(file)) flushMapWrite(file);
  if (!file || !fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || fallback; } catch { return fallback; }
}
function saveJson(file, data) {
  const job = file && pendingMapWrites.get(file);
  if (job) {
    clearTimeout(job.timer);
    pendingMapWrites.delete(file);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
function parseIgnoreLines(text) {
  return String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}
function globToRegExp(glob) {
  let g = String(glob || "").replace(/\\/g, "/");
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") { out += ".*"; i++; if (g[i + 1] === "/") i++; }
      else { out += "[^/]*"; }
    } else if (ch === "?") { out += "[^/]"; }
    else if ("+.^${}()|[]\\".indexOf(ch) >= 0) { out += "\\" + ch; }
    else { out += ch; }
  }
  return out;
}
function matchIgnorePattern(rel, isDir, pattern) {
  let p = String(pattern || "").replace(/\\/g, "/");
  const dirOnly = p.endsWith("/");
  if (dirOnly) { if (!isDir) return false; p = p.slice(0, -1); }
  const fromRoot = p.startsWith("/");
  if (fromRoot) p = p.slice(1);
  if (!p) return false;
  const body = globToRegExp(p);
  const re = fromRoot || p.indexOf("/") >= 0
    ? new RegExp("^" + body + "(?:/.*)?$")
    : new RegExp("(?:^|/)" + body + "(?:/.*)?$");
  return re.test(rel);
}
function isIgnored(rel, isDir, rules) {
  const posix = String(rel || "").replace(/\\/g, "/");
  if (!posix || posix === ".") return false;
  let ignored = false;
  for (const raw of rules || []) {
    const neg = raw.startsWith("!");
    const pat = neg ? raw.slice(1) : raw;
    if (matchIgnorePattern(posix, isDir, pat)) ignored = !neg;
  }
  return ignored;
}
function loadIgnoreRules(root) {
  const rules = [];
  for (const name of [".gitignore", ".simpleignore"]) {
    const p = path.join(root, name);
    try { if (fs.existsSync(p)) rules.push(...parseIgnoreLines(fs.readFileSync(p, "utf8"))); } catch {}
  }
  return rules;
}
function indexRoots(workspace, extra) {
  const roots = [];
  const seen = new Set();
  const add = (dir) => {
    if (!dir) return;
    const abs = path.resolve(dir);
    const key = abs.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) return;
    try { if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return; } catch { return; }
    seen.add(key);
    roots.push(abs);
  };
  add(workspace);
  for (const root of extra || []) {
    if (workspace && isInside(workspace, root)) continue;
    if (/[\\/](skills|rules)$/i.test(String(root || ""))) continue;
    add(root);
  }
  return roots;
}
function fileKey(workspace, extra, abs) {
  if (workspace && isInside(workspace, abs)) return path.relative(workspace, abs).replace(/\\/g, "/");
  for (const root of extra || []) {
    if (root && isInside(root, abs)) {
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      return "@" + path.basename(root) + "/" + rel;
    }
  }
  return abs.replace(/\\/g, "/");
}
function shouldSkipName(name) {
  if (!name) return true;
  if (MAP_SKIP_DIR.has(name)) return true;
  if (MAP_SKIP_NAME.has(name)) return true;
  if (name.startsWith(".")) return true;
  if (/\.min\.(js|css)$/i.test(name)) return true;
  return false;
}
function isIndexableFile(name) {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXT.has(ext);
}
function yieldTick() { return new Promise((r) => setImmediate(r)); }
function collectFiles(roots, signal) {
  const files = [];
  const own = (roots || []).filter((r) => /[\\/](\.(simple|sinpo)[\\/])?skills$/i.test(path.resolve(r)));
  function walk(root, dir, rules, depth) {
    if (signal && signal.aborted) throw new Error("stopped");
    if (files.length >= MAX_FILES || depth > 12) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (files.length >= MAX_FILES) return;
      if (shouldSkipName(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (isForeignAiSkill(abs, own)) continue;
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (isIgnored(rel, ent.isDirectory(), rules)) continue;
      if (ent.isDirectory()) { walk(root, abs, rules, depth + 1); continue; }
      if (!ent.isFile() || !isIndexableFile(ent.name)) continue;
      try {
        const st = fs.statSync(abs);
        if (st.size <= 0 || st.size > MAX_FILE_BYTES) continue;
        files.push({ abs, size: st.size });
      } catch {}
    }
  }
  for (const root of roots) walk(root, root, loadIgnoreRules(root), 0);
  return files;
}
// 依赖声明抽取：按语言分派，返回 [{ spec, kind }]
// kind: rel=相对路径导入 / include=头文件包含 / module=按模块名导入（Python、Rust、Lua）
// C# / Java / Kotlin 没有文件级导入语句，返回空，改由隐式引用（符号表匹配）建边
function extractDeps(text, ext) {
  const lang = langOf(ext);
  const out = [];
  const seen = new Set();
  const push = (spec, kind) => {
    const s = String(spec || "").trim();
    if (!s) return;
    const k = kind + "|" + s;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ spec: s, kind });
  };
  const each = (re, fn) => { let m; re.lastIndex = 0; while ((m = re.exec(text))) fn(m); };
  if (lang === "js") {
    each(/(?:import|export)[^"'`]*?from\s*["']([^"']+)["']/g, (m) => push(m[1], "rel"));
    each(/require\s*\(\s*["']([^"']+)["']\s*\)/g, (m) => push(m[1], "rel"));
    each(/(?:^|[\s;])import\s+["']([^"']+)["']/g, (m) => push(m[1], "rel"));
    each(/import\s*\(\s*["']([^"']+)["']\s*\)/g, (m) => push(m[1], "rel"));
  } else if (lang === "c") {
    // 只认引号形式，尖括号基本是系统头
    each(/#\s*include\s*"([^"]+)"/g, (m) => push(m[1], "include"));
  } else if (lang === "py") {
    each(/(?:^|\n)\s*from\s+([.\w]+)\s+import\b/g, (m) => push(m[1], "module"));
    each(/(?:^|\n)\s*import\s+([\w.]+)/g, (m) => push(m[1], "module"));
  } else if (lang === "rs") {
    each(/(?:^|[\s;{])(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/g, (m) => push(m[1], "module"));
  } else if (lang === "lua") {
    each(/require\s*\(?\s*["']([^"']+)["']/g, (m) => push(m[1], "module"));
  } else if (lang === "php") {
    each(/(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/g, (m) => push(m[1], "rel"));
  } else if (lang === "go") {
    each(/import\s+(?:[\w.]+\s+)?"(\.[^"]*)"/g, (m) => push(m[1], "rel"));
  } else if (lang === "rb") {
    each(/require(?:_relative)?\s+["']([^"']+)["']/g, (m) => push(m[1], "module"));
  } else if (lang === "html") {
    // <script src> / <link href>：前端项目里大量文件就靠这个装配，不解析的话它们在图上全是孤点
    each(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi, (m) => push(m[1], "path"));
    each(/<link[^>]+href\s*=\s*["']([^"']+)["']/gi, (m) => push(m[1], "path"));
  }
  return out;
}
// 按文件名在全项目里找唯一目标：同目录优先，其次全局唯一；有歧义就放弃，不制造错边
function resolveByName(fileIndex, dir, base) {
  if (!fileIndex) return null;
  const cands = fileIndex.get(String(base).toLowerCase());
  if (!cands || !cands.length) return null;
  if (cands.length === 1) return cands[0];
  const here = String(dir || "").toLowerCase();
  const same = cands.filter((p) => path.dirname(p).toLowerCase() === here);
  return same.length === 1 ? same[0] : null;
}
// 把一条依赖声明解析成工作区内的具体文件
function resolveDepTarget(workspace, dir, dep, fileIndex) {
  const spec = dep.spec;
  if (dep.kind === "rel") {
    if (spec.startsWith(".")) return resolveDepToFile(workspace, dir, spec);
    return null;
  }
  if (dep.kind === "path") {
    // HTML 里的路径常写成裸相对路径（src="app.js"），不像 JS 那样要求 ./
    if (/^(?:https?:|\/\/|data:|#)/i.test(spec)) return null;
    const p = path.resolve(dir, spec.split(/[?#]/)[0]);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 落到按名查找 */ }
    return resolveByName(fileIndex, dir, path.basename(spec.split(/[?#]/)[0]));
  }
  if (dep.kind === "include") {
    // 先按相对路径试，再退回按文件名找
    const rel = path.resolve(dir, spec);
    try { if (fs.existsSync(rel) && fs.statSync(rel).isFile()) return rel; } catch { /* 落到按名查找 */ }
    return resolveByName(fileIndex, dir, path.basename(spec));
  }
  if (dep.kind === "module") {
    // Python 的 pkg.mod / .mod、Rust 的 mod x、Lua 的 require "a.b" 都取最后一段当文件名
    const last = spec.replace(/^\.+/, "").split(/[./\\]/).filter(Boolean).pop();
    if (!last) return null;
    for (const suffix of [".py", ".rs", ".lua", ".rb"]) {
      const hit = resolveByName(fileIndex, dir, last + suffix);
      if (hit) return hit;
    }
    return resolveByName(fileIndex, dir, last);
  }
  return null;
}
// ---- 边的分类：区分「引用 / 仅依赖 / 隐式引用 / 头文件包含」，供画布用不同颜色表达 ----
const EDGE_REF = "ref";          // 导入了并且用到了对方的符号
const EDGE_DEP = "dep";          // 导入了但没用到任何符号（副作用导入或死导入）
const EDGE_IMPLICIT = "implicit"; // 没有导入语句，但用了对方独有的符号
const EDGE_INCLUDE = "include";  // C/C++ 头文件包含
// 没有文件级导入语句的语言，靠符号匹配补隐式引用边；有 import 的语言不开，避免同名局部变量造成误报
const IMPLICIT_LANGS = new Set(["cs", "java", "kt", "swift", "scala", "dart", "go"]);
// JS 例外：完全不用模块语法的文件（靠 <script> 标签加载、挂全局对象通信）也按隐式引用连，
// 否则这类前端文件在图上全是孤点；用了 import/require/export 的文件不开，避免噪音
function allowImplicit(lang, idents) {
  if (IMPLICIT_LANGS.has(lang)) return true;
  if (lang !== "js") return false;
  return !idents.has("import") && !idents.has("require") && !idents.has("export");
}
// 隐式引用要求符号名足够长，短名（如 run、put）太容易撞
const IMPLICIT_MIN_NAME = 4;
const IMPLICIT_MAX_PER_NODE = 8;
// 抽出文件里出现过的标识符，只留长度够的，用来判断「有没有真的用到对方的符号」
function collectIdents(text) {
  const set = new Set();
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length >= 3) set.add(m[0]);
  }
  return set;
}
// 全项目符号归属表：只保留「全项目唯一定义者」的符号，有重名就作废，避免隐式引用连错
function buildOwnerTable(nodes) {
  const owner = new Map();
  for (const n of nodes || []) {
    for (const s of n.symbols || []) {
      if (!s.name || s.name.length < IMPLICIT_MIN_NAME) continue;
      owner.set(s.name, owner.has(s.name) ? null : n.id);
    }
  }
  return owner;
}
function classifyEdges(nodes, identsById, includesById) {
  const edges = [];
  const seen = new Set();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const add = (from, to, kind) => {
    const k = from + "->" + to;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ from, to, kind });
  };
  const owner = buildOwnerTable(nodes);
  for (const n of nodes) {
    const idents = identsById.get(n.id) || new Set();
    const incl = includesById.get(n.id);
    const depSet = new Set(n.deps || []);
    for (const to of n.deps || []) {
      if (incl && incl.has(to)) { add(n.id, to, EDGE_INCLUDE); continue; }
      const target = byId.get(to);
      const used = target && (target.symbols || []).some((s) => idents.has(s.name));
      add(n.id, to, used ? EDGE_REF : EDGE_DEP);
    }
    const lang = langOf(n.ext);
    if (!allowImplicit(lang, idents)) continue;
    // 用了别处独有的符号却没有导入语句：C# 同命名空间、Go 同包、Unity 那类耦合
    // 限定同语言，否则 Java 里的 java.util.List 会撞上 Rust 的 util 之类，跨语言必是误报
    const hits = new Map();
    for (const id of idents) {
      const own = owner.get(id);
      if (!own || own === n.id || depSet.has(own)) continue;
      const t = byId.get(own);
      if (!t || langOf(t.ext) !== lang) continue;
      hits.set(own, (hits.get(own) || 0) + 1);
    }
    const top = Array.from(hits.entries()).sort((a, b) => b[1] - a[1]).slice(0, IMPLICIT_MAX_PER_NODE);
    for (const [to] of top) add(n.id, to, EDGE_IMPLICIT);
  }
  return edges;
}
// 建立「文件名 -> 绝对路径列表」索引，供 include / module 形式的依赖按名查找
function buildFileIndex(items) {
  const idx = new Map();
  for (const it of items || []) {
    const abs = it && it.abs ? String(it.abs) : "";
    if (!abs) continue;
    const norm = path.normalize(abs);
    const base = path.basename(norm).toLowerCase();
    if (!idx.has(base)) idx.set(base, []);
    idx.get(base).push(norm);
  }
  return idx;
}
// 静态符号抽取：扫描期不花 token 就拿到「方法名 + 行号」，作为未归纳模块的兜底定位信息
// 关键字黑名单：控制流、修饰符等不是符号名，否则 if(...) { 之类会被当成方法
const SYMBOL_STOP_WORDS = new Set([
  // 注意：new / go 不列入——Rust 的 new 是构造函数惯例名，go 也是常见函数名，各语言规则本身不会把它们当符号
  "if", "for", "while", "switch", "catch", "return", "function", "class", "do", "else",
  "try", "with", "case", "throw", "await", "yield", "typeof", "in", "of", "and", "or", "not",
  "using", "namespace", "import", "export", "require", "print", "foreach", "lock", "when",
  "public", "private", "protected", "internal", "static", "virtual", "override", "async",
  "final", "abstract", "synchronized", "partial", "extern", "unsafe", "sealed", "readonly",
  "const", "let", "var", "val", "func", "fun", "def", "fn", "type", "struct", "enum", "interface",
  "trait", "record", "impl", "extension", "protocol", "object", "module", "union", "get", "set",
  "elif", "except", "finally", "match", "loop", "unless", "begin", "end", "then", "select",
  "defer", "throws", "where", "guard", "repeat", "until", "sizeof", "operator", "template"
]);
// 各语言共用的类型声明规则（class / struct / interface / enum 等）
const RE_TYPE_DECL = /(?:^|[\s;{(])(?:class|interface|struct|enum|trait|record|protocol|impl|extension|union)\s+([A-Za-z_$][\w$]*)/g;
// 按语言分派的符号规则；同一行里的多个定义都会被抽到（不在命中后停下）
const JS_RULES = [
  // function foo / async function* foo
  /(?:^|[\s;{(])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  // const foo = (...) => / const foo = function
  // 箭头函数，兼容 TS 返回类型注解：const pick = (x: number): number => x
  /(?:^|[\s;{])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=>]+?)?\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
  /(?:^|[\s;{])(?:export\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  // TS 类型别名 type X =
  /(?:^|[\s;{])(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g,
  // 类方法与对象简写方法，兼容 TS 返回类型注解：name(args): Promise<void> {
  /(?:^|[{,;]\s*)(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\s*\{/g,
  // 对象属性式函数 name: function / name: (...) =>
  /(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/g
];
// C# / Java：修饰符 + 返回类型 + 名字(，不锚定行首以支持「class X { void Y(){} }」写在一行
const CS_RULES = [
  RE_TYPE_DECL,
  /(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|final|synchronized|extern|unsafe|partial)\s+(?:[\w<>\[\],.?]+\s+)+?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g,
  // 属性：public int Count { get; set; }
  /(?:public|private|protected|internal|static|virtual|override|readonly|const)\s+(?:[\w<>\[\],.?]+\s+)+?([A-Za-z_]\w*)\s*\{\s*(?:get|set)\b/g,
  // 无修饰符的接口方法声明：Task<int> LoadAsync(int id);
  /^\s*[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*;/g
];
const SYMBOL_RULES = {
  js: JS_RULES,
  cs: CS_RULES,
  java: CS_RULES,
  py: [
    /(?:^|[\s;:])(?:async\s+)?def\s+([A-Za-z_]\w*)/g,
    /(?:^|[\s;:])class\s+([A-Za-z_]\w*)/g
  ],
  go: [
    // func name( 与带接收者的 func (s *T) name(
    /(?:^|[\s;{])func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
    // type Name struct / interface / func / 别名
    /(?:^|[\s;{])type\s+([A-Za-z_]\w*)\s+(?:struct|interface|func|map|\[|chan|\*?[A-Za-z_])/g
  ],
  rs: [
    /(?:^|[\s;{])(?:pub(?:\([^)]*\))?\s+)?(?:const\s+|async\s+|unsafe\s+|extern\s+"[^"]*"\s+)*fn\s+([A-Za-z_]\w*)/g,
    // 不含 mod：mod x 是引用别的模块，不是本文件定义的符号，归 deps 处理
    /(?:^|[\s;{])(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|impl)\s+([A-Za-z_]\w*)/g,
    /(?:^|[\s;{])macro_rules!\s+([A-Za-z_]\w*)/g
  ],
  kt: [
    /(?:^|[\s;{])(?:(?:public|private|protected|internal|open|override|suspend|inline|operator|infix|abstract|final)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)/g,
    /(?:^|[\s;{])(?:(?:public|private|protected|internal|open|sealed|abstract|data|inner|enum|annotation)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/g,
    /(?:^|[\s;{])(?:val|var)\s+([A-Za-z_]\w*)\s*[:=]/g
  ],
  swift: [
    /(?:^|[\s;{])(?:(?:public|private|internal|fileprivate|open|static|class|final|override|mutating)\s+)*func\s+([A-Za-z_]\w*)/g,
    /(?:^|[\s;{])(?:(?:public|private|internal|fileprivate|open|final)\s+)*(?:class|struct|enum|protocol|extension|actor)\s+([A-Za-z_]\w*)/g
  ],
  c: [
    // 函数定义与声明：返回类型 名字(...) { 或 ;，含 Class::method
    /(?:^|[\s*&])([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)\s*\([^();]*\)\s*(?:const\s*)?(?:noexcept\s*)?[{;]/g,
    RE_TYPE_DECL,
    /(?:^|\s)#define\s+([A-Za-z_]\w*)/g
  ],
  lua: [
    /(?:^|[\s;])(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/g,
    /(?:^|[\s;])([A-Za-z_][\w.]*)\s*=\s*function\b/g
  ],
  php: [
    /(?:^|[\s;{])(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)/g,
    /(?:^|[\s;{])(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/g
  ],
  rb: [
    /(?:^|[\s;])def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/g,
    /(?:^|[\s;])(?:class|module)\s+([A-Za-z_]\w*)/g
  ],
  scala: [
    /(?:^|[\s;{])(?:(?:private|protected|override|final|implicit|lazy)\s+)*def\s+([A-Za-z_]\w*)/g,
    /(?:^|[\s;{])(?:(?:private|protected|sealed|abstract|final|case|implicit)\s+)*(?:class|object|trait)\s+([A-Za-z_]\w*)/g,
    /(?:^|[\s;{])(?:val|var)\s+([A-Za-z_]\w*)\s*[:=]/g
  ],
  dart: [
    /(?:^|[\s;{])(?:(?:abstract|class|mixin|extension|enum)\s+)([A-Za-z_]\w*)/g,
    /(?:^|[\s;{])(?:(?:static|final|const|Future<[^>]*>|void|[A-Za-z_][\w<>,\s]*)\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:async\s*)?\{/g
  ],
  sh: [
    /(?:^|[\s;])(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{/g,
    /(?:^|[\s;])function\s+([A-Za-z_]\w*)/g
  ],
  ps1: [
    /(?:^|[\s;])function\s+([A-Za-z_][\w-]*)/g
  ],
  // proto 没有函数。方法名用 message / enum / service / rpc，字段名不抽
  proto: [
    /(?:^|[\s;{])(?:message|enum|service)\s+([A-Za-z_]\w*)/g,
    /(?:^|[\s;{])rpc\s+([A-Za-z_]\w*)\s*\(/g
  ],
  // 配置文件只抽键名，不抽值
  yaml: [
    /(?:^|[\s-])([A-Za-z_\u4e00-\u9fff][\w.\u4e00-\u9fff-]*)\s*:/g
  ],
  xml: [
    /<([A-Za-z_][\w:.-]*)(?=[\s/>])/g
  ],
  toml: [
    /^\s*\[([A-Za-z0-9_.-]+)\]/g,
    /^\s*([A-Za-z_][\w.-]*)\s*=/g
  ],
  ini: [
    /^\s*\[([^\]]+)\]/g,
    /^\s*([A-Za-z0-9_.-]+)\s*=/g
  ],
  css: [
    /^\s*([.#]?[A-Za-z_][\w-]*)\s*[,{]/g
  ],
  sql: [
    /\bcreate\s+(?:or\s+replace\s+)?(?:temp\s+|temporary\s+)?(?:table|view|procedure|function|index|trigger)\s+(?:if\s+not\s+exists\s+)?["'[]?([A-Za-z_][\w.]*)/gi
  ],
  gradle: [
    /(?:^|[\s;])(?:task|def)\s+([A-Za-z_]\w*)/g
  ],
  cmake: [
    /\b(?:function|macro)\s*\(\s*([A-Za-z_]\w*)/gi
  ],
  graphql: [
    /\b(?:type|interface|enum|input|union|scalar)\s+([A-Za-z_]\w*)/g
  ],
  bat: [
    /^:([A-Za-z_][\w-]*)/g
  ],
  r: [
    /([A-Za-z.][\w.]*)\s*<-\s*function\b/g
  ]
};
// 扩展名到规则集的映射
const EXT_LANG = {
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".ts": "js", ".tsx": "js", ".mts": "js", ".cts": "js",
  ".vue": "js", ".svelte": "js",
  ".py": "py", ".cs": "cs", ".java": "java", ".kt": "kt", ".kts": "kt",
  ".go": "go", ".rs": "rs", ".swift": "swift", ".scala": "scala", ".dart": "dart",
  ".c": "c", ".h": "c", ".cpp": "c", ".hpp": "c", ".cc": "c", ".m": "c", ".mm": "c",
  ".lua": "lua", ".php": "php", ".rb": "rb", ".sh": "sh", ".ps1": "ps1",
  ".html": "html", ".htm": "html"
};
function langOf(ext) { return EXT_LANG[ext] || ""; }
function isSymbolName(name) {
  if (!name || name.length < 2 || name.length > 80) return false;
  return !SYMBOL_STOP_WORDS.has(name.toLowerCase());
}
// 这些后缀只决定抽哪些名字，不改 langOf，避免把已有的隐式引用边改掉
function symbolKind(ext) {
  if (ext === ".proto") return "proto";
  if (ext === ".json") return "json";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".md" || ext === ".mdc") return "md";
  if (ext === ".txt") return "txt";
  if (ext === ".xml") return "xml";
  if (ext === ".toml") return "toml";
  if (ext === ".ini" || ext === ".cfg" || ext === ".conf") return "ini";
  if (ext === ".css" || ext === ".scss" || ext === ".less") return "css";
  if (ext === ".sql") return "sql";
  if (ext === ".gradle") return "gradle";
  if (ext === ".cmake") return "cmake";
  if (ext === ".graphql" || ext === ".gql") return "graphql";
  if (ext === ".bat" || ext === ".cmd") return "bat";
  if (ext === ".r") return "r";
  return "";
}
function pushSymbol(out, seen, name, line) {
  const n = String(name || "").trim();
  if (!isSymbolName(n) || seen.has(n) || out.length >= MAX_SYMBOLS_PER_FILE) return;
  seen.add(n);
  out.push({ name: n, line: line || 1 });
}
function lineOfKey(lines, name) {
  const re = new RegExp('"' + String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"\\s*:');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i + 1;
  }
  return 1;
}
function extractJsonSymbols(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  function walk(obj, depth) {
    if (out.length >= MAX_SYMBOLS_PER_FILE || depth > 4 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }
    for (const k of Object.keys(obj)) {
      pushSymbol(out, seen, k, lineOfKey(lines, k));
      walk(obj[k], depth + 1);
    }
  }
  walk(data, 0);
  return out;
}
function extractMdHeadings(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i].trim());
    if (!m) continue;
    const name = m[2].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim().slice(0, 80);
    pushSymbol(out, seen, name, i + 1);
  }
  return out;
}
// 单独成行、后面可以跟正文的短标题。长句子和带句号的行不抽
function extractTxtTitles(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.length < 2 || s.length > 32) continue;
    if (/[。！？!?；;，,：:]/.test(s)) continue;
    if (!(i === 0 || !lines[i - 1].trim())) continue;
    pushSymbol(out, seen, s, i + 1);
  }
  return out;
}
function extractSymbols(text, ext) {
  const kind = symbolKind(ext);
  if (!text) return [];
  if (kind === "json") return extractJsonSymbols(text);
  if (kind === "md") return extractMdHeadings(text);
  if (kind === "txt") return extractTxtTitles(text);
  const rules = SYMBOL_RULES[kind || langOf(ext)];
  if (!rules) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS_PER_FILE; i++) {
    const raw = lines[i];
    if (!raw || raw.length > 500) continue;
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("#!")) continue;
    if (line.startsWith("#") && !/^#define\b/.test(line)) continue;
    if (kind === "yaml" && /:\/\//.test(line)) continue;
    for (const re of rules) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(raw))) {
        if (out.length >= MAX_SYMBOLS_PER_FILE) break;
        const name = String(m[1] || "").trim();
        if (!isSymbolName(name) || seen.has(name)) continue;
        seen.add(name);
        out.push({ name, line: i + 1 });
      }
    }
  }
  return out;
}
function resolveDepToFile(workspace, dir, dep) {
  if (!dep.startsWith(".")) return null;
  const base = path.resolve(dir, dep);
  const cands = [
    base, base + path.extname(base),
    base + ".js", base + ".ts", base + ".tsx", base + ".jsx", base + ".mjs", base + ".cjs",
    base + ".py", base + ".cs", base + ".java", base + ".go", base + ".rs",
    base + ".cpp", base + ".c", base + ".h", base + ".hpp", base + ".cc",
    path.join(base, "index.js"), path.join(base, "index.ts"), path.join(base, "index.tsx")
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}
// 解析单个文件的依赖，返回工作区内目标模块的 key 列表；同时记下哪些是头文件包含
function resolveDeps(workspace, extra, abs, text, ext, selfKey, fileIndex, includeOut) {
  const dirOf = path.dirname(abs);
  const resolved = [];
  for (const d of extractDeps(text, ext)) {
    const t = resolveDepTarget(workspace, dirOf, d, fileIndex);
    if (!t) continue;
    const tk = fileKey(workspace, extra, t);
    if (tk === selfKey) continue;
    if (resolved.indexOf(tk) < 0) resolved.push(tk);
    if (includeOut && d.kind === "include") includeOut.add(tk);
  }
  return resolved;
}
function emitStatus(workspace, patch) {
  if (!workspace) return;
  const key = hashPath(workspace);
  const cur = statusByWs.get(key) || {
    workspace, running: false, done: 0, total: 0, pct: 0, nodes: 0, files: 0, error: "", updatedAt: 0
  };
  Object.assign(cur, patch, { workspace });
  // justSummarized 只描述本次事件（刚归纳完的那个模块），不能留在状态快照里被后续事件重复广播
  cur.justSummarized = (patch && patch.justSummarized) || null;
  if (cur.running && cur.total > 0) {
    cur.pct = Math.max(0, Math.min(100, Math.round((Number(cur.done) / Number(cur.total)) * 100)));
  } else if (cur.running) {
    cur.pct = 0;
  } else {
    cur.nodes = Math.max(Number(cur.nodes) || 0, Number(cur.files) || 0);
    cur.files = cur.nodes;
    cur.pct = cur.nodes ? 100 : 0;
    cur.done = cur.nodes;
    if (!cur.total) cur.total = cur.nodes;
    cur.updatedAt = cur.updatedAt || Date.now();
  }
  statusByWs.set(key, cur);
  const snap = Object.assign({}, cur);
  for (const fn of statusListeners) { try { fn(snap); } catch {} }
}
function onStatus(fn) {
  if (typeof fn !== "function") return () => {};
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
function getStatus(workspace) {
  if (!workspace) {
    return { ok: false, reason: "no-workspace", workspace: "", running: false, done: 0, total: 0, pct: 0, nodes: 0, files: 0, error: "", updatedAt: 0 };
  }
  const key = hashPath(workspace);
  const live = statusByWs.get(key);
  if (live && live.running) return Object.assign({ ok: true }, live);
  const map = loadJson(jsonPath(workspace), null);
  const nodes = map && Array.isArray(map.nodes) ? map.nodes.length : 0;
  return { ok: true, workspace, running: false, done: nodes, total: nodes, pct: nodes ? 100 : 0, nodes, files: nodes, error: live && live.error ? live.error : "", updatedAt: (map && map.updatedAt) || 0 };
}
function getMap(workspace) {
  if (!workspace) return null;
  const map = loadMapCached(workspace);
  if (!map || !Array.isArray(map.nodes)) return map;
  const extra = (map.roots || []).filter((r) => r && path.resolve(r) !== path.resolve(workspace));
  ensureFresh(workspace, extra, map);
  return map;
}
async function scanWorkspace(workspace, extra, signal) {
  const roots = indexRoots(workspace, extra);
  const excludes = loadExcludes(workspace);
  const exSet = new Set(excludes);
  const dir = mapDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  const files = collectFiles(roots, signal);
  const fileIndex = buildFileIndex(files);
  const total = files.length || 1;
  const nodes = [];
  // 第一遍收集：每个模块的标识符集合与头文件包含目标，第二遍据此给边分类（用完即弃，不落盘）
  const identsById = new Map();
  const includesById = new Map();
  let processed = 0;
  const pushLive = (running, extraPatch) => {
    emitStatus(workspace, Object.assign({ running, done: processed, total, error: "", nodes: nodes.length, files: nodes.length }, extraPatch || {}));
  };
  pushLive(true);
  for (const f of files) {
    if (signal && signal.aborted) throw new Error("stopped");
    processed++;
    const key = fileKey(workspace, extra, f.abs);
    if (exSet.has(key)) continue;
    let text = "";
    try { text = fs.readFileSync(f.abs, "utf8"); } catch { text = ""; }
    const ext = path.extname(f.abs).toLowerCase();
    const inclSet = new Set();
    const resolved = resolveDeps(workspace, extra, f.abs, text, ext, key, fileIndex, inclSet);
    let mtime = 0;
    try { mtime = fileStamp(fs.statSync(f.abs)); } catch {}
    // symbols 为静态兜底（名字+行号，不花 token）；methods 留空表示尚未 AI 归纳
    const node = { id: key, path: key, abs: f.abs.replace(/\\/g, "/"), ext, size: f.size, mtime, deps: resolved, desc: "", symbols: extractSymbols(text, ext) };
    nodes.push(node);
    identsById.set(key, collectIdents(text));
    if (inclSet.size) includesById.set(key, inclSet);
    pushLive(true);
    if (processed % 32 === 0) await yieldTick();
  }
  const edges = classifyEdges(nodes, identsById, includesById);
  const dirSet = new Set();
  for (const n of nodes) {
    const parts = n.path.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  return { version: MAP_VERSION, workspace: String(workspace).replace(/\\/g, "/"), roots: roots.map((r) => String(r).replace(/\\/g, "/")), generatedAt: Date.now(), nodes, edges, dirs: Array.from(dirSet), updatedAt: Date.now() };
}
async function enrichWithAI(workspace, mapData, modelCfg) {
  if (!modelCfg || !mapData || !mapData.nodes || !mapData.nodes.length) return mapData;
  let agent;
  try { agent = require("./agent"); } catch { return mapData; }
  if (typeof agent.describeProjectMap !== "function") return mapData;
  try { return await agent.describeProjectMap(modelCfg, mapData); } catch (e) { diag.log("map", "AI enrich failed, fallback static", { message: e && e.message }); return mapData; }
}
function writeMarkdown(file, mapData) {
  const lines = [];
  lines.push("# 项目地图（自动生成）");
  lines.push("");
  lines.push("- 生成时间：" + new Date(mapData.generatedAt || Date.now()).toLocaleString());
  lines.push("- 模块节点：" + mapData.nodes.length);
  lines.push("- 连通边：" + mapData.edges.length);
  lines.push("");
  lines.push("## 模块清单");
  lines.push("");
  for (const n of mapData.nodes) {
    const desc = n.desc ? " — " + n.desc : "";
    lines.push("- " + n.path + desc);
  }
  lines.push("");
  lines.push("## 依赖关系");
  lines.push("");
  for (const e of mapData.edges) lines.push("- " + e.from + " → " + e.to);
  lines.push("");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}
async function buildMap(workspace, extra, opts, signal) {
  opts = opts || {};
  const scanned = await scanWorkspace(workspace, extra, signal);
  // 重绘保留旧归纳：源码 size+mtime 没变的节点直接沿用 methods/desc，省 token；变了的清空等待重归纳
  const prev = loadJson(jsonPath(workspace), null);
  if (prev && Array.isArray(prev.nodes)) {
    const old = new Map(prev.nodes.map((n) => [n.id, n]));
    for (const n of scanned.nodes) {
      const o = old.get(n.id);
      if (!o) continue;
      const same = o.size === n.size && (o.mtime || 0) === (n.mtime || 0);
      if (same && Array.isArray(o.methods)) {
        n.methods = o.methods;
        // 重绘没把 methodsMtime 带上时，说明会被当成过期丢掉。文件没变就沿用这次的时间
        n.methodsMtime = o.methodsMtime != null ? o.methodsMtime : n.mtime;
        if (!n.desc && o.desc) n.desc = o.desc;
      } else { delete n.methods; delete n.methodsMtime; n.desc = ""; }
    }
  }
  const mapData = scanned;
  saveJson(jsonPath(workspace), mapData);
  invalidateMapCache(workspace);
  markAligned(workspace, extra);
  writeMarkdown(mdPath(workspace), mapData);
  emitStatus(workspace, { running: false, done: mapData.nodes.length, total: mapData.nodes.length, pct: 100, nodes: mapData.nodes.length, files: mapData.nodes.length });
  const inc = loadInclude(workspace);
  const cfg = chatModelCfg();
  if (cfg && inc && inc.initialized && inc.includes && inc.includes.length) {
    summarizeIncludes(workspace, inc.includes, cfg).catch((e) => {
      diag.log("map", "绘制后方法归纳失败", { message: e && e.message });
    });
  }
  return mapData;
}
function ensureIndex(workspace, extra, opts, signal) {
  if (!workspace) return Promise.resolve({ ok: false, reason: "no-workspace" });
  const key = hashPath(workspace);
  if (jobs.has(key)) return jobs.get(key);
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  controllers.set(key, ac);
  const p = buildMap(workspace, extra, opts, ac.signal).catch((e) => {
    const stopped = e && e.message === "stopped";
    emitStatus(workspace, { running: false, error: stopped ? "" : String(e && e.message ? e.message : e) });
    if (stopped) return { ok: false, reason: "aborted" };
    throw e;
  }).finally(() => {
    if (jobs.get(key) === p) jobs.delete(key);
    if (controllers.get(key) === ac) controllers.delete(key);
    if (signal) signal.removeEventListener("abort", onAbort);
  });
  jobs.set(key, p);
  return p;
}
function kickIndex(workspace, extra, opts) {
  if (!workspace) return;
  ensureIndex(workspace, extra, opts).catch((e) => { diag.log("map", "build map failed", { message: e && e.message }); });
}
function abortIndex(workspace) {
  const ac = controllers.get(hashPath(workspace));
  if (ac) ac.abort();
}
async function deleteIndex(workspace) {
  if (!workspace) return { ok: false, reason: "no-workspace" };
  const key = hashPath(workspace);
  abortIndex(workspace);
  const p = jobs.get(key);
  if (p) await p.catch(() => {});
  try { fs.rmSync(mapDir(workspace), { recursive: true, force: true }); } catch (e) { diag.log("map", "delete map failed", { message: e && e.message }); }
  statusByWs.delete(key);
  emitStatus(workspace, { running: false, done: 0, total: 0, pct: 0, nodes: 0, files: 0, error: "", updatedAt: 0 });
  return getStatus(workspace);
}
// 反向依赖表：被谁依赖
function reverseDeps(mapData) {
  const rev = new Map();
  for (const e of (mapData.edges || [])) {
    if (!rev.has(e.to)) rev.set(e.to, []);
    rev.get(e.to).push(e.from);
  }
  return rev;
}
function fmtMethod(m) {
  const line = m.line ? " :" + m.line : "";
  const kv = m.keyValues ? "（" + m.keyValues + "）" : "";
  const desc = m.desc ? " — " + m.desc : "";
  return "  - " + (m.name || "") + line + kv + desc;
}
// 方法名和行号只认当前源码抽出的符号。AI 归纳只给还存在的符号补说明，名字已经不在文件里的条目直接丢掉
function nodeMethods(n) {
  const sym = Array.isArray(n.symbols) ? n.symbols : [];
  if (!sym.length) return [];
  const aiByName = new Map();
  for (const m of (Array.isArray(n.methods) ? n.methods : [])) {
    const key = String(m.name || "").toLowerCase();
    if (key && !aiByName.has(key)) aiByName.set(key, m);
  }
  // 旧索引可能已经把 mtime 写成新的，说明却还是上一版实现。没有 methodsMtime 对齐就不采用说明
  const trust = n.methodsMtime != null && n.methodsMtime === n.mtime;
  return sym.map((s) => {
    const extra = trust ? aiByName.get(String(s.name || "").toLowerCase()) : null;
    return {
      name: s.name,
      line: s.line,
      keyValues: extra ? String(extra.keyValues || "") : "",
      desc: extra ? String(extra.desc || "") : ""
    };
  });
}
// 没有方法，或有名字但作用和关键值都空，命中后必须带上全文，否则模型看不到文件内容
function needsFullRead(n) {
  const methods = nodeMethods(n);
  if (!methods.length) return true;
  return !methods.some((m) => String(m.desc || "").trim() || String(m.keyValues || "").trim());
}
const bodyCache = new Map();
const BODY_CACHE_MAX = 32;
function fileBodyForNode(n) {
  if (!n || !n.abs) return "（没有文件路径，无法通读）";
  let st = null;
  try { st = fs.statSync(n.abs); }
  catch (e) { return "（读取失败：" + ((e && e.message) || "") + "）"; }
  const mtime = fileStamp(st);
  const cached = bodyCache.get(n.abs);
  if (cached && cached.mtime === mtime && cached.size === st.size) return cached.text;
  let buf;
  try { buf = fs.readFileSync(n.abs); }
  catch (e) { return "（读取失败：" + ((e && e.message) || "") + "）"; }
  const probe = Math.min(buf.length, 8000);
  for (let i = 0; i < probe; i++) {
    if (buf[i] === 0) return "（二进制文件，没有文本正文）";
  }
  const text = buf.toString("utf8");
  bodyCache.set(n.abs, { mtime, size: st.size, text });
  if (bodyCache.size > BODY_CACHE_MAX) bodyCache.delete(bodyCache.keys().next().value);
  return text;
}
function appendFullFile(lines, n) {
  const label = n.path || "";
  lines.push("【全文】" + label);
  lines.push(fileBodyForNode(n));
  lines.push("【全文结束】" + label);
}
// 单模块完整摘要：方法全列 + 依赖 + 被依赖。没有归纳时附上全文
function moduleText(mapData, n, rev) {
  const lines = [];
  lines.push("`" + n.path + "`" + (n.desc ? " — " + n.desc : ""));
  if (n.deps && n.deps.length) lines.push("  依赖：" + n.deps.slice(0, 12).join(", ") + (n.deps.length > 12 ? " …" : ""));
  const by = rev.get(n.id) || [];
  if (by.length) lines.push("  被依赖：" + by.slice(0, 12).join(", ") + (by.length > 12 ? " …" : ""));
  const all = nodeMethods(n);
  if (needsFullRead(n)) {
    if (all.length) {
      lines.push("  方法（" + all.length + "，尚无作用与关键值）：");
      for (const m of all) lines.push(fmtMethod(m));
    } else {
      lines.push("  （该模块未解析出方法，正文如下）");
    }
    appendFullFile(lines, n);
  } else if (all.length) {
    lines.push("  方法（" + all.length + "）：");
    for (const m of all.slice(0, LOOKUP_MAX_METHODS)) lines.push(fmtMethod(m));
    if (all.length > LOOKUP_MAX_METHODS) lines.push("  … 还有 " + (all.length - LOOKUP_MAX_METHODS) + " 个方法");
  }
  return lines.join("\n");
}
// 关键字匹配打分：路径 > 方法名 > 方法说明/关键值 > 模块说明
function scoreNode(n, words) {
  const p = n.path.toLowerCase();
  const d = (n.desc || "").toLowerCase();
  let score = 0;
  const hit = [];
  const covered = new Set();
  for (const w of words) {
    if (p.indexOf(w) >= 0) { score += 10; covered.add(w); }
    if (d.indexOf(w) >= 0) { score += 3; covered.add(w); }
  }
  let methodScore = 0;
  for (const m of nodeMethods(n)) {
    const name = (m.name || "").toLowerCase();
    const rest = ((m.desc || "") + " " + (m.keyValues || "")).toLowerCase();
    let ms = 0;
    for (const w of words) {
      if (name === w) { ms += 12; covered.add(w); }
      else if (name.indexOf(w) >= 0) { ms += 6; covered.add(w); }
      if (rest.indexOf(w) >= 0) { ms += 2; covered.add(w); }
    }
    if (ms) { methodScore += ms; hit.push({ m, ms }); }
  }
  // 方法命中分封顶：防止 preload 这类方法名密集的桥接文件靠堆数量压过真正相关的模块
  score += Math.min(methodScore, METHOD_SCORE_CAP);
  // 覆盖到的不同查询词越多，说明整体越贴题
  score += covered.size * 8;
  hit.sort((a, b) => b.ms - a.ms);
  return { score, hit: hit.map((x) => x.m) };
}
// 查询切词：英文按标识符切，中文按整段加二字滑窗，避免「登录后怎么保存会话」整句匹配不到
const QUERY_STOP_WORDS = new Set([
  "the", "and", "for", "you", "how", "what", "where", "this", "that", "with",
  "怎么", "如何", "什么", "哪里", "哪个", "一下", "现在", "可以", "需要", "应该",
  "这个", "那个", "问题", "代码", "文件", "项目", "功能", "帮我", "我们"
]);
// 中文词到英文标识符的提示表：模块没做 AI 归纳时，中文提问也能命中英文路径与方法名
const CN_HINTS = {
  登录: ["login", "signin", "auth"], 注册: ["register", "signup"], 认证: ["auth", "token"],
  会话: ["session"], 用户: ["user", "account"], 密码: ["password", "passwd"], 令牌: ["token"],
  权限: ["permission", "auth"], 配置: ["config", "setting", "store"], 设置: ["setting", "config"],
  保存: ["save", "write", "store"], 写入: ["write", "save"], 读取: ["read", "load"], 加载: ["load", "init"],
  删除: ["delete", "remove"], 创建: ["create", "make", "new"], 新建: ["create", "new"], 更新: ["update", "upsert"],
  搜索: ["search", "find", "query"], 查询: ["query", "search", "lookup"], 索引: ["index"], 缓存: ["cache"],
  日志: ["log", "diag"], 错误: ["error", "fail"], 异常: ["error", "exception"],
  请求: ["request", "fetch"], 响应: ["response", "result"], 接口: ["api", "interface"], 路由: ["route", "router"],
  数据库: ["database", "db"], 模型: ["model"], 消息: ["message", "msg"], 聊天: ["chat"], 对话: ["chat", "turn"],
  工具: ["tool"], 路径: ["path"], 窗口: ["window", "win"], 渲染: ["render", "draw"], 界面: ["render", "ui", "view"],
  快照: ["snapshot"], 记忆: ["memory"], 技能: ["skill"], 规则: ["rule"], 地图: ["map", "index"],
  向量: ["embed", "vector"], 归纳: ["summarize", "describe"], 进度: ["progress", "status"], 状态: ["status", "state"],
  超时: ["timeout"], 重试: ["retry"], 下载: ["download"], 上传: ["upload"], 图片: ["image", "vision"],
  视觉: ["vision"], 语言: ["lang", "locale", "i18n"], 主题: ["theme"], 沙盒: ["sandbox"], 命令: ["command", "run"],
  初始化: ["init", "setup"], 监听: ["listen", "watch", "on"], 事件: ["event"], 发送: ["send", "post"],
  解析: ["parse"], 格式: ["format"], 校验: ["validate", "check"], 过滤: ["filter"], 排序: ["sort"],
  提示词: ["prompt"], 注入: ["inject", "prompt"], 扫描: ["scan"], 依赖: ["dep", "depend"], 打包: ["build", "pack"]
};
function tokenizeQuery(query) {
  const raw = String(query || "").toLowerCase();
  const words = new Set();
  const addCn = (w) => {
    if (QUERY_STOP_WORDS.has(w)) return;
    words.add(w);
    for (const en of CN_HINTS[w] || []) words.add(en);
  };
  for (const m of raw.match(/[a-z_$][\w$]{1,}/g) || []) {
    if (!QUERY_STOP_WORDS.has(m)) words.add(m);
  }
  for (const seg of raw.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    if (seg.length <= 4) addCn(seg);
    // 长句按二字、三字滑窗取词，「登录后怎么保存会话」也能切出「保存」「会话」
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= seg.length; i++) addCn(seg.slice(i, i + n));
    }
  }
  return Array.from(words).slice(0, 32);
}
// 打分取前 N。磁盘有变动才同步那个文件，没变动不扫目录
function topMatches(workspace, extra, mapData, query, opts) {
  ensureFresh(workspace, extra, mapData);
  const words = tokenizeQuery(query);
  if (!words.length) return null;
  const within = opts.within ? String(opts.within).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : "";
  const scored = [];
  for (const n of mapData.nodes) {
    if (isForeignAiSkill(n.abs || (workspace && n.path ? path.join(workspace, n.path) : n.path || ""))) continue;
    if (within && String(n.abs || "").toLowerCase().indexOf(within) !== 0) continue;
    const r = scoreNode(n, words);
    if (r.score > 0) scored.push({ n, score: r.score, hit: r.hit });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  const limit = Math.max(1, Math.min(MAX_TOP, Number(opts.limit) || LOOKUP_MAX_MODULES));
  const top = scored.slice(0, limit);
  top.total = scored.length;
  return top;
}
function mapTextForQuery(workspace, extra, mapData, query, opts) {
  opts = opts || {};
  const top = topMatches(workspace, extra, mapData, query, opts);
  if (top === null) return "查询为空";
  if (!top.length) return "项目地图无匹配模块（可换更具体的关键词，或先重新绘制地图）";
  const rev = reverseDeps(mapData);
  const lines = top.map(({ n, hit }) => {
    const head = "`" + n.path + "`" + (n.desc ? " — " + n.desc : "");
    if (needsFullRead(n)) {
      const parts = [head];
      if (hit.length) parts.push(hit.map(fmtMethod).join("\n"));
      parts.push("【全文】" + n.path);
      parts.push(fileBodyForNode(n));
      parts.push("【全文结束】" + n.path);
      return parts.join("\n");
    }
    if (!hit.length) return head;
    // 只列命中的方法（带行号），要看全部方法请用 module 参数
    const ms = hit.slice(0, LOOKUP_MAX_METHODS).map(fmtMethod).join("\n");
    const total = nodeMethods(n).length;
    const tail = total > hit.length ? "\n  （共 " + total + " 个方法，传 module=\"" + n.path + "\" 查看全部）" : "";
    return head + "\n" + ms + tail;
  });
  return "项目地图匹配到 " + top.total + " 个模块，这是第一批，不是全部。没有作用和关键值的已附【全文】，以全文为准。作用和关键值看得懂又够用时，才用 :行号 去读要改的那一个方法。看不懂归纳，或里面没有要改的文案、数字、字段时，read_file 读原本代码，不准猜。这批对不上就换关键字继续查：\n\n" + lines.join("\n");
}
// 按模块路径精确/后缀匹配取单模块摘要
function findModule(mapData, id) {
  const want = String(id || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!want) return null;
  let best = null;
  for (const n of mapData.nodes) {
    const p = n.path.toLowerCase();
    if (p === want) return n;
    if (p.endsWith("/" + want) || p.endsWith(want)) { if (!best || n.path.length < best.path.length) best = n; }
  }
  return best;
}
// 地图 JSON 按 mtime+size 缓存，避免每轮对话重复解析大文件；写回地图时显式失效
const mapCache = new Map();
function invalidateMapCache(workspace) {
  mapCache.delete(hashPath(workspace));
}
function loadMapCached(workspace) {
  const file = jsonPath(workspace);
  let st = null;
  try { st = fs.statSync(file); } catch { return null; }
  const key = hashPath(workspace);
  const hit = mapCache.get(key);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.data;
  const data = loadJson(file, null);
  mapCache.set(key, { mtime: st.mtimeMs, size: st.size, data });
  return data;
}
function appendModuleLines(lines, n, hit, rev) {
  lines.push("`" + n.path + "`" + (n.desc ? " — " + n.desc : ""));
  const deps = (n.deps || []).slice(0, 6);
  if (deps.length) lines.push("  依赖：" + deps.join(", "));
  const by = (rev.get(n.id) || []).slice(0, 6);
  if (by.length) lines.push("  被依赖：" + by.join(", "));
  if (needsFullRead(n)) {
    const shown = hit.length ? hit : nodeMethods(n);
    for (const m of shown) lines.push(fmtMethod(m));
    appendFullFile(lines, n);
  } else {
    for (const m of (hit.length ? hit : nodeMethods(n)).slice(0, PROMPT_MAX_METHODS)) lines.push(fmtMethod(m));
  }
}
const MAP_BATCH_HEAD = "【项目地图】下列是按问题打分的第一批模块，不是全部。作用和关键值看得懂、又够用时，靠总结跳过无关代码，要改某一个方法再用 :行号 读那一段。看不懂这句归纳有什么用，或者里面没有要改的文案、数字、字段时，read_file 读原本代码，不准猜。只有方法名、或作用和关键值是空的、或未解析出方法的，已附【全文】的以全文为准，不要再读一遍；没附全文的必须 read_file 整文件。这批对不上就用 map_lookup 或 search_text 继续查后面的模块。";
// 每轮对话的提示词注入：本地打分取命中模块与方法行号，不调模型、不做向量，毫秒级
// 上一轮写过的文件单独标成地图已更新，打分规则不变
function buildPromptBlock(workspace, query, extra) {
  if (!workspace || !String(query || "").trim()) return "";
  const mapData = loadMapCached(workspace);
  if (!mapData || !Array.isArray(mapData.nodes) || !mapData.nodes.length) return "";
  const top = topMatches(workspace, extra || [], mapData, query, { limit: PROMPT_MAX_MODULES }) || [];
  const touch = takeMapTouch(workspace);
  const rev = reverseDeps(mapData);
  const shown = new Set();
  const updatedLines = [];
  for (const p of touch.updated) {
    const n = mapData.nodes.find((x) => x.id === p || x.path === p);
    if (!n || shown.has(n.id)) continue;
    const nAbs = n.abs || path.join(workspace, n.path || "");
    if (isForeignAiSkill(nAbs)) continue;
    appendModuleLines(updatedLines, n, [], rev);
    shown.add(n.id);
  }
  const lines = [];
  for (const { n, hit } of top) {
    if (shown.has(n.id)) continue;
    appendModuleLines(lines, n, hit, rev);
  }
  const parts = [];
  if (updatedLines.length || touch.removed.length) {
    let head = "【地图已更新】这些文件刚写进项目，地图已按新内容重抽，旧归纳已清掉。先看下面再回答，不要凭上一轮对话说项目里没有。";
    if (touch.updated.length) head += "\n" + touch.updated.join("\n");
    if (touch.removed.length) head += "\n已从地图移除：" + touch.removed.join("、");
    parts.push(head);
    if (updatedLines.length) parts.push(updatedLines.join("\n"));
  }
  if (lines.length) parts.push(MAP_BATCH_HEAD + "\n\n" + lines.join("\n"));
  else if (!parts.length) return "";
  return parts.join("\n\n");
}
async function search(workspace, extra, q) {
  q = q || {};
  const query = String(q.query || "").trim();
  const moduleId = String(q.module || "").trim();
  if (!query && !moduleId) return "查询为空";
  if (!workspace) return "请先打开项目";
  const mapData = loadMapCached(workspace);
  if (!mapData || !Array.isArray(mapData.nodes) || !mapData.nodes.length) {
    return "尚未生成项目地图。请在设置中点击「查看项目地图」生成后再用于定位。";
  }
  if (moduleId) {
    ensureFresh(workspace, extra, mapData);
    const n = findModule(mapData, moduleId);
    if (!n) return "项目地图里没有模块：" + moduleId + (query ? "；改用关键字检索：\n\n" + mapTextForQuery(workspace, extra, mapData, query, q) : "");
    const nAbs = n.abs || path.join(workspace, n.path || "");
    if (isForeignAiSkill(nAbs)) return "这是其他 AI 的技能或规则，SpCode 不读取。只使用本程序技能目录里已设置的技能。";
    return moduleText(mapData, n, reverseDeps(mapData));
  }
  return mapTextForQuery(workspace, extra, mapData, query, q);
}
// ---- 单节点增量更新：改过的文件重抽符号并清掉旧归纳；删掉的文件移出地图；新文件补进索引 ----
function fileStamp(st) {
  return Math.round(st.mtimeMs);
}
function absOf(node) {
  return node && node.abs ? path.normalize(node.abs) : "";
}
// 重建某个节点出发的边（含类型），指向它的边保持不动
function rebuildEdgesFrom(mapData, node, text, inclSet) {
  mapData.edges = (mapData.edges || []).filter((e) => e.from !== node.id);
  const idents = collectIdents(text);
  const byId = new Map(mapData.nodes.map((n) => [n.id, n]));
  const depSet = new Set(node.deps || []);
  for (const to of node.deps || []) {
    if (inclSet && inclSet.has(to)) { mapData.edges.push({ from: node.id, to, kind: EDGE_INCLUDE }); continue; }
    const t = byId.get(to);
    const used = t && (t.symbols || []).some((s) => idents.has(s.name));
    mapData.edges.push({ from: node.id, to, kind: used ? EDGE_REF : EDGE_DEP });
  }
  const lang = langOf(node.ext);
  if (!allowImplicit(lang, idents)) return;
  const owner = buildOwnerTable(mapData.nodes);
  const hits = new Map();
  for (const id of idents) {
    const own = owner.get(id);
    if (!own || own === node.id || depSet.has(own)) continue;
    const t = byId.get(own);
    if (!t || langOf(t.ext) !== lang) continue;
    hits.set(own, (hits.get(own) || 0) + 1);
  }
  const top = Array.from(hits.entries()).sort((a, b) => b[1] - a[1]).slice(0, IMPLICIT_MAX_PER_NODE);
  for (const [to] of top) mapData.edges.push({ from: node.id, to, kind: EDGE_IMPLICIT });
}
// 文件内容变了才重抽符号与依赖；没变返回 false。
// 源码变了就丢掉 AI 归纳的 methods/desc：那些说明描述的是旧实现，留着会让检索一直命中过期功能
function refreshNode(workspace, extra, mapData, node) {
  const abs = absOf(node);
  if (!abs) return false;
  let st = null;
  try { st = fs.statSync(abs); } catch { return "missing"; }
  if (!st.isFile()) return "missing";
  const mtime = fileStamp(st);
  const stored = node.mtime || 0;
  // 旧索引把 mtime 截成 32 位。低位一致说明文件没改，不能据此把整个项目重读一遍
  if (st.size === node.size && (stored === mtime || (stored | 0) === (mtime | 0))) return false;
  let text = "";
  try { text = fs.readFileSync(abs, "utf8"); } catch { return false; }
  node.size = st.size;
  node.mtime = mtime;
  node.symbols = extractSymbols(text, node.ext);
  delete node.methods;
  delete node.methodsMtime;
  node.desc = "";
  const inclSet = new Set();
  node.deps = resolveDeps(workspace, extra, abs, text, node.ext, node.id, buildFileIndex(mapData.nodes), inclSet);
  rebuildEdgesFrom(mapData, node, text, inclSet);
  return true;
}
// 懒校验：检索前对节点做 stat 对比，覆盖写文件、外部编辑器、git 切分支。变过的文件重抽符号并清掉旧归纳
function refreshNodes(workspace, extra, mapData, nodes) {
  let changed = 0;
  const gone = [];
  for (const n of nodes) {
    const r = refreshNode(workspace, extra, mapData, n);
    if (r === "missing") gone.push(n.id);
    else if (r) changed++;
  }
  if (gone.length) {
    const drop = new Set(gone);
    mapData.nodes = mapData.nodes.filter((n) => !drop.has(n.id));
    mapData.edges = (mapData.edges || []).filter((e) => !drop.has(e.from) && !drop.has(e.to));
    changed += gone.length;
  }
  if (changed) {
    mapData.updatedAt = Date.now();
    try {
      saveJson(jsonPath(workspace), mapData);
      invalidateMapCache(workspace);
    } catch (e) {
      diag.log("map", "增量写回地图失败", { message: e && e.message });
    }
  }
  return changed;
}
function addNodeFromFile(workspace, extra, mapData, abs, excludes) {
  const key = fileKey(workspace, extra, abs);
  if (!key || excludes.has(key) || mapData.nodes.some((n) => n.id === key)) return false;
  let st = null;
  let text = "";
  try {
    st = fs.statSync(abs);
    text = fs.readFileSync(abs, "utf8");
  } catch { return false; }
  const ext = path.extname(abs).toLowerCase();
  const inclSet = new Set();
  const fresh = {
    id: key, path: key, abs: abs.replace(/\\/g, "/"), ext, size: st.size,
    mtime: fileStamp(st), deps: [], desc: "", symbols: extractSymbols(text, ext)
  };
  mapData.nodes.push(fresh);
  fresh.deps = resolveDeps(workspace, extra, abs, text, ext, key, buildFileIndex(mapData.nodes), inclSet);
  rebuildEdgesFrom(mapData, fresh, text, inclSet);
  return true;
}
// 监听与脏标记：没变动不扫目录。监听失败的根仍走 syncMap，避免漏文件
const rootWatch = new Map();
const rootDirty = new Map();
const alignedWs = new Set();
// 本轮写进地图的文件，留到下一次提问再告诉模型。不放进对话记录
const pendingMapTouch = new Map();
function noteMapTouch(workspace, rel, kind) {
  if (!workspace || !rel) return;
  const key = hashPath(workspace);
  let box = pendingMapTouch.get(key);
  if (!box) { box = { updated: new Set(), removed: new Set() }; pendingMapTouch.set(key, box); }
  const p = String(rel).replace(/\\/g, "/");
  if (kind === "removed") {
    box.updated.delete(p);
    box.removed.add(p);
  } else {
    box.removed.delete(p);
    box.updated.add(p);
  }
}
function takeMapTouch(workspace) {
  const key = hashPath(workspace);
  const box = pendingMapTouch.get(key);
  if (!box) return { updated: [], removed: [] };
  pendingMapTouch.delete(key);
  return { updated: [...box.updated], removed: [...box.removed] };
}
function normRoot(p) {
  try { return path.resolve(p); } catch { return String(p || ""); }
}
function noteDirty(root, filename) {
  const key = normRoot(root);
  let d = rootDirty.get(key);
  if (!d) { d = { full: false, files: new Set() }; rootDirty.set(key, d); }
  if (!filename) { d.full = true; return; }
  d.files.add(path.resolve(key, filename));
}
function isWatchNoise(filename) {
  if (!filename) return false;
  if (String(filename).indexOf("PROJECT_MAP") >= 0) return true;
  return String(filename).split(/[\\/]/).some((part) => shouldSkipName(part));
}
function noteDiskChange(root, filename) {
  if (isWatchNoise(filename)) return;
  noteDirty(root, filename);
}
function noteWatching(root, ok) {
  const key = normRoot(root);
  const prev = rootWatch.get(key);
  if (prev && prev.watcher) { try { prev.watcher.close(); } catch { /* 交给外部监听 */ } }
  rootWatch.set(key, { failed: !ok, watcher: null, external: true });
  if (!ok) noteDirty(key, null);
}
function openWatch(root) {
  const key = normRoot(root);
  const cur = rootWatch.get(key);
  if (cur) return cur;
  try {
    const watcher = fs.watch(key, { recursive: true }, (_ev, filename) => {
      if (isWatchNoise(filename)) return;
      noteDirty(key, filename);
    });
    watcher.on("error", () => {
      rootWatch.set(key, { failed: true, watcher: null });
      noteDirty(key, null);
    });
    const rec = { failed: false, watcher, external: false };
    rootWatch.set(key, rec);
    return rec;
  } catch {
    const rec = { failed: true, watcher: null };
    rootWatch.set(key, rec);
    return rec;
  }
}
function clearDirty(roots) {
  for (const root of roots || []) rootDirty.delete(normRoot(root));
}
function markAligned(workspace, extra) {
  if (!workspace) return;
  alignedWs.add(hashPath(workspace));
  clearDirty(indexRoots(workspace, extra || []));
}
function takeDirty(roots) {
  let full = false;
  const files = [];
  for (const root of roots || []) {
    const d = rootDirty.get(normRoot(root));
    if (!d) continue;
    if (d.full) full = true;
    for (const f of d.files) files.push(f);
    rootDirty.delete(normRoot(root));
  }
  return { full, files };
}
function dropNode(mapData, id) {
  const before = mapData.nodes.length;
  mapData.nodes = mapData.nodes.filter((n) => n.id !== id);
  if (mapData.nodes.length === before) return false;
  mapData.edges = (mapData.edges || []).filter((e) => e.from !== id && e.to !== id);
  return true;
}
function applyDirtyFiles(workspace, extra, mapData, files) {
  const excludes = new Set(loadExcludes(workspace));
  let changed = 0;
  for (const abs of files) {
    let st = null;
    try { st = fs.statSync(abs); } catch { st = null; }
    if (st && st.isDirectory()) {
      syncMap(workspace, extra, mapData);
      return;
    }
    const key = fileKey(workspace, extra || [], path.normalize(abs));
    if (!st || !st.isFile()) {
      const node = mapData.nodes.find((n) => n.id === key || absOf(n).toLowerCase() === path.normalize(abs).toLowerCase());
      if (node && dropNode(mapData, node.id)) changed++;
      continue;
    }
    if (!isIndexableFile(path.basename(abs))) continue;
    const node = mapData.nodes.find((n) => n.id === key);
    if (node) {
      const r = refreshNode(workspace, extra, mapData, node);
      if (r === "missing") { if (dropNode(mapData, node.id)) changed++; }
      else if (r) changed++;
    } else if (addNodeFromFile(workspace, extra, mapData, abs, excludes)) changed++;
  }
  if (!changed) return;
  mapData.updatedAt = Date.now();
  try {
    saveJson(jsonPath(workspace), mapData);
    invalidateMapCache(workspace);
  } catch (e) {
    diag.log("map", "变动写回地图失败", { message: e && e.message });
  }
}
// 提问、查地图、打开地图都走这里。没脏就直接用内存里的地图
function ensureFresh(workspace, extra, mapData) {
  if (!workspace || !mapData || !Array.isArray(mapData.nodes)) return;
  const roots = indexRoots(workspace, extra || []);
  let watchOk = true;
  for (const root of roots) {
    const rec = root ? openWatch(root) : null;
    if (!rec || rec.failed) watchOk = false;
  }
  const key = hashPath(workspace);
  if (!watchOk || !alignedWs.has(key)) {
    syncMap(workspace, extra, mapData);
    if (watchOk) alignedWs.add(key);
    clearDirty(roots);
    return;
  }
  const dirty = takeDirty(roots);
  if (!dirty.full && !dirty.files.length) return;
  if (dirty.full) {
    syncMap(workspace, extra, mapData);
    return;
  }
  applyDirtyFiles(workspace, extra, mapData, dirty.files);
}
// 检索前对齐磁盘：已有文件按 mtime 刷新，消失的节点删掉，新出现的源码补进地图
function syncMap(workspace, extra, mapData) {
  if (!mapData || !Array.isArray(mapData.nodes)) return 0;
  let changed = refreshNodes(workspace, extra, mapData, mapData.nodes.slice());
  const excludes = new Set(loadExcludes(workspace));
  const have = new Set(mapData.nodes.map((n) => path.normalize(n.abs || "").toLowerCase()));
  let added = 0;
  for (const f of collectFiles(indexRoots(workspace, extra || []))) {
    if (have.has(path.normalize(f.abs).toLowerCase())) continue;
    if (addNodeFromFile(workspace, extra || [], mapData, f.abs, excludes)) {
      have.add(path.normalize(f.abs).toLowerCase());
      added++;
    }
  }
  if (added) {
    changed += added;
    mapData.updatedAt = Date.now();
    try {
      saveJson(jsonPath(workspace), mapData);
      invalidateMapCache(workspace);
    } catch (e) {
      diag.log("map", "补新文件写回地图失败", { message: e && e.message });
    }
  }
  return changed;
}
// 写文件后调用：已有节点就刷新，新文件就补一个节点；没有地图时不做任何事（不触发全量扫描）
function upsertFile(workspace, abs, extra) {
  if (!workspace || !abs) return false;
  const mapData = loadMapCached(workspace);
  if (!mapData || !Array.isArray(mapData.nodes)) return false;
  const target = path.normalize(abs);
  let st = null;
  try { st = fs.statSync(target); } catch { return false; }
  if (!st.isFile()) return false;
  const ex = extra || [];
  const key = fileKey(workspace, ex, target);
  const node = mapData.nodes.find((n) => n.id === key);
  const created = !node;
  if (node) {
    if (!refreshNode(workspace, ex, mapData, node)) return false;
  } else {
    if (st.size <= 0 || st.size > MAX_FILE_BYTES || !isIndexableFile(path.basename(target))) return false;
    if (loadExcludes(workspace).indexOf(key) >= 0) return false;
    let text = "";
    try { text = fs.readFileSync(target, "utf8"); } catch { return false; }
    const ext = path.extname(target).toLowerCase();
    const inclSet = new Set();
    const fresh = {
      id: key, path: key, abs: target.replace(/\\/g, "/"), ext, size: st.size,
      mtime: fileStamp(st), deps: [], desc: "", symbols: extractSymbols(text, ext)
    };
    mapData.nodes.push(fresh);
    fresh.deps = resolveDeps(workspace, ex, target, text, ext, key, buildFileIndex(mapData.nodes), inclSet);
    rebuildEdgesFrom(mapData, fresh, text, inclSet);
  }
  mapData.updatedAt = Date.now();
  // [铆钉优化] 不在这里同步整份写盘，交给 scheduleMapWrite 合并写。其他 AI 请勿改回 saveJson
  scheduleMapWrite(workspace, mapData);
  if (created) ensureIncluded(workspace, key);
  noteMapTouch(workspace, key, "updated");
  scheduleResummarize(workspace, key);
  return true;
}
// 删文件后调用：摘掉节点以及与它相关的进出边
function removeFile(workspace, abs, extra) {
  if (!workspace || !abs) return false;
  const mapData = loadMapCached(workspace);
  if (!mapData || !Array.isArray(mapData.nodes)) return false;
  const key = fileKey(workspace, extra || [], path.normalize(abs));
  const before = mapData.nodes.length;
  mapData.nodes = mapData.nodes.filter((n) => n.id !== key);
  if (mapData.nodes.length === before) return false;
  mapData.edges = (mapData.edges || []).filter((e) => e.from !== key && e.to !== key);
  mapData.updatedAt = Date.now();
  try {
    saveJson(jsonPath(workspace), mapData);
    invalidateMapCache(workspace);
  } catch (e) {
    diag.log("map", "增量写回地图失败", { message: e && e.message });
    return false;
  }
  noteMapTouch(workspace, key, "removed");
  return true;
}
function sameWorkspace(ws, stWs) {
  if (!ws || !stWs) return false;
  const norm = (p) => String(p).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return norm(ws) === norm(stWs);
}

function excludesPath(workspace) { return path.join(mapDir(workspace), "PROJECT_MAP.ignore.json"); }
function loadExcludes(workspace) { const d = loadJson(excludesPath(workspace), null); return (d && Array.isArray(d.excludes)) ? d.excludes : []; }
function saveExcludes(workspace, ids) { const arr = Array.isArray(ids) ? ids : []; saveJson(excludesPath(workspace), { version: MAP_VERSION, excludes: arr }); return arr; }

// 白名单：仅 includes 里的模块才会显示在地图；未初始化(initialized=false)时不显示任何模块，需先勾选
function includePath(workspace) { return path.join(mapDir(workspace), "PROJECT_MAP.include.json"); }
function saveInclude(workspace, obj) {
  const o = { version: MAP_VERSION, initialized: !!obj?.initialized, includes: Array.isArray(obj?.includes) ? obj.includes : [] };
  saveJson(includePath(workspace), o);
  return o;
}
function loadInclude(workspace) {
  const d = loadJson(includePath(workspace), null);
  if (d && Array.isArray(d.includes)) return { initialized: !!d.initialized, includes: d.includes };
  // 迁移：老用户已有 excludes（黑名单）时，转成「全部节点 - 已排除」的白名单并标记已初始化，沿用旧结果不弹窗
  const ex = loadExcludes(workspace);
  if (ex.length) {
    const map = loadJson(jsonPath(workspace), null);
    const all = (map && Array.isArray(map.nodes)) ? map.nodes.map((n) => n.id) : [];
    const exSet = new Set(ex);
    const obj = { initialized: true, includes: all.filter((id) => !exSet.has(id)) };
    saveInclude(workspace, obj);
    return obj;
  }
  return { initialized: false, includes: [] };
}
function setInclude(workspace, obj) {
  // 只保存白名单；打开地图 / 勾选模块不再自动调聊天模型归纳
  return saveInclude(workspace, obj);
}
// 写文件新建的脚本：名单已经在用时补进勾选。没建立名单、或本来就勾过的，不动
function ensureIncluded(workspace, id) {
  if (!workspace || !id) return false;
  const inc = loadInclude(workspace);
  if (!inc || !inc.initialized || !Array.isArray(inc.includes)) return false;
  if (inc.includes.indexOf(id) >= 0) return false;
  inc.includes.push(id);
  saveInclude(workspace, inc);
  return true;
}

// ---- 方法级归纳：对勾选的模块用 AI 提炼「方法名 + 关键值 + 说明」，写回地图节点，供人与 AI 直接读摘要 ----
function callModelForText(modelCfg, messages, signal) {
  const noop = () => {};
  const type = modelCfg && modelCfg.type
    ? modelCfg.type
    : (modelCfg && (modelCfg.modelPath || /\.gguf$/i.test(modelCfg.model || "")) ? "local" : "api");
  if (type === "zbaingAi" || (modelCfg && modelCfg.id === "zbaingAi")) {
    return zbaingAi.complete({ modelCfg, messages, signal, onDelta: noop, onThink: noop, onReason: noop })
      .then((r) => (typeof r === "string" ? r : (r && r.content) || ""));
  }
  if (type === "local" || (modelCfg && (modelCfg.modelPath || /\.gguf$/i.test(modelCfg.model || "")))) {
    const modelsDir = localLlm.ensureDir(store.load().modelsDir);
    return localLlm.complete({ modelCfg, modelsDir, messages, stream: false, onDelta: noop, onReason: noop, signal })
      .then((r) => (typeof r === "string" ? r : (r && r.content) || ""));
  }
  // API 模型（openai/anthropic/gemini）
  return apiProtocol.complete({ modelCfg, messages, stream: false, tools: null, onDelta: noop, onReason: noop, signal })
    .then((r) => (typeof r === "string" ? r : (r && r.content) || ""));
}

function parseMethodsJson(text) {
  if (!text) return [];
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && x.name)
      .map((x) => ({
        name: String(x.name || ""),
        keyValues: String(x.keyValues || x.key || x.params || ""),
        desc: String(x.desc || x.description || x.explain || "")
      }))
      .slice(0, SUMMARY_MAX_METHODS);
  } catch (_) {
    return [];
  }
}

// 本地给方法补行号：在源码里找“名字后跟 ( 或 = 或 :”的首个定义行，找不到留空
function attachLines(methods, text) {
  if (!Array.isArray(methods) || !methods.length || !text) return methods || [];
  const lines = text.split(/\r?\n/);
  for (const m of methods) {
    const name = String(m.name || "").replace(/\(.*$/, "").split(/[.:#]/).pop().trim();
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    const re = new RegExp("(^|[^\\w$])" + name.replace(/[$]/g, "\\$") + "\\s*(\\(|=|:|<)");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) { m.line = i + 1; break; }
    }
  }
  return methods;
}
async function summarizeFileMethods(modelCfg, fileInfo, signal) {
  const names = Array.isArray(fileInfo.symbols)
    ? fileInfo.symbols.map((s) => s && s.name).filter(Boolean).slice(0, SUMMARY_MAX_METHODS)
    : [];
  const nameHint = names.length
    ? ("\n已抽出的名字，name 必须从中原样选取，不要新造：\n" + names.join("、") + "\n")
    : "";
  const sys = "你是代码分析助手。分析给定源码文件，为已有名字补上作用和关键值。只输出 JSON 数组，不要任何额外说明文字。";
  const user =
    "文件：" + fileInfo.path + "\n语言扩展：" + (fileInfo.ext || "") + "\n" + nameHint +
    "\n源码：\n```\n" + fileInfo.text + "\n```\n\n" +
    "请输出 JSON 数组，每个元素格式：{\"name\":\"方法名\",\"keyValues\":\"关键值，一行\",\"desc\":\"作用，一句话\"}。" +
    "只输出 JSON，不要代码围栏或解释。";
  const messages = [
    { role: "system", content: sys },
    { role: "user", content: user }
  ];
  let text = "";
  try {
    text = await callModelForText(modelCfg, messages, signal);
  } catch (e) {
    diag.log("map", "调用模型归纳失败", { message: e && e.message });
    return [];
  }
  return attachLines(parseMethodsJson(text), fileInfo.text);
}

function chatModelCfg() {
  try {
    const s = store.load();
    return store.resolveModelCfg(s.currentModelId, s);
  } catch {
    return null;
  }
}

const summaryJobs = new Set();
const oneSummary = new Set();
const summaryAgain = new Set();
// [铆钉优化] 改完文件 20 秒内再改就重新计时，停手后才重归纳，不和正在改代码的模型抢接口。其他 AI 请勿去掉
const RESUMMARIZE_DELAY_MS = 20000;
const resummarizeTimers = new Map();
function scheduleResummarize(workspace, id) {
  if (!workspace || !id) return;
  const k = hashPath(workspace) + "\n" + id;
  const old = resummarizeTimers.get(k);
  if (old) clearTimeout(old);
  resummarizeTimers.set(k, setTimeout(() => {
    resummarizeTimers.delete(k);
    resummarizeNow(workspace, id);
  }, RESUMMARIZE_DELAY_MS));
}
// 写文件更新地图后：勾选过的模块在后台重归纳。正在归纳的同一文件只再排一次
function resummarizeNow(workspace, id) {
  if (!workspace || !id) return;
  const inc = loadInclude(workspace);
  if (!inc || !inc.initialized || !Array.isArray(inc.includes) || inc.includes.indexOf(id) < 0) return;
  const cfg = chatModelCfg();
  if (!cfg) return;
  const flight = hashPath(workspace) + "\n" + id;
  if (oneSummary.has(flight)) {
    summaryAgain.add(flight);
    return;
  }
  summarizeOne(workspace, id, cfg).catch((e) => {
    diag.log("map", "改完重归纳失败", { id, message: e && e.message });
  });
}
// 只改这一个节点再写回，避免整批归纳用内存里的旧地图盖掉刚点开的那份说明
function saveNodePatch(workspace, node) {
  const map = loadJson(jsonPath(workspace), null);
  if (!map || !Array.isArray(map.nodes) || !node) return;
  const hit = map.nodes.find((x) => x.id === node.id);
  if (!hit) return;
  // 归纳期间文件又被写过，这份说明对的是旧源码，不能盖掉新节点
  if (node.methodsMtime != null && hit.mtime !== node.methodsMtime) return;
  hit.symbols = node.symbols || [];
  hit.methods = node.methods || [];
  hit.methodsMtime = node.methodsMtime;
  saveJson(jsonPath(workspace), map);
  invalidateMapCache(workspace);
}
async function summarizeIncludes(workspace, includes, modelCfg, signal) {
  if (!modelCfg || !includes || !includes.length) return;
  const jobKey = hashPath(workspace);
  if (summaryJobs.has(jobKey)) return;
  summaryJobs.add(jobKey);
  try {
  const map = loadJson(jsonPath(workspace), null);
  if (!map || !Array.isArray(map.nodes)) return;
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  // 只归纳勾选且尚未归纳过的节点，已有 methods 的跳过，省 token
  const targets = includes.map((id) => byId.get(id)).filter((n) => n && n.abs && !Array.isArray(n.methods));
  if (!targets.length) {
    emitStatus(workspace, { running: false, summarizing: false, summarizeDone: true, nodes: map.nodes.length, files: map.nodes.length });
    return;
  }
  emitStatus(workspace, { running: true, summarizing: true, done: 0, total: targets.length, nodes: map.nodes.length, files: map.nodes.length });
  let done = 0;
  for (const n of targets) {
    if (signal && signal.aborted) break;
    let text = "";
    try { text = fs.readFileSync(n.abs, "utf8"); } catch { n.methods = []; continue; }
    if (!text.trim()) { n.methods = []; continue; }
    try {
      n.symbols = extractSymbols(text, n.ext);
      const raw = await summarizeFileMethods(modelCfg, { path: n.path, ext: n.ext, text: text, symbols: n.symbols }, signal);
      // 落盘前按当前符号对齐：行号用符号，源码里没有的方法名丢掉
      n.methodsMtime = n.mtime;
      n.methods = nodeMethods(Object.assign({}, n, { methods: raw }));
    } catch (e) {
      diag.log("map", "方法归纳失败", { id: n.id, message: e && e.message });
      n.methods = n.methods || [];
    }
    done++;
    saveNodePatch(workspace, n);
    // 带上刚归纳完的这个模块，画布收到就能立刻更新它，不必等整批归纳结束
    emitStatus(workspace, {
      running: true, summarizing: true, done, total: targets.length,
      nodes: map.nodes.length, files: map.nodes.length,
      justSummarized: { id: n.id, methods: n.methods || [], symbols: n.symbols || [], desc: n.desc || "", mtime: n.mtime, methodsMtime: n.methodsMtime }
    });
  }
  emitStatus(workspace, { running: false, summarizing: false, summarizeDone: true, done, total: targets.length, nodes: map.nodes.length, files: map.nodes.length });
  } finally {
    summaryJobs.delete(jobKey);
  }
}

// 点开一个节点时只归纳这一个文件，把作用和关键值补进弹窗
async function summarizeOne(workspace, id, modelCfg) {
  if (!workspace || !id) return { ok: false, reason: "no-id" };
  if (!modelCfg) return { ok: false, reason: "no-model" };
  const flight = hashPath(workspace) + "\n" + id;
  if (oneSummary.has(flight)) return { ok: false, reason: "busy" };
  oneSummary.add(flight);
  try {
    const map = loadJson(jsonPath(workspace), null);
    if (!map || !Array.isArray(map.nodes)) return { ok: false, reason: "no-map" };
    const n = map.nodes.find((x) => x.id === id);
    if (!n || !n.abs) return { ok: false, reason: "no-node" };
    let text = "";
    try { text = fs.readFileSync(n.abs, "utf8"); } catch { return { ok: false, reason: "read" }; }
    n.symbols = extractSymbols(text, n.ext);
    if (!text.trim() || !n.symbols.length) {
      n.methods = [];
      n.methodsMtime = n.mtime;
      saveNodePatch(workspace, n);
      return { ok: true, id: n.id, symbols: n.symbols, methods: [], mtime: n.mtime, methodsMtime: n.mtime, desc: n.desc || "" };
    }
    const raw = await summarizeFileMethods(modelCfg, { path: n.path, ext: n.ext, text: text, symbols: n.symbols }, null);
    n.methodsMtime = n.mtime;
    n.methods = nodeMethods(Object.assign({}, n, { methods: raw }));
    let st = null;
    try { st = fs.statSync(n.abs); } catch { st = null; }
    if (!st || fileStamp(st) !== n.mtime || st.size !== n.size) return { ok: false, reason: "stale" };
    saveNodePatch(workspace, n);
    emitStatus(workspace, {
      running: false, summarizing: false,
      nodes: map.nodes.length, files: map.nodes.length,
      justSummarized: { id: n.id, methods: n.methods || [], symbols: n.symbols || [], desc: n.desc || "", mtime: n.mtime, methodsMtime: n.methodsMtime }
    });
    return {
      ok: true, id: n.id, symbols: n.symbols, methods: n.methods,
      mtime: n.mtime, methodsMtime: n.methodsMtime, desc: n.desc || ""
    };
  } catch (e) {
    diag.log("map", "单文件归纳失败", { id, message: e && e.message });
    return { ok: false, reason: "fail" };
  } finally {
    oneSummary.delete(flight);
    if (summaryAgain.has(flight)) {
      summaryAgain.delete(flight);
      scheduleResummarize(workspace, id);
    }
  }
}

function gotoDefinition(workspace, extra, symbol) {
  const name = String(symbol || "").trim();
  if (!name) return "符号名为空";
  if (!workspace) return "请先打开项目";
  const map = getMap(workspace);
  if (!map || !Array.isArray(map.nodes)) return "项目地图还没有，无法跳转到定义";
  const hits = [];
  for (const n of map.nodes || []) {
    const nAbs = n.abs || path.join(workspace, n.path || "");
    if (isForeignAiSkill(nAbs)) continue;
    for (const s of n.symbols || []) {
      if (s && s.name === name) hits.push({ path: n.path, abs: n.abs, line: s.line });
    }
  }
  if (!hits.length) return `项目地图里没有 ${name} 的定义。精确文本用 search_text。`;
  return hits.slice(0, 12).map((h) => {
    let snippet = "";
    try {
      const lines = fs.readFileSync(h.abs, "utf8").split(/\r?\n/);
      const start = Math.max(0, (h.line || 1) - 3);
      const end = Math.min(lines.length, (h.line || 1) + 8);
      snippet = lines.slice(start, end).map((ln, i) => `${start + i + 1}|${ln}`).join("\n");
    } catch { snippet = ""; }
    return `${h.path}:${h.line}\n${snippet}`;
  }).join("\n\n");
}

module.exports = {
  ensureIndex, kickIndex, abortIndex, deleteIndex, getStatus, onStatus, search, buildPromptBlock, getMap, upsertFile, removeFile, gotoDefinition,
  noteDiskChange, noteWatching,
  hashPath, fileKey, sameWorkspace, isIgnored, parseIgnoreLines, jsonPath, mdPath,
  getExcludes: loadExcludes, setExcludes: saveExcludes,
  getInclude: loadInclude, setInclude, summarizeIncludes, summarizeOne
};
