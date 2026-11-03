/* ════════════════════════════════════════════════
   J.A.R.V.I.S — Orbital Core v6.0 · app.js
   ════════════════════════════════════════════════ */

const API_BASE    = window.location.origin;
const MAX_HISTORY = 20;
const CONVS_KEY   = "cipher_convs_v1";
const LEGADO_KEY  = "cipher_chat_v1";   // formato de conversa unica, migrado na 1a carga
const MEMORIA_KEY = "cipher_memoria_v1";
const MAX_FATOS   = 60;                 // mesmo teto que o backend aceita

const state = {
  isLoading: false,
  // Arquivos ja enviados ao servidor e ainda nao anexados a uma mensagem.
  anexos: [],
  sessionStart: Date.now(),
  conversas: [],           // [{ id, titulo, mensagens, history, criadaEm, atualizadaEm }]
  idAtual: null,           // null = tela inicial do Cipher, fora de qualquer conversa
  fatos: [],               // memoria persistente: [{ id, texto, origem, criadoEm }]
  modoDocs: false,         // responder com base nas notas indexadas (RAG local)
  contextoMax: null,       // n_ctx real do llama-server, vindo do /api/health
  tokensSessao: 0,         // soma dos tokens gastos desde que a aba abriu
};

const DOM = {
  messagesArea:      () => document.getElementById("messages-area"),
  welcomeScreen:     () => document.getElementById("welcome-screen"),
  messageInput:      () => document.getElementById("message-input"),
  sendButton:        () => document.getElementById("send-button"),
  sendIcon:          () => document.querySelector(".send-icon"),
  loadingIcon:       () => document.querySelector(".loading-icon"),
  typingIndicator:   () => document.getElementById("typing-indicator"),
  charCounter:       () => document.getElementById("char-counter"),
  btnClearChat:      () => document.getElementById("btn-clear-chat"),
  btnMenuToggle:     () => document.getElementById("btn-menu-toggle"),
  btnAnexo:          () => document.getElementById("btn-anexo"),
  fileInput:         () => document.getElementById("file-input"),
  inputContainer:    () => document.querySelector(".input-container"),
  anexosBarra:       () => document.getElementById("anexos-barra"),
  leftSidebar:       () => document.getElementById("left-sidebar"),
  toastContainer:    () => document.getElementById("toast-container"),
  liveTime:          () => document.getElementById("live-time"),
  liveDate:          () => document.getElementById("live-date"),
  rsStatusDot:       () => document.getElementById("rs-status-dot"),
  rsStatusText:      () => document.getElementById("rs-status-text"),
  rsLatency:         () => document.getElementById("rs-latency"),
  rsUptime:          () => document.getElementById("rs-uptime"),
  rsModel:           () => document.getElementById("rs-model"),
  rsPrecisao:        () => document.getElementById("rs-precisao"),
  rsPeso:            () => document.getElementById("rs-peso"),
  rsMotor:           () => document.getElementById("rs-motor"),
  rsVelocidade:      () => document.getElementById("rs-velocidade"),
  rsCache:           () => document.getElementById("rs-cache"),
  rsCtxValor:        () => document.getElementById("rs-ctx-valor"),
  rsCtxPct:          () => document.getElementById("rs-ctx-pct"),
  rsCtxFill:         () => document.getElementById("rs-ctx-fill"),
  rsTokens:          () => document.getElementById("rs-tokens"),
  rsTokensSessao:    () => document.getElementById("rs-tokens-sessao"),
  navModo:           () => document.getElementById("nav-modo"),
  navDocs:           () => document.getElementById("nav-docs"),
  navCipher:         () => document.getElementById("nav-cipher"),
  navNova:           () => document.getElementById("nav-nova-conversa"),
  convList:          () => document.getElementById("conv-list"),
  convEmpty:         () => document.getElementById("conv-empty"),
  convCount:         () => document.getElementById("conv-count"),
  memoriaList:       () => document.getElementById("memoria-list"),
  memoriaCount:      () => document.getElementById("memoria-count"),
  memoriaInput:      () => document.getElementById("memoria-input"),
  memoriaAddBtn:     () => document.getElementById("memoria-add-btn"),
  btnDocs:           () => document.getElementById("btn-docs"),
  btnVoz:            () => document.getElementById("btn-voz"),
  btnMic:            () => document.getElementById("btn-mic"),
};

function setText(el, value) { if (el) el.textContent = value; }

/* ─── Formatadores ───────────────────────────── */

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

/* ═══════════════════════════════════════════════
   CONVERSAS — persistencia e navegacao
   ═══════════════════════════════════════════════
   Tudo mora no localStorage do navegador. O servidor nao guarda conversa
   nenhuma: cada requisicao leva o historico que o front mandar.
   Nao ha expiracao — conversa salva fica ate ser apagada a mao. */

function salvarConversas() {
  try {
    localStorage.setItem(CONVS_KEY, JSON.stringify({ versao: 1, conversas: state.conversas }));
  } catch (_) {
    showToast("Não foi possível salvar a conversa (armazenamento cheio?).", "error");
  }
}

function carregarConversas() {
  try {
    const raw = localStorage.getItem(CONVS_KEY);
    if (raw) {
      const dados = JSON.parse(raw);
      state.conversas = Array.isArray(dados?.conversas) ? dados.conversas : [];
      return;
    }
  } catch (_) { state.conversas = []; }

  // Migra a conversa unica do formato antigo, para nao perder o que ja existia.
  try {
    const antigo = localStorage.getItem(LEGADO_KEY);
    if (!antigo) return;
    const dados = JSON.parse(antigo);
    if (dados?.messages?.length) {
      const quando = dados.savedAt || Date.now();
      state.conversas = [{
        id: gerarId(),
        titulo: tituloDe(dados.messages.find(m => m.role === "user")?.text),
        mensagens: dados.messages,
        history: dados.history || [],
        criadaEm: quando,
        atualizadaEm: quando,
      }];
      salvarConversas();
    }
    localStorage.removeItem(LEGADO_KEY);
  } catch (_) {}
}

function gerarId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function tituloDe(texto) {
  const limpo = (texto || "").replace(/\s+/g, " ").trim();
  if (!limpo) return "Conversa sem título";
  return limpo.length > 42 ? limpo.slice(0, 42).trimEnd() + "…" : limpo;
}

function conversaAtual() {
  return state.conversas.find(c => c.id === state.idAtual) || null;
}

