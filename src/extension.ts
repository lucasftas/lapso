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
  // Busca do NOME de uma sessão sem título: varre o arquivo em blocos, do começo, até
  // achar o primeiro prompt. ⚠️ Não dá pra depender da janela da cabeça: medido em
  // 2026-09-12, o primeiro `last-prompt` fica na mediana de 504 KB (máximo 1,1 MB) e um
  // único anexo colado no chat gera linha de 512 KB que consome a janela inteira — foi o
  // que deixou o fallback da v0.4.1 inerte justamente nas sessões com print colado.
  nameScanChunkBytes: 512 * 1024,
  nameScanMaxBytes: 8 * 1024 * 1024,
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

// ⚠️ `.normalize("NFC")` copia o que o Claude Code faz com o próprio diretório de config
// (`(CLAUDE_CONFIG_DIR ?? ~/.claude).normalize("NFC")`): em caminho ASCII não muda nada, mas
// com acento as duas formas Unicode (composta e decomposta) são strings diferentes pro
// `path.join` e o diretório "não existe".
function claudeConfigDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")).normalize("NFC");
}

function claudeProjectsDir(): string {
  return path.join(claudeConfigDir(), "projects");
}

// Registro de sessões VIVAS que o CLI mantém: um `<pid>.json` por sessão, com `sessionId`,
// `cwd` e `entrypoint`. Não é a fonte do título — é o desempate de última hora pra aba que
// ainda não tem título nenhum (ver `liveSessionFor`).
function claudeSessionsRegistryDir(): string {
  return path.join(claudeConfigDir(), "sessions");
}

// Limite e hash do nome de pasta, iguais aos do Claude Code: passando de 200 caracteres
// o nome é cortado e ganha um sufixo de hash pra não colidir com outro caminho longo.
const CWD_DIR_MAX = 200;

// hashCode estilo Java (o mesmo do CLI): e = (e << 5) - e + charCode, em int32.
// ⚠️ Hasheia o caminho ORIGINAL, não o sanitizado.
function hashCwd(fsPath: string): number {
  let acc = 0;
  for (let i = 0; i < fsPath.length; i++) {
    acc = ((acc << 5) - acc + fsPath.charCodeAt(i)) | 0;
  }
  return acc;
}

// Encoding do cwd que o Claude Code usa pro nome da pasta de projeto: TODO caractere
// que não é [a-zA-Z0-9] vira '-'. Ex: c:\projects\_my.repo -> c--projects--my-repo,
// e d:\GitHub\!_features -> d--GitHub---features (o '!' também vira '-').
//
// ⚠️ Extraído do binário do CLI 2.1.269, não deduzido:
//   var j6 = 200;
//   function k(e){ return e.replace(/[^a-zA-Z0-9]/g,"-") }
//   function cC(e){ let n=k(e); if(n.length<=j6) return n; return `${n.slice(0,j6)}-${Le(e)}` }
// Antes esta função trocava só [:\\/._] — o que coincide com o resultado da regra real em
// caminho "limpo" e divergia calado em qualquer outro caractere. Medido em 2026-09-12
// nos transcripts reais: 5 de 64 projetos ficavam invisíveis pro painel, todos com '!'
// no caminho (`!_features`, `!_me`, `!_scale-v2`, …) — a sessão existia, o transcript
// existia, e o Lapso procurava numa pasta que nunca existiu.
export function encodeCwd(fsPath: string): string {
  const nome = fsPath.replace(/[^a-zA-Z0-9]/g, "-");
  if (nome.length <= CWD_DIR_MAX) {
    return nome;
  }
  return `${nome.slice(0, CWD_DIR_MAX)}-${Math.abs(hashCwd(fsPath)).toString(36)}`;
}

