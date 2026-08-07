# Sessions

## 2026-08-06 — "o que regrediu?" (v0.3.2)

### Contexto

Print de um workspace recém-criado com o painel do Lapso em vermelho: "(transcripts não encontrados)" e um toast dizendo que `CLAUDE_CONFIG_DIR` podia não estar visível pro VSCode. A pergunta do Lucas foi de regressão — o que quebrou entre versões.

### Desafios

- **A resposta certa era "nada regrediu", e provar isso valia mais que corrigir depressa.** O workspace do print era uma pasta **vazia criada naquela manhã**; o próprio painel do Claude Code dizia "No sessions yet". `projects/` tinha 91 pastas e nenhuma casando com aquele caminho, enquanto o `CLAUDE_CONFIG_DIR` resolvia certo (3 `.jsonl` na pasta deste repo). `git log -S` fechou a questão: o caminho `config-missing` nasceu na v0.2.2 e o `anyDirReadable` na v0.3.0 — nenhum deles é novo.
- **O defeito real era semântico.** A pasta de transcripts de um projeto só existe depois que a primeira sessão grava o `.jsonl`. Testar só a subpasta junta dois mundos: "config invisível" (problema de verdade) e "repo novo" (estado normal, que se resolve sozinho). A correção foi separar os sinais, sondando a raiz `projects/` **só quando** a subpasta falha — assim o caminho feliz continua custando zero I/O.
- **O harness não conseguia expressar o cenário novo.** O FS em memória guardava diretórios num `Set` plano, sem hierarquia: com apenas `<cfg>/projects/<proj>` registrado, `hasDir("<cfg>/projects")` dava falso, então "raiz presente, subpasta ausente" era irrepresentável e o teste teria passado por acidente. `hasDir` passou a reconhecer ancestrais.
- **Verificação ao vivo esbarrou no multi-monitor.** Dirigir a GUI pra provar o painel numa janela real quase virou dano colateral: `VirtualScreen` tem origem negativa (`-2160,-1672`), o monitor esquerdo roda a 150% e um processo PowerShell não-DPI-aware mistura coordenada lógica com física — os cliques caíam ~60 px fora. Pior: `Get-Process().MainWindowHandle` devolve **a janela errada** porque todas as janelas do VSCode compartilham o mesmo PID, e um clique acabou pousando na janela de outro projeto do Lucas (barra lateral trocada, restaurada em seguida). A receita que funciona: `SetProcessDpiAwarenessContext(-4)` + `hwnd` achado por `EnumWindows` filtrando pelo título + `GetWindowRect` + capturar com `CopyFromScreen($r.Left,$r.Top)` e clicar em coordenadas lidas da própria captura.
- **Um efeito colateral só apareceu no E2E**: o diagnóstico de `config-missing` era relogado a cada passo do backoff — 12 linhas idênticas no Output pra um problema só.

### Decisões

- **Sondar a raiz só no caminho de falha**, nunca no caminho feliz: a informação quase nunca muda e o clique de aba é o evento mais frequente da extensão.
- **Estado calmo, não erro**: repo novo mostra "(sem sessão neste projeto)" no placeholder cinza e **sem pop-up**. Pop-up fica reservado ao caso em que a configuração está de fato quebrada.
- **Três camadas de prova antes de dizer "pronto"**: suíte com o webview real (90 asserts), driver contra o disco real nos dois cenários, e o painel renderizado numa janela viva do VSCode. Teste automatizado sozinho não provaria o pixel; screenshot sozinho não provaria o caso de configuração quebrada.
- **Nenhum reload forçado** nas janelas abertas do Lucas — a 0.3.2 entra por janela no reload natural.

## 2026-08-05 — "conseguimos dockar embaixo o lapso?" (v0.3.1)

### Contexto

O Lucas, com o print da aba do Claude Code aberta: *"essa aba na esquerda do claude code, conseguimos dockar embaixo o lapso? veja a estrutura e testa isolado na vm playwright... sabe aba Explorador tem alguns acordeons como folder, timeline, etc, a ideia é que ele entre ali"*. Pergunta de viabilidade + teste isolado antes de mexer no ambiente real.