function formatarQuando(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const agora = new Date();
  const mesmoDia = d.toDateString() === agora.toDateString();
  if (mesmoDia) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const ontem = new Date(agora); ontem.setDate(agora.getDate() - 1);
  if (d.toDateString() === ontem.toDateString()) return "ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

/* ─── Lista na sidebar ───────────────────────── */
function renderListaConversas() {
  const lista = DOM.convList();
  if (!lista) return;

  setText(DOM.convCount(), String(state.conversas.length));

  const ordenadas = [...state.conversas].sort((a, b) => (b.atualizadaEm || 0) - (a.atualizadaEm || 0));
  lista.innerHTML = "";

  if (!ordenadas.length) {
    const vazio = document.createElement("p");
    vazio.className = "conv-empty";
    vazio.id = "conv-empty";
    vazio.textContent = "Nenhuma conversa ainda.";
    lista.appendChild(vazio);
    return;
  }

  for (const conv of ordenadas) {
    const item = document.createElement("div");
    item.className = `conv-item${conv.id === state.idAtual ? " active" : ""}`;
    item.dataset.id = conv.id;
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.title = conv.titulo;

    const corpo = document.createElement("div");
    corpo.className = "conv-item-body";

    const titulo = document.createElement("span");
    titulo.className = "conv-item-title";
    titulo.textContent = conv.titulo;

    const meta = document.createElement("span");
    meta.className = "conv-item-meta";
    const trocas = conv.mensagens.filter(m => m.role === "user").length;
    meta.textContent = `${formatarQuando(conv.atualizadaEm)} · ${trocas} ${trocas === 1 ? "pergunta" : "perguntas"}`;

    corpo.appendChild(titulo);
    corpo.appendChild(meta);

    const excluir = document.createElement("button");
    excluir.className = "conv-del";
    excluir.title = "Excluir conversa";
    excluir.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;

    item.appendChild(corpo);
    item.appendChild(excluir);
    lista.appendChild(item);
  }
}

/* ─── Navegação ──────────────────────────────── */

/** Limpa as bolhas do DOM sem tocar na tela de boas-vindas. */
function limparMensagensDaTela() {
  DOM.messagesArea()?.querySelectorAll(".message-wrapper").forEach(el => el.remove());
}

/** Tela inicial: esfera e sugestões, fora de qualquer conversa. */
function mostrarTelaInicial() {
  state.idAtual = null;
  limparMensagensDaTela();

  const ws = DOM.welcomeScreen();
  if (ws) ws.hidden = false;
  DOM.messagesArea()?.classList.add("welcome-mode");

  DOM.navCipher()?.classList.add("active");
  renderListaConversas();
  DOM.messageInput()?.focus();
}

function abrirConversa(id) {
  const conv = state.conversas.find(c => c.id === id);
  if (!conv) return;

  state.idAtual = id;
  limparMensagensDaTela();

  const ws = DOM.welcomeScreen();
  if (ws) ws.hidden = true;
  DOM.messagesArea()?.classList.remove("welcome-mode");
  DOM.navCipher()?.classList.remove("active");

  for (const m of conv.mensagens) renderMessage(m.role, m.text, m.time, m.fontes, m.anexos);
  renderListaConversas();

  const area = DOM.messagesArea();
  if (area) area.scrollTop = area.scrollHeight;
  DOM.messageInput()?.focus();
}

function excluirConversa(id) {
  const era = state.idAtual === id;
  state.conversas = state.conversas.filter(c => c.id !== id);
  salvarConversas();
  if (era) mostrarTelaInicial();
  else renderListaConversas();
  showToast("Conversa excluída.", "info");
}

/* ═══════════════════════════════════════════════
   MEMÓRIA — fatos que valem em qualquer conversa
   ═══════════════════════════════════════════════
   Mesmo desenho das conversas: tudo no localStorage, o servidor nao guarda
   nada. Os fatos vao em cada requisicao e entram no system prompt. Depois de
   cada resposta, o back extrai fatos novos da mensagem em segundo plano. */

function carregarMemoria() {
  try {
    const raw = localStorage.getItem(MEMORIA_KEY);
    if (!raw) return;
    const dados = JSON.parse(raw);
    state.fatos = Array.isArray(dados?.fatos)
      ? dados.fatos.filter(f => f && typeof f.texto === "string" && f.texto.trim())
      : [];
  } catch (_) { state.fatos = []; }
}

function salvarMemoria() {
  try {
    localStorage.setItem(MEMORIA_KEY, JSON.stringify({ versao: 1, fatos: state.fatos }));
  } catch (_) {
    showToast("Não foi possível salvar a memória (armazenamento cheio?).", "error");
  }
}

/** Normaliza para comparar: sem acento, sem caixa, sem pontuacao final. */
function normalizarFato(texto) {
  return texto.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").trim()
    .replace(/[.!]+$/, "");
}

/** Adiciona um fato se ainda nao existir. Devolve true se entrou. */
function adicionarFato(texto, origem) {
  const limpo = (texto || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!limpo) return false;

  const chave = normalizarFato(limpo);
  if (state.fatos.some(f => normalizarFato(f.texto) === chave)) return false;

  state.fatos.unshift({ id: gerarId(), texto: limpo, origem: origem || "manual", criadoEm: Date.now() });
  if (state.fatos.length > MAX_FATOS) state.fatos = state.fatos.slice(0, MAX_FATOS);

  salvarMemoria();
  renderMemoria();
  return true;
}

function excluirFato(id) {
  state.fatos = state.fatos.filter(f => f.id !== id);
  salvarMemoria();
  renderMemoria();
  showToast("Fato removido da memória.", "info");
}

function renderMemoria() {
  const lista = DOM.memoriaList();
  if (!lista) return;

  setText(DOM.memoriaCount(), String(state.fatos.length));
  lista.innerHTML = "";

  if (!state.fatos.length) {
    const vazio = document.createElement("p");
    vazio.className = "memoria-empty";
    vazio.textContent = "Nada aprendido ainda.";
    lista.appendChild(vazio);
    return;
  }

  for (const fato of state.fatos) {
    const item = document.createElement("div");
    item.className = "memoria-item";
    item.dataset.id = fato.id;

    const texto = document.createElement("span");
    texto.className = "memoria-texto";
    texto.textContent = fato.texto;
    texto.title = fato.texto;

    const excluir = document.createElement("button");
    excluir.className = "memoria-del";
    excluir.title = "Esquecer este fato";
    excluir.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

    item.appendChild(texto);
    item.appendChild(excluir);
    lista.appendChild(item);
  }
}

/**
 * Extracao em segundo plano, DEPOIS da resposta terminar: o llama-server
 * processa uma requisicao por vez, e extrair em paralelo atrasaria o chat.
 * Falha aqui e silenciosa de proposito: memoria e um extra.
 */
function extrairMemoriaEmSegundoPlano(mensagem) {
  fetch(`${API_BASE}/api/memoria/extrair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: mensagem }),
  })
    .then(r => (r.ok ? r.json() : null))
    .then(dados => {
      const novos = (dados?.fatos || []).filter(f => adicionarFato(f, "auto"));
      if (novos.length) {
        const extra = novos.length > 1 ? ` (e mais ${novos.length - 1})` : "";
        showToast(`Memória atualizada: ${novos[0]}${extra}`, "success");
      }
    })
    .catch(() => {});
}

/* ─── System status ───────────────────────────── */

async function refreshSystemStatus() {
  const res = await fetch(`${API_BASE}/api/health`);
  const health = res.ok ? await res.json() : null;
  const healthy = health?.status === "healthy";

  const dot = DOM.rsStatusDot();
  if (dot) {
    dot.style.background = healthy ? "var(--success)" : "var(--danger)";
    dot.style.boxShadow  = healthy ? "0 0 8px var(--success)" : "0 0 8px var(--danger)";
  }
  const coreText = DOM.rsStatusText();
  if (coreText) {
    // Antes dizia "OPERACIONAL · OFFLINE": tecnicamente certo (o modelo e o da
    // maquina), mas "OFFLINE" ao lado de "OPERACIONAL" se le como falha.
    // "100% LOCAL" diz a mesma coisa sem a leitura de erro.
    coreText.textContent = healthy ? "OPERACIONAL · 100% LOCAL" : "MODELO DESLIGADO";
    coreText.style.color = healthy ? "var(--success)" : "var(--danger)";
    coreText.title = healthy
      ? "Modelo rodando nesta maquina. Nenhum dado sai daqui."
      : "Suba o llama-server com: npm run modelo";
  }

  state.contextoMax = health?.contextoMax || state.contextoMax;

  const info = health?.modelo || {};
  const bruto = healthy ? (health?.localModel || "") : "";
  const { nome, precisao } = formatarModelo(bruto);

  const elModelo = DOM.rsModel();
  if (elModelo) {
    elModelo.textContent = nome;
    // O id completo continua acessivel, so nao ocupa a linha inteira do painel.
    elModelo.title = bruto || "Modelo local";
  }

  // O /props descreve a quantizacao melhor que o nome do arquivo ("Q4_K - Medium"
  // contra "q4_k_m"), entao ele tem prioridade quando existe.
  const elPrec = DOM.rsPrecisao();
  if (elPrec) {
    elPrec.textContent = info.quantizacao ? info.quantizacao.replace(/\s*-\s*/, " ") : precisao;
    elPrec.title = info.quantizacao ? `Quantizacao ${info.quantizacao}` : "Quantizacao do modelo";
  }

  setText(DOM.rsPeso(), info.bytes ? formatarBytes(info.bytes) : "—");

  const elMotor = DOM.rsMotor();
  if (elMotor) {
    // "b10240-0b14b87d7" -> "llama.cpp b10240": o hash do commit nao cabe e nao
    // diz nada de util aqui; fica no title.
    const build = info.motor ? String(info.motor).split("-")[0] : null;
    /* Mostra ONDE a inferencia esta rodando junto do build. Quando o Cipher
       cai para o segundo endpoint (modelo menor, no servidor) a qualidade da
       resposta muda, e sem este rotulo a diferenca apareceria sem explicacao. */
    /* ⚠️ A variavel desta funcao e `health`, nao `dados`. Escrever o nome
       errado aqui passa no `node --check` e estoura como ReferenceError em
       runtime, dentro de um bloco que roda a cada 2 min: foi exatamente assim
       que o chat inteiro quebrou em 01/11. */
    const onde = health?.endpoint && (health?.endpoints || []).length > 1 ? ` · ${health.endpoint}` : "";
    elMotor.textContent = build ? `llama.cpp ${build}${onde}` : (health?.endpoint || "—");
    elMotor.title = info.motor
      ? `llama.cpp build ${info.motor}${info.slots ? ` · ${info.slots} slots` : ""}`
      : "Motor de inferencia";
  }

  // Sem resposta ainda nao ha o que medir, mas o teto do contexto ja e conhecido.
  if (state.contextoMax && DOM.rsCtxValor()?.textContent === "—") {
    setText(DOM.rsCtxValor(), `0 / ${state.contextoMax}`);
  }

  atualizarRodapeNav(health, healthy);
}

/* Quebra o id do gguf em nome e precisao: "qwen2.5-3b-instruct-q4_k_m" vira
   "Qwen2.5 3B" + "Q4_K_M". O id inteiro estourava a coluna do painel, e o sufixo
   de quantizacao e informacao real demais para virar reticencias. */
const RE_QUANT = /[-_](iq\d[a-z0-9_]*|q\d+[a-z0-9_]*|bf16|f16|f32)$/i;

function formatarModelo(id) {
  if (!id) return { nome: "—", precisao: "—" };

  let base = String(id);
  let precisao = "—";
  const m = base.match(RE_QUANT);
  if (m) { precisao = m[1].toUpperCase(); base = base.slice(0, m.index); }

  // "instruct"/"chat" nao distinguem nada aqui: todo modelo do Cipher e de chat.
  const partes = base.split(/[-_]/)
    .filter(p => p && !/^(instruct|chat|it|gguf)$/i.test(p))
    // "3b" e "7b" sao tamanho de parametros e se escrevem com B maiusculo.
    // Capitalizar so a primeira letra deixava "3b", porque a primeira e o digito.
    .map(p => /^\d+(\.\d+)?b$/i.test(p) ? p.toUpperCase()
                                        : p.charAt(0).toUpperCase() + p.slice(1));

  return { nome: partes.join(" ") || base, precisao };
}

/* Bytes em GB/MB. O .gguf do 3B tem ~2 GB, entao uma casa decimal basta. */
function formatarBytes(bytes) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1).replace(".", ",")} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/* Painel de metricas depois de cada resposta. Tudo aqui e medido, nao estimado:
   os tokens vem do bloco `usage` do llama-server (que so chega porque o provider
   pede stream_options.include_usage) e a latencia, do proprio agent. */
function atualizarMetricas(meta, latMs) {
  const u = meta?.usage || null;

  setText(DOM.rsLatency(), latMs >= 1000 ? `${(latMs / 1000).toFixed(1).replace(".", ",")}s` : `${latMs}ms`);

  // Tokens por segundo conta so a GERACAO: incluir o prompt inflaria o numero,
  // porque ler o prompt e muito mais rapido que gerar token.
  const saida = u?.completionTokens;
  if (saida && latMs > 0) {
    setText(DOM.rsVelocidade(), (saida / (latMs / 1000)).toFixed(1).replace(".", ","));
  }

  if (u?.promptTokens != null && saida != null) {
    const el = DOM.rsTokens();
    if (el) {
      el.textContent = `${u.promptTokens} + ${saida}`;
      el.title = `${u.promptTokens} tokens de entrada, ${saida} gerados`
        + (u.cachedTokens ? ` · ${u.cachedTokens} reaproveitados do cache` : "");
    }

    // Fatia do prompt que o llama-server nao precisou reprocessar. E o que explica
    // a 2a mensagem responder muito mais rapido que a 1a.
    const elCache = DOM.rsCache();
    if (elCache && u.cachedTokens != null && u.promptTokens > 0) {
      const pct = Math.round((u.cachedTokens / u.promptTokens) * 100);
      elCache.textContent = `${pct}%`;
      elCache.title = `${u.cachedTokens} de ${u.promptTokens} tokens do prompt vieram do cache`;
    }
  }

  if (u?.totalTokens != null) {
    state.tokensSessao += u.totalTokens;
    setText(DOM.rsTokensSessao(), state.tokensSessao.toLocaleString("pt-BR"));
  }

  atualizarContexto(u?.totalTokens);
}

/* Barra de contexto: o quanto da janela do modelo a ultima troca ocupou. E o
   numero que mais importa neste projeto — o 3B tem 4096 tokens, e o modo
   documentos sozinho ja come uns 3600 chars de trechos. */
function atualizarContexto(usados) {
  const max = state.contextoMax;
  if (!max || usados == null) return;

  const pct = Math.min(100, (usados / max) * 100);
  // Sem separador de milhar: "4.096" ao lado de "0" se le como numero decimal.
  setText(DOM.rsCtxValor(), `${usados} / ${max} tokens`);
  setText(DOM.rsCtxPct(), `${pct.toFixed(0)}%`);

  const elPct = DOM.rsCtxPct();
  if (elPct) elPct.style.color = pct >= 90 ? "var(--danger)" : pct >= 70 ? "#ffd000" : "var(--p)";

  const fill = DOM.rsCtxFill();
  if (!fill) return;
  fill.style.width = `${pct}%`;
  // Perto do teto o modelo comeca a perder o inicio da conversa: avisa pela cor.
  fill.style.background = pct >= 90 ? "var(--danger)"
    : pct >= 70 ? "#ffd000"
    : "linear-gradient(to right, var(--blue), var(--p))";

  const el = DOM.rsCtxValor();
  if (el) el.title = pct >= 90
    ? "Contexto quase cheio: o modelo comeca a esquecer o inicio da conversa."
    : `${pct.toFixed(0)}% da janela de contexto do modelo`;
}

/* Rodape da sidebar esquerda. Antes era decoracao fixa ("CIPHER SYSTEM /
   ADMIN ACCESS" com barra de progresso em 62% cravada no HTML): o Cipher nao tem
   login nem nivel de acesso, e a barra nunca mediu nada. Agora mostra o unico
   dado real que o painel da direita nao repete: o indice do modo documentos. */
function atualizarRodapeNav(health, healthy) {
  const elModo = DOM.navModo();
  if (elModo) {
    elModo.textContent = healthy ? "100% LOCAL" : "MODELO DESLIGADO";
    elModo.style.color = healthy ? "var(--success)" : "var(--danger)";
  }

  const elDocs = DOM.navDocs();
  if (!elDocs) return;

  const docs = health?.docs;
  if (docs?.disponivel) {
    // "trechos indexados" nao cabe nos ~128px que sobram ao lado do avatar e virava
    // reticencias. O detalhe fica no title.
    const n = docs.trechos || 0;
    elDocs.textContent = `${n.toLocaleString("pt-BR")} trechos`;
    const data = docs.geradoEm ? new Date(docs.geradoEm) : null;
    elDocs.title = data && !isNaN(data)
      ? `Indice gerado em ${data.toLocaleDateString("pt-BR")}. Reindexar: npm run indexar`
      : "Indice do modo documentos";
  } else {
    elDocs.textContent = "Documentos sem indice";
    elDocs.title = "Gere o indice com: npm run indexar";
  }
}

/* ─── Clock + Uptime ─────────────────────────── */
function updateClock() {
  const now = new Date();
  setText(DOM.liveTime(), now.toLocaleTimeString("pt-BR", { hour12: false }));
  setText(DOM.liveDate(), now.toLocaleDateString("pt-BR", { day:"2-digit", month:"short", year:"numeric" }).toUpperCase());
  setText(DOM.rsUptime(), formatUptime(Date.now() - state.sessionStart));
}

/* ─── Loading ────────────────────────────────── */

/* Ponto unico que liga e desliga o indicador de digitacao. Existe para o mini
   globo nunca ficar animando por tras de um indicador escondido: o `hidden` era
   mexido em tres lugares diferentes e um deles esqueceria de parar o rAF. */
function mostrarDigitando(on) {
  const el = DOM.typingIndicator();
  if (!el) return;
  if (on) { el.removeAttribute("hidden"); miniGlobo?.iniciar(); }
  else    { el.setAttribute("hidden", ""); miniGlobo?.parar(); }
}

function setLoading(on) {
  state.isLoading = on;
  const input = DOM.messageInput(), btn = DOM.sendButton();
  if (!input || !btn) return;
  input.disabled = on;
  if (on) {
    btn.disabled = true;
    DOM.sendIcon()?.setAttribute("hidden", "");
    DOM.loadingIcon()?.removeAttribute("hidden");
    mostrarDigitando(true);
  } else {
    btn.disabled = input.value.trim().length === 0;
    DOM.sendIcon()?.removeAttribute("hidden");
    DOM.loadingIcon()?.setAttribute("hidden", "");
    mostrarDigitando(false);
    input.focus();
  }
}

/* ─── Toast ──────────────────────────────────── */
function showToast(msg, type = "info") {
  const c = DOM.toastContainer(); if (!c) return;
  const t = document.createElement("div");
  t.className = `toast toast-${type}`; t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.classList.add("toast-out"); setTimeout(() => t.remove(), 280); }, 3500);
}

/* ─── Char counter ───────────────────────────── */
function updateCharCounter(len) {
  const el = DOM.charCounter(); if (!el) return;
  el.textContent = `${len}/8000`;
  const estado = len > 7500 ? " danger" : len > 6000 ? " warning" : "";
  // `tem-texto` libera os 46px do contador para o placeholder enquanto o campo
  // esta vazio, mas SO em tela estreita (ver a media query no style.css). Com
  // 390px de viewport o textarea fica com ~126px e "Pergunte qualquer coisa..."
  // cortava no meio.
  el.className = `char-counter${estado}${len > 0 ? " tem-texto" : ""}`;
}

/* ─── Markdown ───────────────────────────────── */
function parseMarkdown(text) {
  if (!text) return "";

  text = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  // Protege blocos de código
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_,_l,code) => {
    codeBlocks.push(`<pre><code>${code.trimEnd()}</code></pre>`);
    return `\x00BLK${codeBlocks.length-1}\x00`;
  });

  // Processa linha a linha
  const lines = text.split("\n");
  const out = [];
  let inUl = false, inOl = false;

  for (const line of lines) {
    const ulm = line.match(/^[-*] (.+)/);
    const olm = line.match(/^\d+\. (.+)/);
    if (!ulm && inUl) { out.push("</ul>"); inUl = false; }
    if (!olm && inOl) { out.push("</ol>"); inOl = false; }

    let m;
    if      ((m = line.match(/^### (.+)/))) out.push(`<h3>${m[1]}</h3>`);
    else if ((m = line.match(/^## (.+)/)))  out.push(`<h2>${m[1]}</h2>`);
    else if ((m = line.match(/^# (.+)/)))   out.push(`<h1>${m[1]}</h1>`);
    else if (ulm) { if (!inUl) { out.push("<ul>"); inUl = true; } out.push(`<li>${ulm[1]}</li>`); }
    else if (olm) { if (!inOl) { out.push("<ol>"); inOl = true; } out.push(`<li>${olm[1]}</li>`); }
    else if (/^---+\s*$/.test(line)) out.push("<hr>");
    else out.push(line);
  }
  if (inUl) out.push("</ul>");
  if (inOl) out.push("</ol>");

  const BLOCK = /^<(h[1-6]|ul|ol|li|hr|pre|\/ul|\/ol)[\s>]/;
  const html = out.map((line, i, arr) => {
    if (BLOCK.test(line) || (i > 0 && BLOCK.test(arr[i-1]))) return line;
    return line === "" ? "<br>" : line + "<br>";
  }).join("");

  const result = html
    .replace(/`([^`\n]+)`/g,"<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g,"<em>$1</em>");

  return codeBlocks.reduce((t,b,i) => t.replace(`\x00BLK${i}\x00`, b), result);
}

/* ─── Copy text util ─────────────────────────── */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // fallback para HTTP localhost
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    showToast("Copiado!", "success");
  } catch (_) {
    showToast("Falha ao copiar.", "error");
  }
}

/* ─── Render message ─────────────────────────── */

/**
 * Cria a bolha no DOM e devolve um handle com atualizar/finalizar/remover.
 * E a base tanto da mensagem pronta (renderMessage) quanto do streaming, em
 * que a bolha nasce vazia e cresce a cada token.
 */
function criarBolha(role, time, anexos) {
  const area = DOM.messagesArea();
  // Esconde, nao remove: a tela inicial precisa voltar sem reinicializar a esfera 3D.
  const ws   = DOM.welcomeScreen();
  if (ws) ws.hidden = true;
  if (area) area.classList.remove("welcome-mode");

  const t = time || new Date().toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" });
  const wrap = document.createElement("div");
  wrap.className = `message-wrapper ${role}`;

  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = t;

  /* ⚠️ Os anexos vao antes da bolha, dentro do `content`, e NAO dentro da
     `bubble`. Motivo medido em 2026-11-03: `refs.atualizar()` faz
     `bubble.innerHTML = parseMarkdown(texto)` a cada token do streaming, o que
     apagava o chip no primeiro delta. O sintoma era cruel: o anexo persistia no
     localStorage, a barra limpava certo, e so o chip sumia, sem erro nenhum.
     Fora da bubble, ele sobrevive a qualquer reescrita do texto. */
  if (anexos && anexos.length) {
    const barra = document.createElement("div");
    barra.className = "message-anexos";
    for (const a of anexos) barra.appendChild(montarChipAnexo(a, false));
    contentDiv.appendChild(barra);
  }

  contentDiv.appendChild(bubble);
  contentDiv.appendChild(meta);

  const refs = { time: t, wrap, bubble, textoBruto: "" };

  if (role === "assistant") {
    const copyBtn = document.createElement("button");
    copyBtn.className = "msg-copy-btn";
    copyBtn.title = "Copiar resposta";
    copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    // Le refs.textoBruto na hora do clique: durante o streaming o texto ainda esta crescendo.
    copyBtn.addEventListener("click", () => copyText(refs.textoBruto));
    contentDiv.appendChild(copyBtn);
  }

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "EU" : "J";

  if (role === "user") {
    wrap.appendChild(contentDiv);
    wrap.appendChild(avatar);
  } else {
    wrap.appendChild(avatar);
    wrap.appendChild(contentDiv);
  }

  area.appendChild(wrap);
  area.scrollTo({ top: area.scrollHeight, behavior: "smooth" });

  refs.atualizar = (texto) => {
    refs.textoBruto = texto;
    bubble.innerHTML = parseMarkdown(texto);
    // So acompanha o texto se o usuario ja esta no fim: rolar a forca enquanto
    // ele le o comeco da resposta e pior que nao rolar.
    if (area.scrollHeight - area.scrollTop - area.clientHeight < 140) {
      area.scrollTop = area.scrollHeight;
    }
  };
  refs.marcarStreaming = (ligado) => bubble.classList.toggle("streaming", !!ligado);
  refs.remover = () => wrap.remove();

  // Modo documentos: lista as notas que embasaram a resposta, abaixo da bolha.
  refs.mostrarFontes = (fontes) => {
    if (!Array.isArray(fontes) || !fontes.length) return;
    const div = document.createElement("div");
    div.className = "message-fontes";
    div.textContent = `FONTES: ${fontes.join(" · ")}`;
    contentDiv.insertBefore(div, meta);
  };

  // Acoes de arquivo propostas pelo modelo. Nada foi executado ainda: cada card
  // espera um clique. Tudo que vem do modelo entra por textContent, nunca por
  // innerHTML, porque caminho e conteudo sao texto gerado.
  refs.mostrarAcoes = (acoes) => {
    if (!Array.isArray(acoes) || !acoes.length) return;
    for (const acao of acoes) {
      contentDiv.insertBefore(criarCardDeAcao(acao), meta);
    }
  };

  return refs;
}

/* ═══════════════════════════════════════════════════════════
   DEVOLVER O ERRO DA FERRAMENTA AO MODELO
   ═══════════════════════════════════════════════════════════
   As guardas do montador recusam com motivo e com a lista do que usar, mas o
   erro nasce em `POST /api/arquivos/executar`, que roda DEPOIS do clique e
   fora da conversa. O modelo nunca via a recusa.

   ⚠️ Medido em 2026-11-03: a guarda de contrato recusou tres colunas inventadas
   e respondeu com os 75 nomes certos. Correto, e ainda assim um beco sem saida:
   o usuario leu a lista na tela e teve de reescrever o pedido a mao, porque
   ninguem levou aquele texto de volta para quem errou.

   So vale para recusa que o modelo PODE consertar trocando argumento. Erro de
   rede, acao expirada e falha interna nao entram: repetir a pergunta nao muda
   nada e gastaria uma inferencia por nada. */
const ERROS_QUE_O_MODELO_CONSERTA = new Set([
  "CAMPO_INEXISTENTE", "SOBRESCREVERIA_ORIGEM", "SAIDA_IGUAL_ORIGEM",
  "COLUNAS_DE_MENOS", "COLUNAS_DEMAIS", "SEM_COLUNAS", "SEM_CAMPOS",
  "SEM_SAIDA", "EXTENSAO_NAO_PERMITIDA", "HERDAR_FALHOU", "FORA_DA_RAIZ",
  "JA_EXISTE", "ARQUIVO_RESERVADO", "NAO_ENCONTRADO", "CONTEUDO_INVALIDO",
]);

/* Uma tentativa automatica por card. Sem este teto, uma recusa que o modelo
   nao consegue satisfazer viraria laco infinito de inferencia, e cada volta
   custa segundos no 3B e trava o llama-server, que atende uma por vez. */
const cardsJaDevolvidos = new WeakSet();

function devolverErroAoModelo(card, err) {
  if (!ERROS_QUE_O_MODELO_CONSERTA.has(err.codigo)) return;
  if (cardsJaDevolvidos.has(card)) return;
  cardsJaDevolvidos.add(card);

  const nota = document.createElement("p");
  nota.className = "acao-aviso";
  nota.textContent = "Devolvendo o motivo ao Cipher para ele corrigir e propor de novo.";
  card.appendChild(nota);

  /* O texto vai como mensagem de usuario e APARECE na conversa, de proposito.
     Turno invisivel faria o modelo responder a algo que o usuario nao viu ser
     perguntado, e a conversa salva ficaria sem explicacao para a proposta nova. */
  sendMessage(
    `A ferramenta recusou a acao e nao gravou nada. Motivo exato do sistema:\n\n` +
    `${err.message}\n\n` +
    `Corrija os argumentos seguindo esse motivo e proponha a acao de novo, ` +
    `numa unica chamada de ferramenta. Nao responda em texto.`
  );
}

/** Card de confirmacao de uma acao de arquivo. */
function criarCardDeAcao(acao) {
  const card = document.createElement("div");
  card.className = "acao-card" + (acao.destrutiva ? " destrutiva" : "");

  const titulo = document.createElement("div");
  titulo.className = "acao-titulo";
  titulo.textContent = acao.invalida ? "Pedido invalido" : acao.resumo;
  card.appendChild(titulo);

  if (acao.invalida || !acao.id) {
    const aviso = document.createElement("div");
    aviso.className = "acao-erro";
    aviso.textContent = "O modelo montou um pedido que não deu para interpretar. Peça de novo, com o nome do arquivo.";
    card.appendChild(aviso);
    return card;
  }

  if (acao.previa) {
    const previa = document.createElement("pre");
    previa.className = "acao-previa";
    previa.textContent = acao.previa;
    card.appendChild(previa);
  }

  // A regeneracao do CIPHER.md e uma segunda escrita, derivada desta. Avisar
  // aqui mantem honesta a regra de que nada e gravado sem confirmacao.
  if (acao.geraIndice) {
    const nota = document.createElement("div");
    nota.className = "acao-nota";
    nota.textContent = "O índice CIPHER.md da pasta é atualizado junto.";
    card.appendChild(nota);
  }

  const botoes = document.createElement("div");
  botoes.className = "acao-botoes";

  const confirmar = document.createElement("button");
  confirmar.className = "acao-btn confirmar";
  confirmar.textContent = acao.destrutiva ? "Confirmar" : "Executar";

  const cancelar = document.createElement("button");
  cancelar.className = "acao-btn cancelar";
  cancelar.textContent = "Cancelar";

  const encerrar = (texto, classe) => {
    botoes.remove();
    const estado = document.createElement("div");
    estado.className = `acao-estado ${classe}`;
    estado.textContent = texto;
    card.appendChild(estado);
  };

  confirmar.addEventListener("click", async () => {
    confirmar.disabled = true;
    cancelar.disabled = true;
    confirmar.textContent = "Executando...";
    try {
      const res = await fetch(`${API_BASE}/api/arquivos/executar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: acao.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        const erro = new Error(data?.error || `Falhou (${res.status})`);
        erro.codigo = data?.code || null;
        throw erro;
      }
      encerrar(descreverResultado(data), "ok");
      mostrarSaidaDaAcao(card, data);
    } catch (err) {
      encerrar(err.message, "erro");
      showToast(err.message, "error");
      devolverErroAoModelo(card, err);
    }
  });

  cancelar.addEventListener("click", () => {
    fetch(`${API_BASE}/api/arquivos/cancelar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: acao.id }),
    }).catch(() => {});
    encerrar("Cancelado.", "cancelado");
  });

  botoes.appendChild(confirmar);
  botoes.appendChild(cancelar);
  card.appendChild(botoes);
  return card;
}

