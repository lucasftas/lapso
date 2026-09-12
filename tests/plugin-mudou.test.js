// Suíte dos ajustes ao plugin oficial do Claude Code (v0.4.3).
//
// Contexto: auditoria da extensão `anthropic.claude-code-2.1.259` + medição dos 40
// transcripts mais recentes em 2026-09-12. Cada bloco aqui cobre uma premissa do Lapso que
// o plugin mudou — e que falhava CALADA, porque nada no painel acusa "li o campo errado".
//
// Evidências que motivaram cada bloco (todas medidas, nenhuma suposta):
//   [U] `isVisibleInTranscript` ZEROU (0 ocorrências); quem marca o resumo de compactação
//       agora é `isVisibleInTranscriptOnly` / `isCompactSummary` (6 cada), sempre em
//       `type:user` com `content` STRING começando por "This session is being continued
//       from a previous conversation" — texto que passava pelos dois padrões antigos.
//   [V] `{"type":"last-prompt","lastPrompt":"…"}` é novo e aparece 2.501× nos 40 recentes;
//       a PRIMEIRA do arquivo bate com o primeiro prompt em 6 de 6 sessões conferidas.
//   [W] o CLI reserva nomes na pasta do projeto (`timeline.jsonl` no nível do projeto).
//   [X] o label da aba sem título é o literal `"Claude Code"` (webview oficial:
//       `q && q.length > 25 ? q.substring(0,24)+"…" : q  ||  "Claude Code"`).
//   [Y] `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` traz `sessionId` + `cwd` + `entrypoint`.
//   [Z] `CLAUDE_CODE_PROJECT_DIR_NAME` sobrepõe o nome da pasta inteiro.

const h = require("./harness.js");
const {
  ext, mem, state, ok, section, boot, focus, claudeTab, transcript,
  usarWorkspace, noteBody, lastPosted, settle, LAPSO, PROJECTS_DIR,
} = h;

const COMPACT = "This session is being continued from a previous conversation that ran out of context. The summary below covers…";