// Encoding de versões ANTIGAS do Claude Code, que preservavam tudo fora de [:\/._] —
// inclusive espaço, '!' e caractere não-latino. As pastas criadas naquela época seguem
// no disco com transcripts dentro, então continuam sendo candidatas: em caminho limpo o
// resultado é idêntico ao atual (e a dedup abaixo descarta), e só em caminho com
// caractere especial nascem duas pastas — a nova e a histórica.
export function encodeCwdLegado(fsPath: string): string {
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
  // Override explícito do nome da pasta, honrado pelo Claude Code antes de qualquer
  // encoding (`CLAUDE_CODE_PROJECT_DIR_NAME ?? encode(cwd)`). Quem usa isso quebraria o
  // painel do mesmo jeito que o caractere especial quebrava.
  const override = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  if (override) {
    const dir = path.join(projects, override);
    seen.add(process.platform === "win32" ? dir.toLowerCase() : dir);
    out.push(dir);
  }
  // Regra atual primeiro: é onde a sessão de hoje grava. O legado entra depois, como
  // fallback pra projeto que só tem pasta antiga.
  for (const encode of [encodeCwd, encodeCwdLegado]) {
    for (const v of variants) {
      const dir = path.join(projects, encode(v));
      const key = process.platform === "win32" ? dir.toLowerCase() : dir;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(dir);
    }
  }
  return out;
}

// Label que o webview oficial usa quando a sessão ainda não tem título: `título || "Claude
// Code"`. Não identifica nada — toda aba fresca da janela mostra este mesmo texto.
const LABEL_GENERICO = "claude code";

// ⚠️ Compara em minúsculas porque `normalizeTitle` só faz trim + NFC (o casamento de
// título é sensível a caixa de propósito). Sem isto a checagem nunca disparava — pego
// pelos asserts [X1]/[Y1] da suíte `plugin-mudou`.
export function ehLabelGenerico(titleNormalizado: string): boolean {
  return titleNormalizado.trim().toLowerCase() === LABEL_GENERICO;
}

// Nomes que o Claude Code reserva dentro da pasta de projeto — não são sessões. O CLI
// passou a guardar `timeline.jsonl` no nível do projeto, além de `.dir-sync.json`,
// `.ccr-tip.json`, `bridge-pointer.json` e `.session-aliases` (estes não terminam em
// `.jsonl`, então já caem fora), e os transcripts de subagente/workflow vivem em subpasta
// por sessão (invisíveis pro `readdir` não-recursivo, que é o comportamento certo).
//
// ⚠️ Sem este filtro, `timeline.jsonl` entraria no índice como se "timeline" fosse um
// sessionId: pagaria stat + leitura em toda varredura e, pior, o nome de fallback lido dele
// poderia casar com o label de uma aba — o painel passaria a escrever `.lapso/timeline.md`.
// Preferi rejeitar nomes conhecidos a exigir formato UUID: o formato do sessionId é do CLI
// e pode mudar, e um filtro por formato descartaria sessão de verdade calado.
const NOMES_RESERVADOS = new Set([
  "timeline",
  "journal",
  "history",
  "bridge-pointer",
  "session-aliases",
  "tiny_memory",
]);

export function ehTranscriptDeSessao(nome: string): boolean {
  return !!nome && !NOMES_RESERVADOS.has(nome.toLowerCase());
}

interface SessaoViva {
  sessionId: string;
  cwd: string;
  entrypoint?: string;
  updatedAt?: number;
  startedAt?: number;
}

// Último recurso pra aba que mostra só `"Claude Code"`: o CLI mantém um `<pid>.json` por
// sessão em `<CLAUDE_CONFIG_DIR>/sessions/`, com `sessionId`, `cwd` e `entrypoint`. Se este
// workspace tem EXATAMENTE UMA sessão aberta pelo VSCode, ela é a da aba — não há o que
// desambiguar. Com duas ou mais, desiste: chutar trocaria a nota de lugar.
//
// ⚠️ Isto é observação de um arquivo interno do CLI, não uma API: a extensão oficial não
// lê nem escreve esses campos. Por isso entra só DEPOIS de título e associação de aba, e
// exige que o transcript da sessão exista de fato numa das pastas candidatas.
export async function liveSessionFor(cwdWorkspace: string, idsNoDisco: Set<string>): Promise<string | undefined> {
  let nomes: string[];
  try {
    nomes = await fsp.readdir(claudeSessionsRegistryDir());
  } catch {
    return undefined; // registro não existe nesta versão do CLI
  }
  const alvo = normalizaCaminho(cwdWorkspace);
  const achados: SessaoViva[] = [];
  for (const nome of nomes) {
    if (!nome.endsWith(".json")) {
      continue;
    }
    let dados: SessaoViva;
    try {
      dados = JSON.parse(await fsp.readFile(path.join(claudeSessionsRegistryDir(), nome), "utf8"));
    } catch {
      continue; // arquivo pego no meio de uma escrita
    }
    if (!dados?.sessionId || !dados.cwd || normalizaCaminho(dados.cwd) !== alvo) {
      continue;
    }
    // Sessão de CLI puro não tem aba no editor — só as abertas pelo VSCode disputam.
    if (dados.entrypoint && dados.entrypoint !== "claude-vscode") {
      continue;
    }
    if (!idsNoDisco.has(dados.sessionId)) {
      continue;
    }
    achados.push(dados);
  }
  return achados.length === 1 ? achados[0].sessionId : undefined;
}

