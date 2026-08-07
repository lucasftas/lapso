# PRD — Lapso (repo: notes-session-vscode, hoje lapso)

> Nota de processo: este PRD foi escrito **retroativamente** — o projeto nasceu de um spike interativo (testado ao vivo antes de documentar) em vez do fluxo `bora → bora1` estrito. Decisões abaixo refletem o que foi de fato construído e testado, não hipóteses.

## Objetivo
Post-it por janela/sessão do VSCode: um painel dockado que mostra uma nota (`LAPSO.md`) do workspace daquela janela, editável à mão ou pelo Claude Code, atualizando em tempo real.

> ⚠️ **Evoluiu desde o v0.1.0** (este PRD congela o MVP). Modelo atual (desde a v0.2.0; e desde a v0.3.1 sem container próprio na Activity Bar — a view mora dentro da aba do Claude Code, container `claude-sessions-sidebar`): a nota é **por sessão do Claude Code**, não por janela — o painel segue a **aba de sessão em destaque**, resolve título da aba → `sessionId` pelos transcripts `.jsonl`, e usa `.lapso/<sessionId>.md` (gitignored, apagado quando a aba fecha). `LAPSO.md` na raiz não existe mais. Ver `README.md` pro comportamento vigente.

## Escopo do MVP (v0.1.0)
- Ícone próprio na Activity Bar com painel (`WebviewView`).
- Painel em branco quando `LAPSO.md` não existe — **não** cria arquivo com template automático.
- Campo de texto editável direto no painel: digitar salva no `LAPSO.md` (debounced, 400ms), criando o arquivo na primeira escrita.
- Atualiza o painel em tempo real (efeito de máquina de escrever) quando o `.md` muda por fora (edição manual em editor normal, ou escrita externa do Claude Code) — só quando o painel não está com foco (não interrompe quem está digitando nele).
- Botão "editar" abre o `.md` num editor de texto normal (útil pra edição com recursos completos do editor).
- Cada janela do VSCode mostra a nota do **seu próprio** workspace, automaticamente (sem lógica de detecção de sessão — é grátis por design, cada janela roda sua própria instância de extensão).

## Fora de escopo (v0.1.0)
- Renderização rica de markdown no painel (removido — v0.1.0 inicial tinha `#`/`**negrito**`/listas renderizados, mas a prioridade virou edição direta em texto simples; ver decisão em `Riscos e incógnitas`).
- Posicionamento forçado na secondary side bar (VSCode não expõe API pública pra isso — é um arraste manual do usuário, uma vez).
- Sincronização de nota entre múltiplos workspaces/máquinas.
- Autenticação/permissões — é local, single-user.

## Decisões técnicas
- **Stack**: TypeScript + VSCode Extension API (`@types/vscode` ^1.90.0).
- **Interface**: WebviewView dockada (Activity Bar → Sidebar).
- **Persistência**: arquivo texto (`LAPSO.md`) por workspace, via `vscode.workspace.fs`.
- **SO/hardware alvo**: qualquer SO que rode VSCode Desktop (extensão não usa API nativa de SO).

## Arquitetura
**Modelo:** Direta (interface única).

Interface única (webview dentro da própria extensão), sem separação Core/Interfaces — módulo único (`src/extension.ts`) é pequeno o bastante (renderer markdown-ish + provider + activation) pra não justificar split Core/Interfaces.

## Arquivos da codebase relevantes
- `src/extension.ts` — toda a lógica: `LapsoViewProvider` (webview), renderer markdown-ish, comando `lapso.openNote`, `activate`/`deactivate`.
- `package.json` — contribution points (`viewsContainers`, `views`, `commands`).
- `resources/icon.svg` — ícone da Activity Bar.

## Padrões internos a seguir
- n/a — repo novo, sem convenção prévia do Lucas pra extensões VSCode.

## Docs externas (resumo)
### VSCode Extension API — Webview Views
- URL: https://code.visualstudio.com/api/extension-guides/webview
- Uso: `vscode.window.registerWebviewViewProvider`, `resolveWebviewView`, `postMessage`/`onDidReceiveMessage` pra comunicação extension↔webview.

### VSCode Extension API — Sidebars / Secondary Side Bar
- URL: https://code.visualstudio.com/api/ux-guidelines/sidebars
- Achado da pesquisa: não existe contribution point público pra forçar um view container na secondary side bar por padrão — é sempre posicionamento inicial na Activity Bar/Primary Sidebar, e o usuário arrasta pra secondary side bar manualmente (persistido depois). Documentado no README como passo único de setup.

## Code snippets de referência
```ts
// resolveWebviewView — registro básico (código próprio, src/extension.ts)
resolveWebviewView(webviewView: vscode.WebviewView): void {
  webviewView.webview.options = { enableScripts: true };
  webviewView.webview.html = this.buildHtml();
  webviewView.webview.onDidReceiveMessage((message) => { /* ... */ });
}
```

## Riscos e incógnitas
- **Premissa crítica**: "dá pra ter um painel que gruda numa borda da janela do VSCode, acompanha a janela e troca sozinho por sessão/workspace, sem hack de SO." — **VALIDADA**: testado ao vivo (screenshot real do desktop) — painel abriu, renderizou, e atualizou em tempo real ao editar o `.md` externamente.
- **Pre-mortem (causas de falha)**:
  1. API não permite forçar posicionamento inicial na secondary side bar → mitigado (arraste manual de 1x, documentado no README).
  2. ~~Webview injetava HTML derivado do `.md` via `innerHTML`~~ — **resolvido por mudança de escopo**: v0.1.0 pivotou de renderização rica (HTML via `innerHTML`) pra edição direta em `<textarea>` (decisão do Lucas: painel em branco + digitar cria o arquivo). `textarea.value` nunca interpreta o conteúdo como markup, então essa superfície de risco de injeção deixou de existir — bônus de segurança do pivot, não motivo dele.
  3. Não testado com múltiplas janelas simultâneas com watchers ativos ao mesmo tempo (esperado que funcione, já que cada janela = instância isolada, mas sem teste de carga).
