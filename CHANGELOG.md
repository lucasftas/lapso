# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/). Este projeto segue versionamento semântico.

## [0.4.0] — 2026-08-07

### Added
- **Botão "pedir status"**: barra fina no rodapé do painel ("⟳ pedir status à sessão"). Pro fluxo de sessão **ocupada**: o clique grava `.lapso/<sessionId>.request` e um hook do Claude Code (`PostToolUse` + `Stop`; receita no README) injeta a instrução — a própria sessão atualiza a nota **no meio do turno**, sem parar o que está fazendo. Estados: aguardando (pulsante) → "✓ status atualizado agora"; sem resposta em 90 s, avisa que a sessão está parada (aí é pedir direto no chat). O pedido pendente morre junto com a aba (sem flag órfão), e o host recusa pedido de sessão que não é a exibida.
- 14 asserts novos (bloco `[G]`): 104 no total.

## [0.3.3] — 2026-08-06

Organização do repositório no padrão da indústria (sem mudança de comportamento da extensão) e **abertura do repositório ao público** com histórico compactado.

### Added
- CI GitHub Actions: `npm test` (90 asserts) roda em push, pull request e disparo manual.
- Scaffold `.vscode/` (`launch.json` + `tasks.json`) — F5 abre o Extension Development Host como o README descreve.
- Campos `bugs` e `homepage` no manifest e script `vscode:prepublish` (compila antes de todo empacotamento).
- Notas de evolução na Spec (espelhando a do PRD) e aviso histórico no mock do storyboard.

### Changed
- O `CHANGELOG.md` passou a entrar no `.vsix` — a aba Changelog da página do Marketplace passa a existir a partir do próximo upload.
- Documentação sanitizada: nomes de infra interna, projetos privados e paths de máquina saíram de todos os arquivos versionados (o registro técnico ficou).
- Exemplos de instalação usam placeholder `lapso-<versão>.vsix` em vez de versão fixa; instruções do modelo pré-v0.3.1 ("ícone na Activity Bar") atualizadas pro acordeon dentro da aba do Claude Code.
- Histórico do git compactado num único commit raiz na abertura ao público (backup completo pré-compactação preservado fora do repo).

### Removed
- Código morto: campo `webviewReady` (nunca lido), helpers e exports de teste sem consumidor, entrada morta `LAPSO.md` no `.vscodeignore`, `.vsix` antigos soltos na raiz (todos anexados nos releases do GitHub).

### Fixed
- Suíte de testes divergia em runner Linux (CI): o harness simula ambiente Windows e agora declara `process.platform = win32` — sem isso a dedup de variantes de drive `d--`/`D--` cobrava duas varreduras e um assert de custo falhava.

## [0.3.2] — 2026-08-06

### Fixed
- **Repo novo era acusado de erro de configuração.** Abrir um projeto que ainda não teve nenhuma sessão do Claude Code (a pasta de transcripts dele só nasce com a primeira sessão) caía no mesmo caminho de "transcripts não encontrados": pop-up de alerta e painel dizendo que `CLAUDE_CONFIG_DIR` podia não estar visível pro VSCode — mesmo com a configuração perfeita. Os dois casos agora são distintos: a raiz `<CLAUDE_CONFIG_DIR>/projects` é sondada só quando a pasta do projeto falha, e a raiz presente vira o estado calmo `(sem sessão neste projeto)`, sem pop-up e sem texto de erro. O alerta real continua saindo quando a raiz de fato não existe.

### Added
- Estado `no-sessions-here` no painel, com log próprio em Output → Lapso (uma vez por sessão do painel, não a cada retry).
- 10 asserts novos (`[v0.3.2 · Cenário 3b/3c]`), incluindo o render do painel pelo sandbox do webview: 90 no total.

## [0.3.1] — 2026-08-05

### Changed
- **O painel do Lapso agora mora DENTRO da aba do Claude Code** (lista de sessões, Activity Bar esquerda), como acordeon "Lapso — Nota da sessão" — no padrão dos acordeons do Explorador. A view foi contribuída ao container `claude-sessions-sidebar` da extensão Claude Code; o ícone próprio do Lapso na Activity Bar deixa de existir. Sem mudança de código — só manifest (a view ganhou `icon` e `contextualTitle` pra manter identidade se for arrastada pra outro lugar).

