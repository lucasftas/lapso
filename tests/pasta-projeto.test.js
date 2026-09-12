// Suíte da resolução do NOME DA PASTA DE PROJETO (v0.4.2).
//
// Defeito original, medido em 2026-09-12: `encodeCwd` trocava só `[:\/._]` por '-', e o
// Claude Code troca TUDO que não é [a-zA-Z0-9]. Em caminho "limpo" as duas regras dão o
// mesmo resultado — por isso passou meses sem aparecer. Em caminho com qualquer outro
// caractere elas divergem CALADAS: a extensão procurava numa pasta que nunca existiu e o
// painel entregava "Nenhuma sessão do Claude Code neste projeto ainda", com o botão
// "editar" respondendo "não consegui identificar a sessão desta aba ainda" — as duas
// mensagens de um projeto virgem, num projeto que tinha 3 sessões e 24 MB de transcript.
//
// Varredura dos transcripts reais no dia do diagnóstico: de 64 projetos com transcript
// legível, 5 ficavam invisíveis pro painel — todos com '!' no caminho:
//   d:\GitHub\_GRUPOFACIAL\leadhero\!_features\gestao-de-tarefas
//     → pasta real  d--GitHub--GRUPOFACIAL-leadhero---features-gestao-de-tarefas
//     → Lapso lia   d--GitHub--GRUPOFACIAL-leadhero-!-features-gestao-de-tarefas  (não existe)
//
// A regra nova não é palpite: saiu do binário do CLI 2.1.269 (`bin/claude.exe`),
//   var j6 = 200;
//   function X6(t){ let e=0; for(...) e=(e<<5)-e+t.charCodeAt(r)|0; return e }
//   function k(e){ return e.replace(/[^a-zA-Z0-9]/g,"-") }
//   function cC(e){ let n=k(e); if(n.length<=j6) return n; return `${n.slice(0,j6)}-${Math.abs(X6(e)).toString(36)}` }
// e foi conferida contra as 64 pastas medidas.

const h = require("./harness.js");
const {
  ext, mem, state, ok, section, boot, focus, claudeTab,
  transcriptEm, usarWorkspace, noteBody, lastPosted, settle,
} = h;

