# Operations Log

## 2026-08-07 (botão "pedir status", v0.4.0)
- [x] Pesquisa de viabilidade "injetar prompt numa sessão aberta": código da extensão Claude Code 2.1.221 instalada (manifest + bundle) + docs oficiais via agente. Deep link `/open?session&prompt` achado e descartado (painel aberto descarta o prompt); rota escolhida: flag + hook `PostToolUse`.
- [x] Mock storyboard com 5 variantes × 3 estados (`mocks/lapso-botao-status-storyboard.html`), aberto no Waterfox → **A4 (barra de rodapé) aprovada** pelo Lucas.
- [x] Implementação: rodapé no `buildHtml` + command `requestStatus` no host (guard de sessão exibida) + flag `.lapso/<sessionId>.request` + limpeza no fechamento da aba + ciclo visual (aguardando/atualizado/timeout 90 s).
- [x] Hook global: `lapso-status-request.ps1` (UTF-8 com BOM, `OutputEncoding` UTF-8) + registro no `settings.json` (`PostToolUse` sem matcher + `Stop` com anti-loop). Testado isolado nos 3 cenários (payloads reais; JSON do output validado por bytes).
- [x] **Prova viva E2E na própria sessão**: flag gravado → instrução injetada na tool call seguinte → nota escrita → painel renderizou. Debug no caminho: stdout puro de `PostToolUse` é engolido — trocado pro formato `hookSpecificOutput.additionalContext` (o mesmo do acento-guard).
- [x] `npm test` → **104 asserts verdes** (14 novos, bloco G). CI verde no push.
- [x] `vsce package` → `lapso-0.4.0.vsix` (7 arquivos, conteúdo conferido, CHANGELOG 0.4.0 dentro) → instalada (`lucasftas.lapso@0.4.0`). Nenhuma janela recarregada à força — o botão aparece no reload natural de cada uma.
- [x] filé v0.4.0: release com vsix anexo, item do board Monday bumpado, vault atualizado, tema preservado (Gruvbox Dark Medium), sync de painéis sem itens.
- [ ] Validação final do clique real pelo Lucas (pós-reload da janela).
- [ ] **Marketplace segue na 0.3.1** — publicação manual pendente (PAT do `vsce` inválido, `TF400813`).
- [ ] Segue pendente de antes: `icon` PNG no manifest.

## 2026-08-06 (organização padrão indústria + repo público, v0.3.3)
- [x] Auditoria multi-agente do repo (4 lentes + verificação adversarial): 39 achados confirmados, 1 refutado; todos aplicados.
- [x] Sanitização dos arquivos tracked (nomes de infra/projetos privados/paths de máquina/ID de board fora do conteúdo versionado) + varredura final por termos privados → zero ocorrências.
- [x] Código morto removido (provider + testes); `npm test` → **90 asserts verdes** local.
- [x] Padrão indústria: `vscode:prepublish` + `bugs`/`homepage`; CHANGELOG dentro do `.vsix`; `.vscode/launch+tasks`; caixa do `README.md` corrigida; `.vsix` antigos removidos da raiz (o do v0.2.2, que não tinha asset no release, foi anexado antes).
- [x] CI GitHub Actions criado e **provado verde no Ubuntu** (90 asserts). Runs de push engolidos de manhã eram o "Incident with Actions" oficial do GitHub — pós-incidente, push dispara normal. Fix necessário: harness declara `process.platform = win32`.
- [x] **Descoberta**: o repo GitHub estava PRIVADO (docs/vault diziam "público desde v0.2.2"). Decisão do Lucas: **"Abrir limpando o passado"**.
- [x] Backup completo pré-squash (bundle do histórico + os 8 `.vsix` de todos os releases) → pasta `lapso-backup-pre-squash-2026-08-06` fora do repo. Releases/tags antigos deletados, histórico compactado no root `16a5591`, force push, release v0.3.2 recriado com vsix, repo **PUBLIC** — verificado anônimo (página 200, 1 commit, 1 tag, 1 release).
- [x] filé v0.3.3: bump + `lapso-0.3.3.vsix` (conteúdo conferido, 7 arquivos) + instalada (`lucasftas.lapso@0.3.3`) + release v0.3.3 (vsix anexo) + item do board Monday bumpado + vault atualizado + tema preservado (Gruvbox Dark Medium) + sync de painéis sem itens.
- [ ] **Resíduo conhecido**: commits antigos ainda respondem por SHA direto na API até o garbage collection interno do GitHub (SHAs visíveis na events API por ~90 dias). Purga imediata total = ticket no GitHub Support. Risco baixo (só nomes, sem credencial).
- [ ] **Marketplace segue na 0.3.1** — publicação manual pendente (PAT do `vsce` inválido, `TF400813`).
- [ ] Segue pendente de antes: `icon` PNG no manifest.