/** Quantos CIPHER.md foram regerados junto com a acao. */
function sufixoIndice(r) {
  const n = Array.isArray(r.indices) ? r.indices.length : 0;
  if (!n) return "";
  return n === 1 ? " · índice atualizado" : ` · ${n} índices atualizados`;
}

function descreverResultado(data) {
  const r = data.resultado || {};
  switch (data.ferramenta) {
    case "criar_arquivo":  return `Criado: ${r.caminho}${sufixoIndice(r)}`;
    case "editar_arquivo": return `Salvo: ${r.caminho} (a versão anterior ficou em ${r.backup})${sufixoIndice(r)}`;
    case "apagar_arquivo": return `${r.caminho} foi para a Lixeira${sufixoIndice(r)}`;
    case "ler_arquivo":    return `Lido: ${r.caminho}`;
    case "listar_pasta":   return `${r.total} item(ns) em ${r.caminho}`;
    /* ⚠️ Sem este caso a geração caía no `default` e o card dizia só "Feito.",
       escondendo o que mais importa conferir: quantas colunas e quantos campos
       saíram. Em 2026-11-03 um arquivo saiu com 1 coluna e 59 campos de um
       original de 75, e "Feito." não deu nenhuma pista. */
    case "gerar_relatorio_a2o":
      return `Gerado: ${r.caminho} (${r.colunas} coluna(s), ${r.campos} campo(s), ` +
             `${Math.round((r.bytes || 0) / 1024)} KB)${sufixoIndice(r)}`;
    default:               return "Feito.";
  }
}

/**
 * Completa o card depois da execução: saída de leitura, aviso do servidor e o
 * botão de baixar.
 */
function mostrarSaidaDaAcao(card, data) {
  const r = data.resultado || {};

  // Leitura e listagem devolvem conteudo, que vale a pena mostrar na hora.
  let texto = null;
  if (data.ferramenta === "ler_arquivo") {
    texto = r.conteudo + (r.truncado ? "\n\n[...] arquivo cortado na exibição." : "");
  } else if (data.ferramenta === "listar_pasta") {
    texto = r.itens.length
      ? r.itens.map((i) => (i.tipo === "pasta" ? `${i.nome}/` : i.nome)).join("\n")
      : "Pasta vazia.";
  }
  if (texto !== null) {
    const pre = document.createElement("pre");
    pre.className = "acao-saida";
    pre.textContent = texto;
    card.appendChild(pre);
  }

  /* Aviso que o servidor anexa ao resultado, como o palpite de `herdarDe`. Ele
     existia no payload e nunca era exibido: o usuário não tinha como desmentir
     um palpite que não via. */
  if (r.aviso) {
    const nota = document.createElement("p");
    nota.className = "acao-aviso";
    nota.textContent = r.aviso;
    card.appendChild(nota);
  }

  /* Botao de baixar, quando a acao produziu um arquivo. E o fim do fluxo
     "envio um .jrxml, recebo outro pronto": sem ele o arquivo gerado fica
     so na sandbox do servidor, inalcancavel pelo navegador.

     ⚠️ Isto ficava DEPOIS de um `if (texto === null) return`, e `texto` só é
     preenchido por `ler_arquivo` e `listar_pasta`. Ou seja: o botão existia no
     código e era inalcançável exatamente no caso que o justifica. Medido em
     2026-11-03 com o usuário pedindo "gere o arquivo" e o card respondendo
     "Feito." sem nada para clicar. Não volte a amarrar o botão à saída de
     texto: são coisas independentes. */
  /* ⚠️ So em acao que PRODUZ arquivo. Em `ler_arquivo` o botao aparecia e
     oferecia o arquivo que o proprio usuario tinha acabado de enviar: ele leu
     "Baixar relconhecimento_7.jrxml" embaixo do resumo como se a geracao
     tivesse acontecido, e o que baixaria era o original intacto. Medido em
     2026-11-03. Oferecer download do que ele ja tem nao ajuda e confunde o
     unico momento em que o botao significa algo. */
  const PRODUZ_ARQUIVO = ["criar_arquivo", "editar_arquivo", "gerar_relatorio_a2o"];
  if (PRODUZ_ARQUIVO.includes(data.ferramenta) &&
      r.caminho && /\.(jrxml|xml|md|txt|csv|json|py|sql)$/i.test(r.caminho)) {
    const baixar = document.createElement("a");
    baixar.className = "acao-btn confirmar acao-baixar";
    baixar.href = `${API_BASE}/api/arquivos/baixar?caminho=${encodeURIComponent(r.caminho)}`;
    baixar.setAttribute("download", "");
    baixar.textContent = `Baixar ${r.caminho}`;
    card.appendChild(baixar);
  }
}

function renderMessage(role, text, time, fontes, anexos) {
  const bolha = criarBolha(role, time, anexos);
  bolha.atualizar(text);
  bolha.mostrarFontes(fontes);
  return bolha.time;
}

/* ─── SSE ────────────────────────────────────── */

/**
 * Le um body de fetch como fluxo SSE e chama onEvento(nome, dados) para cada
 * evento completo. Nome null = evento sem "event:" (os deltas de texto).
 */
async function lerSse(body, onEvento) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let corte;
    while ((corte = buffer.indexOf("\n\n")) !== -1) {
      const bloco = buffer.slice(0, corte);
      buffer = buffer.slice(corte + 2);

      let evento = null;
      const datas = [];
      for (const linha of bloco.split("\n")) {
        if (linha.startsWith("event:")) evento = linha.slice(6).trim();
        else if (linha.startsWith("data:")) datas.push(linha.slice(5).trimStart());
      }
      if (!datas.length) continue;

      let dados;
      try { dados = JSON.parse(datas.join("\n")); } catch (_) { continue; }
      onEvento(evento, dados);
    }
  }
}

/* ─── Send ───────────────────────────────────── */
/**
 * Envia a mensagem do input, ou `textoForcado` quando o proprio sistema precisa
 * falar com o modelo (ver devolverErroAoModelo).
 */