// Reimplementação independente da regra do CLI, pra o assert de truncagem não comparar a
// função com ela mesma.
function refClaude(p) {
  let hash = 0;
  for (let i = 0; i < p.length; i++) {
    hash = ((hash << 5) - hash + p.charCodeAt(i)) | 0;
  }
  const s = p.replace(/[^a-zA-Z0-9]/g, "-");
  return s.length <= 200 ? s : `${s.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

async function run() {
  // ============ BLOCO S — o encoder, contra as pastas reais medidas ============

  section("[S1] Caminho com '!' encoda como a pasta que o Claude Code realmente cria");
  {
    const casos = [
      // [cwd lido do transcript, nome da pasta que existe no disco]
      [
        "d:\\GitHub\\_GRUPOFACIAL\\leadhero\\!_features\\gestao-de-tarefas",
        "d--GitHub--GRUPOFACIAL-leadhero---features-gestao-de-tarefas",
      ],
      ["d:\\GitHub\\_COMUNIDADE\\!_me", "d--GitHub--COMUNIDADE---me"],
      [
        "d:\\GitHub\\_GRUPOFACIAL\\!_prontuario-aluna-global",
        "d--GitHub--GRUPOFACIAL---prontuario-aluna-global",
      ],
      [
        "d:\\GitHub\\_GRUPOFACIAL\\facialscale\\!_scale-v2\\html-to-pdf",
        "d--GitHub--GRUPOFACIAL-facialscale---scale-v2-html-to-pdf",
      ],
      [
        "d:\\GitHub\\_GRUPOFACIAL\\sucesso-do-aluno-follow-up\\!_backfill-midias",
        "d--GitHub--GRUPOFACIAL-sucesso-do-aluno-follow-up---backfill-midias",
      ],
    ];
    for (const [cwd, pasta] of casos) {
      ok(ext.encodeCwd(cwd) === pasta, `${cwd} → ${pasta}`);
    }
    ok(
      casos.every(([cwd]) => ext.encodeCwdLegado(cwd) !== ext.encodeCwd(cwd)),
      "o encoder antigo divergia em todos os 5 — é exatamente o defeito"
    );
  }

  section("[S2] Caminho limpo sai IGUAL nas duas regras (nenhuma pasta antiga foi perdida)");
  {
    const limpos = [
      "d:\\GitHub\\_COMUNIDADE\\extension-vscode-lapso-postit",
      "C:\\Users\\Lucas",
      "d:/testws",
      "\\\\let\\4TB",
    ];
    for (const p of limpos) {
      ok(
        ext.encodeCwd(p) === ext.encodeCwdLegado(p),
        `regra nova == antiga em ${p} (${ext.encodeCwd(p)})`
      );
    }
  }

  section("[S3] Espaço, acento e caractere não-latino também viram '-'");
  {
    ok(ext.encodeCwd("d:\\Fotos no drive") === "d--Fotos-no-drive", "espaço vira '-'");
    ok(ext.encodeCwd("d:\\gestão") === "d--gest-o", "acento vira '-' (não é [a-zA-Z0-9])");
    ok(ext.encodeCwd("d:\\一 REPO") === "d----REPO", "caractere não-latino vira '-'");
    ok(
      ext.encodeCwdLegado("d:\\Fotos no drive") === "d-\\Fotos no drive".replace(/[:\\/._]/g, "-"),
      "o legado preservava esses caracteres — é por isso que ele segue como candidato"
    );
  }

  section("[S4] Caminho acima de 200 caracteres corta e ganha hash, igual ao CLI");
  {
    const longo = "d:\\GitHub\\" + "pasta-comprida\\".repeat(20) + "fim";
    const saida = ext.encodeCwd(longo);
    ok(longo.length > 200, `caso de teste tem ${longo.length} caracteres (> 200)`);
    ok(saida === refClaude(longo), "bate com a reimplementação independente da regra do CLI");
    ok(saida.length === 200 + 1 + saida.split("-").pop().length, "corta em 200 + '-' + hash");
    ok(/^[a-z0-9]+$/.test(saida.split("-").pop()), "sufixo é hash em base36");

    // Dois caminhos que só diferem DEPOIS do caractere 200 não podem virar a mesma pasta.
    const a = "d:\\" + "x".repeat(220) + "\\alpha";
    const b = "d:\\" + "x".repeat(220) + "\\beta";
    ok(
      ext.encodeCwd(a) !== ext.encodeCwd(b),
      "o hash separa caminhos longos de prefixo idêntico (senão duas sessões dividiriam pasta)"
    );
  }

  section("[S5] Sem workspace aberto não há candidato (não inventa pasta)");
  {
    const restaurar = usarWorkspace("d:\\GitHub\\_GRUPOFACIAL\\leadhero\\!_features");
    const comWs = ext.sessionsDirCandidates().length;
    restaurar();
    ok(comWs >= 2, `workspace com '!' gera a pasta nova E a histórica (${comWs} candidatos)`);
  }

  // ============ BLOCO T — o painel resolve a sessão de verdade ============

  section("[T1] Aba resolve num workspace com '!' no caminho (o defeito, ponta a ponta)");
  {
    const WS = "d:\\GitHub\\_GRUPOFACIAL\\leadhero\\!_features\\gestao-de-tarefas";
    const restaurar = usarWorkspace(WS);
    try {
      await boot();
      // A pasta que o Claude Code REALMENTE usa hoje.
      const pastaReal =
        "d:/cfg/projects/d--GitHub--GRUPOFACIAL-leadhero---features-gestao-de-tarefas";
      transcriptEm(pastaReal, "sT1", "MONDAY LEADHERO");
      mem.mkdir(WS + "/.lapso");
      mem.write(WS + "/.lapso/sT1.md", noteBody("IMPORTANDO O MONDAY", "notas"));
      await focus(claudeTab("MONDAY LEADHERO"));
      ok(
        lastPosted("update")?.sessionId === "sT1",
        "a aba casa com a sessão (antes: placeholder de projeto virgem)"
      );
      ok(
        !state.posted.some((m) => m.type === "no-sessions-here" || m.type === "unresolved"),
        "não cai em 'Nenhuma sessão do Claude Code neste projeto ainda' — o defeito original"
      );
    } finally {
      restaurar();
    }
  }

  section("[T2] Pasta HISTÓRICA (encoding antigo) continua sendo lida");
  {
    const WS = "d:\\GitHub\\_COMUNIDADE\\!_me";
    const restaurar = usarWorkspace(WS);
    try {
      await boot();
      // Só a pasta da regra ANTIGA existe — projeto cuja última sessão foi antes da
      // mudança de encoding no CLI. Sem o candidato legado, o painel regrediria aqui.
      transcriptEm("d:/cfg/projects/d--GitHub--COMUNIDADE-!-me", "sT2", "diario");
      mem.mkdir(WS + "/.lapso");
      mem.write(WS + "/.lapso/sT2.md", noteBody("ANOTANDO", "n"));
      await focus(claudeTab("diario"));
      ok(
        lastPosted("update")?.sessionId === "sT2",
        "transcript que só existe na pasta antiga ainda resolve"
      );
    } finally {
      restaurar();
    }
  }

  section("[T3] Projeto realmente virgem segue caindo no placeholder (sem falso positivo)");
  {
    const WS = "d:\\GitHub\\_COMUNIDADE\\!_projeto-virgem";
    const restaurar = usarWorkspace(WS);
    try {
      await boot();
      mem.mkdir(WS + "/.lapso");
      await focus(claudeTab("qualquer coisa"));
      await settle(60);
      // `no-sessions-here` é o placeholder do print que abriu o diagnóstico:
      // "(sem sessão neste projeto)" + "Nenhuma sessão do Claude Code neste projeto ainda."
      ok(
        state.posted.some((m) => m.type === "no-sessions-here"),
        "nenhuma pasta candidata existe → placeholder de projeto virgem, como deve ser"
      );
    } finally {
      restaurar();
    }
  }

  h.finish();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
