// Harness de teste do Lapso.
//
// Dirige o provider REAL compilado (`out/extension.js`) com `vscode` e `node:fs`
// mockados sobre um filesystem em memória. Permite reproduzir, sem VSCode aberto:
// troca de aba, fechamento, escrita concorrente do Claude, dispose/re-resolve do
// webview, transcript sem título ainda, diretório de transcripts ausente.
//
// Não cobre pixel/layout — o que depende de render vivo está listado no relatório.

const path = require("path");
const Module = require("module");

const norm = (p) => String(p).replace(/\\/g, "/");
const dirOf = (key) => key.slice(0, key.lastIndexOf("/"));
const baseOf = (key) => key.slice(key.lastIndexOf("/") + 1);

// ---------- filesystem em memória ----------

class MemFS {
  constructor() {
    this.files = new Map(); // key -> { content: Buffer, mtime, size }
    this.dirs = new Set();
    this.clock = 1000;
    this.failReadOnce = new Set(); // keys que devem falhar na próxima leitura
    this.failWriteOnce = new Set(); // keys que devem falhar na próxima escrita
    // Hook por arquivo, disparado A CADA leitura: deixa o teste mutar o arquivo ENTRE
    // duas leituras do mesmo save (é assim que se prova o compare-and-set).
    this.hooks = new Map();
    // Contadores de I/O: é assim que os testes de performance provam que o resolve()
    // parou de ler transcript inteiro e parou de varrer o mesmo diretório duas vezes.
    this.counters = { readdir: 0, stat: 0, open: 0, bytesRead: 0 };
  }
  resetCounters() {
    this.counters = { readdir: 0, stat: 0, open: 0, bytesRead: 0 };
  }
  reset() {
    this.files.clear();
    this.dirs.clear();
    this.failReadOnce.clear();
    this.failWriteOnce.clear();
    this.hooks.clear();
    this.clock = 1000;
    this.resetCounters();
  }
  write(p, text) {
    const key = norm(p);
    const content = Buffer.from(text, "utf8");
    this.files.set(key, { content, mtime: ++this.clock, size: content.length });
    this.dirs.add(dirOf(key));
    return key;
  }
  read(p) {
    const f = this.files.get(norm(p));
    return f ? f.content.toString("utf8") : null;
  }
  exists(p) {
    return this.files.has(norm(p));
  }
  remove(p) {
    return this.files.delete(norm(p));
  }
  mkdir(p) {
    this.dirs.add(norm(p));
  }
  hasDir(p) {
    const d = norm(p);
    if (this.dirs.has(d)) return true;
    for (const key of this.files.keys()) if (dirOf(key) === d) return true;
    // Ancestral de um diretório/arquivo existente também existe — num FS real
    // `<cfg>/projects` está lá enquanto houver qualquer projeto dentro. Sem isto o
    // mock não conseguia representar "raiz presente, subpasta do projeto ausente".
    for (const dir of this.dirs) if (dir.startsWith(d + "/")) return true;
    for (const key of this.files.keys()) if (key.startsWith(d + "/")) return true;
    return false;
  }
  list(p) {
    const d = norm(p);
    if (!this.hasDir(d)) {
      const e = new Error("ENOENT: no such directory, scandir '" + d + "'");
      e.code = "ENOENT";
      throw e;
    }
    const out = [];
    for (const key of this.files.keys()) if (dirOf(key) === d) out.push(baseOf(key));
    return out;
  }
  stat(p) {
    const f = this.files.get(norm(p));
    if (!f) {
      const e = new Error("ENOENT: no such file '" + p + "'");
      e.code = "ENOENT";
      throw e;
    }
    return f;
  }
}

const mem = new MemFS();

// ---------- mock de node:fs / node:fs/promises ----------

