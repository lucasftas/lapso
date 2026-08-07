// Suíte de resiliência e persistência (v0.3.0).
//
// Cobre as 23 correções levantadas na auditoria de 04/08/2026. Cada bloco de asserts
// corresponde a um item do levantamento; o nome do assert cita o defeito original.
// O que NÃO é coberto aqui (depende de render vivo) está listado no relatório final.

const h = require("./harness.js");
const {
  ext, mem, state, ok, section, boot, focus, closeTab, claudeTab, fileTab,
  transcript, transcriptNoTitle, appendTitle, noteBody, notesOf, statusOf,
  fireWatcher, liveWatchers, settle, wait, lastPosted, makeFakeView, makeContext,
  LAPSO, PROJECTS_DIR,
} = h;

const { createWebviewSandbox } = require("./webview-sandbox.js");

async function seedBasic(opts = {}) {
  const b = await boot(opts);
  transcript("sA", "Corrigir login");
  transcript("sB", "Corrigir cadastro");
  mem.write(LAPSO + "/sA.md", noteBody("STATUS DE A", "notas A"));
  mem.write(LAPSO + "/sB.md", noteBody("STATUS DE B", "notas B"));
  return b;
}

async function run() {
  // ================= BLOCO A — webview nunca fica preso =================

  section("[A1] Voltar pra mesma sessão re-renderiza o status (placeholder pegajoso)");
  {
    const { sandbox } = await seedBasic({ sandbox: true });
    transcriptNoTitle("sNova");
    const tabA = claudeTab("Corrigir login");
    await focus(tabA);
    ok(sandbox.statusText() === "STATUS DE A", "status de A aparece na 1ª vez");
    ok(!sandbox.isPlaceholder(), "não está no placeholder com sessão resolvida");

    await focus(claudeTab("Sessão sem título ainda"));
    ok(sandbox.isPlaceholder(), "aba de sessão não resolvida cai no placeholder");

    await focus(tabA);
    ok(
      sandbox.statusText() === "STATUS DE A" && !sandbox.isPlaceholder(),
      "voltar pra A com o MESMO status re-desenha (antes ficava preso no placeholder)"
    );
  }

  section("[A2] Notas não vazam pra tela de outra sessão / placeholder é restaurado");
  {
    const { sandbox } = await seedBasic({ sandbox: true });
    await focus(claudeTab("Corrigir login"));
    ok(sandbox.notesValue() === "notas A", "notas de A carregadas");
    await focus(claudeTab("Sessão sem título ainda"));
    ok(sandbox.notesValue() === "", "campo de notas é limpo ao perder a sessão");
    ok(sandbox.notesDisabled() === true, "campo desabilitado sem sessão");
    await focus(claudeTab("Corrigir login"));
    ok(sandbox.notesDisabled() === false, "campo reabilitado ao voltar");
    ok(
      sandbox.els.notes.placeholder === "// suas anotações",
      "placeholder do campo volta ao original (antes ficava 'Abra/foque uma aba...' pra sempre)"
    );
  }

  section("[A3] Trocar de sessão com o cursor no campo troca o texto (e não salva na sessão errada)");
  {
    const { sandbox, view } = await seedBasic({ sandbox: true });
    await focus(claudeTab("Corrigir login"));
    sandbox.focusNotes();
    await focus(claudeTab("Corrigir cadastro"));
    ok(
      sandbox.notesValue() === "notas B",
      "com foco no campo, trocar de sessão SUBSTITUI o texto (antes ficava o da sessão anterior)"
    );
    sandbox.typeNotes("texto novo em B");
    await settle(520); // o campo tem debounce próprio de 400 ms antes de avisar o host
    ok(notesOf("sB") === "texto novo em B", "digitação foi pra sB");
    ok(notesOf("sA") === "notas A", "nota de sA intacta");

    // Mesma sessão + digitando: NÃO sobrescreve o que está sendo escrito.
    sandbox.focusNotes();
    sandbox.els.notes.value = "rascunho em andamento";
    view.sendToHost({ command: "noop" });
    mem.write(LAPSO + "/sB.md", noteBody("STATUS NOVO DE B", "texto novo em B"));
    fireWatcher("change", LAPSO + "/sB.md");
    await settle(60);
    ok(
      sandbox.notesValue() === "rascunho em andamento",
      "na MESMA sessão, atualização do arquivo não atropela o que está sendo digitado"
    );
  }

  section("[A4] Campo de notas nasce desabilitado (não engole digitação em silêncio)");
  {
    const { sandbox } = await boot({ sandbox: true });
    ok(sandbox.notesDisabled() === true, "textarea nasce disabled antes de qualquer sessão");
  }

  section("[A5] Painel restaura o último render sozinho (reabrir/recarregar)");
  {
    const { view, sandbox } = await seedBasic({ sandbox: true });
    await focus(claudeTab("Corrigir login"));
    const saved = sandbox.getPersisted();
    ok(!!saved && saved.html === "STATUS DE A", "estado do painel foi persistido via setState");

    const revived = createWebviewSandbox(() => view.webview.html, () => {}, saved);
    revived.start();
    ok(
      revived.statusText() === "STATUS DE A" && revived.notesValue() === "notas A",
      "painel recriado mostra o conteúdo na hora, sem esperar mensagem do host"
    );
    ok(
      revived.outbound.some((m) => m.command === "ready"),
      "webview anuncia 'ready' pro host (handshake, sem depender de timing)"
    );
  }

  section("[A6] CSS: flex items podem encolher e o status acompanha o texto revelado");
  {
    const { view, sandbox } = await seedBasic({ sandbox: true });
    const html = view.webview.html;
    ok(/#content\s*\{[^}]*min-height:\s*0/.test(html), "#content tem min-height:0");
    ok(/#notes\s*\{[^}]*min-height:\s*0/.test(html), "#notes tem min-height:0 (antes estourava o painel sem scroll)");
    await focus(claudeTab("Corrigir login"));
    await settle(30);
    ok(
      sandbox.els.status.scrollTop === sandbox.els.status.scrollHeight,
      "status rola junto com o texto revelado (antes o texto era escrito abaixo da dobra)"
    );
  }

  // ================= BLOCO B — sessão persiste, painel se recupera =================

  section("[B1/B3] Rename do título da sessão não apaga o painel (sessão pegajosa)");
  {
    await seedBasic();
    const tabA = claudeTab("Corrigir login");
    await focus(tabA);
    ok(lastPosted("update")?.sessionId === "sA", "sessão A resolvida");
    // O Claude Code renomeia a sessão: o .jsonl muda antes de o label da aba acompanhar.
    appendTitle("sA", "Corrigir login e cadastro de usuário");
    state.posted.length = 0;
    h.fireTabs({ opened: [], closed: [], changed: [tabA] });
    await settle(60);
    ok(
      !state.posted.some((m) => m.type === "unresolved"),
      "dessincronia label×transcript NÃO manda o painel pra 'sessão não identificada'"
    );
    ok(
      lastPosted("update")?.sessionId === "sA" || state.posted.length === 0,
      "painel continua na sessão A durante o rename"
    );
  }

  section("[B2] Sessão nova sem título ainda: o painel se recupera SOZINHO");
  {
    await boot();
    transcriptNoTitle("sNova");
    mem.write(LAPSO + "/sNova.md", noteBody("STATUS DA NOVA", "notas novas"));
    await focus(claudeTab("Minha sessão nova"));
    ok(lastPosted()?.type === "unresolved", "sem título no transcript, começa como não identificada");

    // O Claude Code grava o ai-title ~1min depois. Nenhum evento de aba acontece.
    appendTitle("sNova", "Minha sessão nova");
    state.posted.length = 0;
    await wait(120); // deixa o backoff (10ms) rodar sozinho
    ok(
      lastPosted("update")?.sessionId === "sNova",
      "o retry automático encontra a sessão sem o usuário mexer em nada"
    );
  }

  section("[B4/B5] Associação aba→sessão sobrevive ao reload e cobre aba nunca focada");
  {
    const ctx = makeContext();
    await seedBasic({ context: ctx });
    await focus(claudeTab("Corrigir login"));
    ok(notesOf("sA") === "notas A", "nota de sA existe antes do reload");

    // "Reload Window": provider novo, objetos Tab novos, disco intacto.
    await boot({ context: ctx, keepFs: true });
    const tabDepoisDoReload = claudeTab("Corrigir login");
    state.allTabs.push(tabDepoisDoReload);
    await focus(claudeTab("Corrigir cadastro")); // foca OUTRA aba: a de A nunca foi focada
    await closeTab(tabDepoisDoReload);
    await settle(60);
    ok(
      notesOf("sA") === null,
      "fechar aba nunca focada (após reload) deleta a nota — antes virava órfã pra sempre"
    );
  }

  // ================= BLOCO C — watcher e ciclo de vida =================

  section("[C1] Watcher é re-armado depois de o painel ser descartado e recriado");
  {
    const { view, provider } = await seedBasic();
    const tabA = claudeTab("Corrigir login");
    await focus(tabA);
    ok(liveWatchers().length >= 1, "watcher armado com a sessão ativa");

    view.fireDispose();
    ok(liveWatchers().length === 0, "dispose do painel derruba o watcher");

    const view2 = makeFakeView();
    provider.resolveWebviewView(view2);
    await settle(60);
    await focus(tabA);
    ok(liveWatchers().length >= 1, "re-abrir o painel RE-ARMA o watcher (antes ficava morto pra sempre)");

    view2.sent.length = 0;
    mem.write(LAPSO + "/sA.md", noteBody("STATUS ATUALIZADO", "notas A"));
    fireWatcher("change", LAPSO + "/sA.md");
    await settle(40);
    ok(
      view2.sent.some((m) => m.type === "update" && m.status === "STATUS ATUALIZADO"),
      "escrita do Claude chega no painel recriado, em tempo real"
    );
  }

  section("[C2] Watcher cobre a pasta inteira e trata deleção");
  {
    const { view } = await seedBasic();
    await focus(claudeTab("Corrigir login"));
    const w = liveWatchers()[0];
    ok(
      String(w.pattern?.pattern).includes("*.md"),
      "watcher observa .lapso/*.md (pasta), não um arquivo único"
    );
    view.sent.length = 0;
    mem.remove(LAPSO + "/sA.md");
    fireWatcher("delete", LAPSO + "/sA.md");
    await settle(40);
    ok(
      view.sent.some((m) => m.type === "update" && m.exists === false),
      "deleção da nota por fora é refletida (antes ficava status fantasma)"
    );
  }

  section("[C3] Atividade de uma sessão FORA de foco não limpa o painel");
  {
    const { view } = await seedBasic();
    await focus(claudeTab("Corrigir login"));
    await focus(claudeTab("Sessão sem título ainda")); // zera a sessão exibida
    view.sent.length = 0;
    mem.write(LAPSO + "/sA.md", noteBody("A ESCREVEU DE NOVO", "notas A"));
    fireWatcher("change", LAPSO + "/sA.md");
    await settle(40);
    ok(
      view.sent.length === 0,
      "escrita na sessão antiga não dispara render nenhum (antes re-postava 'unresolved' e apagava a tela)"
    );
  }

  section("[C4] Dispose atrasado do painel antigo não mata o painel novo");
  {
    const { view, provider } = await seedBasic();
    const view2 = makeFakeView();
    provider.resolveWebviewView(view2);
    await settle(40);
    view.fireDispose(); // dispose do ANTIGO chega depois do resolve do novo
    view2.sent.length = 0;
    await focus(claudeTab("Corrigir login"));
    ok(
      view2.sent.some((m) => m.type === "update" && m.sessionId === "sA"),
      "painel novo continua recebendo updates (antes o dispose atrasado o matava permanentemente)"
    );
  }

  section("[C5] deactivate() grava a digitação pendente");
  {
    const { view } = await seedBasic();
    await focus(claudeTab("Corrigir login"));
    view.sendToHost({ command: "saveNotes", text: "digitado e nao salvo ainda", sessionId: "sA" });
    ext.deactivate();
    ok(
      notesOf("sA") === "digitado e nao salvo ainda",
      "texto pendente é gravado no desligamento (antes era descartado em silêncio)"
    );
  }

  section("[C6] Poll de segurança atualiza mesmo se o watcher não disparar");
  {
    const { view } = await seedBasic();
    await focus(claudeTab("Corrigir login"));
    view.sent.length = 0;
    // Escreve SEM disparar o watcher — simula watcher morto/drive de rede.
    mem.write(LAPSO + "/sA.md", noteBody("VEIO PELO POLL", "notas A"));
    await wait(120);
    ok(
      view.sent.some((m) => m.type === "update" && m.status === "VEIO PELO POLL"),
      "mudança no arquivo chega ao painel mesmo sem evento de watcher"
    );
  }

  // ================= BLOCO D — nunca perder texto =================

  section("[D1] Digitação pendente é gravada quando o painel é descartado");
  {
    const { view } = await seedBasic();
    await focus(claudeTab("Corrigir login"));
    view.sendToHost({ command: "saveNotes", text: "rascunho antes do dispose", sessionId: "sA" });
    view.fireDispose();
    ok(notesOf("sA") === "rascunho antes do dispose", "flush no dispose preserva a digitação");
  }

  section("[D2] Salvar as notas não faz o status do Claude voltar atrás (compare-and-set)");
  {
    const { view } = await seedBasic();
    await focus(claudeTab("Corrigir login"));
    const key = (LAPSO + "/sA.md").replace(/\\/g, "/");
    let flipped = false;
    mem.hooks.set(key, () => {
      // Na 1ª leitura do save, o Claude grava um status novo por baixo.
      if (!flipped) {
        flipped = true;
        mem.write(LAPSO + "/sA.md", noteBody("STATUS RECEM ESCRITO", "notas A"));
      }
    });
    view.sendToHost({ command: "saveNotes", text: "minhas notas novas", sessionId: "sA" });
    await settle(150);
    mem.hooks.delete(key);
    ok(statusOf("sA") === "STATUS RECEM ESCRITO", "status novo do Claude é preservado (não regride)");
    ok(notesOf("sA") === "minhas notas novas", "as notas digitadas também foram gravadas");
  }

  section("[D3] Texto fora das duas zonas é preservado na regravação");
  {
    const { view } = await boot();
    transcript("sA", "Corrigir login");
    mem.write(LAPSO + "/sA.md", noteBody("S", "n", "# cabeçalho do Lucas\n\n", "\nrodapé do Lucas\n"));
    await focus(claudeTab("Corrigir login"));
    view.sendToHost({ command: "saveNotes", text: "nota nova", sessionId: "sA" });
    await settle(80);
    const raw = mem.read(LAPSO + "/sA.md");
    ok(raw.includes("# cabeçalho do Lucas"), "prólogo preservado (antes era apagado)");
    ok(raw.includes("rodapé do Lucas"), "epílogo preservado (antes era apagado)");
    ok(notesOf("sA") === "nota nova", "notas atualizadas mesmo assim");
  }

  section("[D4] Arquivo pego no meio da escrita não vira lixo na tela nem no disco");
  {
    const { view, sandbox } = await seedBasic({ sandbox: true });
    await focus(claudeTab("Corrigir login"));
    ok(sandbox.statusText() === "STATUS DE A", "estado bom antes");
    const parcial = "<!-- lapso:status -->\n🎯 escrevendo agora";
    mem.write(LAPSO + "/sA.md", parcial);
    view.sent.length = 0;
    fireWatcher("change", LAPSO + "/sA.md");
    await settle(60);
    ok(view.sent.length === 0, "leitura parcial não é renderizada (antes despejava o markdown cru no campo)");
    ok(sandbox.statusText() === "STATUS DE A", "painel mantém o último estado bom");

    view.sendToHost({ command: "saveNotes", text: "nota durante escrita", sessionId: "sA" });
    await settle(200);
    ok(mem.read(LAPSO + "/sA.md") === parcial, "save durante escrita parcial NÃO grava por cima (antes apagava a zona de status)");
  }

  section("[D5] Erro de leitura não pisca o painel pra vazio");
  {
    const { view } = await seedBasic();
    await focus(claudeTab("Corrigir login"));
    view.sent.length = 0;
    mem.failReadOnce.add((LAPSO + "/sA.md").replace(/\\/g, "/"));
    fireWatcher("change", LAPSO + "/sA.md");
    await settle(40);
    ok(
      !view.sent.some((m) => m.type === "update" && m.status === ""),
      "falha transitória de I/O não gera update vazio (antes o status sumia e voltava)"
    );
    ok(
      state.outputLines.some((l) => l.includes("leitura de")),
      "a falha fica registrada em Output → Lapso"
    );
  }

  section("[D6] Fechar a aba cancela o save pendente (nota não ressuscita órfã)");
  {
    const { view } = await seedBasic();
    const tabA = claudeTab("Corrigir login");
    await focus(tabA);
    view.sendToHost({ command: "saveNotes", text: "texto que nao deve ressuscitar", sessionId: "sA" });
    await closeTab(tabA); // fecha ANTES do debounce
    await settle(120);
    ok(notesOf("sA") === null, "nota apagada e NÃO recriada pelo save atrasado");
  }

  section("[D7] Falha de escrita não marca a nota como salva");
  {
    const { view } = await seedBasic();
    await focus(claudeTab("Corrigir login"));
    mem.failWriteOnce.add((LAPSO + "/sA.md").replace(/\\/g, "/"));
    view.sendToHost({ command: "saveNotes", text: "texto que falhou", sessionId: "sA" });
    await settle(120);
    ok(notesOf("sA") === "notas A", "a escrita falhou mesmo (pré-condição do teste)");
    view.sendToHost({ command: "saveNotes", text: "texto que falhou", sessionId: "sA" });
    await settle(120);
    ok(
      notesOf("sA") === "texto que falhou",
      "reenviar o MESMO texto grava (antes o texto era dado como salvo sem ter sido)"
    );
  }

  // ================= BLOCO E — concorrência =================

  section("[E1/E2] Rajada de eventos de aba: um resolve só, sessão certa, sem falso 'config-missing'");
  {
    await seedBasic();
    const tabA = claudeTab("Corrigir login");
    const tabB = claudeTab("Corrigir cadastro");
    state.allTabs = [tabA, tabB];
    await focus(tabA);
    state.posted.length = 0;
    mem.resetCounters();
    // Troca de aba real dispara 2-3 eventos; aqui simulamos 5 na mesma tick.
    state.activeTab = tabB;
    for (let i = 0; i < 5; i++) h.fireTabs({ opened: [], closed: [], changed: [tabB] });
    for (const cb of state.tabGroupsChangedCbs) cb();
    await settle(80);
    ok(mem.counters.readdir <= 2, `rajada de 6 eventos custa <= 2 varreduras (foi ${mem.counters.readdir})`);
    ok(lastPosted("update")?.sessionId === "sB", "painel termina na aba realmente ativa");
    ok(!state.posted.some((m) => m.type === "config-missing"), "nenhum 'config-missing' falso na corrida");
    ok(
      !state.posted.some((m) => m.type === "update" && m.sessionId === "sA"),
      "nenhum render obsoleto da aba abandonada"
    );
  }

  // ================= BLOCO F — performance =================

  section("[F1] Transcript grande não é lido inteiro pra extrair o título");
  {
    await boot();
    const antesFull = ext.config.fullReadMaxBytes;
    const antesTail = ext.config.tailWindowBytes;
    const antesHead = ext.config.headWindowBytes;
    ext.config.fullReadMaxBytes = 500;
    ext.config.tailWindowBytes = 400;
    ext.config.headWindowBytes = 400;
    transcript("sBig", "Sessão gigante", 200); // bem acima do teto
    const tamanho = mem.stat(PROJECTS_DIR + "/sBig.jsonl").size;
    mem.resetCounters();
    await focus(claudeTab("Sessão gigante"));
    ok(lastPosted("update")?.sessionId === "sBig", "resolve o título mesmo lendo só a janela do fim");
    ok(
      mem.counters.bytesRead < tamanho,
      `leu ${mem.counters.bytesRead} de ${tamanho} bytes (antes lia 100% do arquivo)`
    );
    ext.config.fullReadMaxBytes = antesFull;
    ext.config.tailWindowBytes = antesTail;
    ext.config.headWindowBytes = antesHead;
  }

  section("[F2] Sessão VIVA: só o pedaço novo do transcript é lido");
  {
    await seedBasic();
    const tabA = claudeTab("Corrigir login");
    await focus(tabA);
    const tamanho = mem.stat(PROJECTS_DIR + "/sA.jsonl").size;
    // O transcript da sessão viva cresce a cada mensagem — era cache miss garantido.
    const raw = mem.read(PROJECTS_DIR + "/sA.jsonl");
    mem.write(PROJECTS_DIR + "/sA.jsonl", raw + JSON.stringify({ type: "user", seq: 99 }) + "\n");
    mem.resetCounters();
    h.fireTabs({ opened: [], closed: [], changed: [tabA] });
    await settle(60);
    ok(
      mem.counters.bytesRead < tamanho,
      `releitura incremental leu ${mem.counters.bytesRead} bytes, não os ${tamanho} do arquivo`
    );
  }

  section("[F3/F4] Não-match custa UMA varredura e não se repete dentro do TTL");
  {
    // Medido direto no índice: no provider o retry automático (que é o comportamento
    // desejado) dispararia varreduras extras e mascararia a medição.
    await seedBasic();
    const antesTtl = ext.config.negativeCacheTtlMs;
    ext.config.negativeCacheTtlMs = 5000;
    const idx = new ext.SessionTitleIndex();
    mem.resetCounters();
    await idx.resolve("Título que não existe em lugar nenhum");
    ok(
      mem.counters.readdir === 1,
      `não-match custa 1 varredura (foi ${mem.counters.readdir}; antes eram 2 pelas variantes d--/D--)`
    );
    mem.resetCounters();
    await idx.resolve("Título que não existe em lugar nenhum");
    ok(
      mem.counters.readdir === 0,
      `título que já falhou não é re-varrido dentro do TTL (foi ${mem.counters.readdir})`
    );
    ext.config.negativeCacheTtlMs = antesTtl;
  }

  section("[F4b] Focar um arquivo comum não custa I/O nenhum");
  {
    await seedBasic();
    await focus(claudeTab("Corrigir login"));
    mem.resetCounters();
    await focus(fileTab("extension.ts"));
    ok(
      mem.counters.readdir === 0,
      `focar um arquivo comum não varre transcript nenhum (foi ${mem.counters.readdir}; é o evento mais frequente)`
    );
  }

  section("[F5] Varredura sai no primeiro match, começando pelas sessões mais recentes");
  {
    await boot();
    for (let i = 0; i < 6; i++) {
      transcript("s" + i, "Sessão número " + i);
      await wait(2);
    }
    mem.resetCounters();
    await focus(claudeTab("Sessão número 5")); // a mais recente
    ok(lastPosted("update")?.sessionId === "s5", "resolveu a sessão certa");
    ok(mem.counters.open <= 2, `abriu <= 2 transcripts (foi ${mem.counters.open}; antes abria os 6)`);
  }

  section("[F6] Botão 'editar' reusa o índice quente (não faz varredura fria)");
  {
    await seedBasic();
    await focus(claudeTab("Corrigir login"));
    mem.resetCounters();
    const cmd = state.commands.get("lapso.openNote");
    ok(typeof cmd === "function", "comando lapso.openNote registrado");
    await cmd();
    ok(
      mem.counters.readdir === 0,
      `abrir a nota não relê transcript (foi ${mem.counters.readdir} varredura(s); antes instanciava índice frio)`
    );
  }

  section("[F7] Cache de títulos tem teto (não cresce sem limite)");
  {
    await boot();
    const antes = ext.config.titleCacheMax;
    ext.config.titleCacheMax = 2;
    for (let i = 0; i < 5; i++) transcript("t" + i, "Título " + i);
    const idx = new ext.SessionTitleIndex();
    for (let i = 0; i < 5; i++) {
      const r = await idx.resolve("Título " + i);
      ok(r.sessionId === "t" + i, `resolve continua correto com cache limitado (t${i})`);
    }
    ext.config.titleCacheMax = antes;
  }
}

run().then(
  () => h.finish(),
  (e) => {
    console.error(e);
    process.exit(2);
  }
);