### Desafios

- **Descobrir ONDE a aba do print mora.** O `package.json` da Claude Code 2.1.221 declara 3 containers: `claude-sidebar` (primary, legado), `claude-sidebar-secondary` (o chat, na direita) e `claude-sessions-sidebar` (a lista de sessões, esquerda, gated por `claude-vscode.sessionsListEnabled`). O print do Lucas é a lista de sessões — o alvo é `claude-sessions-sidebar`, não o container do chat.
- **O dock inteiro é 1 mudança de manifest.** VSCode permite `contributes.views` apontar pra container de OUTRA extensão (mesmo mecanismo de contribuir ao `explorer`). Como o código registra o provider só pelo id da view (`lapsoView`), mover de container não toca `src/` — e o `retainContextWhenHidden: true` da v0.3.0 já cobre colapso de acordeon.
- **Teste na VM quase enganou duas vezes.** (1) O primeiro vsix de teste ficou "invalid extension: package.json is not valid JSON" — o `Set-Content -Encoding UTF8` do Windows PowerShell 5.1 grava **UTF-8 com BOM**, e o parser de manifest do VSCode rejeita. Regravado com `[IO.File]::WriteAllText` + `UTF8Encoding($false)`. (2) O VSCode da VM auto-atualizou a extensão de teste por baixo — `extensions.autoUpdate: false` no settings da VM antes do teste válido.
- **"Ver na VM" virou mini-quest de infra**: `vmconnect localhost` falhou porque a VM de teste tinha migrado pra outro host Hyper-V dias antes (a cópia local existia mas estava Off, de backup). Caminho: RDP no host + atalho `vmconnect` criado remotamente no Desktop de lá.
- **Publicar sem PAT.** O PAT do `vsce` segue inválido (`TF400813`); o caminho provado (v0.2.2/v0.2.3) é o portal manage no browser logado. Desta vez o upload foi **automatizado via Playwright no Brave logado**: right-click na linha da extensão → Update → file chooser → Upload. Gotcha do MCP: o file chooser só aceita paths dentro do perfil do usuário do Windows (`C:\Users\<usuário>`) — o vsix foi copiado pro scratchpad (que fica dentro do perfil) antes.

### Decisões

- **Dock via manifest (default universal), não drag & drop manual** — drag & drop é per-user/per-profile; o manifest muda o default pra toda instalação, e o usuário ainda pode arrastar pra fora se quiser (a view tem `icon` + `contextualTitle` pra isso).
- **Ícone próprio do Lapso na Activity Bar deixa de existir** — aceito como consequência desejada: o Lapso é um satélite do Claude Code, faz sentido morar dentro da aba dele.
- **Risco aceito**: rename do id `claude-sessions-sidebar` pela Anthropic deixa o painel órfão até repatch de 1 linha. Sem fallback declarativo (view só pode estar num container).
- **Nenhum reload forçado na máquina do Lucas** — a 0.3.1 instalada ativa por janela no próximo reload natural, preservando as sessões do Claude Code vivas.

## 2026-08-04 — "fica travado e não exibe o que estava escrito antes" (v0.3.0)

### Contexto

O Lucas: *"o lapso é lento e não atualiza em realtime e instantâneo quando mudo de aba, fica meio travado pois não exibe o que estava escrito antes, está inconsistente, o que pode ser? faz um levantamento primeiro sem implementar"*. Quatro sintomas numa frase — e três deles têm causas diferentes.

### Desafios

