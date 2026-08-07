import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as fsp from "fs/promises";

// Pasta (no workspace, gitignored) onde vivem as notas por-sessão.
const LAPSO_DIR = ".lapso";
// viewType dos painéis de sessão do Claude Code (createWebviewPanel("claudeVSCodePanel", ...)).
// A API de tabs prefixa "mainThreadWebview-" — então testamos com includes().
const CLAUDE_PANEL_HINT = "claudeVSCodePanel";

const STATUS_OPEN = "<!-- lapso:status -->";
const STATUS_CLOSE = "<!-- /lapso:status -->";
const NOTES_OPEN = "<!-- lapso:notes -->";
const NOTES_CLOSE = "<!-- /lapso:notes -->";

// Chave do workspaceState que persiste a associação aba→sessão entre reloads da janela.
const TAB_MAP_KEY = "lapso.tabSessions.v1";
// Índice de títulos persistido: reabrir a janela não paga varredura fria de novo.
const INDEX_KEY = "lapso.titleIndex.v1";

// Parâmetros de tempo/tamanho num só lugar — os testes sobrescrevem pra rodar rápido
// (mutam direto o export `config` carregado de out/extension.js — ver tests/harness.js).
// Nada aqui muda a animação do status, que é intencionalmente preservada byte a byte no webview.
export const config = {
  // Coalescing dos eventos de aba: uma troca de aba dispara 2-3 eventos (a aba velha
  // perde EDITOR_ACTIVE, a nova ganha, e cruzar grupos ainda emite onDidChangeTabGroups).
  syncCoalesceMs: 50,
  // Debounce do save das notas no host (o webview já tem o dele).
  saveDebounceMs: 500,
  // Uma aba de sessão do Claude leva ~1min pra ganhar título no .jsonl. Enquanto não
  // resolve, re-tenta nesta escala (e depois no último valor, indefinidamente).
  retryScheduleMs: [1000, 2000, 4000, 8000, 15000, 30000, 60000],
  // Rede de segurança caso o FileSystemWatcher não entregue o evento (drive de rede,
  // watcher morto, escrita por rename). Só roda com o painel visível.
  pollIntervalMs: 3000,
  // Até este tamanho o transcript é lido inteiro (exato e barato). Acima disso a
  // extração de título lê só duas janelas: a CABEÇA (onde o Claude Code grava o
  // ai-title inicial) e a CAUDA (onde caem renomeações e o custom-title).
  fullReadMaxBytes: 512 * 1024,
  headWindowBytes: 512 * 1024,
  tailWindowBytes: 256 * 1024,
  // Último recurso: se nem cabeça nem cauda tinham título, relê inteiro até este teto.
  hugeReadMaxBytes: 32 * 1024 * 1024,
  // Recuo aplicado na leitura incremental pra não cortar uma linha ao meio.
  deltaBackoffBytes: 4096,
  // Título que não resolveu não é re-varrido por este tempo (clicar num arquivo comum
  // é o evento mais frequente e não deve pagar varredura nenhuma).
  negativeCacheTtlMs: 5000,
  titleCacheMax: 500,
  // Tentativas do compare-and-set ao gravar as notas.
  saveCasAttempts: 3,
};

// --- Zonas do arquivo de nota ---

export interface NoteDoc {
  status: string;
  notes: string;
  // Texto fora das duas zonas: preservado na regravação (o contrato diz que o que está
  // fora da zona do Claude é do Lucas e é intocável).
  prologue: string;
  epilogue: string;
  // true quando um marcador abriu e não fechou — arquivo pego no meio de uma escrita.
  // Leitura parcial não renderiza nem grava: mantém o último estado bom.
  partial: boolean;
}

const EMPTY_DOC: NoteDoc = { status: "", notes: "", prologue: "", epilogue: "", partial: false };

function sliceZone(raw: string, open: string, close: string): { text: string; start: number; end: number } | null {
  const oi = raw.indexOf(open);
  if (oi === -1) {
    return null;
  }
  const ci = raw.indexOf(close, oi + open.length);
  if (ci === -1) {
    return null;
  }
  const text = raw.slice(oi + open.length, ci).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return { text, start: oi, end: ci + close.length };
}

// Detecta abertura sem fechamento — sinal de leitura durante truncate+write.
function hasDanglingMarker(raw: string): boolean {
  const openStatus = raw.indexOf(STATUS_OPEN) !== -1;
  const closeStatus = raw.indexOf(STATUS_CLOSE) !== -1;
  const openNotes = raw.indexOf(NOTES_OPEN) !== -1;
  const closeNotes = raw.indexOf(NOTES_CLOSE) !== -1;
  return (openStatus && !closeStatus) || (openNotes && !closeNotes);
}

export function parseZones(raw: string): NoteDoc {
  if (hasDanglingMarker(raw)) {
    return { ...EMPTY_DOC, partial: true };
  }
  const status = sliceZone(raw, STATUS_OPEN, STATUS_CLOSE);
  const notes = sliceZone(raw, NOTES_OPEN, NOTES_CLOSE);
  if (status && notes) {
    const first = Math.min(status.start, notes.start);
    const last = Math.max(status.end, notes.end);
    return {
      status: status.text,
      notes: notes.text,
      prologue: raw.slice(0, first),
      epilogue: raw.slice(last),
      partial: false,
    };
  }
  if (status && !notes) {
    // Zona de notas ausente: o texto fora da zona de status é considerado nota do usuário
    // (compatibilidade com arquivo escrito na mão).
    const before = raw.slice(0, status.start);
    const after = raw.slice(status.end);
    return { status: status.text, notes: (before + after).trim(), prologue: "", epilogue: "", partial: false };
  }
  if (!status && notes) {
    return {
      status: "",
      notes: notes.text,
      prologue: raw.slice(0, notes.start),
      epilogue: raw.slice(notes.end),
      partial: false,
    };
  }
  // Nenhum marcador: arquivo inteiro é nota.
  return { status: "", notes: raw.trim(), prologue: "", epilogue: "", partial: false };
}

export function buildFile(doc: NoteDoc, status: string, notes: string): string {
  const body =
    `${STATUS_OPEN}\n${status}\n${STATUS_CLOSE}\n\n` + `${NOTES_OPEN}\n${notes}\n${NOTES_CLOSE}\n`;
  const pro = doc.prologue ? (doc.prologue.endsWith("\n") ? doc.prologue : doc.prologue + "\n") : "";
  const epi = doc.epilogue ?? "";
  return pro + body + epi;
}

// --- Leitura da nota, distinguindo ausente × erro de I/O × vazio ---

type ReadResult =
  | { kind: "ok"; doc: NoteDoc; mtime: number; size: number }
  | { kind: "missing" }
  | { kind: "partial" }
  | { kind: "io"; error: string };

// --- Resolução título-da-aba → sessionId, via os transcripts .jsonl do Claude Code ---

function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