async function sendMessage(textoForcado = null) {
  // Segunda trava do mesmo risco: so string vale como texto forcado, para um
  // listener ligado direto nao transformar o Event em pergunta.
  if (textoForcado != null && typeof textoForcado !== "string") textoForcado = null;

  const input = DOM.messageInput();
  let msg     = textoForcado ?? input?.value.trim();
  // Mensagem do sistema nao carrega anexo: o que havia ja foi consumido no turno
  // que gerou a proposta recusada.
  const anexos = textoForcado ? [] : [...state.anexos];
  if ((!msg && !anexos.length) || state.isLoading) return;

  /* ⚠️ Os nomes dos anexos entram NO TEXTO da mensagem, e nao so no objeto da
     bolha. O modelo nao ve o estado do front: sem citar o nome no texto, ele
     nao tem como saber que existe arquivo para ler, e responderia perguntando
     qual arquivo. */
  if (anexos.length) {
    const lista = anexos.map((a) => a.nome).join(", ");
    msg = msg
      ? `${msg}\n\n(arquivo anexado: ${lista})`
      : `Leia o arquivo ${lista} e me diga o que ele e e o que da para fazer com ele.`;
  }

  // Corta a leitura da resposta anterior: pergunta nova cala a voz da antiga.
  voz.parar();

  // Sem conversa aberta (tela inicial), a primeira mensagem cria uma. Conversa
  // vazia nunca aparece na lista: ela nasce com conteudo.
  let conv = conversaAtual();
  if (!conv) {
    conv = {
      id: gerarId(),
      titulo: tituloDe(msg),
      mensagens: [],
      history: [],
      criadaEm: Date.now(),
      atualizadaEm: Date.now(),
    };
    state.conversas.push(conv);
    state.idAtual = conv.id;
    DOM.navCipher()?.classList.remove("active");
  }

  const time = renderMessage("user", msg, null, null, anexos);
  conv.mensagens.push({ role: "user", text: msg, time, anexos });
  // Consumidos: o chip some da barra agora que virou parte da mensagem.
  state.anexos = [];
  renderAnexos();
  conv.atualizadaEm = Date.now();
  salvarConversas();
  renderListaConversas();

  /* Mensagem do sistema NAO limpa o input: se o usuario estava digitando quando
     a recusa voltou, apagar o rascunho dele seria perda sem aviso. */
  if (!textoForcado) {
    input.value = ""; input.style.height = "auto";
    updateCharCounter(0);
  }
  setLoading(true);

  // Streaming: a bolha do assistente nasce vazia no primeiro token e cresce a
  // cada delta. Com o modelo local (1 a 6 s por resposta) e a diferenca entre
  // "esta respondendo" e "parece travado".
  let bolha = null;
  let textoResposta = "";

  try {
    const t0  = performance.now();
    const options = { temperature: 0.7, docs: state.modoDocs };
    const res = await fetch(`${API_BASE}/api/chat/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: msg,
        history: conv.history.slice(-MAX_HISTORY),
        options,
        memory: state.fatos.map(f => f.texto),
      }),
    });

    const tipo = res.headers.get("content-type") || "";
    if (!res.ok || !res.body || !tipo.includes("text/event-stream")) {
      // Validacao e rate limit respondem JSON normal antes de virar SSE.
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `Erro na API (${res.status})`);
    }

    let meta = null;
    let erroSse = null;

    await lerSse(res.body, (evento, dados) => {
      if (evento === "fim") {
        meta = dados;
      } else if (evento === "erro") {
        erroSse = dados;
      } else if (dados.delta) {
        if (!bolha) {
          mostrarDigitando(false);
          bolha = criarBolha("assistant");
          bolha.marcarStreaming(true);
        }
        textoResposta += dados.delta;
        bolha.atualizar(textoResposta);
        voz.alimentar(dados.delta);
      }
    });

    // Quando o modelo decide usar uma ferramenta, a resposta vem SEM texto: o
    // conteudo dela e a proposta de acao. Nesse caso "vazio" nao e falha.
    const acoes = Array.isArray(meta?.acoes) ? meta.acoes : [];

    if (erroSse && !textoResposta) throw new Error(erroSse.error || "Falha no provedor.");
    if (!textoResposta && !acoes.length) throw new Error("Resposta vazia do provedor.");
    if (erroSse) showToast("A resposta foi interrompida no meio. O texto acima está incompleto.", "error");

    if (!bolha) {
      mostrarDigitando(false);
      bolha = criarBolha("assistant");
    }
    if (!textoResposta) {
      textoResposta = acoes.length > 1
        ? "Preparei estas ações. Confira e confirme."
        : "Preparei esta ação. Confira e confirme.";
      bolha.atualizar(textoResposta);
    }

    bolha.marcarStreaming(false);
    voz.finalizar();
    const fontes = meta?.fontes?.length ? meta.fontes : undefined;
    bolha.mostrarFontes(fontes);
    // As acoes NAO sao persistidas: o id vive 10 minutos no servidor, e botao
    // que reaparece depois de recarregar so daria erro de acao expirada.
    bolha.mostrarAcoes(acoes);
    conv.mensagens.push({ role: "assistant", text: textoResposta, time: bolha.time, fontes });
    conv.history.push({ role: "user", content: msg }, { role: "assistant", content: textoResposta });
    conv.atualizadaEm = Date.now();

    // Mantém só as últimas MAX_HISTORY * 2 mensagens salvas
    if (conv.mensagens.length > MAX_HISTORY * 2) {
      conv.mensagens = conv.mensagens.slice(-MAX_HISTORY * 2);
    }
    salvarConversas();
    renderListaConversas();

    const latMs = meta?.latencyMs || Math.round(performance.now() - t0);
    atualizarMetricas(meta, latMs);

    // So depois da resposta: o llama-server atende uma requisicao por vez.
    // No modo documentos nao extrai: a pergunta costuma citar conteudo das
    // notas, e virar "fato" solto na memoria seria ruido.
    if (!state.modoDocs) extrairMemoriaEmSegundoPlano(msg);
  } catch (err) {
    // Bolha vazia orfa (erro antes do primeiro token) sai da tela.
    if (bolha && !textoResposta) bolha.remover();
    if (bolha && textoResposta) bolha.marcarStreaming(false);
    showToast(`FALHA: ${err.message}`, "error");
  } finally {
    setLoading(false);
  }
}

/* ═══════════════════════════════════════════════
   VOZ — leitura das respostas em voz alta
   ═══════════════════════════════════════════════
   Web Speech API (speechSynthesis): usa as vozes ja instaladas no macOS, entao
   continua 100% offline. Nenhum texto sai da maquina, igual ao resto do Cipher.

   Fala por FRASE, nao pela resposta inteira: (1) comeca a falar enquanto o
   modelo ainda gera, em vez de esperar o ultimo token; (2) o Chrome corta
   locucoes longas depois de ~15s, e frases curtas nao esbarram nisso. */
const VOZ_CHAVE = "cipher_voz_v1";

/* Duas personas. A API nao informa genero, entao a escolha e por nome.
   ⚠️ Esta maquina so tem UMA voz pt-BR de qualidade: Luciana. Reed, Rocko, Eddy
   e Grandpa sao "novelty voices" da Apple — servem, mas soam travadas. Por isso
   VERONICA (Luciana) e a persona fluente e CIPHER e a grave.
   Daniel (en-GB) e a voz britanica classica, mas leria portugues com fonemas
   ingleses; fica fora de proposito. */
const PERSONAS = {
  cipher: {
    rotulo: "CIPHER",
    nomes: ["Felipe", "Reed", "Rocko", "Eddy", "Grandpa"],
    pitch: 0.75, rate: 1.03,
  },
  veronica: {
    rotulo: "VERONICA",
    nomes: ["Luciana", "Flo", "Sandy", "Shelley"],
    pitch: 0.92, rate: 1.06,
  },
};

const CICLO_VOZ = [null, "veronica", "cipher"];   // null = mudo

const voz = {
  persona: null,          // null | "cipher" | "veronica"
  escolhida: null,
  buffer: "",
  falando: false,         // a esfera le isto para ondular no ritmo da fala
  pulso: 0,               // sobe a cada palavra dita e decai sozinho

  get ligada() { return this.persona !== null; },

  suportada() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  },

  iniciar() {
    if (!this.suportada()) return;
    const salvo = localStorage.getItem(VOZ_CHAVE);
    this.persona = PERSONAS[salvo] ? salvo : null;
    this.selecionarVoz();
    // getVoices() costuma vir vazio na primeira chamada: a lista carrega async.
    window.speechSynthesis.addEventListener?.("voiceschanged", () => this.selecionarVoz());
    this.refletirBotao();
  },

  selecionarVoz() {
    if (!this.persona) { this.escolhida = null; return; }
    const vozes = window.speechSynthesis.getVoices() || [];
    if (!vozes.length) return;
    const ptBr = vozes.filter(v => /^pt[-_]BR/i.test(v.lang));
    const cfg = PERSONAS[this.persona];
    this.escolhida =
      cfg.nomes.map(nome => ptBr.find(v => v.name.startsWith(nome))).find(Boolean)
      || ptBr[0]
      || null;
  },

  /* Um clique so: mudo -> VERONICA -> CIPHER -> mudo. Menu suspenso para duas
     opcoes seria mais peca de interface do que escolha. */
  alternar() {
    if (!this.suportada()) {
      showToast("Este navegador não tem síntese de voz.", "error");
      return;
    }
    const i = CICLO_VOZ.indexOf(this.persona);
    this.persona = CICLO_VOZ[(i + 1) % CICLO_VOZ.length];

    localStorage.setItem(VOZ_CHAVE, this.persona || "");
    this.parar();
    this.selecionarVoz();
    this.refletirBotao();

    if (!this.persona) { showToast("Voz desligada.", "success"); return; }
    const nome = this.escolhida?.name?.replace(/\s*\(.*\)$/, "") || "voz do sistema";
    showToast(`Voz ${PERSONAS[this.persona].rotulo} (${nome}).`, "success");
  },

  refletirBotao() {
    const btn = DOM.btnVoz();
    if (!btn) return;
    btn.classList.toggle("ativo", this.ligada);
    btn.dataset.persona = this.persona || "";
    btn.title = this.ligada
      ? `Voz ${PERSONAS[this.persona].rotulo}: clique para trocar ou silenciar`
      : "Ler as respostas em voz alta";
    btn.querySelector(".voz-on")?.toggleAttribute("hidden", !this.ligada);
    btn.querySelector(".voz-off")?.toggleAttribute("hidden", this.ligada);
  },

  /* Markdown falado em voz alta vira ruido: "asterisco asterisco titulo". Tira a
     marcacao e o bloco de codigo, que ninguem quer ouvir caractere a caractere. */
  limpar(texto) {
    return texto
      .replace(/```[\s\S]*?```/g, " (bloco de código) ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " link ")
      .replace(/\s+/g, " ")
      .trim();
  },

  dizer(frase) {
    const texto = this.limpar(frase);
    if (!texto) return;

    const cfg = PERSONAS[this.persona] || PERSONAS.veronica;
    const fala = new SpeechSynthesisUtterance(texto);
    if (this.escolhida) fala.voice = this.escolhida;
    fala.lang  = this.escolhida?.lang || "pt-BR";
    fala.pitch = cfg.pitch;
    fala.rate  = cfg.rate;

    // A Web Speech API nao da acesso ao audio, entao nao ha amplitude real para
    // ler. O `onboundary` dispara a cada palavra: serve de batida para a esfera
    // pulsar no ritmo de quem fala, que e o efeito que interessa.
    fala.onstart    = () => { this.falando = true; };
    fala.onboundary = () => { this.pulso = 1; };
    fala.onend      = () => { this.falando = window.speechSynthesis.pending || window.speechSynthesis.speaking; };
    fala.onerror    = () => { this.falando = false; };

    window.speechSynthesis.speak(fala);
  },

  /* Decaimento do pulso, chamado pelo laco de animacao da esfera. Fica aqui e
     nao la para o ritmo nao depender da taxa de quadros de um canvas so. */
  consumirPulso(dt) {
    this.pulso = Math.max(0, this.pulso - dt * 3.2);
    return this.pulso;
  },

  /* Recebe os deltas do streaming e solta cada frase fechada. O resto fica no
     buffer ate a proxima pontuacao. */
  alimentar(delta) {
    if (!this.ligada || !this.suportada()) return;
    this.buffer += delta;
    const partes = this.buffer.split(/(?<=[.!?:\n])\s+/);
    this.buffer = partes.pop() || "";
    for (const frase of partes) this.dizer(frase);
  },

  finalizar() {
    if (!this.ligada || !this.suportada()) return;
    if (this.buffer.trim()) this.dizer(this.buffer);
    this.buffer = "";
  },

  parar() {
    if (!this.suportada()) return;
    this.buffer = "";
    this.falando = false;
    this.pulso = 0;
    window.speechSynthesis.cancel();
  },
};

/* ═══════════════════════════════════════════════
   ESCUTA — falar com o Cipher
   ═══════════════════════════════════════════════
   ⚠️ LEIA ANTES DE MEXER: ao contrario do resto do Cipher, isto NAO e offline.
   O SpeechRecognition do Chrome manda o audio do microfone para servidores do
   Google; o Safari usa o servico da Apple. Nao existe reconhecimento local nesta
   API. Isso contraria a decisao de privacidade de 2026-08-18 do projeto, e por
   isso o recurso:
     - nasce DESLIGADO;
     - exige um "sim" explicito, uma vez, com o aviso na tela;
     - grava a escolha em cipher_escuta_v1 e nunca liga sozinho.
   Nao remover a confirmacao "para facilitar": ela e o recurso, nao um enfeite. */
const ESCUTA_CHAVE = "cipher_escuta_v1";

const AVISO_ESCUTA =
  "Atenção: o reconhecimento de fala do navegador NÃO é offline.\n\n" +
  "Ao contrário do chat (que roda 100% na sua máquina), o áudio do seu microfone " +
  "é enviado para servidores do Google para ser transcrito.\n\n" +
  "Deseja habilitar mesmo assim?";

const escuta = {
  rec: null,
  ativa: false,
  autorizada: false,

  suportada() {
    return typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
  },

  iniciar() {
    this.autorizada = localStorage.getItem(ESCUTA_CHAVE) === "1";
    this.refletirBotao();
  },

  alternar() {
    if (!this.suportada()) {
      showToast("Este navegador não reconhece fala. Use o Chrome ou o Safari.", "error");
      return;
    }
    if (this.ativa) { this.parar(); return; }

    if (!this.autorizada) {
      if (!window.confirm(AVISO_ESCUTA)) {
        showToast("Escuta continua desligada.", "success");
        return;
      }
      this.autorizada = true;
      localStorage.setItem(ESCUTA_CHAVE, "1");
    }
    this.comecar();
  },

  comecar() {
    // Enquanto o Cipher fala, o microfone ouviria a propria resposta e o ciclo
    // se realimentaria. Cala a voz antes de abrir o microfone.
    voz.parar();

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = "pt-BR";
    rec.interimResults = true;
    // Uma fala por clique. Modo continuo deixaria o microfone aberto indefinidamente,
    // o que e demais para um recurso que manda audio para fora.
    rec.continuous = false;

    const input = DOM.messageInput();

    rec.onresult = (e) => {
      let texto = "";
      for (let i = e.resultIndex; i < e.results.length; i++) texto += e.results[i][0].transcript;
      if (!input) return;
      input.value = texto;
      input.dispatchEvent(new Event("input"));

      // Resultado final: envia sozinho, senao o ganho de falar se perde no clique.
      if (e.results[e.results.length - 1].isFinal && texto.trim()) {
        this.parar();
        sendMessage();
      }
    };

    rec.onerror = (e) => {
      const msg = e.error === "not-allowed"
        ? "Permissão de microfone negada pelo navegador."
        : e.error === "no-speech" ? "Não ouvi nada."
        : `Falha ao ouvir: ${e.error}`;
      showToast(msg, "error");
    };

    rec.onend = () => { this.ativa = false; this.rec = null; this.refletirBotao(); };

    this.rec = rec;
    this.ativa = true;
    this.refletirBotao();
    try { rec.start(); }
    catch (_) { this.ativa = false; this.refletirBotao(); }
  },

  parar() {
    if (this.rec) { try { this.rec.stop(); } catch (_) {} }
    this.ativa = false;
    this.refletirBotao();
  },

  refletirBotao() {
    const btn = DOM.btnMic();
    if (!btn) return;
    btn.classList.toggle("ouvindo", this.ativa);
    btn.title = this.ativa
      ? "Ouvindo... clique para parar"
      : this.autorizada ? "Falar com o Cipher" : "Falar com o Cipher (precisa ser habilitado)";
  },
};

/* ═══════════════════════════════════════════════
   MINI GLOBO DO INDICADOR "PROCESSANDO"
   ═══════════════════════════════════════════════
   Versao reduzida da esfera: contorno, paralelos, meridianos girando e as mesmas
   ondulacoes neon. Existe porque a tela inicial (onde mora o globo grande) fica
   escondida durante a conversa, entao o efeito de "gerando resposta" nao teria
   onde aparecer. Anima so enquanto o indicador esta visivel: parado, nao consome
   um frame sequer. */
let miniGlobo = null;

function criarMiniGlobo() {
  const canvas = document.getElementById("typing-globe");
  if (!canvas) return null;

  const ctx = canvas.getContext("2d");
  // Mesmo truque da esfera grande: coordenadas logicas fixas, escala no transform.
  const SIZE = 100;
  const CX = SIZE / 2, CY = SIZE / 2, R = SIZE * 0.26;

  let rafId = null, T0 = 0, proxima = 0;
  const ondas = [];

  /* ⚠️ Esta declaracao faltou e derrubou o chat inteiro em 2026-10-31.
     A correcao do canvas foi aplicada com um replace que casou nas DUAS funcoes
     de escala (esta e a do nucleo), mas a variavel so foi declarada na outra.
     Resultado: `ReferenceError: pxAtual is not defined` dentro de
     `mostrarDigitando()`, que roda em `setLoading()`, que roda ao ENVIAR. A
     excecao subia antes do fetch, entao a pergunta aparecia na tela, a conversa
     era criada e a resposta nunca vinha. O sintoma ("mandei ola e nao
     respondeu") parecia lentidao do modelo, e o modelo estava respondendo em
     0,8 s o tempo todo.
     Licao: alteracao em canvas tem de ser verificada NO NAVEGADOR, e nao so com
     `node --check` -- ReferenceError e erro de execucao, nao de sintaxe. */
  let pxAtual = 0;

  function escala() {
    const css = canvas.offsetWidth || 36;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px  = Math.round(css * dpr);
    // Compara com variavel e nao com `canvas.width`: um canvas sem width
    // atribuido nasce 300x150, e quando a conta da exatamente 300 a comparacao
    // com canvas.width dava igual na primeira chamada, a funcao retornava antes
    // do setTransform e o buffer ficava com height 150.
    if (pxAtual === px) return;
    pxAtual = px;
    canvas.width = canvas.height = px;
    ctx.setTransform(px / SIZE, 0, 0, px / SIZE, 0, 0);
  }

  function frame(now) {
    const t = (now - T0) * 0.001;
    ctx.clearRect(0, 0, SIZE, SIZE);

    if (t >= proxima) {
      ondas.push({ born: t, lobos: 5 + Math.floor(Math.random() * 3), fase: Math.random() * Math.PI * 2 });
      proxima = t + 0.5;
    }

    ctx.save();
    ctx.shadowColor = "rgba(255,170,70,0.7)";
    ctx.shadowBlur = 6;
    ctx.lineWidth = 1;
    for (let i = ondas.length - 1; i >= 0; i--) {
      const o = ondas[i];
      const p = (t - o.born) / 1.3;
      if (p >= 1) { ondas.splice(i, 1); continue; }

      // Alcance ate R*1.62: passar disso encostaria na borda dos 36px do canvas.
      const rr = R * (1 + p * 0.62);
      ctx.strokeStyle = `rgba(255,180,90,${(1 - p) * (1 - p) * 0.85})`;
      ctx.beginPath();
      for (let s = 0; s <= 48; s++) {
        const a = (s / 48) * Math.PI * 2;
        const mod = 1 + 0.06 * Math.sin(o.lobos * a + o.fase + t * 1.6);
        const x = CX + Math.cos(a) * rr * mod;
        const y = CY + Math.sin(a) * rr * mod;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();

    const rotY = t * 0.9;
    ctx.strokeStyle = "rgba(255,138,31,0.85)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(CX, CY, R, 0, Math.PI * 2); ctx.stroke();

    ctx.strokeStyle = "rgba(255,138,31,0.38)";
    ctx.lineWidth = 0.7;
    for (let l = 1; l <= 2; l++) {
      const pl = (l / 3) * Math.PI;
      ctx.beginPath();
      ctx.ellipse(CX, CY - R * Math.cos(pl), R * Math.sin(pl), R * Math.sin(pl) * 0.3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Meridiano visto de lado vira uma elipse que estreita e alarga: e o que da
    // a sensacao de rotacao sem projetar ponto a ponto.
    for (let m = 0; m < 3; m++) {
      ctx.beginPath();
      ctx.ellipse(CX, CY, R * Math.abs(Math.cos(rotY + m * Math.PI / 3)), R, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(255,225,170,0.9)";
    ctx.beginPath(); ctx.arc(CX, CY, 1.6 + Math.sin(t * 4) * 0.5, 0, Math.PI * 2); ctx.fill();

    rafId = requestAnimationFrame(frame);
  }

  return {
    iniciar() {
      if (rafId !== null) return;      // ja rodando: nao empilhar um segundo rAF
      escala();
      T0 = performance.now();
      proxima = 0;
      ondas.length = 0;
      rafId = requestAnimationFrame(frame);
    },
    parar() {
      if (rafId === null) return;
      cancelAnimationFrame(rafId);
      rafId = null;
    },
  };
}

/* ═══════════════════════════════════════════════════════════
   CAMPO ESTELAR — fundo que continua a cena do nucleo
   ═══════════════════════════════════════════════════════════
   Substituiu as 65 bolinhas laranja com rebote nas bordas (2026-10-31). O
   rebote era o problema: ponto que bate na borda e volta DENUNCIA onde o canvas
   acaba, e o canvas e um retangulo em cima do fundo preto. Aqui nada bate em
   nada — o campo e polar, centrado na tela, e some por alfa antes de chegar na
   borda.

   Tres coisas desenhadas por quadro, nesta ordem:

     1. nebulosa (cache offscreen, um blit) — poeira em brasa, deriva lenta
     2. estrelas em 3 camadas de paralaxe   — espiral para dentro + cintilacao
     3. mascara de alfa em `destination-out` — dissolve no preto

   O passo 3 e o que casa com o resto da tela. A `.bg-radial` do CSS ja escurece
   as beiradas, mas ela fica ATRAS deste canvas (ordem do index.html), entao sem
   a mascara as estrelas apareceriam por cima do vinhetado e o retangulo ficaria
   visivel. A mascara apaga pelas bordas E pelo centro: o centro e onde mora o
   nucleo, e estrela passando por tras do buraco negro competiria com ele.

   Coerencia com o `initNucleoOrbital`: tudo deriva para DENTRO, em espiral, como
   se a tela inteira estivesse caindo no mesmo poco gravitacional. A camada
   distante anda mais devagar e mais apagada; a proxima, mais rapida e mais
   brilhante. E paralaxe de verdade, nao ruido aleatorio.

   Para ajustar a olho, mexa so no CAMPO_ESTELAR logo abaixo: sao os cinco
   numeros que mudam a intensidade e o ritmo sem mexer na mecanica. */
const CAMPO_ESTELAR = {
  /* Alfa maximo de uma estrela no pico da cintilacao. Teto deliberadamente
     baixo: isto passa por tras do texto do chat. */
  estrelas: 0.46,
  /* Multiplicador global da nebulosa. Acima de ~1.4 ela deixa de ler como
     poeira e vira mancha de gradiente. */
  nebulosa: 0.9,
  /* px² de TELA por estrela. MAIOR = MENOS estrelas. A conta e sobre a area do
     DISCO (meia diagonal), nao do retangulo, porque o campo e polar: boa parte
     das estrelas esta fora da tela a qualquer momento. */
  densidade: 14000,
  /* Multiplica toda a velocidade: deriva, rotacao, cintilacao e respiro da
     nebulosa. 1 e o calibrado; 0.5 deixa quase parado. */
  velocidade: 1,
  /* Quadros por segundo do fundo. Nada aqui se move mais de ~3 px/s, entao 30
     fps e indistinguivel de 60 e corta metade do trabalho — este app abre num
     Celeron de 2 nucleos e em celular. */
  fps: 30,
};

function initCampoEstelar() {
  const canvas = document.getElementById("bg-particles");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const I = CAMPO_ESTELAR;

  /* ⚠️ Canvas em resolucao REDUZIDA, e sem devicePixelRatio.
     O `inset: 0` do CSS estica o canvas para a viewport inteira qualquer que
     seja o tamanho do buffer, entao desenhar em 75% e deixar o navegador ampliar
     custa 56% dos pixels. Isso importa porque cada quadro faz tres operacoes de
     tela cheia (clear, blit da nebulosa, blit da mascara): em 1920x1080 nativo
     seriam ~24 MB de pixel por quadro, que o Celeron N2807 nao entrega sem
     engasgar quando o canvas cai em rasterizacao por software.

     Da para fazer isso aqui porque o conteudo e borrao suave mais ponto de 1 px:
     a ampliacao do navegador so deixa a estrela mais macia, o que ate ajuda. O
     nucleo usa dpr cheio pelo motivo oposto (la existe geometria com borda).

     Consequencia para quem for mexer: TODA coordenada daqui para baixo esta em
     pixel de BUFFER, nao de tela. `vr` das camadas e `densidade` sao as duas
     excecoes, declaradas em pixel de tela e convertidas no uso, para que mudar
     ESCALA nao mude a velocidade nem a densidade percebidas. */
  const ESCALA = 0.75;
  let vpW = 0, vpH = 0;             // viewport, so para decidir o que refazer
  let W = 0, H = 0, cx = 0, cy = 0;
  let rMin = 0, rMax = 0;          // limites radiais do campo, em px
  let nebulosa = null, mascara = null;
  let estrelas = [];

  /* ─── Camadas de paralaxe ───
     `vr` em px de TELA por segundo para dentro, `giro` em rad/s. Os numeros sao
     pequenos de proposito: a camada proxima leva ~4 min para atravessar uma tela
     de notebook e a distante mais de 15. O movimento e percebido quando o olho
     para numa estrela, nunca quando o olho esta lendo o chat. */
  const CAMADAS = [
    { peso: 0.56, vr: 0.80, giro: 0.0040, brilho: 0.42, tam: 1 },  // longe
    { peso: 0.30, vr: 1.75, giro: 0.0075, brilho: 0.74, tam: 1 },  // meio
    { peso: 0.14, vr: 3.10, giro: 0.0125, brilho: 1.00, tam: 2 },  // perto
  ];

  /* Tons de estrela, do branco quente ao tijolo. Nada de azul: a paleta do app
     e brasa, e uma unica estrela azulada rouba a atencao da tela toda. */
  const TONS = [
    [255, 238, 212],
    [255, 206, 152],
    [255, 158,  78],
    [206, 112,  52],
  ];

  /* Paleta pre-calculada: TONS × NIVEIS strings de rgba() prontas.
     Montar `rgba(...)` por estrela por quadro criaria ~7 mil strings por segundo
     só para o coletor de lixo recolher. Com a paleta, desenhar e indexar array. */
  const NIVEIS = 10;
  const PALETA = TONS.map(([r, g, b]) =>
    Array.from({ length: NIVEIS }, (_, i) =>
      `rgba(${r},${g},${b},${(((i + 1) / NIVEIS) * I.estrelas).toFixed(3)})`));

  /* Achatamento vertical do campo. Levemente elipsoide para insinuar o mesmo
     plano inclinado do disco de acrecao do nucleo. Exagerar aqui faz o campo
     parecer esticado numa tela larga. */
  const ACHATAMENTO = 0.94;

  /* ─── Mascara de dissolucao ───
     Duas coisas somadas, e a separacao em DOIS perfis e o ponto:

     ⚠️ Um unico gradiente radial normalizado pela meia diagonal NAO serve, e
     isso foi medido na conta antes de virar codigo. Em 390x844 (celular) a
     beirada lateral fica a 0.42 da meia diagonal, ou seja, dentro da faixa
     visivel: as estrelas chegariam coladas na borda esquerda e direita e o
     retangulo do canvas apareceria. A dissolucao precisa ser medida em fracao
     de CADA eixo, nao de um raio unico.

     `PERFIL_BORDA` roda nos quatro lados (0 = beirada da tela, 1 = fim da faixa
     de dissolucao). As faixas se sobrepoem nos cantos e o `source-over` soma os
     alfas (a = a1 + a2(1-a1)), entao canto apaga mais que lado reto, que e
     exatamente o que se quer.

     `PERFIL_CENTRO` abre um buraco onde mora a sombra do buraco negro: ali
     estrela nao existiria mesmo, estaria lenteada para fora. Fica de proposito
     MENOR que o nucleo inteiro — o resto do disco deixa estrela aparecer no
     meio das lacunas de poeira, e e isso que da continuidade entre as duas
     cenas. */
  const PERFIL_BORDA  = [[0.00, 1.00], [0.34, 0.52], [0.68, 0.14], [1.00, 0.00]];
  const PERFIL_CENTRO = [[0.00, 1.00], [0.45, 0.72], [0.78, 0.22], [1.00, 0.00]];
  const FADE_BORDA  = 0.24;   // fracao de W (lados) e de H (topo/base)
  const RAIO_CENTRO = 0.20;   // fracao do lado MENOR da tela

  /* ─── Manchas da nebulosa ───
     Posicao em fracao do canvas a partir do centro; `r` em fracao do lado menor.
     Poucas, grandes e com alfa baixissimo: nebulosa real nao tem contorno. A
     rotacao negativa alinha as tres maiores num eixo quase horizontal, que e
     como o disco do nucleo se apresenta. */
  const MANCHAS = [
    { x: -0.24, y: -0.04, r: 0.58, achat: 0.42, rot: -0.22, cor: [194,  65,  12], a: 0.085 },
    { x:  0.27, y:  0.07, r: 0.50, achat: 0.46, rot: -0.14, cor: [255,  90,  10], a: 0.060 },
    { x:  0.02, y: -0.26, r: 0.44, achat: 0.60, rot:  0.30, cor: [160,  58,  20], a: 0.055 },
    { x: -0.12, y:  0.29, r: 0.40, achat: 0.52, rot: -0.38, cor: [120,  48,  18], a: 0.050 },
    { x:  0.33, y: -0.22, r: 0.30, achat: 0.70, rot:  0.18, cor: [255, 138,  31], a: 0.030 },
  ];

  /* Folga do cache da nebulosa para cada lado. Precisa ser maior que AMP_NEB,
     senao a deriva revela a borda da imagem cacheada, que e exatamente o
     retangulo visivel que este fundo inteiro existe para evitar. */
  const MARGEM_NEB = 96;
  const AMP_NEB = 34;

  // Periodos longos e primos entre si (127 s, 173 s, 89 s). Periodo parecido bate
  // em fase e o olho passa a ver pulsacao, que e o que cansa.
  const W_NEB_X = (Math.PI * 2) / 127;
  const W_NEB_Y = (Math.PI * 2) / 173;
  const W_NEB_A = (Math.PI * 2) / 89;

  function gerarNebulosa() {
    const c = document.createElement("canvas");
    c.width = W + MARGEM_NEB * 2;
    c.height = H + MARGEM_NEB * 2;
    const g = c.getContext("2d");
    const ox = c.width / 2, oy = c.height / 2;
    const base = Math.min(c.width, c.height);

    // `arc` e caro em volume, mas aqui sao 5 chamadas UMA vez por resize.
    for (const m of MANCHAS) {
      const r = base * m.r;
      const [cr, cg, cb] = m.cor;
      const pico = m.a * I.nebulosa;
      g.save();
      g.translate(ox + c.width * m.x, oy + c.height * m.y);
      g.rotate(m.rot);
      g.scale(1, m.achat);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
      grad.addColorStop(0.00, `rgba(${cr},${cg},${cb},${pico})`);
      grad.addColorStop(0.40, `rgba(${cr},${cg},${cb},${pico * 0.52})`);
      grad.addColorStop(0.75, `rgba(${cr},${cg},${cb},${pico * 0.14})`);
      grad.addColorStop(1.00, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    return c;
  }

  function gerarMascara() {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d");

    // Buraco central.
    const rc = Math.min(W, H) * RAIO_CENTRO;
    const gc = g.createRadialGradient(cx, cy, 0, cx, cy, rc);
    for (const [p, a] of PERFIL_CENTRO) gc.addColorStop(p, `rgba(0,0,0,${a})`);
    g.fillStyle = gc;
    g.beginPath();
    g.arc(cx, cy, rc, 0, Math.PI * 2);
    g.fill();

    // Quatro bordas: [x, y, larg, alt, pontoNaBeirada, pontoInterno].
    const fw = W * FADE_BORDA, fh = H * FADE_BORDA;
    const faixas = [
      [0,      0,      fw, H,  0,     0,  fw,     0     ],
      [W - fw, 0,      fw, H,  W,     0,  W - fw, 0     ],
      [0,      0,      W,  fh, 0,     0,  0,      fh    ],
      [0,      H - fh, W,  fh, 0,     H,  0,      H - fh],
    ];
    for (const [x, y, w, h, x0, y0, x1, y1] of faixas) {
      const grad = g.createLinearGradient(x0, y0, x1, y1);
      for (const [p, a] of PERFIL_BORDA) grad.addColorStop(p, `rgba(0,0,0,${a})`);
      g.fillStyle = grad;
      g.fillRect(x, y, w, h);
    }
    return c;
  }

  /* Reposiciona uma estrela. `inicial` espalha por area (sqrt do sorteio, senao
     a densidade explode no centro); fora disso ela reentra por fora da tela, e
     a entrada e invisivel porque a faixa de dissolucao apaga a beirada inteira.
     O desaparecimento no centro tambem nao se ve: `rMin` fica onde a mascara ja
     apaga ~86%. */
  function recolocar(e, inicial) {
    e.ang = Math.random() * Math.PI * 2;
    e.r = inicial
      ? Math.sqrt(rMin * rMin + Math.random() * (rMax * rMax - rMin * rMin))
      : rMax * (1 + Math.random() * 0.14);
  }

  function gerarEstrelas() {
    /* Area do disco de raio meia-diagonal, nao do retangulo: o campo e polar e
       boa parte dele cai fora da tela a qualquer momento. Convertida para px de
       TELA porque e nessa unidade que `densidade` esta escrita.
       O teto de 240 e o que segura o custo no celular e no Celeron; o piso de 50
       evita ceu vazio numa janela pequena. */
    const areaDisco = (Math.PI * (W * W + H * H)) / 4 / (ESCALA * ESCALA);
    const qtd = Math.max(50, Math.min(240, Math.round(areaDisco / I.densidade)));

    estrelas = [];
    let faiscas = 0;
    for (let i = 0; i < qtd; i++) {
      // Sorteia a camada pelo peso acumulado. O default na ultima camada cobre o
      // caso de os pesos nao somarem exatamente 1.
      const u = Math.random();
      let idxCam = CAMADAS.length - 1, acc = 0;
      for (let k = 0; k < CAMADAS.length; k++) {
        acc += CAMADAS[k].peso;
        if (u <= acc) { idxCam = k; break; }
      }
      const cam = CAMADAS[idxCam];
      const e = {
        cam: idxCam,
        tom: Math.random() < 0.55 ? (Math.random() < 0.5 ? 0 : 1) : (Math.random() < 0.6 ? 2 : 3),
        // Brilho individual dentro da camada: campo com todas as estrelas no
        // mesmo brilho le como textura, nao como ceu.
        base: cam.brilho * (0.45 + Math.random() * 0.55),
        fase: Math.random() * Math.PI * 2,
        // Cintilacao entre 11 s e 26 s por ciclo. Mais rapido que isso vira
        // pisca-pisca e chama atencao.
        wCint: (Math.PI * 2) / (11 + Math.random() * 15),
        // Poucas faiscas, e so na camada da frente: sao 3 fillRect extras cada,
        // e em volume isso deixa de ser barato.
        faisca: idxCam === 2 && faiscas < 6 && Math.random() < 0.22,
        r: 0, ang: 0,
      };
      if (e.faisca) faiscas++;
      recolocar(e, true);
      estrelas.push(e);
    }
  }

  function avancar(dt) {
    for (const e of estrelas) {
      const cam = CAMADAS[e.cam];
      e.ang += cam.giro * dt;
      e.r -= cam.vr * ESCALA * dt;   // vr e em px de tela; `r` vive em px de buffer
      if (e.r < rMin) recolocar(e, false);
    }
  }

  function pintar(t) {
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);

    // Nebulosa: um blit com translacao. Sem escala, de proposito — drawImage com
    // escala reamostra a imagem inteira a cada quadro, e o respiro sai de graca
    // no globalAlpha.
    if (nebulosa) {
      ctx.globalAlpha = 0.84 + 0.16 * Math.sin(t * W_NEB_A);
      ctx.drawImage(
        nebulosa,
        -MARGEM_NEB + Math.sin(t * W_NEB_X) * AMP_NEB,
        -MARGEM_NEB + Math.cos(t * W_NEB_Y) * AMP_NEB * 0.6);
      ctx.globalAlpha = 1;
    }

    for (const e of estrelas) {
      const x = cx + e.r * Math.cos(e.ang);
      const y = cy + e.r * Math.sin(e.ang) * ACHATAMENTO;
      // Metade do campo esta fora da tela a qualquer momento: descartar antes do
      // fillRect vale mais que qualquer micro-otimizacao de desenho.
      if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;

      const cint = 0.70 + 0.30 * Math.sin(t * e.wCint + e.fase);
      let nivel = (e.base * cint * NIVEIS) | 0;
      if (nivel < 0) nivel = 0; else if (nivel >= NIVEIS) nivel = NIVEIS - 1;

      const tons = PALETA[e.tom];
      const tam = CAMADAS[e.cam].tam;

      if (e.faisca && nivel > 5) {
        // Braços de 1 px num nivel mais fraco dao a leitura de estrela brilhante.
        // ⚠️ Nada de shadowBlur: uma sombra por particula derruba o quadro no
        // Celeron, e e por isso que a faisca e desenhada e nao iluminada.
        ctx.fillStyle = tons[nivel - 4];
        ctx.fillRect(x - 2.5, y + 0.5, 6, 1);
        ctx.fillRect(x + 0.5, y - 2.5, 1, 6);
      }

      ctx.fillStyle = tons[nivel];
      ctx.fillRect(x, y, tam, tam);
    }

    // Dissolucao: apaga o que foi pintado seguindo o gradiente de alfa. Tem de
    // ser o ultimo passo, e o composite volta para source-over no inicio do
    // quadro seguinte (clearRect com destination-out nao limpa nada).
    if (mascara) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(mascara, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    }
  }

  function medir() {
    const nW = window.innerWidth, nH = window.innerHeight;
    /* ⚠️ No celular a barra de endereco entra e sai e muda a altura em ~60 px a
       cada rolagem. Regenerar o campo nesses eventos reembaralharia as estrelas
       na cara do usuario, entao mudanca pequena de altura so reestica o canvas e
       mantem as estrelas onde estao (as coordenadas sao polares a partir do
       centro, logo a deformacao e imperceptivel). */
    const refazerCampo = !estrelas.length || Math.abs(nW - vpW) > 1 || Math.abs(nH - vpH) > 140;
    vpW = nW; vpH = nH;

    // Atribuir width ja limpa o canvas, entao quem chama precisa repintar.
    W = canvas.width  = Math.max(1, Math.round(nW * ESCALA));
    H = canvas.height = Math.max(1, Math.round(nH * ESCALA));
    cx = W / 2; cy = H / 2;
    rMax = (Math.hypot(W, H) / 2) * 1.06;             // alem do canto
    rMin = Math.min(W, H) * RAIO_CENTRO * 0.35;       // dentro do buraco da mascara

    nebulosa = gerarNebulosa();
    mascara = gerarMascara();
    if (refazerCampo) gerarEstrelas();
  }

  medir();

  /* Acessibilidade: canvas nao obedece `prefers-reduced-motion` pelo CSS, so a
     guarda do fim do style.css nao cobre nada daqui. Com a preferencia ligada,
     um quadro estatico — o campo continua existindo como cenario, apenas nao se
     move. `t` fixo em 7 s para a cintilacao nao congelar todo mundo em fase. */
  const semMovimento = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  let rafId = null, ultimo = 0, acumulado = 0, t = 0;
  const INTERVALO = 1000 / I.fps;

  function quadro(agora) {
    rafId = requestAnimationFrame(quadro);
    // ⚠️ Teto no dt: aba oculta congela o rAF, e sem o teto o primeiro quadro na
    // volta teria minutos de dt e teleportaria o campo inteiro.
    const dt = Math.min((agora - ultimo) / 1000, 0.25);
    ultimo = agora;

    acumulado += dt * 1000;
    if (acumulado < INTERVALO) return;    // trava em I.fps
    const passo = (acumulado / 1000) * I.velocidade;
    acumulado = 0;

    t += passo;
    avancar(passo);
    pintar(t);
  }

  function ligar() {
    if (semMovimento?.matches) {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      pintar(7);
      return;
    }
    if (rafId !== null) return;
    ultimo = performance.now();
    acumulado = INTERVALO;      // pinta no primeiro quadro, sem tela vazia
    rafId = requestAnimationFrame(quadro);
  }

  let timerResize = null;
  window.addEventListener("resize", () => {
    // Debounce: resize dispara em rajada (arrastar janela, girar o celular) e
    // cada evento custa dois canvas offscreen novos.
    clearTimeout(timerResize);
    timerResize = setTimeout(() => { medir(); ligar(); }, 220);
  });

  // Trocar a preferencia do sistema nao recarrega a pagina.
  semMovimento?.addEventListener?.("change", ligar);

  ligar();
}

/* ═══════════════════════════════════════════════
   ADVANCED 3D HOLOGRAPHIC SPHERE
   ═══════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════
   NUCLEO ORBITAL — planeta/buraco negro com aneis de poeira
   ═══════════════════════════════════════════════════════════
   Substituiu a `initAdvancedSphere` (malha neural ciano) em 2026-10-31.

   O que desenha, de tras para frente — e a ORDEM e o que cria a profundidade,
   nao e estetica:

     1. halo externo (luz espalhada)
     2. metade de TRAS dos aneis            (z < 0)
     3. corpo central + anel de foton
     4. metade da FRENTE dos aneis          (z >= 0)
     5. sombra do corpo projetada no anel
     6. jatos polares e pulsos de voz

   ⚠️ Desenhar o anel inteiro de uma vez e depois o corpo em cima faz o anel
   parecer um adesivo colado atras do planeta: a parte que deveria passar NA
   FRENTE desaparece. A divisao em dois passes pelo sinal de z e o unico motivo
   de a cena ler como 3D num canvas 2D.

   Reatividade (mesmo contrato da esfera antiga, para o resto do app nao mudar):
     state.isLoading  → o disco acelera e esquenta
     voz.falando      → pulsos radiais saem do corpo no ritmo da fala
     voz.consumirPulso(dt) → intensidade instantanea de cada palavra dita

   Movimento continuo, sem estado que acumule: tudo e funcao de `t`, entao a
   animacao nunca "deriva" e pausar a aba nao desincroniza nada. */
function initNucleoOrbital() {
  const canvas = document.getElementById("neural-sphere");
  if (!canvas) return;

  // Ainda sem layout: o offsetWidth e 0 e toda a matematica de escala sairia
  // zerada. Tenta no quadro seguinte.
  if (!canvas.offsetWidth) { requestAnimationFrame(initNucleoOrbital); return; }

  const ctx = canvas.getContext("2d");

  // Sistema de coordenadas LOGICO e fixo: tudo desenha num quadrado SIZE x SIZE
  // e a escala real mora so no setTransform de ajustarEscala(). Herdado da
  // esfera antiga e mantido pelo mesmo motivo: recalcular raios e orbitas a cada
  // resize exigiria reinicializar, o que empilharia timers e rAF.
  const SIZE = 600;
  const CX = SIZE / 2, CY = SIZE / 2;
  const R  = SIZE * 0.365;          // raio de referencia da cena
  const RC = R * 0.46;              // sombra do buraco negro (o "centro")

  /* Raio de influencia da lente gravitacional, em px.
     Tudo que cairia DENTRO deste circulo e empurrado para fora da sombra em vez
     de sumir atras dela — ver defletir(). E o que produz o arco por cima e por
     baixo do buraco, que e a assinatura visual do Gargantua. */
  const R_LENTE = RC * 1.95;

  /* ⚠️ Limite HORIZONTAL do disco, em multiplos de R.
     Do centro ate a borda do canvas ha SIZE/2 = 300px, e R vale 219px, entao
     sobra 1.37R. A faixa externa precisa parar ANTES disso: na primeira versao
     ela ia a 1.74R e as duas bandas de fora eram cortadas pela borda, o que
     fazia o disco inteiro ler como um anel unico em vez de bandas separadas.
     Verticalmente nao ha aperto: o disco e achatado por cos(TILT). */
  const R_MAX = 1.28;

  /* Velocidade angular de referencia do disco.
     ⚠️ Baixa de proposito (era 0.62, ~4x mais rapida). Disco rapido le como
     "carregando", nao como corpo celeste: massa de buraco negro supermassivo
     gira devagar do ponto de vista de quem olha de longe. Com 0.16 a faixa
     interna leva ~35 s por volta e a externa mais de 2 min, entao o movimento
     e percebido sem nunca chamar atencao para si. */
  const VEL_BASE = 0.16;

  // Inclinacao do plano dos aneis. 0 = visto de cima (circulo), PI/2 = de lado
  // (linha). 1.12 rad da a elipse achatada que parece Saturno de viés.
  const TILT = 1.12;
  const COS_T = Math.cos(TILT), SIN_T = Math.sin(TILT);

  let pxAtual = 0;
  function ajustarEscala() {
    const css = canvas.offsetWidth;
    if (!css) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px  = Math.round(css * dpr);
    /* ⚠️ Compara com uma variavel, NAO com `canvas.width`: um canvas sem width
       atribuido nasce 300x150. Quando a conta da exatamente 300 (acontece com
       `--esfera` batendo 300px em viewport baixo, com dpr 1), a comparacao com
       canvas.width dava igual na PRIMEIRA chamada, a funcao retornava antes do
       setTransform e o canvas ficava com height 150: a cena de 600x600 era
       renderizada 1:1 num buffer 300x150 esticado, mostrando so o quadrante
       superior esquerdo, achatado. */
    if (pxAtual === px) return;
    pxAtual = px;
    // Atribuir width reseta o contexto inteiro, por isso o setTransform vem
    // logo depois.
    canvas.width = canvas.height = px;
    const k = px / SIZE;
    ctx.setTransform(k, 0, 0, k, 0, 0);
  }
  ajustarEscala();

  const obs = new ResizeObserver(ajustarEscala);
  obs.observe(canvas);
  // Trocar de monitor muda o devicePixelRatio sem mudar o tamanho em CSS.
  window.addEventListener("resize", ajustarEscala);

  /* ─── Faixas do disco ───
     Cada faixa e uma banda de poeira com densidade e cor propria. As lacunas
     entre elas (o salto de `de` para o `a` da seguinte) sao as divisoes tipo
     Cassini: sem elas o disco fica um borrao uniforme e perde a leitura de
     "poeira", que e justamente o que se quer.

     `cor` vai de quase branco (quente, perto do corpo) a laranja profundo
     (frio, longe): e o gradiente de temperatura de um disco de acrecao. */
  const FAIXAS = [
    { de: 0.60, a: 0.72, dens: 230, cor: [255, 236, 200], brilho: 1.00 },
    { de: 0.76, a: 0.88, dens: 280, cor: [255, 186,  96], brilho: 0.88 },
    { de: 0.92, a: 1.02, dens: 210, cor: [255, 140,  40], brilho: 0.74 },
    { de: 1.06, a: 1.16, dens: 240, cor: [226, 100,  20], brilho: 0.58 },
    { de: 1.20, a: 1.28, dens: 150, cor: [176,  72,  16], brilho: 0.42 },
  ];

  /* Poeira. Cada grao guarda o raio e o angulo INICIAL; a posicao sai de `t`.

     ⚠️ A velocidade cai com o raio (`r^-1.5`, kepleriano). Nao e preciosismo:
     com todos os graos na mesma velocidade angular o disco gira como um disco
     rigido, que e exatamente a aparencia de adesivo girando que se quer evitar.
     Com a lei de Kepler as faixas internas passam as externas e o disco
     "escorre". */
  const POEIRA = [];
  for (const f of FAIXAS) {
    for (let i = 0; i < f.dens; i++) {
      // sqrt para a densidade ficar uniforme por AREA; sem ele a poeira
      // acumula na borda interna de cada faixa.
      const u = Math.sqrt(Math.random());
      const r = R * (f.de + (f.a - f.de) * u);
      POEIRA.push({
        r,
        ang: Math.random() * Math.PI * 2,
        vel: VEL_BASE * Math.pow(R * 0.8 / r, 1.5),
        cor: f.cor,
        brilho: f.brilho * (0.45 + Math.random() * 0.55),
        tam: Math.random() < 0.90 ? 1 : 2,
        // Espessura do disco: deslocamento vertical pequeno e aleatorio, senao
        // a poeira fica num plano matematico de espessura zero.
        h: (Math.random() - 0.5) * R * 0.045,
        cintila: Math.random() * Math.PI * 2,
      });
    }
  }

  /* Graos grandes: poucos, com halo proprio. Sao eles que dão a sensacao de
     movimento a olho nu, porque o olho segue ponto brilhante e nao nuvem. */
  const GRAOS = Array.from({ length: 34 }, () => {
    const r = R * (0.60 + Math.random() * (R_MAX - 0.60));
    return {
      r,
      ang: Math.random() * Math.PI * 2,
      vel: VEL_BASE * Math.pow(R * 0.8 / r, 1.5),
      tam: 1.4 + Math.random() * 1.6,
      h: (Math.random() - 0.5) * R * 0.05,
      fase: Math.random() * Math.PI * 2,
    };
  });

  /* Estrelas de fundo, fora do disco. Ficam paradas (nao giram com o disco) e
     so cintilam: dao referencia de que a camera e que esta olhando. */
  const ESTRELAS = Array.from({ length: 70 }, () => {
    const ang = Math.random() * Math.PI * 2;
    const rad = R * (R_MAX + 0.06 + Math.random() * 0.30);
    return {
      x: CX + rad * Math.cos(ang),
      y: CY + rad * Math.sin(ang) * 0.85,
      tam: Math.random() < 0.8 ? 0.7 : 1.3,
      fase: Math.random() * Math.PI * 2,
      spd: 0.18 + Math.random() * 0.5,
    };
  });

  /* Pulsos radiais: um por palavra dita. Nascem no corpo e expandem pelo plano
     do disco, entao sao elipses e nao circulos. */
  const PULSOS = [];
  const MAX_PULSOS = 10;

  /** Projeta um ponto do plano do disco (raio, angulo, altura) para a tela. */
  function projetar(r, ang, h) {
    const sx = Math.cos(ang) * r;
    const sz = Math.sin(ang) * r;
    return {
      x: CX + sx,
      y: CY + sz * COS_T - h * SIN_T,
      z: sz * SIN_T + h * COS_T,   // > 0 = na frente do corpo
    };
  }

  /* ─── Doppler beaming ───
     O lado do disco que gira NA DIRECAO de quem olha chega muito mais
     brilhante; o que se afasta, mais apagado. E o que faz o anel do Gargantua
     (e as fotos reais de Sgr A*) ser visivelmente torto em brilho, com um lado
     quase branco e o outro em brasa fraca.

     A velocidade tangencial em `ang` aponta para `ang + PI/2`, e a componente
     dela na direcao da camera sai proporcional a cos(ang): cos(ang)=1 e o lado
     que se aproxima. O expoente 1.6 concentra o brilho num arco menor, em vez
     de espalhar em meia volta inteira.

     Sem isto o anel tem brilho uniforme e le como aro desenhado a mao. */
  function brilhoDoppler(ang) {
    return 0.30 + 0.70 * Math.pow(0.5 + 0.5 * Math.cos(ang), 1.6);
  }

  /* ─── Lente gravitacional ───
     O buraco negro curva a luz que passa perto, entao a metade do disco que
     esta ATRAS dele nao fica escondida: ela aparece contornando a sombra, por
     cima e por baixo. E o unico motivo de o Gargantua do Interestelar parecer
     ter um disco "em pe" alem do disco horizontal.

     O mapeamento comprime o intervalo [0, R_LENTE] para [RC*1.02, R_LENTE]:
     nada pode aparecer dentro da sombra (ela engole a luz), e o que estaria la
     se acumula logo na borda — por isso o brilho fica mais denso colado no
     corpo, que tambem e o comportamento real.

     Devolve null quando o ponto nao deve ser desenhado. */
  function defletir(p) {
    const dx = p.x - CX, dy = p.y - CY;
    const d = Math.hypot(dx, dy);
    if (d >= R_LENTE) return p;          // longe demais: a luz segue reta

    // Na frente do buraco nao ha o que defletir: a luz vem direto para a camera.
    if (p.z >= 0) return d < RC ? null : p;

    if (d < 0.0001) return null;         // exatamente atras do centro: engolido
    const alvo = RC * 1.02 + (d / R_LENTE) * (R_LENTE - RC * 1.02);
    const k = alvo / d;
    return { x: CX + dx * k, y: CY + dy * k, z: p.z, lente: true };
  }

  let rafId = 0;
  let ultimoT = 0;
  let avisouErroNucleo = false;
  let ultimoQuadroPesado = 0;

  /* ─── Passe de poeira ───
     `frente` escolhe a metade: false desenha o que passa ATRAS do corpo, true o
     que passa na frente. Chamada duas vezes por quadro, com o corpo desenhado
     entre as duas. */
  function desenharPoeira(t, frente, calor) {
    for (const d of POEIRA) {
      const ang = d.ang + t * d.vel;
      const bruto = projetar(d.r, ang, d.h);
      if ((bruto.z >= 0) !== frente) continue;
      const p = defletir(bruto);
      if (!p) continue;

      // Profundidade clareia o que vem para a frente. Cintilacao lenta para a
      // poeira nao parecer estatica quando o disco esta devagar.
      const prof = 0.55 + 0.45 * (p.z / (R * R_MAX));
      const cint = 0.90 + 0.10 * Math.sin(t * 0.55 + d.cintila);
      const a = Math.min(1, d.brilho * prof * cint * brilhoDoppler(ang) * (0.85 + calor * 0.5));
      if (a < 0.02) continue;

      const [cr, cg, cb] = d.cor;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
      // fillRect e nao arc: sao ~950 graos por quadro, e arc custa caro o
      // suficiente para derrubar o fps no celular.
      ctx.fillRect(p.x - d.tam / 2, p.y - d.tam / 2, d.tam, d.tam);
    }
  }

  /** Graos grandes, com rastro e halo. Mesmo esquema de dois passes. */
  function desenharGraos(t, frente, calor) {
    for (const g of GRAOS) {
      const ang = g.ang + t * g.vel;
      const bruto = projetar(g.r, ang, g.h);
      if ((bruto.z >= 0) !== frente) continue;
      const p = defletir(bruto);
      if (!p) continue;

      const prof = 0.5 + 0.5 * (p.z / (R * R_MAX));
      const brilho = (0.5 + 0.5 * Math.sin(t * 0.7 + g.fase)) * prof;
      const a = Math.min(1, (0.35 + brilho * 0.65) * brilhoDoppler(ang) * (0.8 + calor * 0.6));

      // Rastro: a posicao de alguns instantes atras, no mesmo arco.
      const pa = defletir(projetar(g.r, ang - 0.10, g.h));
      if (pa && (pa.z >= 0) === frente) {
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = `rgba(255,170,80,${a * 0.30})`;
        ctx.lineWidth = g.tam * 0.55;
        ctx.stroke();
      }

      const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, g.tam * 3.2);
      halo.addColorStop(0, `rgba(255,236,200,${a})`);
      halo.addColorStop(0.4, `rgba(255,150,50,${a * 0.5})`);
      halo.addColorStop(1, "rgba(255,110,20,0)");
      ctx.beginPath();
      ctx.arc(p.x, p.y, g.tam * 3.2, 0, Math.PI * 2);
      ctx.fillStyle = halo;
      ctx.fill();
    }
  }

  /* ─── Arcos de contorno das faixas ───
     Elipses finas que marcam onde cada banda comeca e termina. Baratissimo
     (5 strokes) e e o que faz a lacuna entre faixas ser percebida como divisao
     e nao como falta de poeira. */
  function desenharArcos(t, frente, calor) {
    // `ellipse` com rotacao 0: o raio vertical e o horizontal vezes cos(TILT),
    // que e a propria projecao usada em projetar().
    for (const f of FAIXAS) {
      for (const borda of [f.de, f.a]) {
        const rx = R * borda;
        const ry = rx * COS_T;
        const [cr, cg, cb] = f.cor;
        // Cada metade e partida em dois quartos para o beaming poder variar
        // ao longo do arco: um stroke so teria brilho unico e o degrade de
        // luminosidade do disco morreria justamente nos contornos.
        const base = (frente ? 0.17 : 0.07) * (0.8 + calor * 0.4);
        const inicio = frente ? 0 : Math.PI;
        for (let q = 0; q < 2; q++) {
          const de = inicio + q * (Math.PI / 2);
          const ate = de + Math.PI / 2;
          const a = base * brilhoDoppler((de + ate) / 2);
          ctx.beginPath();
          ctx.ellipse(CX, CY, rx, ry, 0, de, ate);
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${a})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }
  }

  /* ─── Corpo central ───
     Buraco negro: interior quase preto, borda incandescente (anel de foton) e
     um gradiente que simula luz rasante do disco batendo no limbo. */
  function desenharCorpo(t, calor) {
    const resp = 0.5 + 0.5 * Math.sin(t * 0.32);
    const intens = 0.62 + 0.38 * resp + calor * 0.45;

    /* ⚠️ ORDEM: brilho PRIMEIRO, sombra DEPOIS, anel de foton por ultimo.
       Nao e preferencia — e correcao de um bug real: `createRadialGradient`
       pinta TUDO que cai dentro do raio interno com a cor do stop 0. O brilho
       de acrecao comeca em RC*1.08, entao ele enchia o disco inteiro do buraco
       de laranja e a "sombra" aparecia marrom clara. Desenhar o preto depois
       recorta o excesso sem precisar de path em anel. */

    // 1. Brilho de acrecao: a poeira defletida se acumula logo fora da sombra
    //    (ver defletir()), entao a luz tambem. Cai rapido.
    const borda = ctx.createRadialGradient(CX, CY, RC * 1.02, CX, CY, RC * 1.70);
    borda.addColorStop(0,   `rgba(255,180,80,${0.34 * intens})`);
    borda.addColorStop(0.35, `rgba(255,130,34,${0.15 * intens})`);
    borda.addColorStop(1,   "rgba(255,90,16,0)");
    ctx.beginPath();
    ctx.arc(CX, CY, RC * 1.70, 0, Math.PI * 2);
    ctx.fillStyle = borda;
    ctx.fill();

    /* 2. A sombra. PRETA DE VERDADE, `#000` literal.
       Nada de gradiente avermelhado aqui dentro: um buraco negro nao devolve
       luz nenhuma. Qualquer brilho no interior quebra a leitura — o olho passa
       a ver uma esfera iluminada de lado, nao um poco. O preto e mais escuro
       que o proprio fundo da pagina (#090502), e e isso que faz engolir. */
    /* Degrade radial, nao preto chapado: preto absoluto no miolo subindo para um
       ambar muito escuro so na ultima fatia do raio. E a luz do disco rasando o
       limbo, e e o que da volume — chapado, o centro le como recorte de papel
       colado na tela.

       ⚠️ Os valores sao propositalmente quase pretos (o mais claro e #1A0C04,
       ainda mais escuro que o #FF8A1F de qualquer borda). Clarear mais do que
       isto transforma o poco numa esfera iluminada de lado e mata a leitura de
       buraco negro, que foi o defeito de uma versao anterior desta cena. O
       degrade so comeca a subir em 72% do raio. */
    const miolo = ctx.createRadialGradient(CX, CY, 0, CX, CY, RC);
    miolo.addColorStop(0,    "#000000");
    miolo.addColorStop(0.72, "#000000");
    miolo.addColorStop(0.88, "#0B0502");
    miolo.addColorStop(0.97, "#1A0C04");
    miolo.addColorStop(1,    "#2A1206");
    ctx.beginPath();
    ctx.arc(CX, CY, RC, 0, Math.PI * 2);
    ctx.fillStyle = miolo;
    ctx.fill();

    /* 3. Anel de foton: a luz que orbitou o buraco e escapou tangenciando a
       sombra. E FINO e colado na borda, nos poucos pixels a partir de RC.
       Gradiente estreito e nao halo largo: halo largo vira farol e esconde o
       disco, que foi o defeito da primeira versao desta cena. */
    /* Em vez de um anel radial unico, um gradiente LINEAR atravessado por cima
       do anel: ele varia com o angulo e acompanha o Doppler da borda. O
       `clip` recorta a faixa fina entre RC e RC*1.075 (evenodd = dois arcos,
       o de dentro vira furo). */
    ctx.save();
    ctx.beginPath();
    ctx.arc(CX, CY, RC * 1.085, 0, Math.PI * 2);
    ctx.arc(CX, CY, RC * 0.995, 0, Math.PI * 2);
    ctx.clip("evenodd");
    /* ⚠️ Vai da DIREITA para a esquerda: em projetar(), ang=0 cai em x = CX + r,
       e brilhoDoppler() tem maximo em cos(ang)=1. Entao o lado que se aproxima
       (o mais brilhante) e a direita. Com o gradiente no sentido natural
       (esquerda->direita) o anel brilhava do lado oposto ao da poeira, e os
       dois se contradiziam na mesma cena. */
    const foton = ctx.createLinearGradient(CX + RC, CY, CX - RC, CY);
    foton.addColorStop(0,    `rgba(255,252,242,${0.95 * intens})`);
    foton.addColorStop(0.30, `rgba(255,214,150,${0.72 * intens})`);
    foton.addColorStop(0.62, `rgba(255,160,56,${0.34 * intens})`);
    foton.addColorStop(1,    `rgba(210,96,20,${0.18 * intens})`);
    ctx.fillStyle = foton;
    ctx.fillRect(CX - RC * 1.1, CY - RC * 1.1, RC * 2.2, RC * 2.2);
    ctx.restore();

    /* 4. Borda do limbo, em DEGRADE ao longo do anel.
       ⚠️ Nao use um `stroke` unico aqui: uma cor so produz um aro de brilho
       uniforme, que e exatamente o que faz a cena parecer um circulo desenhado
       a mao em vez de luz. O brilho tem de seguir o mesmo Doppler do disco — o
       lado que se aproxima quase branco, o que se afasta quase apagado.

       Varrido em segmentos curtos com sobreposicao (o passo e 1/N, o arco e
       1.6/N) para o degrade sair continuo: sem a sobreposicao aparecem costuras
       entre os segmentos. */
    const SEG = 96;
    for (let i = 0; i < SEG; i++) {
      const de = (i / SEG) * Math.PI * 2;
      const ate = ((i + 1.6) / SEG) * Math.PI * 2;
      const meio = (de + ate) / 2;
      const d = brilhoDoppler(meio);
      // Cor tambem anda com o brilho: branco-quente no lado que se aproxima,
      // ambar escuro no que se afasta. So alfa daria um aro cinza.
      const cr = 255;
      const cg = Math.round(150 + 100 * d);
      const cb = Math.round(70 + 140 * d);
      const a = (0.18 + 0.72 * d) * (0.75 + 0.25 * resp);
      ctx.beginPath();
      ctx.arc(CX, CY, RC, de, ate);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${a})`;
      ctx.lineWidth = 0.8 + 1.1 * d;
      ctx.stroke();
    }
  }



  /* ⚠️ NAO existe sombra projetada nesta cena, e nao e esquecimento.
     Uma versao anterior desenhava uma elipse escura "do corpo sobre o anel".
     Esta errado por dois motivos: o disco e AUTO-LUMINOSO (ele proprio e a
     fonte de luz, nao ha luz externa para o corpo bloquear), e a sombra
     aparecia como uma mancha marrom sobre a silhueta. Removida em 2026-10-31.
     Se um dia alguem quiser escurecer parte do disco, o caminho certo e o
     Doppler beaming em `brilhoDoppler()`, que e fisico. */



  /* Jatos polares: dois cones de luz saindo dos polos, perpendiculares ao
     disco. Ficam discretos em repouso e crescem quando o modelo esta gerando —
     é o indicador visual de "trabalhando". */
  function desenharJatos(t, gerando, calor) {
    const forca = (gerando ? 0.75 : 0.22) + calor * 0.35;
    const ondula = 0.85 + 0.15 * Math.sin(t * 0.8);
    const alt = R * (0.55 + forca * 0.5) * ondula;

    for (const dir of [-1, 1]) {
      const g = ctx.createLinearGradient(CX, CY, CX, CY + dir * alt);
      g.addColorStop(0, `rgba(255,210,150,${0.26 * forca})`);
      g.addColorStop(0.35, `rgba(255,140,40,${0.13 * forca})`);
      g.addColorStop(1, "rgba(255,110,20,0)");
      ctx.beginPath();
      ctx.moveTo(CX - RC * 0.26, CY);
      ctx.lineTo(CX + RC * 0.26, CY);
      ctx.lineTo(CX + RC * 0.62, CY + dir * alt);
      ctx.lineTo(CX - RC * 0.62, CY + dir * alt);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  /** Nasce um pulso por palavra dita, e um lento e constante em repouso. */
  let proximoPulso = 0;
  function pulsar(t, gerando, falando, pulso) {
    const intervalo = falando ? 0.26 : gerando ? 0.9 : 4.5;
    if (t >= proximoPulso) {
      proximoPulso = t + intervalo;
      if (PULSOS.length < MAX_PULSOS) {
        PULSOS.push({ born: t, forca: falando ? 0.5 + pulso * 0.5 : gerando ? 0.4 : 0.22 });
      }
    }
  }

  function desenharPulsos(t) {
    const DUR = 5.0;
    for (let i = PULSOS.length - 1; i >= 0; i--) {
      const p = PULSOS[i];
      const prog = (t - p.born) / DUR;
      if (prog >= 1) { PULSOS.splice(i, 1); continue; }
      // Comeca na borda do corpo e vai ate o fim do disco.
      const rx = RC + (R * R_MAX - RC) * prog;
      const a = (1 - prog) * 0.30 * p.forca;
      if (a < 0.004) continue;
      ctx.beginPath();
      ctx.ellipse(CX, CY, rx, rx * COS_T, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,170,70,${a})`;
      ctx.lineWidth = 1.6 * (1 - prog);
      ctx.stroke();
    }
  }

  function desenharEstrelas(t) {
    for (const e of ESTRELAS) {
      const a = 0.18 + 0.32 * (0.5 + 0.5 * Math.sin(t * e.spd + e.fase));
      ctx.fillStyle = `rgba(255,225,190,${a})`;
      ctx.fillRect(e.x, e.y, e.tam, e.tam);
    }
  }

  /* ─── Imagem secundaria (anel de Einstein) ───
     Alem da poeira defletida grao a grao, o disco inteiro aparece uma segunda
     vez como um anel fino contornando a sombra: e a luz que deu meia volta no
     buraco antes de escapar. No Gargantua e essa imagem que forma o arco
     subindo por cima e descendo por baixo da esfera preta, e sem ela a cena le
     como "planeta com aneis" em vez de buraco negro.

     Desenhada como anel circular (nao elipse): a imagem secundaria perde a
     inclinacao do disco original, porque a luz foi curvada para fora do plano.
     Mais intensa nos polos, onde o disco real nao cobre. */
  function desenharAnelEinstein(t, calor) {
    const resp = 0.5 + 0.5 * Math.sin(t * 0.32);
    const intens = 0.55 + 0.45 * resp + calor * 0.4;

    for (const [raio, largura, alfa] of [
      [RC * 1.16, 2.6, 0.30],
      [RC * 1.30, 1.8, 0.16],
      [RC * 1.46, 1.2, 0.08],
    ]) {
      // Varre o anel em passos e modula pelo angulo: mais forte em cima e em
      // baixo (onde |sin| e alto), porque de lado o disco real ja cobre.
      const PASSOS = 72;
      for (let i = 0; i < PASSOS; i++) {
        const de = (i / PASSOS) * Math.PI * 2;
        const ate = ((i + 1.4) / PASSOS) * Math.PI * 2;
        const meio = (de + ate) / 2;
        const polar = Math.pow(Math.abs(Math.sin(meio)), 1.5);
        const a = alfa * intens * (0.18 + 0.82 * polar) * brilhoDoppler(meio);
        if (a < 0.004) continue;
        ctx.beginPath();
        ctx.arc(CX, CY, raio, de, ate);
        ctx.strokeStyle = `rgba(255,205,140,${a})`;
        ctx.lineWidth = largura;
        ctx.stroke();
      }
    }
  }

  function draw(ms) {
    /* ⚠️ Sai cedo quando a cena esta ESCONDIDA, e isso nao e micro-otimizacao.
       `criarBolha()` e `abrirConversa()` poem `hidden` na tela de boas-vindas,
       que vira `display:none`. O navegador NAO throttla o rAF por isso (so a
       troca de aba throttla), entao o quadro inteiro continuava sendo desenhado
       para ninguem durante a conversa toda: ~1110 fillRect de poeira, 34 graos,
       70 estrelas, 37 gradientes alocados e ~350 arcos com stroke, a 60 fps.
       Num Celeron de 2 nucleos e no celular, isso e a conta mais cara da tela.

       `offsetParent === null` cobre display:none em qualquer ancestral e custa
       uma leitura de layout. Continua agendando o proximo quadro para a cena
       voltar sozinha quando o usuario clicar em CIPHER ou NOVA. */
    if (canvas.offsetParent === null) {
      rafId = requestAnimationFrame(draw);
      return;
    }

    /* ⚠️ Durante a geracao a cena desenha a 20 fps em vez de 60, e isso NAO e
       economia de bateria: e o unico jeito de a animacao parar de competir com
       a propria resposta que o usuario esta esperando.

       Medido em 31/10/2026, com a aba do Cipher aberta: o processo de GPU do
       Chrome marcava 45% de CPU e o load do Mac batia 10,4. O llama.cpp roda a
       inferencia no METAL, a mesma GPU que o canvas usa, entao os dois disputam
       o mesmo recurso. A geracao caiu de 18 tok/s para 5,6 tok/s nessa briga.

       Contraintuitivo de proposito: a versao anterior deixava a cena MAIS
       intensa enquanto gerava (ondas em rajada, jatos crescendo), que e
       exatamente quando ela tem de sair da frente. O movimento continua visivel
       a 20 fps; o que some e um terco do custo de GPU. */
    if (state.isLoading === true) {
      if (ms - ultimoQuadroPesado < 50) {
        rafId = requestAnimationFrame(draw);
        return;
      }
      ultimoQuadroPesado = ms;
    }

    const t = ms / 1000;
    /* ⚠️ save/restore no par com o try: desenharCorpo() usa `clip()`, e uma
       excecao no meio dele deixaria o clip ATIVO para sempre. O catch mantem o
       laco vivo, entao a cena encolheria para o recorte do anel de foton e
       assim ficaria, com exatamente uma linha no console (avisouErroNucleo
       garante isso). Um lancamento unico viraria degradacao permanente. */
    ctx.save();
    try {
      ctx.clearRect(0, 0, SIZE, SIZE);

      const gerando = state.isLoading === true;
      const falando = voz.falando === true;
      // dt real entre quadros: o decaimento do pulso nao pode depender do fps.
      const pulso = voz.consumirPulso(Math.min(0.05, t - ultimoT));
      ultimoT = t;

      // "Calor" e a intensidade geral da cena. Um escalar so, consumido por
      // todas as camadas, mantem a reacao coerente: tudo esquenta junto.
      const calor = (gerando ? 0.5 : 0) + (falando ? 0.3 : 0) + pulso * 0.4;

      pulsar(t, gerando, falando, pulso);

      // 1. halo externo: luz do disco espalhada no "ar".
      // Contido de proposito: uma versao anterior ia a R*1.53 com alfa alto e
      // o laranja lavava a area de chat inteira, deixando a cena sem contraste.
      const haloA = 0.035 + 0.02 * Math.sin(t * 0.22) + calor * 0.04;
      const halo = ctx.createRadialGradient(CX, CY, RC * 0.9, CX, CY, R * (R_MAX + 0.05));
      halo.addColorStop(0, `rgba(255,150,46,${haloA * 1.5})`);
      halo.addColorStop(0.5, `rgba(210,84,14,${haloA * 0.7})`);
      halo.addColorStop(1, "rgba(140,46,8,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, SIZE, SIZE);

      desenharEstrelas(t);

      // 2. metade de TRAS do disco.
      desenharArcos(t, false, calor);
      desenharPoeira(t, false, calor);
      desenharGraos(t, false, calor);

      // 3. corpo (tapa o que ficou atras).
      desenharJatos(t, gerando, calor);
      desenharCorpo(t, calor);

      // 3b. imagem secundaria: sai de tras da sombra, por isso vem depois do
      //     corpo e antes da poeira da frente.
      desenharAnelEinstein(t, calor);

      // 4. metade da FRENTE do disco, por cima do corpo.
      desenharPoeira(t, true, calor);
      desenharGraos(t, true, calor);
      desenharArcos(t, true, calor);

      // 5.
      desenharPulsos(t);
    } catch (erro) {
      /* Um quadro que falha nao pode matar a animacao: sem o catch, qualquer
         excecao aqui congela a tela inicial para sempre.

         ⚠️ Mas o catch MUDO custou caro em 2026-10-31: um erro dentro do draw
         deixava a cena pela metade (so o halo pintava) e nao havia nada no
         console — o sintoma parecia bug de CSS ou de layout, e a investigacao
         foi feita lendo pixel do canvas. Loga UMA vez: o suficiente para dizer
         onde olhar, sem inundar o console a 60 fps. */
      if (!avisouErroNucleo) {
        avisouErroNucleo = true;
        console.error("[nucleo] quadro falhou, a cena fica incompleta:", erro);
      }
    } finally {
      ctx.restore();
    }
    rafId = requestAnimationFrame(draw);
  }

  rafId = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(rafId);
    obs.disconnect();
    window.removeEventListener("resize", ajustarEscala);
  };
}



/* ═══════════════════════════════════════════════════════════
   ANEXOS VISIVEIS NA CONVERSA
   ═══════════════════════════════════════════════════════════
   O arquivo enviado aparece como chip acima do campo e, depois de enviar, fica
   dentro da bolha da pergunta.

   ⚠️ Antes disto o upload so mostrava um toast de 3 s: o arquivo ia para a
   sandbox e sumia da tela. Quem voltasse na conversa depois nao tinha como
   saber que arquivo tinha sido enviado, e o modelo citava um nome que nao
   aparecia em lugar nenhum.

   O chip some da barra quando a mensagem e enviada, nao quando o upload termina:
   ele representa "anexado a esta mensagem", e nao "existe no servidor".
*/

const ICONE_ARQUIVO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6.5A1.5 1.5 0 0 0 5 3.5v17A1.5 1.5 0 0 0 6.5 22h11a1.5 1.5 0 0 0 1.5-1.5V7z"/><polyline points="14 2 14 7 19 7"/></svg>';
const ICONE_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';

function formatarKB(bytes) {
  const kb = (bytes || 0) / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
}

/** Monta um chip. `removivel` false é o da bolha já enviada. */
function montarChipAnexo(anexo, removivel) {
  const chip = document.createElement("div");
  chip.className = "anexo-chip";
  /* `textContent` no nome e nao innerHTML: nome de arquivo vem do disco e pode
     conter `<`. Com innerHTML isso seria injecao de HTML na propria interface. */
  chip.innerHTML = ICONE_ARQUIVO;
  const elNome = document.createElement("span");
  elNome.className = "anexo-nome";
  elNome.textContent = anexo.nome;
  elNome.title = anexo.nome;
  const elTam = document.createElement("span");
  elTam.className = "anexo-tam";
  elTam.textContent = formatarKB(anexo.bytes);
  chip.append(elNome, elTam);
  if (removivel) {
    const x = document.createElement("button");
    x.className = "anexo-x";
    x.type = "button";
    x.title = "Remover anexo";
    x.setAttribute("aria-label", `Remover ${anexo.nome}`);
    x.innerHTML = ICONE_X;
    x.addEventListener("click", () => {
      state.anexos = state.anexos.filter((a) => a.nome !== anexo.nome);
      renderAnexos();
      /* Nao apaga o arquivo do servidor: ele ja foi gravado e pode ser util
         depois. Remover aqui so desfaz o vinculo com ESTA mensagem. */
    });
    chip.appendChild(x);
  }
  return chip;
}

/**
 * Habilita o envio. Com anexo pendente, mensagem vazia passa a valer: "aqui
 * esta o arquivo" e um pedido legitimo, e o texto vira um padrao.
 */
function atualizarBotaoEnviar() {
  const btn = DOM.sendButton();
  const input = DOM.messageInput();
  if (!btn || !input) return;
  const temTexto = input.value.trim().length > 0;
  btn.disabled = state.isLoading || (!temTexto && state.anexos.length === 0);
}

function renderAnexos() {
  const barra = DOM.anexosBarra();
  if (!barra) return;
  barra.innerHTML = "";
  barra.hidden = state.anexos.length === 0;
  for (const a of state.anexos) barra.appendChild(montarChipAnexo(a, true));
  // O botao de enviar aceita mensagem vazia quando ha anexo.
  atualizarBotaoEnviar();
}

/* ═══════════════════════════════════════════════════════════
   UPLOAD DE ARQUIVO
   ═══════════════════════════════════════════════════════════
   Manda o arquivo para a sandbox do Cipher. A partir dai o modelo consegue ler
   com `ler_arquivo`, e .jrxml grande volta como especificacao resumida.

   Le com `File.text()` e envia como TEXTO em JSON. Nao usa FormData de
   proposito: multipart exigiria uma dependencia nova no servidor, e tudo que a
   sandbox aceita ja e texto.
*/

/* Teto do lado do cliente, espelhando o da sandbox. Existe para o erro aparecer
   na hora, em vez de depois de subir 1 MB e voltar 400. */
const TETO_UPLOAD = 1024 * 1024;

/**
 * Registra o arquivo como anexo da mensagem em edicao.
 *
 * ⚠️ Existe como funcao porque havia DOIS caminhos de sucesso no upload (novo e
 * substituir) e só o primeiro criava o chip. Resultado medido em 2026-11-03:
 * reenviar um arquivo que já estava na sandbox gravava certo e não aparecia
 * nada na tela, e o 400 do `JA_EXISTE` no console sugeria falha de upload.
 */
function registrarAnexo(nome, bytes) {
  if (!state.anexos.some((a) => a.nome === nome)) {
    state.anexos.push({ nome, bytes: bytes || 0 });
  }
  renderAnexos();
  DOM.messageInput()?.focus();
}

async function enviarArquivo(arquivo) {
  if (!arquivo) return;

  if (arquivo.size > TETO_UPLOAD) {
    showToast(arquivo.name + " tem " + Math.round(arquivo.size / 1024) + " KB. O limite e 1 MB.", "error");
    return;
  }

  const btn = DOM.btnAnexo();
  btn?.classList.add("enviando");

  try {
    const conteudo = await arquivo.text();
    const res = await fetch(API_BASE + "/api/arquivos/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: arquivo.name, conteudo }),
    });
    const dados = await res.json().catch(() => ({}));

    if (res.ok) {
      /* O chip substitui o toast como confirmacao: ele FICA na tela ate a
         mensagem ser enviada, enquanto o toast sumia em 3 s e deixava o usuario
         sem saber se o arquivo tinha ido. */
      registrarAnexo(dados.caminho, dados.bytes);
      return;
    }

    /* JA_EXISTE e o unico erro com acao obvia. Os outros (extensao, tamanho,
       jrxml invalido) ja vem com texto explicativo do servidor. */
    if (dados.code === "JA_EXISTE") {
      if (confirm("Ja existe " + arquivo.name + " no Cipher. Substituir?")) {
        const r2 = await fetch(API_BASE + "/api/arquivos/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nome: arquivo.name, conteudo, sobrescrever: true }),
        });
        const d2 = await r2.json().catch(() => ({}));
        if (r2.ok) registrarAnexo(d2.caminho || arquivo.name, d2.bytes ?? arquivo.size);
        else showToast(d2.error || "Nao consegui substituir.", "error");
      }
      return;
    }
    showToast(dados.error || "Nao consegui enviar o arquivo.", "error");
  } catch (erro) {
    showToast("Falha ao ler o arquivo.", "error");
  } finally {
    btn?.classList.remove("enviando");
  }
}

