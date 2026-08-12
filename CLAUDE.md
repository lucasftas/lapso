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

## ⛔ Regras operacionais duráveis (auditoria 2026-08-12)

> Extraídas do vault (`d:\GitHub\.obisidian-master-lucas\projetos\<repo>.md`), onde viviam como
> narrativa histórica dentro de recaps — cada uma já custou retrabalho real. Confirmadas por
> verificação adversarial nesta rodada (2026-08-12).

### Reinstalar VSIX com a MESMA versão não recarrega nada — bump de versão obrigatório antes de rei…

## ⛔ Reinstalar VSIX: SEMPRE bumpar a versão antes — mesma versão = build velho segue vivo em silêncio

O VSCode ignora reinstalação de `.vsix` com o MESMO número de versão e não recarrega a extensão sem reload da janela: o host em memória continua rodando o build antigo enquanto o disco tem o novo — o painel "não preenche" e nada acusa erro (aconteceu na v0.1.0 e de novo na v0.2.1). Regra: (1) bumpar `version` no `package.json` ANTES de `vsce package` + `code --install-extension`, sempre; (2) janelas já abertas seguem na versão antiga até o reload natural de cada uma — validar comportamento novo SÓ depois de confirmar a versão viva em memória (ex: grep no `out/extension.js` instalado, `code --list-extensions --show-versions`); (3) ⛔ nunca forçar `Developer: Reload Window` numa janela do Lucas — derruba a sessão do Claude Code que estiver rodando nela.

_Por que importa:_ Não coberto: CLAUDE.md do repo ('Instalar localmente') ensina vsce package + code --install-extension SEM bump; MEMORY.md só tem marketplace/animação/squash; manual mestre sem 'vsix'/'Reload Window'. Vigente (v0.4.0 ainda cita 'janelas seguem na 0.3.3 até recarregar'; linha 120 mantém a fronteira do Reload). Valor alto: bug marcado 'recorrente' no vault (mordeu na v0.1.0 E na v0.2.1, horas de debug de 'painel não preenche'), falha silenciosa, e o antídoto óbvio (forçar Developer: Reload Window) derruba sessão viva do Claude Code do Lucas.  
<sub>vault: lapso.md linha 163</sub>

### JSON (package.json/manifest) gravado com BOM = extensão marcada 'invalid — is not valid JSON' e…

## ⛔ JSON do repo (`package.json` etc.) gravado via PowerShell: SEM BOM

`Set-Content -Encoding UTF8` no Windows PowerShell 5.1 grava BOM — e manifest `package.json` com BOM faz o VSCode marcar a extensão como "invalid — is not valid JSON": ela some inteira, sem erro apontando a causa (incidente real no teste da v0.3.1 na VM). Gravar JSON sempre sem BOM: `[IO.File]::WriteAllText($path, $texto, [Text.UTF8Encoding]::new($false))` — ou editar pelas tools Write/Edit. Não confundir com a regra global dos `.ps1` (esses levam BOM; JSON, nunca).

_Por que importa:_ Não coberto em CLAUDE.md/MEMORY/manual mestre — e o manual tem a regra INVERSA (.ps1 grava COM BOM, hook acento-guard), que induz generalização errada pro JSON. Falha 100% silenciosa ('invalid — is not valid JSON', extensão some sem apontar BOM). O cenário não é nicho: o fluxo padrão de teste do repo é patchear manifest em VM via PowerShell 5.1 (Set-Content), exatamente onde mordeu na v0.3.1. Vigente, custo de diagnóstico alto, regra de 3 linhas.  
<sub>vault: lapso.md linha 90</sub>

### Quando o modelo/comportamento do produto muda, varrer o `description` do `package.json` junto c…

## Mudou o modelo do produto → varrer o `description` do `package.json` junto

O `description` do manifest é o único texto que o público lê na galeria do Marketplace e nenhum passo do filé o revisa — já ficou 3 versões desatualizado (v0.2.3: 4 erros numa linha). Sempre que o modelo/comportamento da extensão mudar, incluir na varredura de docs: `description` do `package.json` + README + este CLAUDE.md (grep pelos termos do modelo antigo, ex: `flutuante`, `nota.md`).

_Por que importa:_ Verificado: nenhum passo do filé (docs/gatilhos/file.md global nem a seção filé do CLAUDE.md do repo) revisa o description do package.json. Evidência empírica de que sessões NÃO fazem sozinhas: 3 versões de drift (4 erros numa linha) até o Lucas cobrar com print — 'cobrança do Lucas' é exatamente o marcador de custo alto do critério. Produto público no Marketplace, modelo já mudou 2-3× em 5 semanas de vida do repo; a lição vive só num recap antigo (v0.2.3) que vai afundando.  
<sub>vault: lapso.md linha 140</sub>