## 2026-08-06 (falso alarme de configuração em repo novo, v0.3.2)
- [x] Diagnóstico do print do Lucas ("o que regrediu?"): nada regrediu. O workspace do print era uma pasta **vazia criada no mesmo dia**, sem nenhuma sessão do Claude Code — confirmado por `ls` (91 pastas em `projects/`, nenhuma casando) e pelo próprio painel do Claude ("No sessions yet"). O aviso vinha do caminho `!anyDirReadable` de `src/extension.ts`, presente desde a v0.2.2.
- [x] Fix implementado: `rootReadable` no `ResolveResult`, `projectsRootReadable()` sondando a raiz só no caminho de falha, estado `no-sessions-here` no webview, dedup do log de `config-missing`.
- [x] Testes: 10 asserts novos (cenários 3b/3c em `tests/concurrency.test.js`) + `hasDir` do harness reconhecendo ancestrais. `npm test` → **90 asserts verdes**.
- [x] Verificação contra o **disco real** (script no scratchpad, `out/extension.js` real + `fs` real): config real → `no-sessions-here`, zero pop-up; config inexistente → `config-missing` + 1 pop-up.
- [x] Verificação **ao vivo no VSCode**: janela nova numa pasta vazia, painel dockado do Claude Code mostrando "(sem sessão neste projeto)" com status cinza e nota "Nenhuma sessão do Claude Code neste projeto ainda", sem toast. Janela fechada depois; nenhum transcript de teste gravado.
- [x] `vsce package` → `lapso-0.3.2.vsix` (6 arquivos, 21.59 KB) → instalada (`lucasftas.lapso@0.3.2`). Nenhuma janela recarregada à força — as abertas seguem na 0.3.1 até o reload natural.
- [x] filé v0.3.2: commit `ccc8ff0` + push, release `v0.3.2` com o vsix anexo, item do board Monday bumpado, vault (`projetos/lapso.md`) atualizado, tema do workspace preservado (Gruvbox Dark Medium), sync de painéis sem itens (extensão não serve painel web).
- [ ] **Marketplace ainda serve a 0.3.1** — publicação da 0.3.2 segue manual (PAT do `vsce` inválido, `TF400813`; caminho é o portal manage no browser logado).
- [ ] Segue pendente de antes: `icon` PNG 128×128 no manifest.