// Comparação de caminho tolerante ao que varia entre as duas pontas: o registro do CLI
// grava `d:\GitHub\…` e o VSCode entrega `D:\GitHub\…`.
function normalizaCaminho(p: string): string {
  return p.replace(/[\\/]+$/, "").replace(/\\/g, "/").normalize("NFC").toLowerCase();
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

// Texto que o VSCode NÃO usa pra nomear a aba: envelopes de ferramenta, avisos do
// sistema e contexto injetado por hook chegam como mensagem de papel "user" e
// atropelariam o primeiro prompt de verdade.
//
// A terceira alternativa cobre o resumo de compactação, que é a PRIMEIRA entrada de papel
// "user" numa sessão nascida de `/compact` ou de retomada. Medido em 2026-09-12 nos 40
// transcripts mais recentes: ele chega como `content` string (sem `<`, sem `Caveat:`) e por
// isso passava pelos dois primeiros padrões — viraria o nome da sessão.
const NAO_E_PROMPT = /^(<|Caveat:|\[Request interrupted|This session is being continued from a previous conversation)/;

// Entrada de transcript que existe só pra contexto e não é prompt digitado. ⚠️
// `isVisibleInTranscript` era o campo até meados de 2026 e ZEROU: nos 40 transcripts mais
// recentes ele tem 0 ocorrência, e quem marca o resumo de compactação agora é
// `isVisibleInTranscriptOnly` / `isCompactSummary` (6 ocorrências cada, sempre no mesmo
// envelope). O campo velho fica na checagem porque transcript antigo no disco ainda o traz.
function ehEnvelope(entrada: {
  isMeta?: boolean;
  isVisibleInTranscript?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  isCompactSummary?: boolean;
}): boolean {
  return !!(
    entrada.isMeta ||
    entrada.isVisibleInTranscript === false ||
    entrada.isVisibleInTranscriptOnly ||
    entrada.isCompactSummary
  );
}

// Nome da sessão pela entrada `last-prompt`, que o Claude Code passou a gravar a cada
// prompt: `{"type":"last-prompt","lastPrompt":"…","leafUuid":"…"}`. A PRIMEIRA do arquivo é
// o primeiro prompt, já limpo — sem envelope de ferramenta, sem tool_result, sem imagem.
// Medido em 2026-09-12: bate com o primeiro prompt em 6 de 6 sessões conferidas, e são
// 2.501 ocorrências nos 40 transcripts mais recentes. Por ser mais barato e mais robusto que
// remontar o prompt a partir das entradas `user`, tem prioridade sobre `scanFirstPrompt`.
const LAST_PROMPT = /"lastPrompt":"((?:[^"\\]|\\.)*)"/;

export function scanLastPrompt(chunk: string): string {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.includes('"type":"last-prompt"')) {
      continue;
    }
    const m = line.match(LAST_PROMPT);
    if (!m) {
      continue;
    }
    const texto = decodeJsonString(m[1]).trim();
    if (!texto || NAO_E_PROMPT.test(texto)) {
      continue;
    }
    // Uma linha só: a aba nunca mostra quebra.
    return texto.split(/\r?\n/)[0].trim();
  }
  return "";
}

