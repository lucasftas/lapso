// Sandbox do webview: extrai o <script> gerado por buildHtml() e o executa num DOM
// mínimo. Sem isso não dá pra provar os defeitos do LADO do painel (chave de render,
// campo de notas vazando entre sessões, restauração após reload) — eles vivem no
// JavaScript embutido no HTML, não no host.

function makeEl(id) {
  const listeners = new Map();
  const classes = new Set();
  return {
    id,
    _text: "",
    get textContent() {
      return this._text;
    },
    set textContent(v) {
      this._text = String(v);
      this.scrollHeight = this._text.length; // proxy simples pra checar auto-scroll
    },
    value: "",
    disabled: false,
    placeholder: "",
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      _set: classes,
    },
    addEventListener(evt, cb) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(cb);
    },
    fire(evt) {
      for (const cb of listeners.get(evt) ?? []) cb({ target: this });
    },
  };
}

function extractScript(html) {
  const m = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("script do webview não encontrado no HTML");
  return m[1];
}

function createWebviewSandbox(getHtml, sendToHost, initialState) {
  const els = {
    status: makeEl("status"),
    notes: makeEl("notes"),
    title: makeEl("title"),
    "edit-btn": makeEl("edit-btn"),
    "req-footer": makeEl("req-footer"),
  };
  // Espelha o HTML estático inicial (o painel nasce assim antes de qualquer mensagem).
  els.status.textContent = "// o Claude escreve aqui o que está fazendo";
  els.status.classList.add("empty");
  els.notes.disabled = true;
  els.notes.placeholder = "// suas anotações";
  els.title.textContent = ".lapso";
  els["req-footer"].textContent = "⟳ pedir status à sessão";
  els["req-footer"].classList.add("hidden");

  let persisted = initialState ?? null;
  const outbound = [];
  let messageListener = null;
  let perf = 0;

  const api = {
    postMessage(m) {
      outbound.push(m);
      sendToHost(m);
    },
    setState(s) {
      persisted = s;
    },
    getState() {
      return persisted;
    },
  };

  const doc = {
    getElementById: (id) => els[id],
    activeElement: null,
  };
  const win = {
    addEventListener(evt, cb) {
      if (evt === "message") messageListener = cb;
    },
  };
  const perfObj = {
    now() {
      perf += 1;
      return perf;
    },
  };
  // Uma "frame" já entrega o texto inteiro: o timing da animação não é objeto de teste
  // (foi decisão explícita mantê-la como está) — o que se testa é SE ela é disparada.
  const raf = (cb) => setTimeout(() => cb(perfObj.now() + 5000), 0);
  const timeout = (cb, ms) => {
    const t = setTimeout(cb, ms);
    if (t && typeof t.unref === "function") t.unref();
    return t;
  };

  const sandbox = {
    els,
    outbound,
    getPersisted: () => persisted,
    start() {
      const src = extractScript(getHtml());
      const fn = new Function(
        "acquireVsCodeApi",
        "document",
        "window",
        "performance",
        "requestAnimationFrame",
        "setTimeout",
        "clearTimeout",
        src
      );
      fn(() => api, doc, win, perfObj, raf, timeout, clearTimeout);
    },
    send(msg) {
      if (messageListener) messageListener({ data: msg });
    },
    focusNotes() {
      doc.activeElement = els.notes;
    },
    typeNotes(text) {
      els.notes.value = text;
      els.notes.fire("input");
    },
    statusText: () => els.status.textContent,
    isPlaceholder: () => els.status.classList.contains("empty"),
    notesValue: () => els.notes.value,
    notesDisabled: () => els.notes.disabled,
    titleText: () => els.title.textContent,
    clickRequest() {
      els["req-footer"].fire("click");
    },
    requestText: () => els["req-footer"].textContent,
    requestHidden: () => els["req-footer"].classList.contains("hidden"),
    requestWaiting: () => els["req-footer"].classList.contains("waiting"),
    requestDone: () => els["req-footer"].classList.contains("done"),
  };
  return sandbox;
}

module.exports = { createWebviewSandbox };