## 2026-08-05 (dock na aba do Claude Code, v0.3.1 + publicação no Marketplace)
- [x] Levantada a estrutura da sidebar da extensão Claude Code 2.1.221 (`viewsContainers`/`views` do `package.json` instalado): a aba esquerda do print do Lucas = view `claudeVSCodeSessionsList` no container `claude-sessions-sidebar`.
- [x] Teste isolado numa VM Windows dedicada (host Hyper-V interno): VSCode 1.131.0 + Claude Code 2.1.220 + vsix do Lapso patcheado à mão (manifest apontando pro container do Claude Code) → acordeon "NOTA DA SESSÃO" confirmado embaixo da lista de sessões. `extensions.autoUpdate` desligado na VM pra preservar o teste.
- [x] Console da VM exibido pro Lucas via RDP no host Hyper-V (atalho de console criado remotamente no Desktop de lá). Aprovado: "fantástico!".
- [x] Patch real no repo: `contributes.views["claude-sessions-sidebar"]`, remove `viewsContainers`, view com `icon` + `contextualTitle`; bump 0.3.1. Zero mudança em `src/`.
- [x] `vsce package` → `lapso-0.3.1.vsix` (6 arquivos, 20.79 KB) → instalada na máquina do Lucas (`lucasftas.lapso@0.3.1`, ativa no próximo reload de cada janela — nenhuma janela foi recarregada à força).
- [x] filé v0.3.1: commit `bd826a4` + push, release `v0.3.1` com o vsix anexo, item do board Monday bumpado, vault atualizado, tema do workspace preservado (Gruvbox Dark Medium).
- [x] **Publicação no Marketplace (resolve a pendência de 2026-08-04)**: upload do `lapso-0.3.1.vsix` pelo portal manage no Brave logado (PAT do `vsce` segue inválido, `TF400813`) — automação via Playwright: menu de contexto da linha Lapso → Update → upload → grid em `0.3.1`. Verificação de "no ar" pela API `extensionquery` (a página `/items` não vale como prova).
- [ ] Segue pendente de antes: `icon` PNG 128×128 no manifest.
- [ ] Conferência ao vivo pós-reload na máquina do Lucas: altura/recorte do acordeon dividindo o painel com a lista de sessões.

## 2026-08-04 (auditoria de lentidão + refatoração de resiliência, v0.3.0)
- [x] Levantamento adversarial da queixa "lento / não atualiza / fica travado": 9 subagentes (6 verificações de hipótese, 2 caçadas, 1 síntese) → **11 causas confirmadas + 12 riscos latentes**, com as hipóteses refutadas registradas.
- [x] Medição de baseline (somente leitura, algoritmo replicado): este repo 5 ms · repo médio 354 ms · repo grande 1203 ms (2313 ms contando a varredura dupla real das variantes `d--`/`D--`).
- [x] Conferido que **não havia fix pendente de compilar**: `out/extension.js` instalado ≡ repo ≡ ambos os `.vsix` (SHA256 `D2616194…8220`); a 0.2.3 mudou só metadado.
- [x] Descartadas por evidência: `files.watcherExclude` (chave inexistente no settings global e no `.code-workspace`), perda de `postMessage` por falta de handshake (o VSCode enfileira em 3 camadas), colisão de prefixo entre os 2 títulos vivos deste repo (0 caractere de prefixo comum).
- [x] Entrevista pré-voo (`/voudormir`): animação **mantida como está**, instalar sozinho ao fim, checkpoints + commit único na master sem push.
- [x] `src/extension.ts` refatorado (23 correções em 6 blocos) + harness de teste reescrito + sandbox do webview criado.
- [x] Suíte: **80 asserts verdes** (`npm test` → 9 de regressão da v0.2.2 + 71 novos).
- [x] Bench comparativo contra os diretórios reais (somente leitura): repo grande **2347 ms → 389 ms → 5 ms após reload → 0 ms em uso**.
- [x] Bump 0.2.3 → 0.3.0; `vsce package` → `lapso-0.3.0.vsix` (6 arquivos, 20.48 KB).
- [x] **Sanitização**: o primeiro empacotamento capturou `.claude/scheduled_tasks.lock` (estado local da sessão do Claude Code) dentro do `.vsix`. Adicionado `.claude/**` ao `.vscodeignore` e `.claude/` ao `.gitignore`, e o pacote foi refeito antes de instalar.
- [x] **Instalada e conferida**: `code --list-extensions --show-versions` → `lucasftas.lapso@0.3.0`, e o `out/extension.js` instalado tem SHA256 idêntico ao do repo (`625CC7E1…B13D`).
- [x] **filé v0.3.0**: `git push` (`54d3eba..1b1772a`), `gh release create v0.3.0` com o `lapso-0.3.0.vsix` anexo, item do board Monday bumpado, vault (`contexto-master/projetos.md` + `projetos/lapso.md`) atualizado, tema/ícones do workspace conferidos (Gruvbox Dark Medium preservado).
- [x] `CLAUDE.md` do projeto corrigido: a seção do filé ainda dizia "repo privado — sem release pública", desatualizada desde o v0.2.2 (o repo é público no GitHub e no Marketplace).
- [ ] **Pendente de conferência ao vivo** (não dá pra provar em harness): recorte real do CSS na altura da sidebar do Lucas · ordem real `resolveWebviewView` × `onDidDispose` ao mover a view de container · contagem real de eventos de aba por gesto. Todas exigem `Developer: Reload Window` antes.
- [ ] **Publicação da 0.3.0 no Marketplace não foi feita** (o filé não publica). Enquanto isso a galeria serve a `0.2.3` — Settings Sync pode reverter a instalação local e trazer os defeitos de volta.
- [ ] Segue pendente de antes: `icon` PNG 128×128 no manifest.

