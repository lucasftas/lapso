# Lapso

[![Testes](https://github.com/lucasftas/lapso/actions/workflows/test.yml/badge.svg)](https://github.com/lucasftas/lapso/actions/workflows/test.yml)

Post-it **por sessão do Claude Code**: um painel dockado que mostra a nota da aba de sessão em destaque. Troca de aba → troca a nota. Temporária e descartável (some quando a aba fecha).

> Nome do repositório no GitHub: `notes-session-vscode` (histórico) → renomeado pra `lapso`. Nome do produto/extensão: **Lapso**.

## Como funciona

- A extensão contribui um `WebviewView` **dentro da aba do Claude Code** (a lista de sessões na Activity Bar): o Lapso aparece como acordeon **"Lapso — Nota da sessão"** embaixo da lista, no padrão dos acordeons do Explorador. Tema Dracula Soft estilo mini-terminal. (Requer a extensão [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) instalada — sem ela o painel não tem onde aparecer.)
- **Uma nota por sessão do Claude Code**, em `.lapso/<sessionId>.md` (pasta `.lapso/` no `.gitignore` — temporária, não versiona).
- **Segue a aba em destaque**: quando você foca uma aba de sessão do Claude Code, o painel resolve qual sessão é (casa o título da aba com o `sessionId` lendo os transcripts `.jsonl` do Claude Code) e mostra a nota daquela sessão. Troca de aba → troca a nota.
- **Casamento preciso por ID**: o Claude escreve o status em `.lapso/<seu-sessionId>.md` (ele conhece o próprio sessionId); a extensão resolve aba→sessionId pelo título. Convergem no mesmo arquivo, sem chute.
- **Descartável**: ao fechar a aba de uma sessão, a extensão apaga a nota `.lapso/<sessionId>.md` dela.
- O painel tem **duas zonas** no mesmo arquivo, por marcador HTML:
  - **Status** (topo, read-only) — território do Claude Code, efeito de máquina de escrever. Entre `<!-- lapso:status -->` e `<!-- /lapso:status -->`.
  - **Suas notas** (baixo, editável) — só você mexe. Entre `<!-- lapso:notes -->` e `<!-- /lapso:notes -->`.
- **Não-sobrescrever, por design**: cada zona salva relendo a outra do disco e recombinando → o Claude nunca apaga suas notas e você nunca apaga o status dele.
- Scroll contido no campo, barra estilizada.
- Requer `CLAUDE_CONFIG_DIR` (ou `~/.claude`) acessível — é de lá que a extensão lê os transcripts pra casar aba→sessão.
- **Projeto ainda sem sessão** (a pasta de transcripts dele só nasce com a primeira sessão): o painel mostra `(sem sessão neste projeto)` em cinza, sem alerta — e volta sozinho assim que a sessão começa. O aviso de configuração só aparece quando a raiz de transcripts realmente não existe.

## Instalar

### Do Marketplace (recomendado)

Publicada como [`lucasftas.lapso`](https://marketplace.visualstudio.com/items?itemName=lucasftas.lapso) — instala num comando e o **Settings Sync** replica em toda máquina logada na mesma conta do VSCode:

```bash
code --install-extension lucasftas.lapso
```

### Do VSIX do release (sem buildar)
1. Baixe o arquivo `lapso-<versão>.vsix` anexado no [último release](https://github.com/lucasftas/lapso/releases/latest).
2. Instale com um comando (precisa do VSCode com o `code` no PATH):

```bash
code --install-extension lapso-<versão>.vsix
```

3. `Developer: Reload Window` (ou reabra o VSCode). O Lapso aparece como acordeon dentro da aba do Claude Code (lista de sessões).

### Buildar do código (dev)

```bash
git clone https://github.com/lucasftas/lapso.git
cd lapso
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository --no-yarn
code --install-extension lapso-<versão>.vsix   # a versão do arquivo gerado segue o `version` do package.json
```

> **Reinstalando por cima de uma versão já rodando?** O VSCode **não recarrega** a extensão sozinho — o host em memória continua com o código antigo até você dar `Developer: Reload Window`. Se reempacotar mantendo o **mesmo número de versão**, o VSCode nem sinaliza a atualização. Por isso cada build novo **sobe a versão** (semver) — garante que o reload pega o código novo.

> Requisito: Node.js + `code` CLI no PATH (VSCode → Command Palette → "Shell Command: Install 'code' command in PATH").

Pra deixar na lateral **direita** (secondary side bar): arraste o cabeçalho do acordeon **"Lapso — Nota da sessão"** (dentro da aba do Claude Code) pra área da secondary side bar (`Ctrl+Alt+B` abre/fecha) uma vez — o VSCode lembra o posicionamento depois disso.

## Convenção pro Claude Code

O Claude escreve em `.lapso/<sessionId>.md` (o próprio sessionId dele) na pasta `.lapso/` do workspace — gitignored, temporário. A extensão resolve a aba de sessão em destaque → `sessionId` (casando o título da aba com os transcripts `.jsonl`) e mostra a nota daquele arquivo. Não há mais `LAPSO.md` versionado na raiz.

## Dev

```bash
npm install
npm run watch
```

Depois `F5` no VSCode (ou `code --extensionDevelopmentPath=.` numa pasta de teste) abre um Extension Development Host com a extensão carregada.

## Testes

```bash
npm test
```

90 asserts, sem framework e sem VSCode aberto: o harness dirige o `out/extension.js` **real** com `vscode` e `node:fs` mockados sobre um filesystem em memória, e um sandbox executa o script do webview num DOM mínimo. Cobre troca de aba, fechamento, escrita concorrente, painel descartado e recriado, sessão ainda sem título e diretório de transcripts ausente.

## Estrutura

```
src/extension.ts          — toda a lógica (provider, índice de sessões, parse de zonas, webview)
tests/harness.js          — mocks de vscode + node:fs e helpers de driver
tests/webview-sandbox.js  — executa o script do webview num DOM mínimo
tests/concurrency.test.js — regressão dos fixes críticos da v0.2.2
tests/resilience.test.js  — suíte de resiliência e persistência (v0.3.0)
resources/icon.svg        — ícone da view (usado se ela for arrastada pra fora do container do Claude Code)
docs/specs/               — PRD.md (decisões) + Spec.md (milestones)
```

## Releases

https://github.com/lucasftas/lapso/releases