### Removed
- Container próprio `lapsoContainer` na Activity Bar (substituído pelo dock acima).

## [0.3.0] — 2026-08-04

Refatoração de **resiliência e persistência** do painel, a partir de uma auditoria adversarial que fechou **11 causas confirmadas + 12 riscos latentes**. A animação de digitação do status foi mantida intencionalmente como estava.

### Fixed
- **Painel ficava preso no placeholder.** A chave de deduplicação do render guardava só o texto do status; depois de passar por "sessão não identificada", voltar pra mesma sessão com o mesmo status batia "nada mudou" e nada era re-desenhado — o painel ficava cinza com o status existindo no arquivo. A chave agora é `sessionId ⊕ status`, e todo estado neutro a zera.
- **Painel se limpava sozinho durante o rename da sessão.** O `ai-title` muda ao longo da sessão e o label da aba dessincroniza do `.jsonl` por alguns segundos; qualquer falha de resolução zerava a sessão exibida. Agora a associação aba→sessão é **pegajosa**: só é abandonada quando a aba muda de identidade.
- **Sessão nova (~1 min sem título no transcript) não se recuperava sozinha.** Agora há **retry com backoff** (1s→2s→4s→…→60s) e observação da pasta de transcripts — o painel encontra a sessão sem o usuário mexer em nada.
- **Watcher morria e nunca voltava.** Era re-armado só no ramo de troca de sessão; depois de o painel ser descartado e recriado, ficava morto e o painel só mudava ao trocar de aba. Agora o watcher cobre a **pasta** `.lapso/*.md`, é idempotente, trata `onDidDelete` e entra em `context.subscriptions`.
- **Painel podia morrer de vez** quando um `dispose` atrasado do painel antigo chegava depois do `resolve` do novo (zerava a referência da view nova). Resolvido com token de view.
- **Notas de uma sessão apareciam (e eram salvas) em outra** quando o cursor estava dentro do campo durante a troca de aba. A substituição agora é obrigatória quando a sessão muda; o foco só preserva o texto dentro da mesma sessão.
- **Digitação recente era descartada em silêncio** ao fechar/mover o painel ou desligar a extensão. Agora há flush pendente no `dispose` e no `deactivate`.
- **Salvar as notas fazia o status do Claude voltar atrás** (read-modify-write sem trava). Agora é compare-and-set com até 3 tentativas.
- **Texto fora das duas zonas era apagado** na regravação. Prólogo e epílogo do arquivo são preservados.
- **Arquivo pego no meio da escrita** virava lixo na tela (markdown cru dentro do campo) e podia apagar a zona de status no disco. Leitura parcial agora é detectada e ignorada — mantém o último estado bom.
- **Erro transitório de I/O fazia o status piscar e sumir** (todo erro virava string vazia). Agora distingue inexistente × erro × vazio, e registra a falha em Output → Lapso.
- **Nota ressuscitava órfã**: um save debounced podia disparar depois do delete do fechamento da aba, recriando um arquivo que nunca mais seria apagado. Escritas e deleções agora são serializadas por sessão, e fechar a aba cancela o save pendente.
- **Falha de escrita marcava a nota como salva** (perda silenciosa) e podia derrubar o provider. Agora só marca depois da confirmação, e a falha é tratada.
- **Aba de sessão nunca focada fechava sem apagar a nota** — `.lapso/` acumulava órfãos. A associação aba→sessão agora é persistida e adotada mesmo sem foco.
- **Rajada de eventos de aba** (uma troca dispara 2-3) fazia varreduras concorrentes, sem ordem garantida, podendo exibir a sessão errada e gerar `config-missing` falso. Agora há coalescing, execução serializada e token de geração.
- **Campo de notas nascia habilitado** sem sessão: o usuário digitava e o texto era descartado sem nenhum aviso.
- **CSS**: `#content` e `#notes` sem `min-height: 0` estouravam o painel (fundo cortado, sem barra de rolagem); o status não acompanhava o texto revelado.

