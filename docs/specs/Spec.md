# Spec — Lapso v0.1.0 (repo: notes-session-vscode, hoje lapso)

> Nota de processo: Spec escrita retroativamente — milestones abaixo já foram implementados e testados ao vivo (screenshot real do desktop, não inferência). Marcados `[x]` porque de fato rodam, não porque "devem" rodar.

> ⚠️ **Evoluiu desde o v0.1.0** (esta Spec congela o MVP). Modelo atual: nota **por sessão do Claude Code** em `.lapso/<sessionId>.md` (gitignored, descartada quando a aba fecha), view dockada no container `claude-sessions-sidebar` da extensão Claude Code (sem container/ícone próprio na Activity Bar desde a v0.3.1), painel de texto simples sem renderização markdown. `LAPSO.md` na raiz não existe mais. Ver `README.md` pro comportamento vigente.

## Visão geral da implementação
Extensão única, um arquivo TypeScript (`src/extension.ts`): provider de `WebviewView` + renderer markdown-ish + comando de edição. Sem bundler (compila direto com `tsc`), sem dependências de runtime além da API do VSCode.

## Milestone M1 — Painel dockado + ícone na Activity Bar
**Objetivo**: extensão ativa, ícone próprio aparece, painel abre ao clicar.
**Aceitação**: pra que o Lucas consiga achar o Lapso em qualquer janela do VSCode, dado que a extensão está instalada → um ícone de post-it aparece na Activity Bar e abre um painel lateral ao clicar.
**Critério de pronto**: `npm run compile` sem erro; Extension Development Host mostra o ícone; clicar abre o painel.
**Cenários de teste**: happy `clica no ícone, painel abre` · edge `nenhum (ícone estático)` · erro `n/a nesta etapa`

- [x] `package.json` (criar) — `viewsContainers.activitybar` + `views.lapsoContainer` + comando `lapso.openNote`
- [x] `resources/icon.svg` (criar) — ícone de post-it, estilo VSCode Activity Bar (`currentColor`)
- [x] `src/extension.ts` (criar) — `activate()` registra `WebviewViewProvider`

## Milestone M2 — Nota por workspace + renderização markdown
**Objetivo**: `LAPSO.md` é criado automaticamente e renderizado no painel.
**Aceitação**: pra que o Lucas (ou o Claude Code) escreva uma nota sem setup manual, dado que abre uma janela nova → `LAPSO.md` já existe com um template e aparece renderizado no painel.
**Critério de pronto**: abrir workspace sem `LAPSO.md` → arquivo é criado com o template; painel mostra o conteúdo formatado (H1, parágrafo).
**Cenários de teste**: happy `workspace sem LAPSO.md → cria + renderiza` · edge `workspace sem pasta aberta → mensagem "abra uma pasta"` · erro `arquivo com markdown malformado → renderiza o que der, sem crashar`

- [x] `src/extension.ts` — `ensureNoteFile`, `readNote`, `renderMarkdownish` (suporta `#`/`##`/`###`, `**bold**`, `*italic*`, listas `-`)
- [x] Testado ao vivo: painel mostrou "Nota da sessão" + parágrafo do template, renderizado (não texto cru)

## Milestone M3 — Atualização em tempo real
**Objetivo**: editar o `.md` (por fora ou por dentro do VSCode) atualiza o painel sem reload.
**Aceitação**: pra que o Claude Code preencha a nota e o Lucas veja na hora, dado que o `.md` mudou → o painel reflete o novo conteúdo em menos de 1s, sem precisar fechar/abrir o painel.
**Critério de pronto**: escrever no arquivo externamente (fora do editor) → painel atualiza sozinho.
**Cenários de teste**: happy `escrita externa → live-update` · edge `múltiplos saves seguidos rápidos → painel reflete o último` · erro `arquivo deletado → n/a (watcher não trata delete nesta versão, risco conhecido)`

- [x] `src/extension.ts` — `FileSystemWatcher` (`onDidChange`/`onDidCreate`) + `vscode.workspace.onDidChangeTextDocument`
- [x] Testado ao vivo: escrevi `LAPSO.md` via ferramenta externa (Write, simulando Claude Code) → screenshot real do desktop confirmou o painel atualizado com o novo conteúdo (heading + negrito + lista), sem reload manual

## Milestone M4 — Hardening (CSP) antes de compartilhar
**Objetivo**: webview não roda com script-src/default-src abertos, já pensando em compartilhamento futuro com a comunidade.
**Aceitação**: pra que o projeto seja seguro de abrir em repositório de terceiro, dado que o `LAPSO.md` pode vir de fonte não confiável → o webview só executa o script nonced da própria extensão, sem carregar rede/scripts externos.
**Critério de pronto**: `Content-Security-Policy` presente no HTML do webview (`default-src 'none'`, `script-src 'nonce-...'`); recompila e o painel continua funcionando.
**Cenários de teste**: happy `CSP presente + painel funcionando` · edge `n/a` · erro `n/a`