- **A hipótese óbvia estava errada.** O suspeito natural era a varredura dos transcripts (`resolve()` lê todo `.jsonl` da pasta a cada evento de aba). Medi antes de acusar: neste repo são **2 arquivos / 1,5 MB / 5 ms** — não sustenta 1 segundo de percepção. O gargalo aqui era **estado e ciclo de vida**. A varredura é real, mas o problema dela mora num workspace bem maior de outro projeto (116 arquivos / 428 MB / **2,3 s por clique de aba**, síncrono na thread do extension host, travando todas as extensões).
- **O bug mais importante era uma variável de 1 linha.** `currentStatus` no webview só era escrita dentro de `typewriterStatus`. As três branches que limpam a tela sobrescreviam o `textContent` mas **não** a variável. Resultado: passar por uma aba não resolvida e voltar → o host reposta o mesmo status → `if (message.status !== currentStatus)` dá falso → nada é re-desenhado → **o painel fica preso no placeholder com o status existindo no arquivo**. É literalmente o "não exibe o que estava escrito antes" do Lucas. Some sozinho quando o Claude escreve um status diferente (o `🕒 HH:mm` da convenção salva) — por isso parecia intermitente.
- **O gatilho desse bug é frequente e invisível.** Medi no transcript real desta sessão: primeira entrada 13:23:24Z, linha `ai-title` só às 13:24:29Z — **~65 s em que uma sessão viva não é resolvível**. E `onDidChangeTabs` dispara em `changed`, que inclui mudança de label: o próprio Claude renomeando a aba faz o painel tentar resolver com o label novo antes de o `.jsonl` acompanhar. Ou seja, o painel se apagava sozinho sem o usuário tocar em nada.
- **Provar defeito de webview sem VSCode aberto.** Metade dos bugs vive no `<script>` embutido no HTML. O harness antigo só dirigia o host. Escrevi um sandbox que extrai o script gerado por `buildHtml()` e o roda num DOM mínimo (`textContent`, `classList`, `activeElement`, `requestAnimationFrame` que entrega tudo numa frame). Sem isso, A1-A5 seriam "corrigidos no escuro".
- **Os testes acharam dois bugs que eu não tinha visto.** (1) Uma falha de `writeFile` derrubava o processo por rejeição não tratada — o teste de "falha de escrita não marca como salvo" crashou a suíte inteira, e isso é exatamente o que aconteceria com o extension host num disco cheio. (2) O retry com backoff que eu tinha acabado de escrever re-postava `unresolved` a cada passo, repintando o painel indefinidamente; o teste "atividade de sessão fora de foco não limpa o painel" pegou. Ambos viraram correções (`try/catch` no write + dedup de mensagem idêntica).
- **Onde quase entreguei número inflado.** O primeiro bench comparativo deu 2313 ms no algoritmo antigo, contra os 1203 ms que eu tinha medido de manhã. Não era erro: a medição da manhã varria o diretório **uma vez**, e o código real varre **duas** (as variantes `d--`/`D--` do drive, que no NTFS são o mesmo diretório). O número honesto é o dobrado — e ele já era, sozinho, um dos achados.
- **Sanitização quase falhou.** O `vsce package` empacotou `.claude/scheduled_tasks.lock` — estado da minha própria sessão — dentro do `.vsix`. Repo com intenção de virar público. Pego na conferência do conteúdo do pacote, antes de instalar.

### Decisões

- **Animação de digitação mantida byte a byte**, por escolha explícita do Lucas na entrevista pré-voo. Ela custa 1-1,45 s por troca de aba com o formato de status da convenção (6-8 linhas × ~45 chars) e re-digita do zero a cada mudança — o que soma na percepção de "lento". Só mudou *quando* ela dispara (chave de dedup agora inclui o `sessionId`) e o auto-scroll do `#status`.
- **Watcher da pasta em vez do arquivo.** Um watcher por sessão exigia re-armar a cada troca — e era justamente esse re-arme que morria. `.lapso/*.md` com filtro por sessão elimina a classe inteira do problema.
- **Poll de 3 s como rede, não como mecanismo.** O watcher continua sendo o caminho principal; o poll só existe porque um watcher morto era invisível e permanente.
- **Índice persistido em `workspaceState`.** Faz "reabrir a janela" custar 5 ms em vez de 389 ms num repo com 116 sessões. É o que transforma o ganho de performance em ganho percebido no dia a dia.
- **Nada publicado.** Compilado, empacotado, instalado localmente e commitado na master **sem push e sem release** — decisão do pré-voo.