// Último recurso pra nomear uma sessão: o PRIMEIRO PROMPT do usuário.
//
// ⚠️ Por que existe: o `transcriptNoTitle` dos testes documenta "~65 s até o Claude Code
// gravar o ai-title", e o índice inteiro depende desse registro pra casar a aba. Medido em
// 2026-08-29: sessões novas ficaram HORAS sem `ai-title` nenhum (zero ocorrência de
// `"type":"ai-title"` no .jsonl), e sem título o painel nunca resolve — a mensagem
// "não consegui identificar a sessão desta aba ainda" some só quando o registro aparece,
// e ele pode não aparecer nunca. O primeiro prompt não tem esse problema: é gravado na
// primeira troca e é EXATAMENTE de onde o Claude Code tira o nome da aba (conferido nas
// sessões reais: prompt "bora2" → aba "bora2"), então casa pela régua que já existe,
// inclusive truncado (`titleMatches`).
//
// Só entra quando não há `custom-title` nem `ai-title`; assim que um deles é gravado, ele
// assume — o Claude Code renomeia a aba no mesmo movimento, e as duas pontas seguem juntas.
export function scanFirstPrompt(chunk: string): string {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.includes('"type":"user"')) {
      continue;
    }
    let entrada: {
      isMeta?: boolean;
      isVisibleInTranscript?: boolean;
      isVisibleInTranscriptOnly?: boolean;
      isCompactSummary?: boolean;
      message?: { content?: unknown };
    };
    try {
      entrada = JSON.parse(line);
    } catch {
      continue; // linha cortada ao meio pela janela de leitura
    }
    if (ehEnvelope(entrada)) {
      continue;
    }
    const conteudo = entrada.message?.content;
    let texto = "";
    if (typeof conteudo === "string") {
      texto = conteudo;
    } else if (Array.isArray(conteudo)) {
      for (const bloco of conteudo) {
        if (bloco && typeof bloco === "object" && (bloco as { type?: string }).type === "text") {
          texto = String((bloco as { text?: string }).text ?? "");
          break;
        }
      }
    }
    texto = texto.trim();
    if (!texto || NAO_E_PROMPT.test(texto)) {
      continue;
    }
    // Uma linha só: a aba nunca mostra quebra, e o label é o começo do prompt.
    return texto.split(/\r?\n/)[0].trim();
  }
  return "";
}

// Nome de uma sessão SEM título, na ordem do mais confiável pro mais frágil: a entrada
// `last-prompt` (já limpa, gravada pelo Claude Code) e, se ela não existir naquele pedaço,
// a remontagem a partir das entradas `user` — que é o caminho de transcript mais antigo.
function nomeSemTitulo(chunk: string): string {
  return scanLastPrompt(chunk) || scanFirstPrompt(chunk);
}