// Encoding do cwd que o Claude Code usa pro nome da pasta de projeto:
// troca ':', '\', '/', '_', '.' por '-'. Ex: c:\projects\_my.repo
// -> c--projects--my-repo
export function encodeCwd(fsPath: string): string {
  return fsPath.replace(/[:\\/._]/g, "-");
}

// No NTFS as variantes de drive maiúsculo/minúsculo apontam pro MESMO diretório físico;
// varrer as duas dobrava o custo de todo não-match. Deduplica sem depender do FS.
export function sessionsDirCandidates(): string[] {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return [];
  }
  const fsPath = folder.uri.fsPath;
  const projects = claudeProjectsDir();
  const variants: string[] = [fsPath];
  if (/^[a-zA-Z]:/.test(fsPath)) {
    variants.push(fsPath[0].toLowerCase() + fsPath.slice(1));
    variants.push(fsPath[0].toUpperCase() + fsPath.slice(1));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of variants) {
    const dir = path.join(projects, encodeCwd(v));
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(dir);
  }
  return out;
}

// A raiz existe? É o que separa "CLAUDE_CONFIG_DIR invisível pro VSCode" (raiz ausente)
// de "este projeto ainda não teve sessão do Claude Code" (raiz presente, subpasta não —
// ela só nasce quando a primeira sessão grava o .jsonl).
export async function projectsRootReadable(): Promise<boolean> {
  try {
    await fsp.readdir(claudeProjectsDir());
    return true;
  } catch {
    return false;
  }
}

const AI_TITLE = /"aiTitle":"((?:[^"\\]|\\.)*)"/;
const CUSTOM_TITLE = /"customTitle":"((?:[^"\\]|\\.)*)"/;

// Varre um pedaço de .jsonl e devolve o ÚLTIMO título de cada tipo encontrado ali.
// ⚠️ A ordem dos campos varia entre entradas ({type,aiTitle,sessionId} vs {type,sessionId,
// aiTitle}) — filtrar a linha pelo type e extrair o valor de qualquer posição.
export function scanTitles(chunk: string): { ai: string; custom: string } {
  let ai = "";
  let custom = "";
  for (const line of chunk.split(/\r?\n/)) {
    if (line.includes('"type":"ai-title"')) {
      const m = line.match(AI_TITLE);
      if (m) {
        ai = m[1];
      }
    } else if (line.includes('"type":"custom-title"')) {
      const m = line.match(CUSTOM_TITLE);
      if (m) {
        custom = m[1];
      }
    }
  }
  return { ai, custom };
}