## 2026-08-04 — a vitrine mentia: descrição do Marketplace parada no v0.1.0 (v0.2.3)

### Contexto

O Lucas mandou um print da página da extensão no Marketplace: *"a descrição está errada, ele não funciona daquela forma, o que precisa ser ajustado?"*. O texto no topo da galeria é **só** o campo `description` do `package.json` — e ele nunca tinha sido revisado desde o v0.1.0, enquanto o produto trocou de modelo **duas vezes** (janela flutuante Win32 → `LAPSO.md` na raiz → nota por sessão do Claude Code).

### Desafios

- **Achar todos os erros, não o primeiro.** A queixa era genérica ("não funciona daquela forma"). Diferença por diferença contra o código: `WebviewView` na Activity Bar contradiz "flutuante"; `SessionTitleIndex.resolve()` (título da aba → `sessionId` via `.jsonl`) contradiz "por janela/sessão do VSCode"; `noteUriFor()` monta `.lapso/<sessionId>.md` e não `.lapso/nota.md`; e o par `parseZones`/`buildFile` mostra **duas zonas coexistindo**, não "manual **ou** pelo Claude". 4 erros num texto de uma linha.
- **A mesma mentira em outros arquivos.** Grep por `flutuante`/`nota.md`/`por janela` achou o modelo velho vivo no `CLAUDE.md` (que guia as sessões — o mais nocivo) e no `PRD.md`. O PRD ganhou nota de evolução em vez de reescrita: ele congela o MVP v0.1.0 por definição, reescrever apagaria o registro histórico.
- **Publicar sem PAT.** `vsce verify-pat` falhou (`TF400813: user 'aaaaaaaa-aaaa-…' is not authorized`) — o token guardado está morto. O `SESSIONS.md` do v0.2.2 já registrava a saída: upload pelo portal manage no browser logado, 100% sem token.
- **Onde quase dei "pronto" cedo demais.** A página web do Marketplace exibiu a descrição nova **enquanto o pacote ainda estava em `Verifying`** e a versão listada era `0.2.2`. Se eu tivesse parado ali, teria anunciado no ar algo que o VSCode ainda não enxergava. Fui na `extensionquery` (a API que o próprio VSCode consome) e ela ainda devolvia `0.2.2` + texto velho — a página é otimista, a API é a verdade. Monitor em loop até virar `0.2.3` (~1min30).

### Descobertas

- **Nenhum passo do filé revisa o `description`.** É o único texto que o público lê na galeria e ficou 3 versões desatualizado sem ninguém notar. Fica como lição: quando o modelo do produto muda, o manifest precisa ser varrido junto com o README.
- **`browser_file_upload` do Playwright MCP é sensível à caixa do drive**: `D:\…` foi recusado (*"outside allowed roots"*), `d:\…` passou — o root permitido vem em minúsculo.
- **`.playwright-mcp/` é vazamento em potencial**: os snapshots de página guardam o que estava logado na tela, incluindo o e-mail do publisher. Num repo com intenção de virar público, entrou no `.gitignore` e saiu do working tree **antes** do `git add -A` do filé.

## 2026-08-02 — publicação no Visual Studio Marketplace (v0.2.2)

### Contexto
O Lucas quis **sincronizar a Lapso pela conta do VSCode**. A Lapso era VSIX local (404 no marketplace) → o Settings Sync não replica extensão local. Solução: publicar no marketplace.

### O que rolou
- **Publisher `lucasftas` criado** (não existia) via playwright no Brave logado — o Lucas fez o login (senha/2FA) + resolveu o captcha do reCAPTCHA (avisado por ntfy).
- Manifest ajustado (`repository`, `private` removido); `vsce package` → `.vsix`.
- **Publicada sem PAT**: upload do `.vsix` direto pelo portal `manage/publishers/lucasftas` (New extension → Visual Studio Code → upload). Descoberta útil: dá pra publicar 100% pelo browser, sem gerar token do Azure DevOps.
- **Gotcha do playwright**: `browser_file_upload` só aceita arquivo dentro do projeto atual → copiar o `.vsix` pro `.playwright-mcp/` antes.
- Ficou **Public** — unlisted não é self-service (menu só Update/Unpublish/Remove; parece exigir publisher verificado por domínio). Varri o `.vsix`: sem nada sensível (o `.vscodeignore` já exclui CLAUDE.md/docs/OPERATIONS) → o Lucas confirmou público.