- [x] `src/extension.ts` — `buildHtml` recebe `webview`, gera nonce por render, `<meta http-equiv="Content-Security-Policy">`, `<script nonce="...">`
- [x] Testado ao vivo após a mudança: painel voltou a abrir e mostrou o conteúdo já editado do teste anterior — nada quebrou

## Milestone M5 — Efeito de máquina de escrever no update
**Objetivo**: quando a nota muda, o texto novo aparece caractere por caractere, não trocado instantaneamente.
**Aceitação**: pra que o Lucas perceba visualmente que a nota "está sendo escrita" (por ele ou pelo Claude Code), dado que o conteúdo mudou → os caracteres surgem gradualmente no painel.
**Critério de pronto**: escrever nota nova externamente → capturas de tela em sequência mostram texto parcial crescendo até completar.
**Cenários de teste**: happy `nota curta revela rápido e por completo` · edge `edição direta no editor (tecla a tecla) é debounced em 350ms pra não disparar animação a cada tecla` · erro `página com timer de animação suspenso (rAF parado) → fallback via setTimeout força a revelação completa`

- [x] `src/extension.ts` — `typewriterReveal` no webview: `TreeWalker` sobre os text nodes do HTML renderizado, revelação por tempo decorrido (`performance.now()`) em vez de contagem de ticks fixos — self-corrige se frames forem pulados
- [x] `src/extension.ts` — debounce de 350ms em `onDidChangeTextDocument` (evita re-render a cada tecla ao editar direto no arquivo)
- [x] **Bug real encontrado e corrigido durante o teste ao vivo**: com `requestAnimationFrame` puro, a animação as vezes travava a meio caminho e nunca terminava — descobri que `requestAnimationFrame` fica **suspenso indefinidamente** quando a página do webview não tem foco genuíno (reproduzido de forma consistente no ambiente de automação usado pra testar). Fix: `setTimeout` de segurança (`MAX_DURATION_MS + 200`) que força a revelação completa — `setTimeout` sobrevive a esse throttling, `requestAnimationFrame` não. Confirmado ao vivo: nota completa (heading + 2 parágrafos) apareceu 100% depois do fallback disparar.

## Milestone M6 — Edição direta no painel (pivot de escopo)
**Objetivo**: painel em branco sem `LAPSO.md`; digitar direto no painel cria/atualiza o arquivo; atualização externa não interrompe quem está digitando.
**Aceitação**: pra que o Lucas escreva a nota sem precisar abrir um editor separado, dado que o painel está vazio → ele digita ali mesmo e o `LAPSO.md` aparece sozinho no repo.
**Critério de pronto**: workspace sem `LAPSO.md` → painel abre em branco (sem template); nenhum arquivo é criado até o primeiro input.
**Cenários de teste**: happy `workspace limpo → painel em branco, sem LAPSO.md no disco` · edge `escrita externa chega enquanto o campo está focado → ignorada até perder o foco (não FROM apaga o que a pessoa está digitando)` · erro `texto idêntico ao último salvo → não reescreve o arquivo à toa`

- [x] `src/extension.ts` — removido `renderMarkdownish`/`escapeHtml` (código morto após o pivot — painel não renderiza mais HTML)
- [x] `src/extension.ts` — `<textarea>` no lugar do `<div>` read-only; evento `input` com debounce de 400ms envia `{command:'save', text}`; extensão grava via `vscode.workspace.fs.writeFile` (mesma API já testada em M2/M3)
- [x] `src/extension.ts` — `ensureNoteFile` removido; `readNote` retorna `''` se o arquivo não existe, sem criar nada — satisfaz "fica em branco"
- [x] `src/extension.ts` — guarda de foco (`hasFocus`) no webview: atualização externa só aplica quando o campo não está em edição ativa
- [x] Testado: `ls` no workspace de teste após ativação confirma **zero arquivo criado** (antes criava `LAPSO.md` com template automaticamente) — valida a parte de "fica em branco" via inspeção direta do disco
- [x] **Bônus de segurança do pivot**: como o conteúdo nunca mais passa por `innerHTML`, a superfície de risco de injeção via `.md` malicioso (documentada em `PRD.md` → Riscos) deixou de existir
- [ ] Pendente: confirmação visual do fluxo "digitar → arquivo aparece" (bloqueado nesta sessão porque a janela em primeiro plano do ambiente de teste era uma sessão RDP ativa do Lucas — não forcei foco pra não interromper o trabalho dele real). Verificação rápida (~10s) fica pro próprio Lucas ou pra próxima sessão.