async function readWindow(file: string, start: number, length: number): Promise<string> {
  if (length <= 0) {
    return "";
  }
  const handle = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

interface TitleCacheEntry {
  mtimeMs: number;
  size: number;
  ai: string;
  custom: string;
  title: string;
}

export function decodeJsonString(s: string): string {
  if (!s) {
    return "";
  }
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

export function normalizeTitle(s: string): string {
  // NFC: o "ú" pode vir composto (U+00FA) do .jsonl e decomposto (u + U+0301)
  // do label da aba (ou vice-versa) — normalizar antes de comparar.
  return (s || "").trim().normalize("NFC");
}

// Compara o label da aba com o título do .jsonl, tolerante a: normalização
// Unicode (acentos) e truncação do label com reticências ("…" ou "...").
export function titleMatches(want: string, jsonlTitle: string): boolean {
  const a = normalizeTitle(want);
  const b = normalizeTitle(jsonlTitle);
  if (a === b) {
    return true;
  }
  const truncated = a.replace(/[….]+$/, "").trim();
  return truncated.length >= 6 && b.startsWith(truncated);
}

export interface ResolveResult {
  sessionId?: string;
  // A pasta de transcripts DESTE workspace existe e foi lida.
  anyDirReadable: boolean;
  // A raiz `<CLAUDE_CONFIG_DIR>/projects` existe. Distingue os dois motivos de não
  // achar sessão: raiz ausente = config realmente invisível pro VSCode; raiz presente
  // e subpasta ausente = projeto que ainda não teve nenhuma sessão do Claude Code
  // (estado normal de repo novo — não é erro e não merece pop-up de alerta).
  rootReadable: boolean;
}

// Persistência do índice entre reloads da janela: sem isto, toda reabertura do VSCode
// pagava a varredura fria completa do diretório de transcripts.
export interface IndexStore {
  load(): Array<[string, TitleCacheEntry]> | undefined;
  save(entries: Array<[string, TitleCacheEntry]>): void;
}

export class SessionTitleIndex {
  // LRU: sessionId -> título extraído + assinatura do arquivo.
  private cache = new Map<string, TitleCacheEntry>();
  private store: IndexStore | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(store?: IndexStore) {
    this.store = store;
    try {
      for (const [k, v] of store?.load() ?? []) {
        if (v && typeof v.title === "string") {
          this.cache.set(k, v);
        }
      }
    } catch {
      /* estado corrompido/incompatível: começa frio */
    }
  }

  private scheduleStoreSave(): void {
    if (!this.store || this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      try {
        this.store?.save(Array.from(this.cache.entries()));
      } catch {
        /* workspaceState indisponível */
      }
    }, 2000);
    if (typeof (this.saveTimer as unknown as { unref?: () => void }).unref === "function") {
      (this.saveTimer as unknown as { unref: () => void }).unref();
    }
  }
  // Títulos que não resolveram, com TTL — clicar num arquivo comum é o evento mais
  // frequente e não pode pagar varredura.
  private negative = new Map<string, number>();
  // Diagnóstico do último resolve(), exposto só pra log. O valor autoritativo vem no
  // retorno de resolve() — campo mutável compartilhado gerava falso-positivo de
  // "config-missing" quando dois resolves corriam juntos.
  lastTriedDirs: string[] = [];

  private touch(sessionId: string, entry: TitleCacheEntry): void {
    this.cache.delete(sessionId);
    this.cache.set(sessionId, entry);
    while (this.cache.size > config.titleCacheMax) {
      const oldest = this.cache.keys().next();
      if (oldest.done) {
        break;
      }
      this.cache.delete(oldest.value);
    }
    this.scheduleStoreSave();
  }

  invalidate(sessionId?: string): void {
    if (sessionId) {
      this.cache.delete(sessionId);
    } else {
      this.cache.clear();
    }
    this.negative.clear();
  }

  // Extrai o título de um transcript lendo o mínimo possível:
  //  - arquivo pequeno  → leitura inteira (exato e barato);
  //  - já em cache e só cresceu → lê apenas o delta (mata o custo da sessão VIVA, cujo
  //    .jsonl muda a cada mensagem e por isso dava cache miss garantido);
  //  - arquivo grande sem cache → janela da cauda e, se preciso, da cabeça.
  private async titleOf(dir: string, sessionId: string): Promise<string | undefined> {
    const file = path.join(dir, `${sessionId}.jsonl`);
    let stat: { mtimeMs: number; size: number };
    try {
      const st = await fsp.stat(file);
      stat = { mtimeMs: Number(st.mtimeMs), size: Number(st.size) };
    } catch {
      this.cache.delete(sessionId);
      return undefined;
    }
    const cached = this.cache.get(sessionId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.touch(sessionId, cached);
      return cached.title;
    }

    let ai = "";
    let custom = "";
    try {
      if (cached && stat.size >= cached.size && cached.size > 0) {
        const from = Math.max(0, cached.size - config.deltaBackoffBytes);
        let chunk = await readWindow(file, from, stat.size - from);
        if (from > 0) {
          // Descarta a linha possivelmente cortada ao meio pelo recuo.
          const nl = chunk.indexOf("\n");
          chunk = nl === -1 ? "" : chunk.slice(nl + 1);
        }
        const found = scanTitles(chunk);
        ai = found.ai || cached.ai;
        custom = found.custom || cached.custom;
      } else if (stat.size <= config.fullReadMaxBytes) {
        const found = scanTitles(await readWindow(file, 0, stat.size));
        ai = found.ai;
        custom = found.custom;
      } else {
        // Duas janelas de tamanho fixo, independentes do tamanho do arquivo: a cabeça
        // (ai-title original, gravado nas primeiras trocas) e a cauda (renomeação e
        // custom-title, que são sempre entradas posteriores). A cauda tem prioridade.
        const head = scanTitles(await readWindow(file, 0, Math.min(config.headWindowBytes, stat.size)));
        const tailFrom = Math.max(0, stat.size - config.tailWindowBytes);
        const tail = scanTitles(await readWindow(file, tailFrom, stat.size - tailFrom));
        ai = tail.ai || head.ai;
        custom = tail.custom || head.custom;
        if (!ai && !custom && stat.size <= config.hugeReadMaxBytes) {
          const whole = scanTitles(await readWindow(file, 0, stat.size));
          ai = whole.ai;
          custom = whole.custom;
        }
      }
    } catch {
      return cached?.title;
    }

    const title = decodeJsonString(custom || ai);
    this.touch(sessionId, { mtimeMs: stat.mtimeMs, size: stat.size, ai, custom, title });
    return title;
  }

  // Dado o título da aba ativa, acha o sessionId correspondente.
  // Estratégia: primeiro tenta casar contra os títulos JÁ em cache (custo zero de I/O,
  // confirmando só o arquivo vencedor); só então varre os desconhecidos, do mais recente
  // pro mais antigo, saindo no primeiro match exato.
  async resolve(activeTitle: string): Promise<ResolveResult> {
    const want = normalizeTitle(activeTitle);
    const candidates = sessionsDirCandidates();
    this.lastTriedDirs = candidates;
    if (!want) {
      const readable = candidates.length > 0;
      return { sessionId: undefined, anyDirReadable: readable, rootReadable: readable };
    }
    const negAt = this.negative.get(want);
    if (negAt !== undefined && Date.now() - negAt < config.negativeCacheTtlMs) {
      return { sessionId: undefined, anyDirReadable: true, rootReadable: true };
    }

    let anyDirReadable = false;
    for (const dir of candidates) {
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      anyDirReadable = true;
      const ids = names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -".jsonl".length));

      // Fase 1 — casa contra o cache, sem tocar no disco.
      const cachedHits: string[] = [];
      for (const id of ids) {
        const c = this.cache.get(id);
        if (c && c.title && titleMatches(want, c.title)) {
          cachedHits.push(id);
        }
      }
      for (const id of cachedHits) {
        // Confirma que o título em cache continua valendo (1 stat + leitura do delta).
        const fresh = await this.titleOf(dir, id);
        if (fresh && titleMatches(want, fresh)) {
          return { sessionId: id, anyDirReadable, rootReadable: true };
        }
      }

      // Fase 2 — varre os desconhecidos/desatualizados, mais recentes primeiro.
      const unknown: { id: string; mtimeMs: number }[] = [];
      for (const id of ids) {
        if (cachedHits.includes(id)) {
          continue;
        }
        const c = this.cache.get(id);
        let mtimeMs = c?.mtimeMs ?? 0;
        try {
          const st = await fsp.stat(path.join(dir, `${id}.jsonl`));
          mtimeMs = Number(st.mtimeMs);
          if (c && c.mtimeMs === mtimeMs && c.size === Number(st.size)) {
            // Cache válido e já sabemos que não casa — pula sem ler o arquivo.
            continue;
          }
        } catch {
          continue;
        }
        unknown.push({ id, mtimeMs });
      }
      unknown.sort((a, b) => b.mtimeMs - a.mtimeMs);

      const prefixHits: { id: string; mtimeMs: number }[] = [];
      for (const u of unknown) {
        const title = await this.titleOf(dir, u.id);
        if (!title) {
          continue;
        }
        if (normalizeTitle(title) === want) {
          return { sessionId: u.id, anyDirReadable, rootReadable: true };
        }
        if (titleMatches(want, title)) {
          prefixHits.push(u);
        }
      }
      if (prefixHits.length) {
        // Desempate por título truncado: a sessão modificada mais recentemente.
        prefixHits.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return { sessionId: prefixHits[0].id, anyDirReadable, rootReadable: true };
      }
    }

    if (anyDirReadable) {
      this.negative.set(want, Date.now());
      return { sessionId: undefined, anyDirReadable, rootReadable: true };
    }
    // Só aqui a raiz é sondada: no caminho feliz o custo é zero, e no caminho de falha
    // é 1 readdir por retry — o preço de não acusar "config invisível" quando o projeto
    // simplesmente ainda não teve sessão nenhuma.
    return { sessionId: undefined, anyDirReadable, rootReadable: await projectsRootReadable() };
  }
}

export function isClaudeSessionTab(tab: vscode.Tab | undefined): boolean {
  if (!tab) {
    return false;
  }
  const input = tab.input as { viewType?: string } | undefined;
  return !!input && typeof input.viewType === "string" && input.viewType.includes(CLAUDE_PANEL_HINT);
}

// Identidade textual estável de uma aba, usada pra reencontrar a sessão depois de um
// reload da janela (quando os objetos Tab são recriados e o WeakMap se perde).
function tabKey(tab: vscode.Tab): string | undefined {
  const input = tab.input as { viewType?: string } | undefined;
  if (!input || typeof input.viewType !== "string") {
    return undefined;
  }
  return `${input.viewType}\u0000${tab.label}`;
}

class LapsoViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private viewToken = 0;
  private index: SessionTitleIndex;
  private currentSessionId: string | undefined;
  private currentTitle = "";
  private noteWatcher: vscode.FileSystemWatcher | undefined;
  private transcriptWatchers: fs.FSWatcher[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryStep = 0;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private lastNotes: string | undefined;
  private lastSig = "";
  private disposables: vscode.Disposable[] = [];
  // Associação estável aba→sessionId, fixada na 1ª resolução de uma aba de sessão
  // do Claude. A deleção no fechamento usa ISSO — nunca re-resolve por texto (título
  // duplicado/truncado + desempate por mtime apagava a nota da sessão VIVA errada).
  private tabSessions = new WeakMap<vscode.Tab, string>();
  // Espelho textual do mapa acima, persistido no workspaceState: sobrevive ao reload da
  // janela e cobre a aba que nunca foi focada (que fechava sem deletar a nota).
  private tabKeyMap = new Map<string, string>();
  // Save pendente carrega o sessionId capturado no momento da digitação — o timer
  // não pode reler currentSessionId (trocar de aba gravava o texto na sessão errada).
  private pendingSave: { sessionId: string; text: string } | undefined;
  // Fila serial de escrita por sessão: save debounced e delete de fechamento não podem
  // se cruzar (o save atrasado ressuscitava a nota de uma aba já fechada).
  private writeChains = new Map<string, Promise<unknown>>();
  private deletedSessions = new Set<string>();
  private output = vscode.window.createOutputChannel("Lapso");
  private warnedNoDir = false;
  private loggedNoSessions = false;
  private lastNoDirLog = "";
  private syncRunning = false;
  private syncDirty = false;
  private syncCoalesceTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private lastPosted: Record<string, unknown> | undefined;
  private lastPostedJson = "";
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.context.subscriptions.push(this.output);
    this.index = new SessionTitleIndex({
      load: () => this.context.workspaceState.get<Array<[string, TitleCacheEntry]>>(INDEX_KEY),
      save: (entries) => {
        void this.context.workspaceState.update(INDEX_KEY, entries);
      },
    });
    const stored = this.context.workspaceState.get<Record<string, string>>(TAB_MAP_KEY);
    if (stored) {
      for (const [k, v] of Object.entries(stored)) {
        this.tabKeyMap.set(k, v);
      }
    }
  }

  // ---- caminhos ----

  private lapsoDirUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    return vscode.Uri.joinPath(folder.uri, LAPSO_DIR);
  }

  private noteUriFor(sessionId: string): vscode.Uri | undefined {
    const dir = this.lapsoDirUri();
    if (!dir) {
      return undefined;
    }
    return vscode.Uri.joinPath(dir, `${sessionId}.md`);
  }

  private async readNote(uri: vscode.Uri): Promise<ReadResult> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return { kind: "missing" };
    }
    let raw: string;
    try {
      raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch (e) {
      return { kind: "io", error: String((e as Error)?.message ?? e) };
    }
    const doc = parseZones(raw);
    if (doc.partial) {
      return { kind: "partial" };
    }
    return { kind: "ok", doc, mtime: stat.mtime, size: stat.size };
  }

  // ---- sincronização de aba (serializada + coalescida) ----

  requestSync(): void {
    if (this.syncCoalesceTimer) {
      return;
    }
    this.syncCoalesceTimer = setTimeout(() => {
      this.syncCoalesceTimer = undefined;
      void this.runSync();
    }, config.syncCoalesceMs);
  }

  private async runSync(): Promise<void> {
    if (this.syncRunning) {
      this.syncDirty = true;
      return;
    }
    this.syncRunning = true;
    try {
      do {
        this.syncDirty = false;
        await this.syncActiveTab();
      } while (this.syncDirty);
    } finally {
      this.syncRunning = false;
    }
  }

  // Descobre a sessão da aba de editor ativa e atualiza o painel.
  private async syncActiveTab(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const gen = ++this.generation;
    this.adoptKnownTabs();
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!activeTab) {
      // Sem aba ativa: se já havia sessão, mantém o que está na tela; senão avisa
      // explicitamente (antes o método saía calado e o textarea ficava editável à toa).
      if (!this.currentSessionId) {
        this.postUnresolved("");
      }
      return;
    }
    const title = activeTab.label;
    const isClaude = isClaudeSessionTab(activeTab);

    // Aba comum: nunca mexe na sessão exibida — dá pra editar código sem perder a nota.
    if (!isClaude) {
      if (!this.currentSessionId) {
        this.postUnresolved("");
      }
      return;
    }

    const { sessionId, anyDirReadable, rootReadable } = await this.index.resolve(title);
    if (gen !== this.generation) {
      return; // resultado obsoleto: outra sincronização já assumiu
    }

    if (sessionId) {
      this.rememberTab(activeTab, sessionId);
      this.cancelRetry();
      await this.activateSession(sessionId, title, gen);
      return;
    }

    // Não resolveu. Antes de limpar o painel, tenta a associação estável desta aba:
    // o título só aparece no .jsonl ~1min depois de a sessão nascer, e o rename do
    // ai-title cria a mesma janela de dessincronia sem o usuário ter trocado de aba.
    const sticky = this.tabSessions.get(activeTab) ?? this.stickyByKey(activeTab);
    if (sticky) {
      this.cancelRetry();
      await this.activateSession(sticky, title, gen);
      return;
    }

    if (!anyDirReadable) {
      this.setSession(undefined);
      // Raiz de transcripts existe → é repo novo, ainda sem sessão gravada. Estado
      // normal e transitório: some sozinho quando o Claude Code criar o .jsonl. Antes
      // caía no mesmo alerta de "CLAUDE_CONFIG_DIR invisível" e acusava um problema
      // de configuração que não existia.
      if (rootReadable) {
        this.reportNoSessionsHere();
      } else {
        this.reportNoConfigDir();
      }
      this.scheduleRetry();
      return;
    }

    this.currentTitle = title;
    this.setSession(undefined);
    this.postUnresolved(title);
    // Aba de sessão do Claude sem título ainda: volta a tentar sozinho.
    this.scheduleRetry();
  }

  private async activateSession(sessionId: string, title: string, gen: number): Promise<void> {
    const changed = sessionId !== this.currentSessionId;
    if (changed) {
      // Flush do save pendente da sessão ANTERIOR antes de trocar (o save já carrega
      // o próprio sessionId, então mesmo atrasado grava na sessão certa).
      this.flushPendingSave();
      this.setSession(sessionId);
    }
    this.currentTitle = title;
    this.ensureNoteWatcher();
    this.ensurePoll();
    await this.pushUpdate(gen);
  }

  private setSession(sessionId: string | undefined): void {
    this.currentSessionId = sessionId;
    this.lastSig = "";
    if (!sessionId) {
      this.lastNotes = undefined;
    }
  }

  // Fixa a associação da aba (memória + workspaceState).
  private rememberTab(tab: vscode.Tab, sessionId: string): void {
    this.tabSessions.set(tab, sessionId);
    const key = tabKey(tab);
    if (!key) {
      return;
    }
    if (this.tabKeyMap.get(key) === sessionId) {
      return;
    }
    this.tabKeyMap.set(key, sessionId);
    void this.persistTabMap();
  }

  private stickyByKey(tab: vscode.Tab): string | undefined {
    const key = tabKey(tab);
    return key ? this.tabKeyMap.get(key) : undefined;
  }

  // Reassocia abas de sessão que existem mas nunca foram focadas — sem elas, fechar a
  // aba não deletava a nota e o .lapso/ acumulava órfãos.
  private adoptKnownTabs(): void {
    const groups = vscode.window.tabGroups.all ?? [];
    for (const group of groups) {
      for (const tab of group.tabs ?? []) {
        if (!isClaudeSessionTab(tab) || this.tabSessions.get(tab)) {
          continue;
        }
        const known = this.stickyByKey(tab);
        if (known) {
          this.tabSessions.set(tab, known);
        }
      }
    }
  }

  private async persistTabMap(): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.tabKeyMap) {
      obj[k] = v;
    }
    try {
      await this.context.workspaceState.update(TAB_MAP_KEY, obj);
    } catch {
      /* workspaceState indisponível — o mapa em memória ainda vale nesta janela */
    }
  }

  // ---- retry automático enquanto a aba do Claude não resolve ----

  private scheduleRetry(): void {
    if (this.retryTimer) {
      return;
    }
    const sched = config.retryScheduleMs;
    const delay = sched[Math.min(this.retryStep, sched.length - 1)] ?? 1000;
    this.retryStep++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.requestSync();
    }, delay);
    if (typeof (this.retryTimer as unknown as { unref?: () => void }).unref === "function") {
      (this.retryTimer as unknown as { unref: () => void }).unref();
    }
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retryStep = 0;
  }

  // ---- watchers ----

  // Idempotente e sem dependência de troca de sessão: o watcher cobre a PASTA .lapso
  // inteira, então continua válido quando a sessão muda e sobrevive a create/delete.
  private ensureNoteWatcher(): void {
    if (this.noteWatcher || this.disposed) {
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, `${LAPSO_DIR}/*.md`)
    );
    const onEvent = (uri: vscode.Uri) => {
      const base = uri.fsPath.replace(/\\/g, "/").split("/").pop() ?? "";
      if (this.currentSessionId && base === `${this.currentSessionId}.md`) {
        void this.pushUpdate(this.generation);
      }
    };
    watcher.onDidChange(onEvent);
    watcher.onDidCreate(onEvent);
    watcher.onDidDelete(onEvent);
    this.noteWatcher = watcher;
    this.context.subscriptions.push(watcher);
  }

  // Rede de segurança: se o FileSystemWatcher não entregar (drive de rede, escrita por
  // rename, watcher morto), o poll pega a mudança. Só roda com o painel visível.
  private ensurePoll(): void {
    if (this.pollTimer || this.disposed) {
      return;
    }
    this.pollTimer = setInterval(() => {
      if (!this.view || this.view.visible === false || !this.currentSessionId) {
        return;
      }
      void this.pushUpdate(this.generation);
    }, config.pollIntervalMs);
    if (typeof (this.pollTimer as unknown as { unref?: () => void }).unref === "function") {
      (this.pollTimer as unknown as { unref: () => void }).unref();
    }
  }

  // Observa a pasta de transcripts pra reagir na hora em que o Claude Code grava o
  // título da sessão nova (melhor que esperar o próximo passo do backoff).
  private ensureTranscriptWatchers(): void {
    if (this.transcriptWatchers.length || this.disposed) {
      return;
    }
    for (const dir of sessionsDirCandidates()) {
      try {
        const w = fs.watch(dir, { persistent: false }, (_event, filename) => {
          if (filename && !String(filename).endsWith(".jsonl")) {
            return;
          }
          if (filename) {
            this.index.invalidate(String(filename).replace(/\.jsonl$/, ""));
          }
          if (!this.currentSessionId) {
            this.requestSync();
          }
        });
        w.on("error", () => {
          /* pasta sumiu ou FS não suporta — o backoff continua cobrindo */
        });
        this.transcriptWatchers.push(w);
      } catch {
        /* best-effort: sem watcher, o retry com backoff é o caminho de recuperação */
      }
    }
  }

  private disposeTranscriptWatchers(): void {
    for (const w of this.transcriptWatchers) {
      try {
        w.close();
      } catch {
        /* já fechado */
      }
    }
    this.transcriptWatchers = [];
  }

  // ---- envio pro webview ----

  // Mensagem idêntica à última não é reenviada: o retry com backoff re-avalia a aba a
  // cada passo e, sem isto, re-postaria "sessão não identificada" indefinidamente —
  // repintando o painel (e cancelando animação) sem nada ter mudado.
  private post(message: Record<string, unknown>): void {
    const json = JSON.stringify(message);
    if (json === this.lastPostedJson) {
      return;
    }
    this.lastPostedJson = json;
    this.lastPosted = message;
    this.view?.webview.postMessage(message);
  }

  private postUnresolved(title: string): void {
    this.post({ type: "unresolved", title, sessionId: null });
  }

  private reportNoConfigDir(): void {
    const dirs = this.index.lastTriedDirs;
    const line =
      `[lapso] Não achei o diretório de transcripts do Claude Code. Tentei: ` +
      `${dirs.join(" | ") || "(nenhum candidato — sem workspace?)"}. ` +
      `Verifique se CLAUDE_CONFIG_DIR está visível pro processo do VSCode ` +
      `(a variável precisa existir ANTES de abrir o VSCode; "Reload Window" não relança o processo pai).`;
    // O retry com backoff repassa por aqui a cada passo: sem dedup, o Output enchia de
    // linhas idênticas e o diagnóstico real ficava soterrado.
    if (line !== this.lastNoDirLog) {
      this.lastNoDirLog = line;
      this.output.appendLine(line);
    }
    if (!this.warnedNoDir) {
      this.warnedNoDir = true;
      void vscode.window.showWarningMessage(
        "Lapso: não achei os transcripts do Claude Code (CLAUDE_CONFIG_DIR pode não estar visível pro VSCode). Detalhes em Output → Lapso."
      );
    }
    this.post({ type: "config-missing", dirs, sessionId: null });
  }

  // Sem alerta e sem pop-up: a ausência é esperada até a primeira sessão nascer.
  private reportNoSessionsHere(): void {
    if (!this.loggedNoSessions) {
      this.loggedNoSessions = true;
      this.output.appendLine(
        `[lapso] Nenhuma sessão do Claude Code registrada pra este projeto ainda ` +
          `(esperava ${this.index.lastTriedDirs.join(" | ")}). A pasta nasce com a primeira ` +
          `sessão; o painel volta sozinho quando isso acontecer.`
      );
    }
    this.post({ type: "no-sessions-here", sessionId: null });
  }

  private async pushUpdate(gen: number): Promise<void> {
    if (!this.view || this.disposed) {
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      this.post({ type: "no-workspace", sessionId: null });
      return;
    }
    const sessionId = this.currentSessionId;
    if (!sessionId) {
      this.post({ type: "unresolved", title: this.currentTitle, sessionId: null });
      return;
    }
    const uri = this.noteUriFor(sessionId);
    if (!uri) {
      return;
    }
    const res = await this.readNote(uri);
    // Descarta resultado obsoleto: outra sincronização já trocou a sessão exibida.
    if (gen !== this.generation || sessionId !== this.currentSessionId) {
      return;
    }
    if (res.kind === "partial" || res.kind === "io") {
      // Arquivo pego no meio de uma escrita ou erro transitório de leitura: mantém o
      // último estado bom na tela — nunca pisca pra vazio nem grava por cima.
      if (res.kind === "io") {
        this.output.appendLine(`[lapso] leitura de ${uri.fsPath} falhou: ${res.error}`);
      }
      return;
    }
    const doc = res.kind === "ok" ? res.doc : EMPTY_DOC;
    const sig = res.kind === "ok" ? `${res.mtime}:${res.size}` : "missing";
    if (sig === this.lastSig && this.lastPosted?.type === "update") {
      return; // nada mudou no disco desde o último envio
    }
    this.lastSig = sig;
    this.lastNotes = doc.notes;
    this.post({
      type: "update",
      sessionId,
      status: doc.status,
      notes: doc.notes,
      title: this.currentTitle,
      exists: res.kind === "ok",
    });
  }

  // ---- gravação das notas ----

  // Encadeia por sessão: nenhuma escrita/deleção da mesma nota roda em paralelo.
  private enqueue<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(job, job);
    this.writeChains.set(
      sessionId,
      next.catch(() => undefined)
    );
    return next;
  }

  private async saveNotes(sessionId: string, newNotes: string): Promise<void> {
    if (!sessionId || this.deletedSessions.has(sessionId)) {
      return;
    }
    const dir = this.lapsoDirUri();
    const uri = this.noteUriFor(sessionId);
    if (!dir || !uri) {
      return;
    }
    const job = async (): Promise<void> => {
      if (this.deletedSessions.has(sessionId)) {
        return;
      }
      try {
        await vscode.workspace.fs.createDirectory(dir);
      } catch {
        /* já existe */
      }
      // Compare-and-set: relê imediatamente antes de gravar e refaz se o Claude escreveu
      // o status no meio do caminho (senão a regravação devolvia o status VELHO).
      for (let attempt = 0; attempt < config.saveCasAttempts; attempt++) {
        const before = await this.readNote(uri);
        if (before.kind === "partial") {
          await new Promise((r) => setTimeout(r, 30));
          continue;
        }
        const doc = before.kind === "ok" ? before.doc : EMPTY_DOC;
        const payload = Buffer.from(buildFile(doc, doc.status, newNotes), "utf8");
        const after = await this.readNote(uri);
        if (after.kind === "ok" && before.kind === "ok" && after.doc.status !== before.doc.status) {
          continue; // status mudou durante a preparação — refaz com o novo
        }
        try {
          await vscode.workspace.fs.writeFile(uri, payload);
        } catch (e) {
          // Falha de escrita NUNCA pode derrubar o provider nem marcar a nota como
          // salva: o texto continua "não salvo" e a próxima digitação tenta de novo.
          this.output.appendLine(
            `[lapso] falha ao gravar ${uri.fsPath}: ${String((e as Error)?.message ?? e)}`
          );
          return;
        }
        // Só marca como salvo DEPOIS que a escrita confirmou.
        if (sessionId === this.currentSessionId) {
          this.lastNotes = newNotes;
        }
        return;
      }
      this.output.appendLine(`[lapso] não consegui gravar as notas de ${sessionId} sem conflito.`);
    };
    try {
      await this.enqueue(sessionId, job);
    } catch (e) {
      this.output.appendLine(`[lapso] gravação das notas falhou: ${String((e as Error)?.message ?? e)}`);
    }
  }

  private scheduleSaveNotes(sessionId: string, text: string): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.pendingSave = { sessionId, text };
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = undefined;
      const p = this.pendingSave;
      this.pendingSave = undefined;
      if (p) {
        void this.saveNotes(p.sessionId, p.text);
      }
    }, config.saveDebounceMs);
  }

  // Save pendente é despejado JÁ (não debounced), carregando seu próprio sessionId.
  private flushPendingSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = undefined;
    }
    if (this.pendingSave) {
      const p = this.pendingSave;
      this.pendingSave = undefined;
      void this.saveNotes(p.sessionId, p.text);
    }
  }

  // Último recurso no desligamento: grava sem await, de forma síncrona, pra não perder
  // o que foi digitado nos últimos ~900 ms (debounce do webview + do host).
  private flushPendingSaveSync(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = undefined;
    }
    const p = this.pendingSave;
    this.pendingSave = undefined;
    if (!p || this.deletedSessions.has(p.sessionId)) {
      return;
    }
    const uri = this.noteUriFor(p.sessionId);
    const dir = this.lapsoDirUri();
    if (!uri || !dir) {
      return;
    }
    try {
      let doc = EMPTY_DOC;
      try {
        doc = parseZones(fs.readFileSync(uri.fsPath, "utf8"));
        if (doc.partial) {
          doc = EMPTY_DOC;
        }
      } catch {
        /* não existe ainda */
      }
      fs.mkdirSync(dir.fsPath, { recursive: true });
      fs.writeFileSync(uri.fsPath, buildFile(doc, doc.status, p.text), "utf8");
    } catch {
      /* nada a fazer no shutdown */
    }
  }

  // ---- fechamento de aba ----

  // Ao fechar uma aba de sessão, descarta a nota temporária daquela sessão.
  private async onTabsClosed(closed: readonly vscode.Tab[]): Promise<void> {
    for (const tab of closed) {
      // Usa SÓ a associação estável aba→sessionId (memória ou workspaceState). Nunca
      // re-resolve por texto: título duplicado/truncado apagava a nota de uma sessão VIVA.
      const sessionId = this.tabSessions.get(tab) ?? this.stickyByKey(tab);
      if (!sessionId) {
        continue;
      }
      this.tabSessions.delete(tab);
      const key = tabKey(tab);
      if (key) {
        this.tabKeyMap.delete(key);
        void this.persistTabMap();
      }
      // Cancela um save debounced da mesma sessão — senão ele ressuscitaria a nota
      // depois do delete, e sem associação ela nunca mais seria apagada.
      if (this.pendingSave?.sessionId === sessionId) {
        this.pendingSave = undefined;
        if (this.saveDebounceTimer) {
          clearTimeout(this.saveDebounceTimer);
          this.saveDebounceTimer = undefined;
        }
      }
      this.deletedSessions.add(sessionId);
      const uri = this.noteUriFor(sessionId);
      if (uri) {
        await this.enqueue(sessionId, async () => {
          try {
            await vscode.workspace.fs.delete(uri);
          } catch {
            /* já não existe */
          }
        });
      }
      if (sessionId === this.currentSessionId) {
        this.setSession(undefined);
      }
    }
    await this.runSync();
  }

  // ---- ciclo de vida do webview ----

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const token = ++this.viewToken;
    this.disposed = false;
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      if (message?.command === "ready") {
        // Reenvia o último estado: garante que o painel nunca fica no HTML estático,
        // mesmo se a mensagem anterior tiver saído antes de o script registrar o listener.
        if (this.lastPosted) {
          this.view?.webview.postMessage(this.lastPosted);
        }
        void this.runSync();
      } else if (message?.command === "edit") {
        void vscode.commands.executeCommand("lapso.openNote");
      } else if (message?.command === "saveNotes" && typeof message.text === "string") {
        // Captura o sessionId AGORA (no recebimento), não no disparo do timer; e recusa
        // um save cujo sessionId de origem já não é o exibido (texto de outra sessão).
        const origin = typeof message.sessionId === "string" ? message.sessionId : this.currentSessionId;
        if (!origin || origin !== this.currentSessionId) {
          return;
        }
        if (message.text !== this.lastNotes) {
          this.scheduleSaveNotes(origin, message.text);
        }
      }
    });

    // Reage à troca de aba ativa e ao fechamento de abas.
    const subs: vscode.Disposable[] = [
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        if (e.closed.length) {
          void this.onTabsClosed(e.closed);
        } else {
          this.requestSync();
        }
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.requestSync()),
    ];
    if (typeof webviewView.onDidChangeVisibility === "function") {
      subs.push(
        webviewView.onDidChangeVisibility(() => {
          if (webviewView.visible) {
            void this.runSync();
          }
        })
      );
    }
    this.disposables.push(...subs);

    webviewView.onDidDispose(() => {
      // Um dispose atrasado NÃO pode apagar a view nova (se ele chegar depois de um novo
      // resolveWebviewView, o token já mudou e este handler não é mais o dono).
      if (token !== this.viewToken) {
        return;
      }
      this.disposed = true;
      this.flushPendingSaveSync();
      this.noteWatcher?.dispose();
      this.noteWatcher = undefined;
      this.disposeTranscriptWatchers();
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      this.cancelRetry();
      if (this.syncCoalesceTimer) {
        clearTimeout(this.syncCoalesceTimer);
        this.syncCoalesceTimer = undefined;
      }
      for (const d of subs) {
        d.dispose();
      }
      this.disposables = this.disposables.filter((d) => !subs.includes(d));
      this.view = undefined;
      // ⚠️ currentSessionId é zerado pra que o próximo resolveWebviewView re-arme tudo
      // (watcher, poll) em vez de achar que "já está na sessão certa" e não armar nada.
      this.currentSessionId = undefined;
      this.lastSig = "";
    });

    this.ensureTranscriptWatchers();
    void this.runSync();
  }

  dispose(): void {
    this.disposed = true;
    this.flushPendingSaveSync();
    this.noteWatcher?.dispose();
    this.noteWatcher = undefined;
    this.disposeTranscriptWatchers();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.cancelRetry();
    if (this.syncCoalesceTimer) {
      clearTimeout(this.syncCoalesceTimer);
      this.syncCoalesceTimer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  // Usado pelo comando lapso.openNote — reusa o índice quente do provider em vez de
  // instanciar um frio (que relia todos os transcritos a cada clique em "editar").
  async resolveForCommand(title: string): Promise<string | undefined> {
    const active = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (active && isClaudeSessionTab(active)) {
      const sticky = this.tabSessions.get(active) ?? this.stickyByKey(active);
      if (sticky) {
        return sticky;
      }
    }
    const { sessionId } = await this.index.resolve(title);
    return sessionId;
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 32 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
        Math.floor(Math.random() * 62)
      )
    ).join("");
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  /* Tema Dracula Soft — painel estilo mini-terminal / código */
  html, body { margin: 0; padding: 0; height: 100%; background: #282a36; overflow: hidden; }
  body {
    display: flex; flex-direction: column; box-sizing: border-box; color: #f8f8f2;
    font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, "Courier New", monospace;
    font-size: 12.5px; line-height: 1.6;
  }
  #chrome { display: flex; align-items: center; gap: 7px; padding: 8px 12px; flex: 0 0 auto; background: #21222c; border-bottom: 1px solid #191a21; }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .dot.r { background: #ff5555; } .dot.y { background: #f1fa8c; } .dot.g { background: #50fa7b; }
  #chrome .title { margin-left: 6px; font-size: 11px; color: #f8f8f2; opacity: 0.6; letter-spacing: 0.04em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
  #edit-btn { margin-left: auto; background: none; border: none; cursor: pointer; font-family: inherit; font-size: 11px; color: #6272a4; }
  #edit-btn:hover { color: #bd93f9; }
  #content { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 12px 14px; overflow: hidden; box-sizing: border-box; }
  .cmt { color: #6272a4; flex: 0 0 auto; margin: 0 0 4px 0; }
  .cmt.sp { margin-top: 12px; }
  /* min-height:0 é obrigatório em flex item com scroll próprio: sem isso o item não
     encolhe abaixo do conteúdo, estoura o #content (overflow:hidden) e o fundo some
     sem nenhuma barra de rolagem de resgate. */
  #status { flex: 0 1 auto; min-height: 2.4em; max-height: 60%; overflow-y: auto; white-space: pre-wrap; word-break: break-word; color: #f8f8f2; margin: 0 0 2px 0; }
  #status.empty { color: #6272a4; }
  #notes {
    flex: 1 1 auto; min-height: 0; width: 100%; box-sizing: border-box; resize: none; border: none; outline: none;
    background: transparent; color: #f1fa8c; font-family: inherit; font-size: 12.5px; line-height: 1.6;
    overflow-y: auto; margin-top: 2px; scrollbar-width: thin; scrollbar-color: #44475a transparent;
  }
  #notes:disabled { opacity: 0.75; }
  #notes::placeholder { color: #6272a4; }
  #status::-webkit-scrollbar, #notes::-webkit-scrollbar { width: 8px; }
  #status::-webkit-scrollbar-track, #notes::-webkit-scrollbar-track { background: transparent; }
  #status::-webkit-scrollbar-thumb, #notes::-webkit-scrollbar-thumb { background: #44475a; border-radius: 4px; border: 2px solid transparent; background-clip: content-box; }
  #status::-webkit-scrollbar-thumb:hover, #notes::-webkit-scrollbar-thumb:hover { background: #565971; background-clip: content-box; }
</style>
</head>
<body>
  <div id="chrome">
    <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
    <span class="title" id="title">.lapso</span>
    <button id="edit-btn">editar</button>
  </div>
  <div id="content">
    <div class="cmt">/* status */</div>
    <div id="status" class="empty">// o Claude escreve aqui o que está fazendo</div>
    <div class="cmt sp">/* notas */</div>
    <textarea id="notes" disabled placeholder="// suas anotações"></textarea>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const statusEl = document.getElementById('status');
    const notesEl = document.getElementById('notes');
    const titleEl = document.getElementById('title');
    const STATUS_PLACEHOLDER = '// o Claude escreve aqui o que está fazendo';
    const NOTES_PLACEHOLDER = '// suas anotações';

    document.getElementById('edit-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'edit' });
    });

    let saveTimer = null;
    notesEl.addEventListener('input', () => {
      if (saveTimer) { clearTimeout(saveTimer); }
      saveTimer = setTimeout(() => {
        vscode.postMessage({ command: 'saveNotes', text: notesEl.value, sessionId: renderedSession });
      }, 400);
    });

    let revealToken = 0;
    // Chave do último render: sessão + status. Guardar só o texto fazia o painel ficar
    // PRESO no placeholder — depois de uma passagem por "sessão não identificada" o
    // status voltava igual, a comparação dava "nada mudou" e nada era re-renderizado.
    let renderKey = null;
    let renderedSession = null;
    // Texto ALVO do status (não o que está na tela): a animação revela aos poucos, e
    // persistir o que está na tela salvaria um texto pela metade.
    let lastStatusText = '';
    const MS_PER_CHAR = 4;
    const MAX_DURATION_MS = 1500;

    function typewriterStatus(text) {
      const token = ++revealToken;
      if (text.length === 0) { statusEl.classList.add('empty'); statusEl.textContent = STATUS_PLACEHOLDER; return; }
      statusEl.classList.remove('empty');
      const total = text.length;
      const start = performance.now();
      function tick(now) {
        if (token !== revealToken) { return; }
        const elapsed = now - start;
        const target = elapsed >= MAX_DURATION_MS ? total : Math.min(total, Math.floor(elapsed / MS_PER_CHAR));
        statusEl.textContent = text.slice(0, target);
        statusEl.scrollTop = statusEl.scrollHeight;
        if (target < total) { requestAnimationFrame(tick); }
      }
      requestAnimationFrame(tick);
      setTimeout(() => {
        if (token === revealToken) { statusEl.textContent = text; statusEl.scrollTop = statusEl.scrollHeight; }
      }, MAX_DURATION_MS + 200);
    }

    // Estado neutro: usado por toda mensagem que NÃO é 'update'. Zera a chave de render
    // pra que a volta pra mesma sessão sempre re-desenhe o status.
    function showIdle(title, statusText, isError) {
      renderKey = null;
      renderedSession = null;
      revealToken++;
      notesEl.disabled = true;
      notesEl.value = '';
      titleEl.textContent = title;
      if (isError) {
        statusEl.classList.remove('empty');
        statusEl.textContent = statusText;
        lastStatusText = statusText;
      } else {
        statusEl.classList.add('empty');
        statusEl.textContent = STATUS_PLACEHOLDER;
        lastStatusText = '';
      }
      persist();
    }

    function persist() {
      try {
        vscode.setState({
          html: lastStatusText || STATUS_PLACEHOLDER, empty: statusEl.classList.contains('empty'),
          notes: notesEl.value, disabled: notesEl.disabled, title: titleEl.textContent,
          renderKey: renderKey, session: renderedSession
        });
      } catch (e) { /* setState indisponível */ }
    }

    // Restaura instantaneamente o último render conhecido (reabrir o painel / recarregar
    // a janela mostra o conteúdo na hora, sem esperar o primeiro I/O do host).
    (function restore() {
      let s = null;
      try { s = vscode.getState(); } catch (e) { s = null; }
      if (!s) { return; }
      statusEl.textContent = s.html || STATUS_PLACEHOLDER;
      if (s.empty) { statusEl.classList.add('empty'); } else { statusEl.classList.remove('empty'); }
      notesEl.value = s.notes || '';
      notesEl.disabled = !!s.disabled;
      notesEl.placeholder = s.disabled ? notesEl.placeholder : NOTES_PLACEHOLDER;
      titleEl.textContent = s.title || '.lapso';
      renderKey = s.renderKey || null;
      renderedSession = s.session || null;
      lastStatusText = s.empty ? '' : (s.html || '');
    })();

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message) { return; }
      if (message.type === 'no-workspace') {
        notesEl.placeholder = 'Abra uma pasta/projeto nesta janela.';
        showIdle('.lapso', '', false);
        return;
      }
      if (message.type === 'unresolved') {
        notesEl.placeholder = 'Abra/foque uma aba de sessão do Claude Code.';
        showIdle(message.title || '(sessão não identificada)', '', false);
        return;
      }
      if (message.type === 'no-sessions-here') {
        notesEl.placeholder = 'Nenhuma sessão do Claude Code neste projeto ainda.';
        showIdle('(sem sessão neste projeto)', '', false);
        return;
      }
      if (message.type === 'config-missing') {
        notesEl.placeholder = 'Transcripts do Claude Code não encontrados.';
        showIdle('(transcripts não encontrados)',
          'Não achei os transcripts do Claude Code. CLAUDE_CONFIG_DIR pode não estar visível pro VSCode — veja Output → Lapso.', true);
        return;
      }
      if (message.type === 'update') {
        const sessionChanged = message.sessionId !== renderedSession;
        notesEl.disabled = false;
        notesEl.placeholder = NOTES_PLACEHOLDER;
        titleEl.textContent = message.title || '.lapso';
        const status = message.status || '';
        const key = (message.sessionId || '') + '\\u0000' + status;
        if (key !== renderKey) { typewriterStatus(status); }
        renderKey = key;
        lastStatusText = status;
        // Com o cursor DENTRO do campo, só preserva o que está digitado se continuarmos
        // na MESMA sessão; ao trocar de sessão a substituição é obrigatória, senão o
        // texto da sessão anterior ficaria na tela e seria salvo na sessão nova.
        const typing = document.activeElement === notesEl;
        if (sessionChanged || !typing) { notesEl.value = message.notes || ''; }
        renderedSession = message.sessionId || null;
        persist();
      }
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new LapsoViewProvider(context);
  activeProvider = provider;
  context.subscriptions.push({ dispose: () => provider.dispose() });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("lapsoView", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lapso.openNote", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showInformationMessage("Abra uma pasta/projeto nesta janela.");
        return;
      }
      const active = vscode.window.tabGroups.activeTabGroup?.activeTab;
      if (!isClaudeSessionTab(active)) {
        void vscode.window.showInformationMessage("Foque uma aba de sessão do Claude Code pra abrir a nota dela.");
        return;
      }
      const sessionId = await provider.resolveForCommand(active!.label);
      if (!sessionId) {
        void vscode.window.showInformationMessage("Não consegui identificar a sessão desta aba ainda.");
        return;
      }
      const dir = vscode.Uri.joinPath(folder.uri, LAPSO_DIR);
      const uri = vscode.Uri.joinPath(dir, `${sessionId}.md`);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        try {
          await vscode.workspace.fs.createDirectory(dir);
        } catch {
          /* já existe */
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(buildFile(EMPTY_DOC, "", ""), "utf8"));
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    })
  );
}

let activeProvider: LapsoViewProvider | undefined;

export function deactivate(): void {
  activeProvider?.dispose();
  activeProvider = undefined;
}