## 2026-08-04 (correção da descrição do Marketplace + release v0.2.3)
- [x] Auditada a descrição publicada contra o código: 4 divergências no `description` do `package.json` (dockado ≠ flutuante · por-sessão-do-Claude ≠ por-janela · `.lapso/<sessionId>.md` ≠ `.lapso/nota.md` · duas zonas ≠ "manual ou Claude").
- [x] `description` reescrita + `keywords` add + bump 0.2.2 → 0.2.3; `npm run compile` + `vsce package` → `lapso-0.2.3.vsix` (6 arquivos, 12.17 KB).
- [x] `CLAUDE.md` (ainda dizia `LAPSO.md` na raiz) corrigido; nota de evolução no `docs/specs/PRD.md`.
- [x] **Publicada** no Marketplace via portal manage no browser logado — o PAT do `vsce` está inválido (`TF400813`), mesmo caminho sem-PAT do v0.2.2.
- [x] **Verificada na API pública** (`extensionquery`): `0.2.3` + descrição nova. A página web mostrava o texto novo antes disso, com o pacote ainda em `Verifying` — só a API prova.
- [x] `.playwright-mcp/` (snapshots com dados da conta logada) adicionado ao `.gitignore` e removido do working tree **antes** do `git add -A`.
- [x] `notes-session-vscode.code-workspace` → `extension-vscode-lapso-postit.code-workspace` (rename detectado pelo git, tema Gruvbox Dark Medium preservado).
- [x] `gh release create v0.2.3` (VSIX anexo) + Monday bump.
- [ ] **Segue pendente**: `icon` PNG 128×128 no manifest (Marketplace mostra ícone genérico). E o E2E ao vivo de 2 sessões simultâneas, herdado do v0.2.2.

## 2026-08-02 (publicação no marketplace + release v0.2.2)
- [x] Publisher `lucasftas` criado no Visual Studio Marketplace (via playwright/Brave logado — login com senha/2FA + captcha resolvidos pelo Lucas).
- [x] Manifest ajustado pra publicar (`repository` add, `private` removido) + commit/push.
- [x] `vsce package` → `lapso-0.2.2.vsix` e **publicada** (`lucasftas.lapso`) via upload pelo portal manage — **sem PAT**, 100% browser.
- [x] `gh release create v0.2.2` + Monday.
- [~] **E2E ao vivo de 2 sessões simultâneas NÃO executado** nesta sessão (o gate original do v0.2.2). Publicada com base no teste de mock (9/9); o live segue recomendado como validação final.