function escreverLinhas(sessionId, linhas, dir = PROJECTS_DIR) {
  mem.mkdir(dir);
  mem.write(dir + "/" + sessionId + ".jsonl", linhas.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
function userLine(sessionId, content, extra = {}) {
  return { type: "user", sessionId, message: { role: "user", content }, ...extra };
}
function sessaoViva(pid, dados) {
  mem.write("d:/cfg/sessions/" + pid + ".json", JSON.stringify(dados));
}

async function run() {
  // ======== BLOCO U — envelope de compactação não pode virar nome de sessão ========

  section("[U1] Resumo de compactação marcado com isVisibleInTranscriptOnly é pulado");
  {
    await boot();
    escreverLinhas("sU1", [
      userLine("sU1", COMPACT, { isVisibleInTranscriptOnly: true }),
      userLine("sU1", "arrumar o painel"),
    ]);
    mem.write(LAPSO + "/sU1.md", noteBody("S", "n"));
    await focus(claudeTab("arrumar o painel"));
    ok(
      lastPosted("update")?.sessionId === "sU1",
      "o nome vem do prompt de verdade, não do resumo (campo novo respeitado)"
    );
  }

  section("[U2] Mesma coisa com isCompactSummary");
  {
    await boot();
    escreverLinhas("sU2", [
      userLine("sU2", COMPACT, { isCompactSummary: true }),
      userLine("sU2", "seguir de onde parou"),
    ]);
    mem.write(LAPSO + "/sU2.md", noteBody("S", "n"));
    await focus(claudeTab("seguir de onde parou"));
    ok(lastPosted("update")?.sessionId === "sU2", "isCompactSummary também marca envelope");
  }

  section("[U3] O campo ANTIGO (isVisibleInTranscript:false) continua respeitado");
  {
    await boot();
    escreverLinhas("sU3", [
      userLine("sU3", "conteúdo de transcript antigo", { isVisibleInTranscript: false }),
      userLine("sU3", "prompt de verdade"),
    ]);
    mem.write(LAPSO + "/sU3.md", noteBody("S", "n"));
    await focus(claudeTab("prompt de verdade"));
    ok(
      lastPosted("update")?.sessionId === "sU3",
      "transcript gravado por versão antiga do CLI não regride"
    );
  }

  section("[U4] Sem campo nenhum, o TEXTO do resumo de compactação ainda é rejeitado");
  {
    await boot();
    // O defeito na sua forma mais crua: `content` string, sem `<`, sem `Caveat:`,
    // sem marcador nenhum — só o texto. Era isto que viraria o nome da sessão.
    escreverLinhas("sU4", [userLine("sU4", COMPACT), userLine("sU4", "o prompt real")]);
    mem.write(LAPSO + "/sU4.md", noteBody("S", "n"));
    await focus(claudeTab("o prompt real"));
    ok(lastPosted("update")?.sessionId === "sU4", "guarda textual cobre o envelope sem marcador");

    state.posted.length = 0;
    await focus(claudeTab("This session is being contin…"));
    ok(
      !state.posted.some((m) => m.type === "update"),
      "e uma aba com o texto do resumo NÃO casa com essa sessão"
    );
  }

  // ======== BLOCO V — last-prompt, a fonte nova de nome ========

  section("[V1] Sessão sem título resolve pela entrada last-prompt");
  {
    await boot();
    escreverLinhas("sV1", [
      { type: "last-prompt", sessionId: "sV1", lastPrompt: "importar o Monday", leafUuid: "abc" },
    ]);
    mem.write(LAPSO + "/sV1.md", noteBody("S", "n"));
    await focus(claudeTab("importar o Monday"));
    ok(
      lastPosted("update")?.sessionId === "sV1",
      "last-prompt sozinho nomeia a sessão (sem precisar remontar entradas user)"
    );
  }

  section("[V2] last-prompt tem prioridade sobre a remontagem por entradas user");
  {
    await boot();
    escreverLinhas("sV2", [
      // Uma entrada `user` que o parser antigo pegaria primeiro, e o last-prompt correto.
      userLine("sV2", [{ type: "tool_result", content: "saída de ferramenta" }]),
      { type: "last-prompt", sessionId: "sV2", lastPrompt: "o pedido de verdade" },
      userLine("sV2", "texto que não é o começo"),
    ]);
    mem.write(LAPSO + "/sV2.md", noteBody("S", "n"));
    await focus(claudeTab("o pedido de verdade"));
    ok(lastPosted("update")?.sessionId === "sV2", "a fonte mais confiável ganha");
  }

  section("[V3] Título de verdade continua vencendo o last-prompt");
  {
    await boot();
    escreverLinhas("sV3", [
      { type: "last-prompt", sessionId: "sV3", lastPrompt: "prompt inicial" },
      { type: "ai-title", sessionId: "sV3", aiTitle: "Título gerado pela IA" },
      { type: "custom-title", sessionId: "sV3", customTitle: "NOME QUE O LUCAS DEU" },
    ]);
    mem.write(LAPSO + "/sV3.md", noteBody("S", "n"));
    await focus(claudeTab("NOME QUE O LUCAS DEU"));
    ok(lastPosted("update")?.sessionId === "sV3", "custom-title > ai-title > last-prompt");

    state.posted.length = 0;
    await focus(claudeTab("prompt inicial"));
    ok(
      !state.posted.some((m) => m.type === "update"),
      "e o fallback sai de cena: a aba com o prompt antigo não resolve mais"
    );
  }

  // ======== BLOCO V2 — a janela fixa da cabeça não alcança o prompt ========

  section("[V4] Anexo colado empurra o prompt pra fora da janela — e o nome sai igual");
  {
    await boot();
    // Reprodução do caso real medido em 2026-09-12 no transcript desta própria sessão:
    // uma imagem colada no chat virou UMA linha de 512 KB, do tamanho exato da janela de
    // cabeça. A janela morria no meio dessa linha e o prompt, que vem depois, nunca era
    // lido: o painel ficava no "não consegui identificar a sessão desta aba ainda" pra
    // sempre, mesmo com o fallback da v0.4.1 instalado.
    const anexoGigante = { type: "attachment", sessionId: "sV4", data: "x".repeat(700 * 1024) };
    escreverLinhas("sV4", [
      anexoGigante,
      userLine("sV4", "<system-reminder>contexto injetado</system-reminder>"),
      userLine("sV4", "o prompt depois do anexo"),
    ]);
    mem.write(LAPSO + "/sV4.md", noteBody("S", "n"));
    await focus(claudeTab("o prompt depois do anexo"));
    ok(
      lastPosted("update")?.sessionId === "sV4",
      "a busca do nome varre em blocos e passa por cima da linha gigante"
    );
  }

  section("[V5] Sessão sem título e sem prompt não revarre o arquivo a cada sincronização");
  {
    await boot();
    escreverLinhas("sV5", [{ type: "attachment", sessionId: "sV5", data: "y".repeat(600 * 1024) }]);
    const aba = claudeTab("nome que não existe");
    await focus(aba);
    mem.resetCounters();
    // Duas sincronizações seguidas sem o arquivo mudar: a segunda não pode reler nada.
    h.fireTabs({ opened: [], closed: [], changed: [aba] });
    await settle(60);
    const lidoNaSegunda = mem.counters.bytesRead;
    ok(
      lidoNaSegunda < 600 * 1024,
      `segunda varredura leu ${(lidoNaSegunda / 1024).toFixed(0)} KB, não o arquivo inteiro`
    );
  }

  // ======== BLOCO W — arquivo reservado na pasta do projeto não é sessão ========

  section("[W1] timeline.jsonl não entra no índice como se fosse sessão");
  {
    await boot();
    // O caso perigoso: o arquivo reservado tem um last-prompt que casaria com o label.
    escreverLinhas("timeline", [
      { type: "last-prompt", sessionId: "x", lastPrompt: "revisar o relatório" },
    ]);
    mem.write(LAPSO + "/timeline.md", noteBody("NÃO É SESSÃO", "n"));
    await focus(claudeTab("revisar o relatório"));
    ok(
      lastPosted()?.sessionId !== "timeline",
      "sem isso o painel passaria a escrever .lapso/timeline.md"
    );
    ok(
      state.posted.some((m) => m.type === "unresolved" || m.type === "no-sessions-here"),
      "a aba fica sem sessão, que é o correto"
    );
  }

  // ======== BLOCO X — o label genérico "Claude Code" não identifica nada ========

  section("[X1] Aba 'Claude Code' não sequestra sessão cujo título começa igual");
  {
    await boot();
    transcript("sX1", "Claude Code no Chrome funciona?");
    mem.write(LAPSO + "/sX1.md", noteBody("S", "n"));
    await focus(claudeTab("Claude Code"));
    ok(
      lastPosted()?.sessionId !== "sX1",
      "o label genérico não casa por prefixo com um título de verdade"
    );
  }

  section("[X2] Duas abas sem título não compartilham a nota (chave textual descartada)");
  {
    await boot();
    transcript("sX2a", "Sessão A com nome");
    mem.write(LAPSO + "/sX2a.md", noteBody("NOTA DA A", "n"));
    const abaA = claudeTab("Sessão A com nome");
    await focus(abaA);
    ok(lastPosted("update")?.sessionId === "sX2a", "aba A resolve normalmente");

    // A mesma aba perde o título (o plugin renomeia pra "Claude Code" em transição) e
    // outra aba fresca aparece: se a chave textual fosse gravada, as duas dividiriam nota.
    state.posted.length = 0;
    await focus(claudeTab("Claude Code"));
    const mapa = state.workspaceState?.get?.("lapso.tabMap") ?? {};
    ok(
      !Object.keys(mapa).some((k) => k.endsWith("Claude Code")),
      "nenhuma entrada persistida com a chave ambígua"
    );
  }

  // ======== BLOCO Y — registro de sessões vivas do CLI ========

  section("[Y1] Aba 'Claude Code' resolve pela ÚNICA sessão viva deste workspace");
  {
    await boot();
    transcript("sY1", "título que a aba ainda não mostra");
    mem.write(LAPSO + "/sY1.md", noteBody("STATUS DA SESSÃO NOVA", "n"));
    sessaoViva(1001, { pid: 1001, sessionId: "sY1", cwd: "d:\\testws", entrypoint: "claude-vscode" });
    await focus(claudeTab("Claude Code"));
    ok(
      lastPosted("update")?.sessionId === "sY1",
      "a aba sem título resolve na hora (antes: 'não consegui identificar a sessão desta aba ainda')"
    );
  }

  section("[Y2] Duas sessões vivas no mesmo workspace → NÃO chuta");
  {
    await boot();
    transcript("sY2a", "sessão A");
    transcript("sY2b", "sessão B");
    mem.write(LAPSO + "/sY2a.md", noteBody("A", "n"));
    mem.write(LAPSO + "/sY2b.md", noteBody("B", "n"));
    sessaoViva(2001, { pid: 2001, sessionId: "sY2a", cwd: "d:/testws", entrypoint: "claude-vscode" });
    sessaoViva(2002, { pid: 2002, sessionId: "sY2b", cwd: "d:/testws", entrypoint: "claude-vscode" });
    await focus(claudeTab("Claude Code"));
    ok(
      !state.posted.some((m) => m.type === "update"),
      "ambiguidade → fica sem resolver; chutar trocaria a nota de lugar"
    );
  }

  section("[Y3] Sessão de CLI puro é ignorada (não tem aba no editor)");
  {
    await boot();
    transcript("sY3", "sessão de terminal");
    mem.write(LAPSO + "/sY3.md", noteBody("T", "n"));
    sessaoViva(3001, { pid: 3001, sessionId: "sY3", cwd: "d:/testws", entrypoint: "cli" });
    await focus(claudeTab("Claude Code"));
    ok(!state.posted.some((m) => m.type === "update"), "entrypoint cli não disputa aba");
  }

  section("[Y4] Registro apontando sessão sem transcript aqui é ignorado");
  {
    await boot();
    transcript("sY4real", "sessão que existe");
    mem.write(LAPSO + "/sY4real.md", noteBody("R", "n"));
    // Registro stale: sessionId que não tem .jsonl na pasta deste projeto.
    sessaoViva(4001, { pid: 4001, sessionId: "sY4fantasma", cwd: "d:/testws", entrypoint: "claude-vscode" });
    await focus(claudeTab("Claude Code"));
    ok(
      lastPosted()?.sessionId !== "sY4fantasma",
      "palpite do registro é conferido contra o disco antes de virar sessão"
    );
  }

  section("[Y5] Registro de OUTRO workspace não vaza pra este");
  {
    await boot();
    transcript("sY5", "sessão daqui");
    mem.write(LAPSO + "/sY5.md", noteBody("D", "n"));
    sessaoViva(5001, { pid: 5001, sessionId: "sY5", cwd: "d:/outro-projeto", entrypoint: "claude-vscode" });
    await focus(claudeTab("Claude Code"));
    ok(!state.posted.some((m) => m.type === "update"), "casamento é por cwd");
  }

  // ======== BLOCO Z — override do nome da pasta e normalização do config dir ========

  section("[Z1] CLAUDE_CODE_PROJECT_DIR_NAME é honrado como pasta de transcripts");
  {
    const antes = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = "pasta-escolhida-a-mao";
    try {
      await boot();
      escreverLinhas("sZ1", [{ type: "ai-title", sessionId: "sZ1", aiTitle: "com override" }],
        "d:/cfg/projects/pasta-escolhida-a-mao");
      mem.write(LAPSO + "/sZ1.md", noteBody("S", "n"));
      await focus(claudeTab("com override"));
      ok(
        lastPosted("update")?.sessionId === "sZ1",
        "a pasta apontada pela env entra na busca (o Claude Code a usa antes de qualquer encoding)"
      );
    } finally {
      if (antes === undefined) delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
      else process.env.CLAUDE_CODE_PROJECT_DIR_NAME = antes;
    }
  }

  section("[Z2] CLAUDE_CONFIG_DIR com acento é normalizado em NFC, como o CLI faz");
  {
    const antes = process.env.CLAUDE_CONFIG_DIR;
    // Mesma pasta escrita nas duas formas Unicode: composta (NFC) e decomposta (NFD).
    const nfc = "d:/configuração".normalize("NFC");
    const nfd = "d:/configuração".normalize("NFD");
    ok(nfc !== nfd, "as duas formas são strings diferentes (senão o teste não prova nada)");
    try {
      const restaurar = usarWorkspace("d:/testws");
      process.env.CLAUDE_CONFIG_DIR = nfd;
      const candidatos = ext.sessionsDirCandidates();
      restaurar();
      // `path.join` devolve separador do Windows — comparar só a forma Unicode.
      const comBarras = (p) => p.replace(/\\/g, "/");
      ok(
        candidatos.length > 0 && candidatos.every((c) => comBarras(c).startsWith(nfc)),
        "o candidato sai em NFC mesmo com a env em NFD (o CLI grava a pasta em NFC)"
      );
      ok(
        candidatos.every((c) => !comBarras(c).startsWith(nfd)),
        "e nunca na forma decomposta, que seria outra pasta pro path.join"
      );
    } finally {
      process.env.CLAUDE_CONFIG_DIR = antes;
    }
  }

  h.finish();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