function makeFsMocks() {
  const promises = {
    async stat(p) {
      mem.counters.stat++;
      const f = mem.stat(p);
      return { mtimeMs: f.mtime, size: f.size, isFile: () => true, isDirectory: () => false };
    },
    async readdir(p) {
      mem.counters.readdir++;
      return mem.list(p);
    },
    // O registro de sessões vivas do CLI (`<config>/sessions/<pid>.json`) é lido inteiro,
    // não por janela — sem este mock o fallback por sessão viva passava só em produção.
    async readFile(p, enc) {
      const f = mem.stat(p);
      mem.counters.open++;
      return enc ? f.content.toString(enc) : f.content;
    },
    async open(p, _flags) {
      const key = norm(p);
      if (mem.failReadOnce.has(key)) {
        mem.failReadOnce.delete(key);
        const e = new Error("EBUSY: resource busy '" + p + "'");
        e.code = "EBUSY";
        throw e;
      }
      const f = mem.stat(p);
      mem.counters.open++;
      return {
        async read(buf, offset, length, position) {
          const src = f.content.subarray(position, position + length);
          src.copy(buf, offset);
          mem.counters.bytesRead += src.length;
          return { bytesRead: src.length };
        },
        async close() {},
      };
    },
  };
  const fsMock = {
    promises,
    readFileSync(p, enc) {
      const f = mem.stat(p);
      return enc ? f.content.toString(enc) : f.content;
    },
    writeFileSync(p, data) {
      mem.write(p, typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    },
    mkdirSync(p) {
      mem.mkdir(p);
    },
    watch(dir, _opts, _cb) {
      if (!mem.hasDir(dir)) {
        const e = new Error("ENOENT watch '" + dir + "'");
        e.code = "ENOENT";
        throw e;
      }
      return { close() {}, on() {} };
    },
  };
  return { fsMock, promises };
}

// ---------- mock do vscode ----------

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

function uriFile(p) {
  const fsPath = norm(p);
  return { scheme: "file", fsPath, path: fsPath, toString: () => fsPath };
}
function uriJoin(base, ...segs) {
  return uriFile([base.fsPath, ...segs].join("/"));
}

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

function makeVscodeMock(state) {
  const vscodeMock = {
    Uri: { file: uriFile, joinPath: uriJoin },
    FileType,
    RelativePattern,
    workspace: {
      workspaceFolders: [{ uri: uriFile("d:/testws"), name: "testws", index: 0 }],
      fs: {
        async stat(uri) {
          const f = mem.stat(uri.fsPath);
          return { type: FileType.File, mtime: f.mtime, size: f.size, ctime: f.mtime };
        },
        async readFile(uri) {
          const key = norm(uri.fsPath);
          if (mem.failReadOnce.has(key)) {
            mem.failReadOnce.delete(key);
            const e = new Error("EBUSY " + key);
            e.code = "EBUSY";
            throw e;
          }
          const content = mem.stat(uri.fsPath).content;
          const hook = mem.hooks.get(key);
          if (hook) hook();
          return new Uint8Array(content);
        },
        async writeFile(uri, data) {
          const key = norm(uri.fsPath);
          if (mem.failWriteOnce.has(key)) {
            mem.failWriteOnce.delete(key);
            const e = new Error("EPERM " + key);
            e.code = "EPERM";
            throw e;
          }
          mem.write(uri.fsPath, Buffer.from(data).toString("utf8"));
        },
        async readDirectory(uri) {
          return mem.list(uri.fsPath).map((n) => [n, FileType.File]);
        },
        async delete(uri) {
          if (!mem.remove(uri.fsPath)) throw new Error("ENOENT " + uri.fsPath);
        },
        async createDirectory(uri) {
          mem.mkdir(uri.fsPath);
        },
      },
      createFileSystemWatcher(pattern) {
        const w = {
          pattern,
          disposed: false,
          _change: [],
          _create: [],
          _delete: [],
          onDidChange(cb) {
            w._change.push(cb);
            return { dispose() {} };
          },
          onDidCreate(cb) {
            w._create.push(cb);
            return { dispose() {} };
          },
          onDidDelete(cb) {
            w._delete.push(cb);
            return { dispose() {} };
          },
          dispose() {
            w.disposed = true;
          },
        };
        state.watchers.push(w);
        return w;
      },
      async openTextDocument() {
        return {};
      },
    },
    window: {
      createOutputChannel() {
        return {
          appendLine: (s) => state.outputLines.push(s),
          append() {},
          show() {},
          clear() {},
          dispose() {},
        };
      },
      showWarningMessage: async (s) => {
        state.warnings.push(s);
      },
      showInformationMessage: async (s) => {
        state.infos.push(s);
      },
      async showTextDocument() {
        return {};
      },
      registerWebviewViewProvider(id, provider) {
        state.provider = provider;
        return { dispose() {} };
      },
      tabGroups: {
        get activeTabGroup() {
          return { activeTab: state.activeTab, tabs: state.allTabs };
        },
        get all() {
          return [{ activeTab: state.activeTab, tabs: state.allTabs }];
        },
        onDidChangeTabs(cb) {
          state.tabsChangedCbs.push(cb);
          return { dispose() {} };
        },
        onDidChangeTabGroups(cb) {
          state.tabGroupsChangedCbs.push(cb);
          return { dispose() {} };
        },
      },
    },
    commands: {
      registerCommand(id, fn) {
        state.commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand(id, ...args) {
        const fn = state.commands.get(id);
        return fn ? Promise.resolve(fn(...args)) : Promise.resolve();
      },
    },
  };
  return vscodeMock;
}

// ---------- bootstrap ----------

const state = {
  provider: null,
  activeTab: undefined,
  allTabs: [],
  tabsChangedCbs: [],
  tabGroupsChangedCbs: [],
  watchers: [],
  outputLines: [],
  warnings: [],
  infos: [],
  commands: new Map(),
};

const vscodeMock = makeVscodeMock(state);
const { fsMock, promises: fspMock } = makeFsMocks();

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeMock;
  if (request === "fs") return fsMock;
  if (request === "fs/promises" || request === "node:fs/promises") return fspMock;
  if (request === "node:fs") return fsMock;
  return origLoad.apply(this, arguments);
};

process.env.CLAUDE_CONFIG_DIR = "d:/cfg";
// O harness simula um ambiente Windows (paths com drive letter), e a dedup de variantes
// de drive em sessionsDirCandidates() decide por process.platform — sem isto a suíte
// diverge rodando em Linux (CI): d--/D-- viram 2 diretórios e o assert de 1 varredura falha.
Object.defineProperty(process, "platform", { value: "win32" });
const PROJECTS_DIR = "d:/cfg/projects/d--testws"; // encodeCwd("d:/testws")
const WS = "d:/testws";
const LAPSO = WS + "/.lapso";

const ext = require(path.resolve(__dirname, "..", "out", "extension.js"));

// Tempos curtos: os testes não podem esperar segundos reais.
ext.config.syncCoalesceMs = 1;
ext.config.saveDebounceMs = 20;
ext.config.retryScheduleMs = [10, 10, 10];
ext.config.pollIntervalMs = 25;
ext.config.negativeCacheTtlMs = 5;
// Recuo pequeno pra que a leitura incremental seja observável em transcript de teste
// (em produção são 4 KB, que num arquivo de 1 KB leria tudo de qualquer jeito).
ext.config.deltaBackoffBytes = 16;

// ---------- helpers de driver ----------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
async function settle(ms = 40) {
  await wait(ms);
  for (let i = 0; i < 6; i++) await tick();
}

function claudeTab(label) {
  return { label, input: { viewType: "mainThreadWebview-claudeVSCodePanel" } };
}
function fileTab(label) {
  return { label, input: { uri: uriFile(WS + "/" + label) } };
}

function fireTabs(evt) {
  for (const cb of state.tabsChangedCbs) cb(evt);
}

async function focus(tab, opts = {}) {
  state.activeTab = tab;
  if (tab && !state.allTabs.includes(tab)) state.allTabs.push(tab);
  if (opts.clearPosted !== false) state.posted.length = 0;
  fireTabs({ opened: [], closed: [], changed: [tab].filter(Boolean) });
  await settle(opts.settle ?? 60);
}

async function closeTab(tab) {
  state.allTabs = state.allTabs.filter((t) => t !== tab);
  if (state.activeTab === tab) state.activeTab = undefined;
  fireTabs({ opened: [], closed: [tab], changed: [] });
  await settle(60);
}

// Dispara os callbacks do FileSystemWatcher vivo (simula o Claude gravando a nota).
function fireWatcher(kind, fsPath) {
  for (const w of state.watchers) {
    if (w.disposed) continue;
    const list = kind === "change" ? w._change : kind === "create" ? w._create : w._delete;
    for (const cb of list) cb(uriFile(fsPath));
  }
}

function liveWatchers() {
  return state.watchers.filter((w) => !w.disposed);
}

function noteBody(status, notes, prologue = "", epilogue = "") {
  return (
    prologue +
    `<!-- lapso:status -->\n${status}\n<!-- /lapso:status -->\n\n` +
    `<!-- lapso:notes -->\n${notes}\n<!-- /lapso:notes -->\n` +
    epilogue
  );
}

function notesOf(sid) {
  const raw = mem.read(LAPSO + "/" + sid + ".md");
  if (raw == null) return null;
  const m = raw.match(/<!-- lapso:notes -->\n([\s\S]*?)\n<!-- \/lapso:notes -->/);
  return m ? m[1] : null;
}
function statusOf(sid) {
  const raw = mem.read(LAPSO + "/" + sid + ".md");
  if (raw == null) return null;
  const m = raw.match(/<!-- lapso:status -->\n([\s\S]*?)\n<!-- \/lapso:status -->/);
  return m ? m[1] : null;
}

function transcript(sessionId, aiTitle, extraLines = 0) {
  const filler = Array.from(
    { length: extraLines },
    (_, i) => JSON.stringify({ type: "user", sessionId, seq: i, pad: "x".repeat(40) })
  );
  const lines = [
    JSON.stringify({ type: "user", sessionId, seq: -1 }),
    ...filler,
    JSON.stringify({ type: "ai-title", aiTitle, sessionId }),
  ];
  mem.write(PROJECTS_DIR + "/" + sessionId + ".jsonl", lines.join("\n") + "\n");
}

// Transcript SEM entrada de título — é o estado de uma sessão recém-aberta
// (medido: ~65 s até o Claude Code gravar o ai-title).
function transcriptNoTitle(sessionId) {
  mem.write(
    PROJECTS_DIR + "/" + sessionId + ".jsonl",
    JSON.stringify({ type: "user", sessionId, seq: 0 }) + "\n"
  );
}

// Transcript sem título mas COM o primeiro prompt do usuário — o estado real medido em
// 2026-08-29, quando sessões novas ficaram horas sem `ai-title` nenhum. `antes` injeta as
// linhas de envelope que o Claude Code grava ANTES do prompt (system-reminder, caveat de
// comando local, contexto de hook), que não podem ser confundidas com o nome da sessão.
function transcriptFirstPrompt(sessionId, prompt, antes = []) {
  const linhas = [
    ...antes.map((texto) =>
      JSON.stringify({ type: "user", sessionId, message: { role: "user", content: texto } })
    ),
    JSON.stringify({ type: "user", sessionId, message: { role: "user", content: prompt } }),
  ];
  mem.write(PROJECTS_DIR + "/" + sessionId + ".jsonl", linhas.join("\n") + "\n");
}

// Transcript num diretório de projeto ARBITRÁRIO — pra exercitar a resolução do nome da
// pasta (encodeCwd) com workspace fora do `d:/testws` padrão, que não tem caractere
// especial nenhum e por isso não distingue a regra atual da antiga.
function transcriptEm(dirProjeto, sessionId, aiTitle) {
  mem.mkdir(dirProjeto);
  const linhas = [
    JSON.stringify({ type: "user", sessionId, seq: -1 }),
    JSON.stringify({ type: "ai-title", aiTitle, sessionId }),
  ];
  mem.write(dirProjeto + "/" + sessionId + ".jsonl", linhas.join("\n") + "\n");
}

// Troca o workspace aberto (o mock expõe um array só de leitura pro código sob teste).
// Devolve a função que restaura o padrão — chamar sempre no fim do bloco, senão os testes
// seguintes herdam o workspace trocado.
function usarWorkspace(fsPath) {
  const anterior = vscodeMock.workspace.workspaceFolders;
  vscodeMock.workspace.workspaceFolders = [
    { uri: uriFile(fsPath), name: fsPath.split(/[\\/]/).pop(), index: 0 },
  ];
  return () => {
    vscodeMock.workspace.workspaceFolders = anterior;
  };
}

// Mesma coisa, com o conteúdo em blocos (a outra forma que o Claude Code grava).
function transcriptFirstPromptBlocos(sessionId, prompt) {
  mem.write(
    PROJECTS_DIR + "/" + sessionId + ".jsonl",
    JSON.stringify({
      type: "user",
      sessionId,
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    }) + "\n"
  );
}

function appendTitle(sessionId, aiTitle) {
  const key = PROJECTS_DIR + "/" + sessionId + ".jsonl";
  const raw = mem.read(key) ?? "";
  mem.write(key, raw + JSON.stringify({ type: "ai-title", aiTitle, sessionId }) + "\n");
}

function appendCustomTitle(sessionId, customTitle) {
  const key = PROJECTS_DIR + "/" + sessionId + ".jsonl";
  const raw = mem.read(key) ?? "";
  mem.write(key, raw + JSON.stringify({ type: "custom-title", customTitle, sessionId }) + "\n");
}

// ---------- webview fake (lado do host) ----------

function makeFakeView(opts = {}) {
  const view = {
    visible: opts.visible !== false,
    sent: [],
    webview: {
      options: {},
      cspSource: "vscode-resource:",
      html: "",
      _msgCbs: [],
      onDidReceiveMessage(cb) {
        view.webview._msgCbs.push(cb);
        return { dispose() {} };
      },
      postMessage(m) {
        state.posted.push(m);
        view.sent.push(m);
        if (view.__sandbox) view.__sandbox.send(m);
        return Promise.resolve(true);
      },
    },
    _disposeCbs: [],
    onDidDispose(cb) {
      view._disposeCbs.push(cb);
      return { dispose() {} };
    },
    _visCbs: [],
    onDidChangeVisibility(cb) {
      view._visCbs.push(cb);
      return { dispose() {} };
    },
    fireDispose() {
      for (const cb of view._disposeCbs) cb();
    },
    setVisible(v) {
      view.visible = v;
      for (const cb of view._visCbs) cb();
    },
    sendToHost(msg) {
      for (const cb of view.webview._msgCbs) cb(msg);
    },
  };
  return view;
}

state.posted = [];

function makeContext() {
  const ws = new Map();
  return {
    subscriptions: { push() {} },
    workspaceState: {
      get: (k, d) => (ws.has(k) ? ws.get(k) : d),
      update: async (k, v) => {
        ws.set(k, v);
      },
      __store: ws,
    },
  };
}

// Sobe uma instância limpa do provider com um webview fake já resolvido.
async function boot(opts = {}) {
  // keepFs: simula "recarregar a janela" — o processo do provider morre e volta, mas o
  // disco (transcripts + .lapso) continua exatamente onde estava.
  if (!opts.keepFs) {
    mem.reset();
  }
  mem.mkdir(LAPSO);
  mem.mkdir(PROJECTS_DIR);
  state.posted.length = 0;
  state.outputLines.length = 0;
  state.warnings.length = 0;
  state.infos.length = 0;
  state.watchers.length = 0;
  state.activeTab = undefined;
  state.allTabs = [];
  state.tabsChangedCbs.length = 0;
  state.tabGroupsChangedCbs.length = 0;
  state.commands.clear();

  // Descarta o provider do teste anterior: sem isso os timers dele (retry, poll)
  // continuam vivos e poluem as asserções dos testes seguintes.
  if (state.provider && typeof state.provider.dispose === "function") {
    state.provider.dispose();
  }
  const ctx = opts.context ?? makeContext();
  ext.activate(ctx);
  const provider = state.provider;
  const view = makeFakeView(opts);
  if (opts.sandbox) {
    const { createWebviewSandbox } = require("./webview-sandbox.js");
    view.__sandbox = createWebviewSandbox(() => view.webview.html, (msg) => view.sendToHost(msg));
  }
  provider.resolveWebviewView(view);
  if (view.__sandbox) view.__sandbox.start();
  await settle(60);
  return { provider, view, ctx, sandbox: view.__sandbox };
}

// ---------- asserts ----------

const results = { pass: 0, fail: 0, failures: [] };
function ok(cond, msg) {
  if (cond) {
    results.pass++;
    console.log("  PASS " + msg);
  } else {
    results.fail++;
    results.failures.push(msg);
    console.log("  FAIL " + msg);
  }
}
function section(name) {
  console.log("\n" + name);
}
function finish() {
  const total = results.pass + results.fail;
  console.log(
    "\n" +
      (results.fail === 0
        ? `TODOS OS ${total} TESTES PASSARAM`
        : `${results.fail} de ${total} TESTE(S) FALHARAM:\n  - ` + results.failures.join("\n  - "))
  );
  Module._load = origLoad;
  process.exit(results.fail === 0 ? 0 : 1);
}

function lastPosted(type) {
  for (let i = state.posted.length - 1; i >= 0; i--) {
    if (!type || state.posted[i].type === type) return state.posted[i];
  }
  return undefined;
}

module.exports = {
  ext,
  mem,
  state,
  PROJECTS_DIR,
  LAPSO,
  wait,
  settle,
  claudeTab,
  fileTab,
  focus,
  closeTab,
  fireTabs,
  fireWatcher,
  liveWatchers,
  noteBody,
  notesOf,
  statusOf,
  transcript,
  transcriptNoTitle,
  transcriptEm,
  usarWorkspace,
  transcriptFirstPrompt,
  transcriptFirstPromptBlocos,
  appendTitle,
  appendCustomTitle,
  makeFakeView,
  makeContext,
  boot,
  ok,
  section,
  finish,
  lastPosted,
};