## 2026-08-01 (v0.2.2 — correção dos 6 críticos)
- [x] Implementados os 6 fixes críticos no `extension.ts` (WeakMap aba→sessionId, save com sessionId capturado + flush, diagnóstico CLAUDE_CONFIG_DIR).
- [x] `tests/concurrency.test.js` + `npm test` — 9/9 passam (mock do `vscode` dirigindo o provider real).
- [x] Bump 0.2.1 → 0.2.2, package/install local pra teste ao vivo.
- [ ] **GATED**: `gh release create v0.2.2` + Monday bump — só após E2E ao vivo com 2 sessões simultâneas (escolha do Lucas: "testo de verdade antes de publicar").
- [ ] Aguardando Lucas rodar o teste live de 2 sessões.

## 2026-08-01 (v0.2.1)
- [x] Teste no post-it não preencheu → investigado até a causa-raiz (host da extensão em memória = build velho, modelo `LAPSO.md` raiz; reinstall sobre mesma versão 0.2.0 sem `Reload Window`).
- [x] Auditada a resolução de transcript-dir (`CLAUDE_CONFIG_DIR` honrado, `encodeCwd` + variantes de drive corretos) — OK pro setup do Lucas.
- [x] Bump 0.2.0 → 0.2.1 (package.json + README) — força o VSCode a reconhecer a atualização.
- [x] README saneado: "Convenção pro Claude Code" reescrita pro modelo `.lapso/<sessionId>.md` (estava ensinando `LAPSO.md` raiz); nota sobre reinstall-sem-reload.
- [x] Workflow adversarial (5 lentes) caçando "o que mais pode quebrar" no `extension.ts`.
- [x] Release v0.2.1 (filé) + docs + vault + VSIX empacotado/instalado.
- [ ] Pendente (ação do Lucas): `Developer: Reload Window` pra ativar o host novo e ver o painel preencher.

## 2026-07-30
- [x] Corrigida a regra global "anota no lapso" (CLAUDE.md do Lucas): gatilho autoriza criar `LAPSO.md`, trava ambiguidade com logs de plano, formato leigo — resolve incidente onde uma sessão escreveu num log em vez do arquivo canônico.
- [x] Storyboard de 10 mocks de layout terminal/código (Dracula Soft + Alucard) aberto no Waterfox.
- [x] Implementado o tema A2 (Dracula Soft, `/* status */` `/* notas */`, chrome de terminal) — testado ao vivo no painel real.
- [x] `.vscodeignore` corrigido (mocks/docs não vazam mais pro pacote); `.vsix` limpo anexado ao release.
- [x] README com instalação em PC novo (release) + build.
- [x] Release v0.2.0 (filé) + Monday bump.
- [ ] Pendente: layout dividido em faixas (status/notas com borda) vs fluxo contínuo — o A2 ficou fluido; se quiser separação visual mais forte, é ajuste futuro.

## 2026-07-29
- [x] Spike de viabilidade: painel dockado no VSCode que acompanha a janela e troca por sessão (validado ao vivo).
- [x] Scaffold da extensão + compilação `tsc` + instalação local via `.vsix`.
- [x] Teste ao vivo no Extension Development Host (screenshot real do desktop).
- [x] Sanitização (grep por dados privados) + hardening CSP no webview.
- [x] `git init`, repo privado `lucasftas/lapso` criado no GitHub, push inicial.
- [x] Rebrand `notes-session-vscode` → **Lapso** (ids, container, comando, repo renomeado no GitHub).
- [x] Convenção de arquivo migrada para `LAPSO.md` na raiz (versionável).
- [x] Pivot: painel virou campo editável direto, em branco por padrão.
- [x] Efeito de máquina de escrever + fix do `requestAnimationFrame` suspenso.
- [x] Scrollbar estilizada + scroll contido no campo (pedido do Lucas após ver a barra nativa).
- [x] Painel dividido em zonas status(Claude)/notas(usuário) — não-sobrescrever por marcador; teste de lógica 10/10.
- [x] Release v0.1.0 (filé): tema único do workspace, docs, GitHub Release, vault.
- [ ] Pendente: confirmação visual do layout dividido (tela travou); formato exato do status + limite de caracteres; gravar regra global de preenchimento do status.