// Varre o transcript em blocos, do começo (ou de onde uma varredura anterior parou), até
// achar o nome ou bater o teto. Devolve também até onde leu, pra sessão viva sem título
// não revarrer o mesmo trecho a cada sincronização.
//
// A costura entre blocos guarda a sobra da última linha incompleta; linha maior que um
// bloco inteiro (anexo, imagem colada) é descartada — nunca é prompt nem `last-prompt`,
// e acumulá-la só faria a memória crescer.
async function buscarNomeEmBlocos(
  file: string,
  size: number,
  de: number
): Promise<{ nome: string; varridoAte: number }> {
  const teto = Math.min(size, config.nameScanMaxBytes);
  let pos = Math.max(0, de);
  let sobra = "";
  while (pos < teto) {
    const len = Math.min(config.nameScanChunkBytes, teto - pos);
    const bruto = sobra + (await readWindow(file, pos, len));
    pos += len;
    const ultimaQuebra = bruto.lastIndexOf("\n");
    const completo = ultimaQuebra === -1 ? "" : bruto.slice(0, ultimaQuebra);
    sobra = ultimaQuebra === -1 ? bruto : bruto.slice(ultimaQuebra + 1);
    if (sobra.length > config.nameScanChunkBytes) {
      sobra = ""; // linha gigante: segue em frente em vez de acumular
    }
    const nome = nomeSemTitulo(completo);
    if (nome) {
      return { nome, varridoAte: pos };
    }
  }
  return { nome: "", varridoAte: pos };
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
  // Primeiro prompt do usuário — fallback de nome quando o transcript não tem título
  // nenhum. Fica no cache porque mora na CABEÇA do arquivo: sem guardar, a sessão viva
  // (que só cresce na cauda) releria a cabeça a cada sincronização.
  first?: string;
  // Até onde a busca do nome já varreu. Sem isto, sessão sem título e sem prompt (ou com
  // o prompt além do teto) revarreria megabytes a cada sincronização.
  nameScannedTo?: number;
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
    let first = cached?.first ?? "";
    let nameScannedTo = cached?.nameScannedTo ?? 0;
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
        const conteudo = await readWindow(file, 0, stat.size);
        const found = scanTitles(conteudo);
        ai = found.ai;
        custom = found.custom;
        first = nomeSemTitulo(conteudo);
      } else {
        // Duas janelas de tamanho fixo, independentes do tamanho do arquivo: a cabeça
        // (ai-title original, gravado nas primeiras trocas) e a cauda (renomeação e
        // custom-title, que são sempre entradas posteriores). A cauda tem prioridade.
        const cabeca = await readWindow(file, 0, Math.min(config.headWindowBytes, stat.size));
        const head = scanTitles(cabeca);
        const tailFrom = Math.max(0, stat.size - config.tailWindowBytes);
        const tail = scanTitles(await readWindow(file, tailFrom, stat.size - tailFrom));
        ai = tail.ai || head.ai;
        custom = tail.custom || head.custom;
        // O primeiro prompt está na cabeça por definição — a janela já lida basta.
        first = first || nomeSemTitulo(cabeca);
        if (!ai && !custom && stat.size <= config.hugeReadMaxBytes) {
          const whole = scanTitles(await readWindow(file, 0, stat.size));
          ai = whole.ai;
          custom = whole.custom;
        }
      }
      // Sessão anônima chegando pelo caminho incremental (só a cauda foi lida) ou vinda
      // de um cache gravado por versão anterior, que não tinha o campo: o primeiro prompt
      // mora na cabeça e precisa de uma leitura própria. Custo pago só enquanto não
      // existe título nenhum — assim que o Claude Code grava um, este ramo morre.
      // Sessão sem título nenhum: aí sim vale varrer o arquivo em blocos atrás do nome —
      // a janela fixa da cabeça não serve (uma imagem colada no chat vira uma linha de
      // 512 KB e come a janela inteira, empurrando o prompt pra fora). A varredura anda
      // do ponto onde a anterior parou, então a sessão viva não paga isso de novo.
      if (!ai && !custom && !first && nameScannedTo < stat.size) {
        const achado = await buscarNomeEmBlocos(file, stat.size, nameScannedTo);
        first = achado.nome;
        nameScannedTo = achado.varridoAte;
      }
    } catch {
      return cached?.title;
    }

    // Precedência: o nome que o Lucas deu vence o que a IA gerou, que vence o primeiro
    // prompt. O fallback nunca disputa com um título de verdade — só evita que a sessão
    // fique anônima e o painel sem dono.
    const title = decodeJsonString(custom || ai) || first;
    this.touch(sessionId, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ai,
      custom,
      first,
      nameScannedTo,
      title,
    });
    return title;
  }

  // sessionIds que existem de fato nas pastas candidatas deste workspace. Usado pra
  // conferir o palpite do registro de sessões vivas antes de confiar nele.
  async sessionIdsOnDisk(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const dir of sessionsDirCandidates()) {
      let nomes: string[];
      try {
        nomes = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const n of nomes) {
        if (!n.endsWith(".jsonl")) {
          continue;
        }
        const id = n.slice(0, -".jsonl".length);
        if (ehTranscriptDeSessao(id)) {
          out.add(id);
        }
      }
    }
    return out;
  }

  // Dado o título da aba ativa, acha o sessionId correspondente.
  // Estratégia: primeiro tenta casar contra os títulos JÁ em cache (custo zero de I/O,
  // confirmando só o arquivo vencedor); só então varre os desconhecidos, do mais recente
  // pro mais antigo, saindo no primeiro match exato.
  async resolve(activeTitle: string): Promise<ResolveResult> {
    const want = normalizeTitle(activeTitle);
    const candidates = sessionsDirCandidates();
    this.lastTriedDirs = candidates;
    // Aba sem título nenhum mostra o label genérico `"Claude Code"` (é o literal do
    // webview oficial: `título || "Claude Code"`) — e TODA aba fresca mostra o mesmo.
    // Casar por esse texto é pior que não casar: pegaria qualquer sessão cujo título
    // comece com "Claude Code" e, pior, o índice gravaria essa associação como se fosse
    // identidade da aba. Quem resolve esse caso é `liveSessionFor`, por `cwd`.
    if (!want || ehLabelGenerico(want)) {
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
      const ids = names
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => n.slice(0, -".jsonl".length))
        .filter(ehTranscriptDeSessao);

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
  // Aba sem título ainda mostra o label genérico `"Claude Code"`, igual em todas — usar
  // isso como identidade textual faria duas abas frescas compartilharem a mesma chave, e
  // a nota de uma apareceria (ou seria apagada) no lugar da outra. Nesse estado sobra o
  // WeakMap por objeto de aba, que é identidade de verdade.
  if (ehLabelGenerico(normalizeTitle(tab.label))) {
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

  private requestUriFor(sessionId: string): vscode.Uri | undefined {
    const dir = this.lapsoDirUri();
    if (!dir) {
      return undefined;
    }
    return vscode.Uri.joinPath(dir, `${sessionId}.request`);
  }

  // Pedido de status (botão do rodapé): grava um arquivo-flag que um hook do Claude
  // Code (PostToolUse/Stop) consome — a sessão dona do sessionId atualiza a própria
  // nota ao vê-lo. O watcher do painel observa só *.md, então o .request não re-renderiza.
  private async writeStatusRequest(sessionId: string): Promise<void> {
    const dir = this.lapsoDirUri();
    const uri = this.requestUriFor(sessionId);
    if (!dir || !uri) {
      return;
    }
    await this.enqueue(sessionId, async () => {
      if (this.deletedSessions.has(sessionId)) {
        return;
      }
      try {
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(new Date().toISOString() + "\n", "utf8"));
      } catch (e) {
        this.output.appendLine(
          `[lapso] falha ao gravar pedido de status: ${String((e as Error)?.message ?? e)}`
        );
      }
    });
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

    // Aba que mostra só "Claude Code": não há texto pra casar, mas o registro de sessões
    // do CLI diz quais sessões estão abertas neste workspace. Uma só → é esta aba.
    if (anyDirReadable && ehLabelGenerico(normalizeTitle(title))) {
      const viva = await this.resolveByLiveSession();
      if (gen !== this.generation) {
        return;
      }
      if (viva) {
        // Só o WeakMap da aba — a chave textual "Claude Code" é ambígua de propósito
        // (`tabKey` devolve undefined nela), então nada é persistido.
        this.tabSessions.set(activeTab, viva);
        this.cancelRetry();
        await this.activateSession(viva, title, gen);
        return;
      }
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

  // Consulta o registro de sessões vivas do CLI e confirma contra os transcripts que
  // existem neste workspace. Devolve undefined se houver ambiguidade — chutar entre duas
  // sessões abertas trocaria a nota de lugar, que é o pior defeito possível aqui.
  private async resolveByLiveSession(): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    try {
      const ids = await this.index.sessionIdsOnDisk();
      const achado = await liveSessionFor(folder.uri.fsPath, ids);
      if (achado) {
        this.output.appendLine(
          `[lapso] aba sem título ainda: resolvida pelo registro de sessões vivas do CLI (${achado}).`
        );
      }
      return achado;
    } catch {
      return undefined;
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
      const reqUri = this.requestUriFor(sessionId);
      if (uri) {
        await this.enqueue(sessionId, async () => {
          try {
            await vscode.workspace.fs.delete(uri);
          } catch {
            /* já não existe */
          }
          // O pedido de status pendente morre junto com a sessão — flag órfão nunca fica.
          if (reqUri) {
            try {
              await vscode.workspace.fs.delete(reqUri);
            } catch {
              /* já não existe */
            }
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
      } else if (message?.command === "requestStatus" && typeof message.sessionId === "string") {
        // Mesmo guard do save: só aceita pedido da sessão exibida (um clique atrasado
        // depois da troca de aba não pode pedir status em nome de outra sessão).
        if (message.sessionId === this.currentSessionId && !this.deletedSessions.has(message.sessionId)) {
          void this.writeStatusRequest(message.sessionId);
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
  #req-footer { flex: 0 0 auto; text-align: center; padding: 5px 0 6px; cursor: pointer; user-select: none;
                font-size: 11px; color: #6272a4; background: #21222c; border-top: 1px solid #191a21; }
  #req-footer:hover { color: #bd93f9; background: #23242f; }
  #req-footer.hidden { display: none; }
  #req-footer.waiting { color: #f1fa8c; cursor: default; animation: req-pulse 1.2s ease-in-out infinite; }
  #req-footer.done { color: #50fa7b; cursor: default; }
  @keyframes req-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
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
  <div id="req-footer" class="hidden">⟳ pedir status à sessão</div>
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

    // Botão "pedir status" (rodapé): grava um pedido em .lapso/<sessionId>.request via
    // host; um hook do Claude Code (PostToolUse/Stop) consome o arquivo e a PRÓPRIA
    // sessão atualiza a nota no meio do turno. O botão só pede e dá feedback — quem
    // responde é a sessão (o painel atualiza pelo watcher normal quando ela escrever).
    const reqEl = document.getElementById('req-footer');
    const REQ_IDLE = '⟳ pedir status à sessão';
    const REQ_WAITING = '⏳ pedido enviado — aguardando a sessão…';
    const REQ_DONE = '✓ status atualizado agora';
    const REQ_TIMEOUT_TEXT = '⚠ sem resposta — sessão parada? peça no chat';
    const REQ_TIMEOUT_MS = 90000;
    const REQ_DONE_MS = 4000;
    let reqState = 'idle';
    let reqSession = null;
    let reqTimer = null;
    function reqSet(state, text) {
      reqState = state;
      reqEl.classList.remove('waiting');
      reqEl.classList.remove('done');
      if (state !== 'idle') { reqEl.classList.add(state); }
      reqEl.textContent = text;
    }
    function reqClearTimer() {
      if (reqTimer) { clearTimeout(reqTimer); reqTimer = null; }
    }
    function reqReset() { reqClearTimer(); reqSession = null; reqSet('idle', REQ_IDLE); }
    reqEl.addEventListener('click', () => {
      if (reqState === 'waiting' || !renderedSession) { return; }
      vscode.postMessage({ command: 'requestStatus', sessionId: renderedSession });
      reqSession = renderedSession;
      reqClearTimer();
      reqSet('waiting', REQ_WAITING);
      reqTimer = setTimeout(() => {
        if (reqState === 'waiting') { reqSession = null; reqSet('idle', REQ_TIMEOUT_TEXT); }
      }, REQ_TIMEOUT_MS);
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
      reqReset();
      reqEl.classList.add('hidden');
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
        reqEl.classList.remove('hidden');
        // Trocou de sessão exibida → o feedback visual do pedido anterior não vale mais
        // (o arquivo-flag continua no disco e o hook consome de qualquer forma).
        if (sessionChanged && reqState !== 'idle') { reqReset(); }
        const status = message.status || '';
        const key = (message.sessionId || '') + '\\u0000' + status;
        if (key !== renderKey) {
          typewriterStatus(status);
          if (reqState === 'waiting' && message.sessionId === reqSession) {
            reqClearTimer();
            reqSession = null;
            reqSet('done', REQ_DONE);
            reqTimer = setTimeout(() => { if (reqState === 'done') { reqReset(); } }, REQ_DONE_MS);
          }
        }
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