function initUpload() {
  const btn = DOM.btnAnexo();
  const input = DOM.fileInput();
  const caixa = DOM.inputContainer();

  btn?.addEventListener("click", () => input?.click());
  input?.addEventListener("change", async () => {
    await enviarArquivo(input.files?.[0]);
    /* Zera o valor: sem isto, escolher o MESMO arquivo de novo nao dispara
       `change`, e o segundo envio simplesmente nao acontece, sem nada na tela
       explicando por que. */
    input.value = "";
  });

  if (!caixa) return;

  /* Arrastar e soltar. `dragover` PRECISA de preventDefault: sem ele o
     navegador abre o arquivo e a pagina do Cipher e substituida pelo XML. */
  let profundidade = 0;
  const parar = (e) => { e.preventDefault(); e.stopPropagation(); };

  caixa.addEventListener("dragenter", (e) => {
    parar(e);
    /* Contador de profundidade: `dragleave` dispara ao passar sobre CADA filho,
       e sem contar o realce piscaria enquanto o cursor atravessa a caixa. */
    profundidade++;
    caixa.classList.add("arrastando");
  });
  caixa.addEventListener("dragover", parar);
  caixa.addEventListener("dragleave", (e) => {
    parar(e);
    if (--profundidade <= 0) { profundidade = 0; caixa.classList.remove("arrastando"); }
  });
  caixa.addEventListener("drop", async (e) => {
    parar(e);
    profundidade = 0;
    caixa.classList.remove("arrastando");
    const lista = [...(e.dataTransfer?.files || [])];
    if (lista.length > 1) showToast("Envie um arquivo por vez.", "error");
    else await enviarArquivo(lista[0]);
  });

  // Soltar FORA da caixa tambem nao pode abrir o arquivo no navegador.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

/* ─── Init ───────────────────────────────────── */
function init() {
  const input = DOM.messageInput(), btn = DOM.sendButton();
  if (!input || !btn) return;

  // Desativa scroll enquanto só o globo está visível
  if (DOM.welcomeScreen()) DOM.messagesArea()?.classList.add("welcome-mode");

  updateClock();
  setInterval(updateClock, 1000);

  // Abre sempre na tela inicial; as conversas ficam na sidebar, a um clique.
  carregarConversas();
  renderListaConversas();

  carregarMemoria();
  renderMemoria();

  refreshSystemStatus().catch(() => showToast("Não foi possível carregar o status operacional.", "error"));

  // Revalida o status do provedor a cada 2min. Pausa com a aba oculta.
  setInterval(() => {
    if (document.visibilityState === "hidden") return;
    refreshSystemStatus().catch(() => {});
  }, 120_000);

  // Quando a aba volta a ficar visivel, refresca imediatamente.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshSystemStatus().catch(() => {});
    }
  });

  initCampoEstelar();
  initNucleoOrbital();
  initUpload();
  miniGlobo = criarMiniGlobo();
  voz.iniciar();
  escuta.iniciar();

  DOM.btnVoz()?.addEventListener("click", () => voz.alternar());
  DOM.btnMic()?.addEventListener("click", () => escuta.alternar());

  input.addEventListener("input", () => {
    const len = input.value.length;
    atualizarBotaoEnviar();
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 100) + "px";
    updateCharCounter(len);
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!btn.disabled) sendMessage(); }
  });

  /* ⚠️ `() => sendMessage()` e NAO `sendMessage`: a funcao passou a aceitar um
     texto no primeiro argumento, e listener entrega o Event ali. Ligada direto,
     o clique mandaria "[object PointerEvent]" como pergunta ao modelo. */
  btn.addEventListener("click", () => sendMessage());

  // Botão do header: sai da conversa e volta à tela inicial. Não apaga nada —
  // antes ele limpava o histórico e recarregava a página.
  DOM.btnClearChat()?.addEventListener("click", () => {
    mostrarTelaInicial();
    fecharSidebarNoMobile();
  });

  // Nav: CIPHER e NOVA levam à tela inicial. A conversa só nasce ao enviar a
  // primeira mensagem, então as duas fazem a mesma coisa por design.
  DOM.navCipher()?.addEventListener("click", () => { mostrarTelaInicial(); fecharSidebarNoMobile(); });
  DOM.navNova()?.addEventListener("click", () => { mostrarTelaInicial(); fecharSidebarNoMobile(); });

  // Lista de conversas: um listener no container aguenta a lista sendo redesenhada.
  DOM.convList()?.addEventListener("click", e => {
    const item = e.target.closest(".conv-item");
    if (!item) return;
    const id = item.dataset.id;

    const btnDel = e.target.closest(".conv-del");
    if (btnDel) {
      e.stopPropagation();
      // Dois cliques para excluir: o primeiro arma, o segundo confirma. Evita
      // perder conversa por clique errado sem recorrer a um modal.
      if (btnDel.classList.contains("confirmando")) {
        excluirConversa(id);
      } else {
        DOM.convList()?.querySelectorAll(".conv-del.confirmando").forEach(b => {
          b.classList.remove("confirmando");
          b.title = "Excluir conversa";
        });
        btnDel.classList.add("confirmando");
        btnDel.title = "Clique de novo para excluir";
        setTimeout(() => {
          btnDel.classList.remove("confirmando");
          btnDel.title = "Excluir conversa";
        }, 3000);
      }
      return;
    }

    abrirConversa(id);
    fecharSidebarNoMobile();
  });

  DOM.convList()?.addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const item = e.target.closest(".conv-item");
    if (!item) return;
    e.preventDefault();
    abrirConversa(item.dataset.id);
    fecharSidebarNoMobile();
  });

  // Modo documentos: responde com base nas notas indexadas (npm run indexar).
  DOM.btnDocs()?.addEventListener("click", () => {
    state.modoDocs = !state.modoDocs;
    DOM.btnDocs()?.classList.toggle("ativo", state.modoDocs);
    showToast(
      state.modoDocs
        ? "Modo documentos ligado: respostas com base nas suas notas."
        : "Modo documentos desligado.",
      "info"
    );
  });

  // Memoria: adicionar a mao e excluir com dois cliques (mesmo padrao das conversas).
  const memoriaInput = DOM.memoriaInput();
  const adicionarFatoManual = () => {
    const texto = memoriaInput?.value.trim();
    if (!texto) return;
    if (adicionarFato(texto, "manual")) {
      memoriaInput.value = "";
      showToast("Fato guardado na memória.", "success");
    } else {
      showToast("Esse fato já está na memória.", "info");
    }
  };
  DOM.memoriaAddBtn()?.addEventListener("click", adicionarFatoManual);
  memoriaInput?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); adicionarFatoManual(); }
  });

  DOM.memoriaList()?.addEventListener("click", e => {
    const btnDel = e.target.closest(".memoria-del");
    if (!btnDel) return;
    const item = e.target.closest(".memoria-item");
    if (!item) return;

    if (btnDel.classList.contains("confirmando")) {
      excluirFato(item.dataset.id);
    } else {
      DOM.memoriaList()?.querySelectorAll(".memoria-del.confirmando").forEach(b => {
        b.classList.remove("confirmando");
        b.title = "Esquecer este fato";
      });
      btnDel.classList.add("confirmando");
      btnDel.title = "Clique de novo para esquecer";
      setTimeout(() => {
        btnDel.classList.remove("confirmando");
        btnDel.title = "Esquecer este fato";
      }, 3000);
    }
  });

  // Sidebar drawer (mobile)
  DOM.btnMenuToggle()?.addEventListener("click", () => DOM.leftSidebar()?.classList.toggle("open"));
  document.addEventListener("click", e => {
    const sb = DOM.leftSidebar(), tb = DOM.btnMenuToggle();
    if (sb?.classList.contains("open") && !sb.contains(e.target) && !tb?.contains(e.target))
      sb.classList.remove("open");
  });

  input.focus();
}

function fecharSidebarNoMobile() {
  DOM.leftSidebar()?.classList.remove("open");
}

document.addEventListener("DOMContentLoaded", init);