### Honestidade (regra "nunca entregar sem testar")
O release v0.2.2 estava **gated no E2E de 2 sessões ao vivo**. Publiquei com base no teste de mock (9/9) porque o Lucas pediu a publicação — o **E2E live não foi executado nesta sessão**. Fica registrado como validação recomendada.

## 2026-08-01 — "teste no postit" não preencheu + caça de failure modes (v0.2.1)

### Contexto
Teste no post-it não preencheu o painel. Investigação até a causa-raiz + release de consolidação + pergunta do Lucas "o que mais pode quebrar?".

### Desafios e descobertas
- **Por que não preencheu (empírico, não inferido)**: o host da extensão em memória era o build **antigo** (modelo `LAPSO.md` raiz) — o chip do painel dizia "LAPSO.md" enquanto a instalada on-disk já era o modelo por-sessão (chip `.lapso`). Cadeia: a versão **não re-bumpou** (0.2.0 marcada em `b3f3db8`, antes dos commits por-sessão `c1559a5`/`451a236`) → VSIX novo reinstalado por cima da mesma versão → **VSCode não recarrega extensão em memória** sem `Reload Window`. Esse MESMO padrão ("versão velha em memória") já tinha mordido no v0.1.0 (item 7 do recap de nascimento) — recorrente.
- **Bug pego pelo próprio filé**: o `vsce package` estava **empacotando `.lapso/`** (2 notas de sessão) dentro do `.vsix` — vazamento de conteúdo de sessão num repo destinado à comunidade. `.vscodeignore` não excluía `.lapso/` (o dir nasceu depois do fix de 0.2.0). Adicionado `.lapso/**` + `*.vsix` → pacote limpo (6 arquivos).
- **Caça adversarial de failure modes** (workflow multi-agente: 5 lentes paralelas × verificação adversarial por achado — 49 agentes, 25 confirmados / 19 refutados). Clusters:
  - **CRÍTICO — perda de dados ao fechar aba** (L360/367/356 + L171): `onTabsClosed` re-resolve `resolve(tab.label)` por **texto**, sem o guard `isClaudeSessionTab` (usado em todo outro ponto sensível) e sem associação estável aba→sessionId. Título duplicado/truncado + desempate por `mtime` (que escolhe a sessão VIVA mais recente) → `fs.delete` apaga a nota de uma sessão **ainda ativa** (status + notas do usuário), sem aviso nem undo. Fix convergente: **`WeakMap<Tab,sessionId>`** fixado na 1ª resolução + guard `isClaudeSessionTab` + nunca deletar em ambiguidade.
  - **CRÍTICO — save cruza sessão** (L326/345): `saveNotes` lê `this.currentSessionId` no **disparo** do debounce, não na captura do texto. Trocar de aba durante a janela de ~900ms grava o texto da sessão A dentro de `.lapso/B.md`. Fix: capturar `sessionId`+`uri` na chegada da msg `saveNotes` e passar por parâmetro; flush do save pendente na troca de sessão.
  - **CRÍTICO — CLAUDE_CONFIG_DIR não herdado** (L58): se o Code.exe foi aberto sem a env no snapshot, cai no fallback `~/.claude` (vazio) → resolução falha 100%, e a mensagem "Foque uma aba de sessão" é **idêntica** à do estado benigno → indiagnosticável. Fix: Output Channel + `showWarningMessage` citando os paths tentados quando 0 dirs resolvem.
  - **ALTA**: match por prefixo `startsWith` amplia colisões (L195); TOCTOU no `saveNotes` clobbera status escrito pelo Claude (L340); sem `onDidDelete` no watcher (L292/293); `syncActiveTab` sem token de geração (corrida out-of-order, L273); `buildFile` **descarta conteúdo fora das zonas** (viola o contrato "fora das marcas é intocável", L48); `lastNotes` marcado como salvo **antes** do `writeFile` confirmar (falha de I/O = perda silenciosa, L341).
  - **MÉDIA/BAIXA**: `readRaw` trata qualquer erro como vazio (L245); `parseZones` aninha marcadores corrompidos (L33); botão "editar" abre 2º editor da mesma zona sem coordenação (L464); nonce via `Math.random()` (não CSPRNG, L419); `disposables`/cache de títulos sem limite (L92/396); só `workspaceFolders[0]` (multi-root, L70).
