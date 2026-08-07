// Regressão dos fixes críticos da v0.2.2 (perda de dados).
// Estes 3 cenários vinham da auditoria adversarial anterior e continuam valendo —
// a refatoração de resiliência não pode quebrá-los.
//   1) fechar aba deleta SÓ a nota da sessão daquela aba (associação estável),
//      e NUNCA deleta por colisão de título (aba comum / sessão viva).
//   2) save carrega o sessionId capturado na digitação — trocar de aba no meio
//      não grava o texto na sessão errada.
//   3) transcripts inexistentes (CLAUDE_CONFIG_DIR não visível) → sinal distinto
//      (config-missing + Output), não o genérico "sessão não identificada".

const h = require("./harness.js");
const { ok, section, boot, focus, closeTab, claudeTab, fileTab, transcript, noteBody, notesOf, mem, state, PROJECTS_DIR, LAPSO } = h;

async function seed() {
  const b = await boot();
  transcript("sA", "Corrigir login");
  transcript("sB", "Corrigir cadastro");
  transcript("sC", "extension.ts refactor abas");
  mem.write(LAPSO + "/sA.md", noteBody("status A", "notas A"));
  mem.write(LAPSO + "/sB.md", noteBody("status B", "notas B"));
  mem.write(LAPSO + "/sC.md", noteBody("status C", "notas C"));
  return b;
}

async function run() {
  section("[v0.2.2 · Cenário 1] Deleção usa associação estável aba→sessionId");
  {
    await seed();
    const tabA = claudeTab("Corrigir login");
    await focus(tabA);
    await closeTab(tabA);
    ok(notesOf("sA") === null, "fechar aba de sA deleta .lapso/sA.md");
    ok(notesOf("sB") === "notas B", "nota de sB (sessão não tocada) intacta");
    ok(notesOf("sC") === "notas C", "nota de sC intacta");
  }

  section("[v0.2.2 · Cenário 1b] Fechar aba COMUM com título colidente NÃO deleta sessão viva");
  {
    await seed();
    await focus(claudeTab("extension.ts refactor abas"));
    const commonTab = fileTab("extension.ts"); // prefixo de 'extension.ts refactor abas'
    await closeTab(commonTab);
    ok(notesOf("sC") === "notas C", "aba comum 'extension.ts' NÃO apaga .lapso/sC.md");
  }

  section("[v0.2.2 · Cenário 2] Save carrega sessionId da digitação (troca de aba no meio)");
  {
    const { view } = await seed();
    await focus(claudeTab("Corrigir login"));
    view.sendToHost({ command: "saveNotes", text: "NOVA nota digitada em A", sessionId: "sA" });
    await focus(claudeTab("Corrigir cadastro"));
    await h.settle(80);
    ok(notesOf("sA") === "NOVA nota digitada em A", "texto digitado em A foi gravado em .lapso/sA.md");
    ok(notesOf("sB") === "notas B", "nota de sB NÃO foi corrompida com texto de A");
  }

  section("[v0.2.2 · Cenário 3] Transcripts inexistentes → sinal distinto (config-missing)");
  {
    await boot();
    mem.dirs.delete(PROJECTS_DIR);
    state.posted.length = 0;
    state.outputLines.length = 0;
    await focus(claudeTab("Qualquer sessão"));
    const gotConfigMissing = state.posted.some((m) => m.type === "config-missing");
    const gotPlainUnresolved = state.posted.some((m) => m.type === "unresolved");
    ok(gotConfigMissing, "webview recebe 'config-missing' (não o genérico 'unresolved')");
    ok(!gotPlainUnresolved, "não emite 'unresolved' quando a causa é dir ausente");
    ok(
      state.outputLines.some((l) => l.includes("CLAUDE_CONFIG_DIR")),
      "Output → Lapso registra o diagnóstico com CLAUDE_CONFIG_DIR"
    );
  }

  // Defeito v0.3.1: abrir um repo NOVO (pasta de transcripts do projeto ainda não
  // criada, porque nenhuma sessão rodou ali) caía no MESMO caminho de "transcripts
  // não encontrados" e acusava CLAUDE_CONFIG_DIR invisível — com pop-up de alerta —
  // mesmo com a configuração perfeita. Agora os dois casos são distintos.
  section("[v0.3.2 · Cenário 3b] Repo novo sem sessão → aviso calmo, não erro de config");
  {
    const { sandbox } = await boot({ sandbox: true });
    mem.dirs.delete(PROJECTS_DIR); // este projeto nunca teve sessão...
    mem.mkdir("d:/cfg/projects/d--outro-projeto"); // ...mas a raiz de transcripts está lá
    state.posted.length = 0;
    state.outputLines.length = 0;
    state.warnings.length = 0;
    await focus(claudeTab("Sessão de um repo recém-criado"));
    ok(
      state.posted.some((m) => m.type === "no-sessions-here"),
      "webview recebe 'no-sessions-here' (raiz de transcripts existe, só falta a sessão)"
    );
    ok(
      !state.posted.some((m) => m.type === "config-missing"),
      "NÃO acusa config-missing quando CLAUDE_CONFIG_DIR está visível"
    );
    ok(state.warnings.length === 0, "nenhum pop-up de alerta pra um estado normal");
    ok(
      !state.outputLines.some((l) => l.includes("CLAUDE_CONFIG_DIR")),
      "Output não culpa CLAUDE_CONFIG_DIR"
    );
    ok(
      state.outputLines.some((l) => l.includes("Nenhuma sessão")),
      "Output registra o motivo real (projeto ainda sem sessão)"
    );
    ok(
      sandbox.titleText() === "(sem sessão neste projeto)",
      `painel mostra o estado calmo (mostrou "${sandbox.titleText()}")`
    );
    ok(sandbox.isPlaceholder(), "status fica no placeholder cinza, sem texto de erro");
  }

  // A raiz sumir de vez continua sendo erro de config — o novo caminho não pode
  // engolir o diagnóstico legítimo.
  section("[v0.3.2 · Cenário 3c] Raiz de transcripts ausente continua sendo config-missing");
  {
    await boot();
    mem.dirs.delete(PROJECTS_DIR);
    state.posted.length = 0;
    state.warnings.length = 0;
    await focus(claudeTab("Qualquer sessão"));
    ok(
      state.posted.some((m) => m.type === "config-missing"),
      "sem a raiz, o alerta de configuração continua saindo"
    );
    ok(state.warnings.length === 1, "pop-up de alerta sai uma vez pro caso legítimo");
    // O retry com backoff repassava pelo log a cada passo: 12 linhas idênticas no
    // Output pra um diagnóstico só.
    const repetidas = state.outputLines.filter((l) => l.includes("CLAUDE_CONFIG_DIR")).length;
    ok(repetidas === 1, `diagnóstico logado uma vez, não a cada retry (foi ${repetidas})`);
  }
}

run().then(
  () => h.finish(),
  (e) => {
    console.error(e);
    process.exit(2);
  }
);
