# Lapso — CLAUDE.md

## Visão geral
Extensão VSCode (TypeScript). Um post-it dockado por **sessão do Claude Code**: segue a aba de sessão em destaque, resolve título da aba → `sessionId` pelos transcripts `.jsonl`, e lê/renderiza `.lapso/<sessionId>.md` do workspace em tempo real (pasta gitignored, nota descartada quando a aba fecha). Sem dependências de runtime — só `@types/vscode`/`typescript` como devDependency. Ver `docs/specs/PRD.md` e `docs/specs/Spec.md` pras decisões e milestones.

## ⛔ Sanitização — tratar TODO conteúdo commitado como público
A extensão é pública no Visual Studio Marketplace (`lucasftas.lapso`) e o repositório destina-se a compartilhamento público no GitHub — a visibilidade pode alternar, não confiar nela. **Nunca** commitar:
- Paths absolutos da máquina do Lucas, nomes de repositório/projeto privado, hostname do parque, credenciais.
- Screenshots de teste que capturem janelas/conteúdo de outras sessões (usar sempre pasta de scratch fora do repo pra qualquer captura de teste).
- Qualquer coisa que remeta a Grupo Facial/clientes/infra interna.

Antes de qualquer commit, se algo do ambiente de teste vazou (screenshot, path, log), sanitizar antes — não depois.

## Regras do projeto
- Sem bundler — `tsc` puro compila `src/extension.ts` → `out/extension.js`.
- Zero dependência de runtime além da API do VSCode — mantém a extensão leve e fácil de auditar antes de publicar.
- Webview sempre com CSP explícito (`default-src 'none'`, nonce por render) — nunca relaxar isso sem motivo documentado.

## Padrão de commits
Português, prefixo convencional (`feat:`, `fix:`, `docs:`, `refactor:`) + co-author Claude.

## Como rodar (dev)
```bash
npm install
npm run compile
code --extensionDevelopmentPath=. <pasta-de-teste>
```

## Instalar localmente (uso real)
```bash
npx @vscode/vsce package --allow-missing-repository --no-yarn
code --install-extension lapso-<versão>.vsix
```

## Estrutura do projeto
```
src/extension.ts          — toda a lógica (provider, índice de sessões, renderer, comandos)
tests/harness.js          — mocks de vscode + node:fs, FS em memória com contadores de I/O
tests/webview-sandbox.js  — executa o script do webview num DOM mínimo (testa o painel sem VSCode)
tests/concurrency.test.js — regressão dos fixes críticos da v0.2.2
tests/resilience.test.js  — suíte de resiliência e persistência (v0.3.0)
resources/icon.svg        — ícone da view (campo "icon" em contributes.views; o Lapso mora no container claude-sessions-sidebar do Claude Code desde a v0.3.1)
docs/specs/PRD.md         — decisões técnicas
docs/specs/Spec.md        — milestones + critério de pronto
```

## Testes
`npm test` roda as duas suítes (104 asserts). Nenhuma correção de comportamento entra sem assert que a cubra — e o assert cita o defeito original, pra não virar teste órfão.

## Botão "pedir status" (v0.4.0)
O rodapé do painel grava `.lapso/<sessionId>.request`; um hook do Claude Code (`PostToolUse` sem matcher + `Stop`, script `lapso-status-request.ps1` nas configs globais do mantenedor) consome o flag e injeta a instrução pra sessão atualizar a própria nota no meio do turno. Gotcha comprovado: em `PostToolUse`, contexto só chega ao modelo como JSON `hookSpecificOutput.additionalContext` — stdout puro é ignorado. A receita pública genérica está no README.

## ⛔ A animação de digitação do status é intocável
`typewriterStatus` no webview (`MS_PER_CHAR`, `MAX_DURATION_MS`, reveal a partir do char 0, rodando em toda troca de aba) é uma escolha explícita do Lucas — confirmada em 2026-08-04. Não "otimizar" sem ele pedir. O que pode mudar é *quando* ela dispara (a chave de dedup do render).

## Gatilho "filé"
Segue as regras globais privadas do mantenedor (carregadas automaticamente na sessão dele, fora deste repo). **Extensão pública no Marketplace desde a v0.2.2** (`lucasftas.lapso`) — o filé cria release no GitHub normalmente. A seção de sanitização acima vale integralmente: conferir o conteúdo do `.vsix` antes de instalar/publicar (o `vsce package` já capturou `.claude/scheduled_tasks.lock` uma vez).

**Publicar no Marketplace é passo separado e manual**: o PAT guardado pelo `vsce` está inválido (`TF400813`); o upload sai pelo portal manage no browser logado. O filé **não** publica — enquanto isso o Marketplace serve a versão anterior e o Settings Sync pode reverter a instalação local.