### Added
- **Restauração instantânea do painel** (`getState`/`setState`) + handshake `ready` com o host: reabrir o painel ou recarregar a janela mostra o conteúdo na hora.
- **Poll de segurança** (3 s, só com o painel visível): a nota atualiza mesmo se o watcher não entregar o evento.
- **Índice de títulos persistido** por workspace: reabrir a janela não paga varredura fria de novo.
- **Suíte de testes de resiliência** (`tests/resilience.test.js`, 71 asserts) + harness reutilizável com `vscode` e `node:fs` mockados e **sandbox que executa o script real do webview** (`tests/webview-sandbox.js`). Total: **80 asserts**, `npm test`.

### Performance
Resolução de sessão (medida contra os diretórios de transcripts reais, somente leitura):

| cenário | antes | depois (1ª vez) | após reload | em uso |
|---|---|---|---|---|
| 116 transcripts / 428 MB | **2347 ms** | 389 ms | 5 ms | **0 ms** |
| 38 transcripts / 133 MB | **713 ms** | 131 ms | 2 ms | **0 ms** |

- Transcript grande deixa de ser lido inteiro: duas janelas de tamanho fixo (cabeça + cauda) em vez de `readFile` + `toString` + `split` do arquivo todo (o maior do parque tem 76,8 MB, e isso rodava **síncrono na thread do extension host**).
- Sessão viva (cujo `.jsonl` cresce a cada mensagem, dando cache miss garantido) passa a ter só o **delta** relido.
- O mesmo diretório físico não é mais varrido duas vezes (as variantes `d--`/`D--` apontam pro mesmo lugar no NTFS).
- **Cache negativo por título** e saída no primeiro match: focar um arquivo comum — o evento mais frequente — passou a custar **zero** I/O.

## [0.2.3] — 2026-08-04

### Fixed
- **Descrição do Marketplace não batia com o produto** (`package.json` → `description`). O texto ainda era o do v0.1.0 e errava em 4 pontos: dizia **"flutuante"** (é dockado — `WebviewView` na Activity Bar; a janela flutuante Win32 foi descartada ainda no spike), **"por janela/sessão do VSCode"** (é por **sessão do Claude Code** — o painel segue a aba de sessão em destaque e resolve título→`sessionId` pelos transcripts `.jsonl`; uma janela pode ter N notas), **`.lapso/nota.md`** (arquivo que não existe desde o v0.2.0 — é `.lapso/<sessionId>.md`) e **"manual ou pelo Claude"** (são **duas zonas no mesmo arquivo**, não alternativas). Novo texto descreve o comportamento real. Publicada no Marketplace e conferida na API pública (`extensionquery`), não só na página web — a página mostra o metadado novo enquanto o pacote ainda está em `Verifying`, então só a API prova que está no ar de verdade.
- **`CLAUDE.md` e `docs/specs/PRD.md` ensinavam o modelo antigo** (`LAPSO.md` na raiz). `CLAUDE.md` atualizado pro modelo por-sessão; o PRD, que congela o MVP v0.1.0 por definição, ganhou nota de evolução apontando pro README.

### Added
- `keywords` no manifest (`claude code`, `post-it`, `notas`, `sessão`, `notes`, `sticky note`) — a extensão não aparecia em busca por termo relacionado.
- `.playwright-mcp/` no `.gitignore`: os snapshots de sessões de publicação guardam dados da conta logada (e-mail do publisher). Repo com intenção de virar público — não versionar.

### Known gaps
- Sem `icon` no manifest → o Marketplace mostra o ícone genérico. O `resources/icon.svg` só serve pra Activity Bar; a galeria exige **PNG 128×128**.

## [0.2.2] — 2026-08-02