## Milestone M7 — Scrollbar estilizada
**Objetivo**: quando o conteúdo passa da altura, a barra de rolagem combina com o post-it em vez da barra nativa do webview.
**Critério de pronto**: conteúdo longo → barra fina cor oliva translúcida, contida no campo (não vaza a barra do VSCode).

- [x] `src/extension.ts` — `::-webkit-scrollbar` fino oliva translúcido (`rgba(120,110,40,...)`) + `scrollbar-width: thin`; `body/html { overflow: hidden }` pra o scroll ficar contido no campo
- [x] Validado pelo Lucas (viu o scroll com a barra nativa e pediu estilizar)

## Milestone M8 — Duas zonas: status (Claude) + notas (você), sem sobrescrever
**Objetivo**: separar o que o Claude preenche (status ao vivo) do que é do usuário (notas), de forma que nenhum apague o outro.
**Aceitação**: pra que o Lucas leia rápido "o que está rodando e o objetivo" sem perder suas anotações manuais, dado que Claude e usuário escrevem no mesmo `LAPSO.md` → cada um tem sua zona demarcada e intocável pela outra parte.
**Decisão-raiz**: não dá pra detectar autoria por caractere em texto plano → fronteira por **marcador** (`<!-- lapso:status -->` / `<!-- lapso:notes -->`), não por detecção. Layout do painel dividido (decisão do Lucas): status read-only em cima, notas editáveis embaixo.
**Cenários de teste**: happy `roundtrip build→parse fiel` · edge `texto livre legado sem marcador → vira nota, nada perdido` · erro `salvar uma zona relê a outra do disco antes de escrever → impossível sobrescrever`

- [x] `src/extension.ts` — `parseZones`/`buildFile`/`extractBetween`: extrai as zonas por marcador; `buildFile` reconstrói o arquivo canônico com as 4 marcas
- [x] `src/extension.ts` — `saveNotes` relê o disco, preserva a zona `status` atual e regrava só a `notes` (e vice-versa quando o Claude edita `status`)
- [x] `src/extension.ts` — painel dividido: `#status` (div read-only, efeito typewriter, faixa superior) + `#notes` (textarea editável, faixa inferior) + labels de zona + divisória
- [x] **Testado por lógica (10/10)** — `node` script exercitando `parseZones`/`buildFile`: roundtrip, legado preservado, **salvar notas não apaga status**, **atualizar status não apaga notas**, bootstrap vazio. É o núcleo do "não-sobrescrever", validado sem depender de tela.
- [ ] Pendente: confirmação **visual** do layout dividido (status em cima + notas embaixo, cores, divisória). Bloqueado nesta sessão — a tela travou (lock screen, `foreground=0`, `CopyFromScreen` = "handle invalid") durante o teste. Verificação de ~10s fica pro Lucas ao destravar, ou próxima sessão.

## Regra de preenchimento do status (a definir em regra global do Lucas)
- O Claude preenche a zona `lapso:status` a cada resposta (decisão do Lucas: "toda resposta").
- Escreve SEMPRE via edição cirúrgica mirando entre `<!-- lapso:status -->` e `<!-- /lapso:status -->` — nunca reescreve o arquivo inteiro.
- Fora dos marcadores = território do usuário, intocável sem pedido expresso.
- Formato do status (campos exatos: Ação/Objetivo/Desde/Previsão) + limite de caracteres (pra não gerar scroll) — a fechar com o Lucas.

## Ordem de execução
M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 (cada um com critério de pronto verificado; M6/M8 têm parte visual pendente conforme as notas)

## Testes/validação
- M1–M5, M7: verificados com captura de tela real do desktop (`.NET GDI CopyFromScreen` + leitura da imagem).
- M6: estado "em branco" verificado por inspeção de disco; fluxo visual digitar→arquivo pendente.
- M8: núcleo (não-sobrescrever) verificado por teste de lógica em `node` (10/10); layout visual pendente (tela travada na sessão).
- Pendente pra v0.2.0: teste com múltiplas janelas simultâneas; teste de posicionamento manual na secondary side bar; empacotamento `.vsix` final revisado antes de qualquer publicação pública.

---
**Self-score**: 9/10. Cobertura de escopo: ok (todo item do README/PRD virou milestone). Critério de pronto mensurável: ok. Premissa crítica atacada cedo: ok (M1–M3 validam a premissa antes de M4 ser sequer necessário). Edge+erro: parcial — delete de arquivo não tratado (risco conhecido, documentado, não bloqueia v0.1.0). Granularidade: ok.