- **Auditado e OK**: `claudeProjectsDir()` honra `CLAUDE_CONFIG_DIR`; `encodeCwd` + variantes de drive resolvem o dir correto. 19 achados refutados na verificação adversarial (ex: "encodeCwd não cobre UNC", "cache não escopado por dir" — derrubados lendo o código).

### Verificação
- Root cause do "não preencheu": confirmado por grep no `out/extension.js` instalado (chip `.lapso`, sem `LAPSO.md`) × chip do painel ("LAPSO.md") + git log das versões — não inferência.
- Vazamento `.lapso/` no VSIX: `vsce ls` antes (8 arquivos, 2 `.md` de sessão) e depois do fix (6 arquivos, zero `.md` de sessão).
- Failure modes: cada achado passou por um verificador adversarial independente (real/refutado + confiança + citação de linha). Os 6 críticos = confiança alta (5) / média (1, o de env externa).
- ⚠️ Os 6 críticos são bugs de **concorrência/multi-sessão** — exigem o harness de 2 sessões concorrentes na VM (como o E2E que pegou os bugs do 0.2.1 anterior); NÃO shipados no v0.2.1 sem esse teste. Candidatos a **v0.2.2**.

### v0.2.2 — correção dos 6 críticos (Lucas escolheu "corrige tudo agora + testo antes de publicar")
- **Deleção segura**: o insight-chave é que **título não identifica sessão de forma única** (dois `aiTitle` iguais são indistinguíveis pela heurística) — então a deleção NÃO pode re-resolver por texto. Fix: `WeakMap<Tab,sessionId>` fixado na 1ª resolução; `onTabsClosed` deleta pela associação. Efeito colateral bom: aba comum com título colidente parou de apagar nota de sessão viva (o pior caso).
- **Save capturado**: o bug era clássico TOCTOU — o closure guardava o texto mas relia `currentSessionId` no disparo. Fix: capturar o `sessionId` junto do texto + flush na troca. Um `lastNotes` guard também passou a só atualizar quando o save é da sessão exibida.
- **Diagnóstico de env**: `CLAUDE_CONFIG_DIR` não herdado dava falha muda idêntica a "nada focado". Fix: Output Channel + warning 1× + estado `config-missing` no painel citando os paths.
- **Como testei sem VM**: escrevi `tests/concurrency.test.js` que **mocka o `vscode`** (FS em memória + tabGroups + webview) e dirige o **provider compilado real** pelos 3 cenários — 9/9. Prova a lógica dos fixes de concorrência de forma determinística (melhor que clicar à mão pra corrida). O E2E ao vivo de 2 sessões continua sendo o **gate de release** (confirma a integração com os eventos reais do VSCode).
- **Release GATED**: source commitado + VSIX 0.2.2 instalada local; `gh release`/Monday só após o teste ao vivo passar.

## 2026-07-30 — Repaginação terminal + distribuição (v0.2.0)

### Contexto
Dois pedidos: (1) por que "anota no lapso" falhou numa outra sessão; (2) repaginar o painel com cara de mini-terminal / código, tema Dracula Soft, divisórias estilo comentário de código.