### Added (publicação no marketplace)
- **Publicada no Visual Studio Marketplace** como [`lucasftas.lapso`](https://marketplace.visualstudio.com/items?itemName=lucasftas.lapso). Publisher `lucasftas` criado nesta data (via portal manage, sem PAT). Instalável por `code --install-extension lucasftas.lapso` e replicada automaticamente pelo **Settings Sync** em todas as máquinas logadas na conta — resolve o "sincronizar pela minha conta do VSCode". Ajustes de manifest pra publicar: `repository` adicionado, `private` removido.

### Fixed (6 críticos de perda de dados, achados na auditoria adversarial do v0.2.1)
- **Deleção ao fechar aba apagava a nota da sessão errada** (L356/360/367/171): `onTabsClosed` re-resolvia por texto (sem guard `isClaudeSessionTab`) e o desempate por `mtime` escolhia a sessão VIVA mais recente. Agora usa uma **associação estável aba→sessionId** (`WeakMap<Tab,sessionId>`) fixada na 1ª resolução — deleta exatamente a nota da aba fechada, nunca por colisão de título. Fechar aba comum / sessão viva não apaga mais nada.
- **Save cruzava sessão** (L326/345): `saveNotes` lia `currentSessionId` no disparo do debounce → trocar de aba dentro de ~900ms gravava o texto de A em `.lapso/B.md`. Agora o `sessionId` é **capturado na digitação** e passado por parâmetro; troca de sessão faz **flush** do save pendente pra sessão certa.
- **`CLAUDE_CONFIG_DIR` não visível → falha total silenciosa** (L58): se a env não chega ao processo do VSCode, caía no fallback `~/.claude` vazio e a mensagem era idêntica à de "nada focado". Agora há **Output Channel "Lapso"** + `showWarningMessage` (1×) + estado distinto `config-missing` no painel citando os paths tentados.

### Added
- `tests/concurrency.test.js` + script `npm test`: teste de integração (mock do `vscode` dirigindo o provider real) cobrindo os 3 cenários acima — 9/9 passam. Regressão automatizada pros bugs de concorrência.

### Housekeeping
- `onDidDispose` reseta `disposables`/`pendingSave`/`view` (evita refs órfãs ao reabrir o painel).

> Publicada no marketplace em 2026-08-02 (`lucasftas.lapso`) + release v0.2.2. ⚠️ **Honestidade**: os 6 fixes têm teste de mock (9/9), mas o **E2E ao vivo de 2 sessões simultâneas NÃO foi executado nesta sessão de publicação** — segue recomendado como validação final da integração com os eventos reais do VSCode.

## [0.2.1] — 2026-08-01

### Changed
- **Virada de arquitetura — nota por SESSÃO do Claude Code, não por repo.** Antes: um `LAPSO.md` versionado por workspace. Agora: `.lapso/<sessionId>.md` (no `.gitignore`), uma nota por sessão, temporária.
- **Painel segue a aba em destaque**: resolve a aba de sessão ativa → `sessionId` casando o título da aba (`aiTitle`/`customTitle`) com os transcripts `.jsonl` do Claude Code. Troca de aba → troca a nota. Usa `vscode.window.tabGroups` (`onDidChangeTabs`).
- **Casamento preciso por ID**: o Claude escreve em `.lapso/<seu-sessionId>.md`; a extensão resolve aba→sessionId pelo título — convergem no mesmo arquivo, sem heurística de "aba da frente".
- **README atualizado pro modelo por-sessão**: a seção "Convenção pro Claude Code" ainda mandava escrever `LAPSO.md` na raiz (texto do modelo antigo) — agora descreve `.lapso/<sessionId>.md`.

### Added
- Descarte automático: ao fechar a aba de uma sessão, a nota `.lapso/<sessionId>.md` dela é apagada.
- Nota no README sobre o **reinstall sem reload**: VSCode não recarrega a extensão em memória sozinho; por isso cada build sobe a versão (garante que o reload pegue o código novo).

### Fixed (bugs achados no teste E2E na VM)
- **Regex de título frágil à ordem dos campos**: o `.jsonl` grava `{type,aiTitle,sessionId}` e `{type,sessionId,aiTitle}` em ordens diferentes; o regex exigia `aiTitle` colado no `type` e perdia a entrada mais recente. Agora filtra a linha pelo `type` e extrai `aiTitle`/`customTitle` de qualquer posição.
- **`tab.label` vem truncado com "…"**: a API do VSCode trunca o label de abas longas (ex "Responder com palavra ún…"), quebrando o match exato. Agora o match tolera truncação (prefixo) + normaliza Unicode (NFC) pra acentos.

### Diagnosticado (não é bug de código)
- **Painel mostrava placeholder mesmo com nota escrita**: o host da extensão em memória era o build antigo (modelo `LAPSO.md` raiz) — a 0.2.0 foi reinstalada por cima da mesma versão sem `Reload Window`, então o código por-sessão on-disk nunca ativou. Bump pra 0.2.1 força o VSCode a reconhecer a atualização.

### Verificado
- **E2E completo na VM Windows 10** (Claude Code real, 2 sessões, troca de aba ao vivo): aba longa→nota A, aba curta→nota B, troca via atalho→painel troca junto. Casamento preciso por sessionId confirmado por screenshot. O teste na VM pegou os 2 bugs acima que o teste no host (dados de 1 sessão, título curto sem acento) não revelava.
- Resolução título→sessionId também testada contra transcripts `.jsonl` reais no host (2/2).

[0.2.1]: https://github.com/lucasftas/lapso/releases/tag/v0.2.1

## [0.2.0] — 2026-07-30

### Added
- **Tema Dracula Soft, painel estilo mini-terminal / código** (mock A2): chrome com 3 dots + `LAPSO.md`, fundo `#282a36`, fonte monospace, divisórias `/* status */` e `/* notas */` em cor de comentário. Status leigo em claro, notas em amarelo.
- Storyboard de referência com 10 variações de layout (5 escuro Dracula Soft + 5 claro Alucard × 5 estilos de divisória) em `mocks/lapso-terminal-storyboard.html`.
- **Distribuição para PC novo**: `.vsix` limpo anexado ao GitHub Release — instalar em máquina formatada = baixar do release + `code --install-extension`, sem buildar.
- README com passo-a-passo de instalação (release rápido + build do código).

### Changed
- Formato do status agora é **leigo** (🎯 objetivo / 🔄 agora / 📍 estado / 🕒 hora), foto do momento reescrita a cada prompt — sem jargão técnico.

### Fixed
- `.vscodeignore` deixava `mocks/` e docs vazarem pro pacote `.vsix` — agora o pacote leva só o essencial (6 arquivos).

[0.2.0]: https://github.com/lucasftas/lapso/releases/tag/v0.2.0

## [0.1.0] — 2026-07-29

### Added
- Extensão VSCode **Lapso**: post-it dockado por janela/sessão, um ícone próprio na Activity Bar com `WebviewView`.
- Painel **dividido em duas zonas** gravadas no mesmo `LAPSO.md`, demarcadas por marcador HTML:
  - **Status** (`<!-- lapso:status -->`) — território do Claude Code, read-only no painel, com efeito de máquina de escrever.
  - **Notas** (`<!-- lapso:notes -->`) — território do usuário, campo editável direto no painel.
- **Não-sobrescrever por design**: cada zona salva relendo a outra do disco e recombinando — impossível uma parte apagar a outra.
- Preservação de texto livre legado: `LAPSO.md` pré-existente sem marcadores vira nota, nada é descartado.
- Atualização em tempo real via `FileSystemWatcher` + `onDidChangeTextDocument` (edição por fora reflete no painel sem reload).
- Efeito de máquina de escrever na zona status (revelação por tempo decorrido com `requestAnimationFrame` + fallback `setTimeout` pra páginas sem foco).
- Scrollbar estilizada combinando com o post-it, contida no campo (não vaza a barra nativa do webview).
- Content-Security-Policy explícito no webview (`default-src 'none'`, nonce por render).
- Convenção de arquivo `LAPSO.md` na raiz do workspace (versionável, ao lado de README/CHANGELOG).

### Security
- Webview usa `<textarea>`/`textContent` (nunca `innerHTML` cru) — sem superfície de injeção via `.md` de fonte não confiável.

[0.1.0]: https://github.com/lucasftas/lapso/releases/tag/v0.1.0