### Desafios e descobertas
- **"anota no lapso" falhou porque a regra global tinha 2 furos**: enfatizava "não criar `LAPSO.md`" sem o outro lado (quando pedir, CRIE), e não travava a ambiguidade do nome "lapso" (que colide com "log/lapso de tempo"). Uma sessão do orquestrador escreveu `## LAPSO` dentro de `plans/comercial-orq-inercia-log.md` — o painel nunca mostrou, porque só lê `LAPSO.md` da raiz. Corrigido: gatilho explícito que autoriza criar + proibição de escrever em log de plano + formato leigo.
- **Regra global só vale pra sessão nova**: o CLAUDE.md é lido no início da sessão. A sessão que já estava rodando com a regra velha não pega a correção até reiniciar — documentado.
- **Layout terminal**: 10 mocks (Dracula Soft + Alucard, 5 estilos de divisória). Lucas escolheu o A2 (bloco inline `/* status */`). Implementado só mexendo no CSS/HTML do `buildHtml` — toda a lógica de zonas ficou intacta. O A2 é enxuto → cabe na largura estreita sem quebrar (a preocupação era com o banner box A3).
- **Distribuição em PC novo**: a pergunta "como instalo num PC formatado?" levou a anexar o `.vsix` ao GitHub Release (`gh release upload`). Descoberto no processo que o `.vscodeignore` deixava `mocks/` e docs vazarem pro pacote (13 arquivos) — corrigido pra 6.

### Verificação
- Tema A2: screenshot real do painel (idêntico ao mock, sem quebra na largura estreita).
- `.vsix` limpo: `vsce package` mostrou os 6 arquivos; anexo ao release confirmado via `gh release view`.

## 2026-07-29 — Nascimento do Lapso (v0.1.0)

### Contexto
Pedido inicial: notas estilo post-it flutuante no VSCode, preenchível à mão ou pelo Claude Code, "colado" na janela e trocando por sessão. Pergunta de fundo: dá pra criar janela sobreposta dentro do VSCode?

### Desafios e descobertas
- **Janela flutuante Win32 vs painel nativo**: testei os dois ao vivo. O overlay Win32 externo funciona (post-it grudado no canto via `GetWindowRect`+timer) mas é frágil (processo externo, snap/maximize atrapalha). O `WebviewView` nativo é a escolha certa: dockado, acompanha a janela e **troca por sessão de graça** — cada janela do VSCode roda sua própria instância da extensão, sem nenhuma lógica de detecção de sessão.
- **Não existe API pública** pra forçar posicionamento inicial na secondary side bar — é arraste manual de 1x, persistido pelo VSCode. Documentado.
- **`requestAnimationFrame` suspende em página sem foco**: o efeito de máquina de escrever travava a meio caminho no ambiente de teste. Causa-raiz: rAF fica suspenso indefinidamente quando o webview não tem foco genuíno. Fix: fallback `setTimeout` (imune a esse throttling) que força a revelação completa.
- **Origem do texto não é detectável por caractere**: a pergunta central do Lucas ("como saber o que é meu vs do Claude pra não sobrescrever?") não tem solução por detecção de autoria em texto plano. Resposta: **fronteira por marcador** (`<!-- lapso:status -->` vs `<!-- lapso:notes -->`) — a origem é definida pela zona. Cada zona salva relendo a outra do disco → impossível sobrescrever. Layout escolhido pelo Lucas: painel dividido (status em cima, notas embaixo).
- **Sanitização desde o início**: repo com intenção de compartilhamento futuro com a comunidade — grep por dados privados a cada etapa, screenshots de teste sempre em scratch fora do repo.
- **Erro cometido + corrigido**: rodei `taskkill /F /IM pwsh.exe` (mata TODO pwsh do sistema, não só o PID de teste). Conferido depois — sem dano. Passei a fechar janelas de teste por `WM_CLOSE` no hwnd específico.

### Verificação
- Painel/dock/live-update/typewriter/scrollbar: screenshot real do desktop (`.NET GDI CopyFromScreen`), não inferência.
- Lógica de não-sobrescrever: teste `node` 10/10 (salvar notas preserva status, atualizar status preserva notas, legado preservado, roundtrip, bootstrap).
- Pendente: confirmação visual do layout dividido — a tela travou (lock screen) no fim da sessão.
