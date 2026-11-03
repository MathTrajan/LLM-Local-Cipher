/**
 * ============================================================
 * CIPHER CHAT - Provedor local (llama.cpp / llama-server)
 * ============================================================
 * Fala o protocolo OpenAI (/v1/chat/completions), que o llama-server expoe.
 * Nao depende de SDK: o fetch nativo do Node basta.
 *
 * O modelo roda na maquina, sem internet e sem custo por token. O preco e a
 * latencia: um 3B quantizado responde em segundos, nao em centenas de ms.
 * ============================================================
 */

const fs = require("fs/promises");
const { getEnvString } = require("../config");

/* ═══════════════════════════════════════════════════════════
   DOIS MODELOS, COM ALTERNANCIA
   ═══════════════════════════════════════════════════════════
   O Cipher fala com uma LISTA de llama-server, em ordem de preferencia, e usa o
   primeiro que responder. Hoje:

     1. Mac pela tailnet .... Qwen 3B, 22 a 24 tok/s (Metal)
     2. Sentinel local ...... modelo pequeno, sempre de pe

   Por que dois: o primario depende do Mac estar ligado, e antes disso toda
   mensagem virava 503 quando ele estava fechado. O secundario roda no proprio
   servidor e nao depende de mais nada.

   ⚠️ Isto NAO contradiz a decisao de privacidade de 2026-08-18. Aquela proibia
   FALLBACK DE NUVEM (Groq): dado saindo para terceiro. Os dois endpoints aqui
   sao maquinas do usuario, e o trafego entre eles passa cifrado pela tailnet.

   ⚠️ A ordem importa e nao e alfabetica: o primeiro da lista e o melhor modelo,
   nao o mais perto. Cair para o secundario piora a resposta, entao ele e ultimo
   recurso e nao escolha de desempate.

   `LOCAL_LLM_BASE_URL` continua valendo sozinho (um endpoint so) para nao
   quebrar quem tiver o .env antigo. */
const ENDPOINTS = (() => {
  const lista = getEnvString("LOCAL_LLM_ENDPOINTS", "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (lista.length) return lista.map((u) => u.replace(/\/+$/, ""));
  return [(getEnvString("LOCAL_LLM_BASE_URL") || "http://127.0.0.1:8080/v1").replace(/\/+$/, "")];
})();

/* Qual endpoint respondeu por ultimo. Comeca no primeiro e so muda quando o
   health check manda. Guardar a escolha evita testar os dois a cada mensagem,
   que dobraria a latencia de verificacao. */
let indiceAtual = 0;
const BASE_URL = ENDPOINTS[0];

/** O endpoint em uso agora. */
function enderecoAtual() {
  return ENDPOINTS[indiceAtual] || ENDPOINTS[0];
}

/** Nome curto para log e para o painel. */
function apelidoDe(url) {
  const m = String(url).match(/\/\/([^:/]+)/);
  if (!m) return url;
  const host = m[1];
  if (host === "127.0.0.1" || host === "localhost") return "local";
  return host;
}
// O llama-server aceita qualquer nome de modelo: ele serve o unico GGUF carregado.
const MODEL = getEnvString("LOCAL_LLM_MODEL") || "local";
const TIMEOUT_MS = Number(getEnvString("LOCAL_LLM_TIMEOUT_MS", "120000")) || 120000;

/* ⚠️ Timeout POR ENDPOINT, porque eles tem ordens de grandeza diferentes.
   Medido em 2026-11-03: o 3B no Metal do Mac faz 22 a 24 tok/s; o 0.5B no
   Celeron sem AVX faz 0,7 a 1,0 tok/s. Uma resposta de 80 tokens sai em 4 s no
   primeiro e em 80 a 120 s no segundo, e isso ANTES do prefill.
   Com o teto unico de 120 s o fallback abortava sempre, e o erro que aparecia
   era "o modelo local nao esta respondendo" com o modelo rodando e gerando. */
const TIMEOUT_FALLBACK_MS = Number(getEnvString("LOCAL_LLM_TIMEOUT_FALLBACK_MS", "600000")) || 600000;

/** O endpoint em uso e o primario, ou um fallback mais lento? */
function ehFallback() {
  return indiceAtual > 0;
}

function timeoutAtual() {
  return ehFallback() ? TIMEOUT_FALLBACK_MS : TIMEOUT_MS;
}

async function postJson(path, body, timeoutMs = null) {
  timeoutMs = timeoutMs ?? timeoutAtual();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${enderecoAtual()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detalhe = await res.text().catch(() => "");
      throw new Error(`llama-server respondeu ${res.status}: ${detalhe.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function chat(messages, options = {}) {
  /* ⚠️ 1024 era pouco para GERAR ARQUIVO e o sintoma enganava: medido em
     2026-11-01, ao pedir um .jrxml o modelo entra em tool calling, monta o JSON
     de `criar_arquivo` com o conteudo inteiro dentro e estoura o teto. O JSON
     sai TRUNCADO no meio, o JSON.parse falha e o usuario ve "o modelo montou um
     pedido invalido", que sugere erro de raciocinio quando na verdade foi
     corte por limite. 42 segundos gastos para nao entregar nada.
     3072 cabe um .jrxml pequeno ou medio; o contexto de 8192 suporta. */
  const maxTokens = options.maxTokens || 3072;
  const temperature = options.temperature ?? 0.7;

  const corpo = {
    model: options.model || MODEL,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  if (options.tools?.length) {
    corpo.tools = options.tools;
    corpo.tool_choice = options.toolChoice || "auto";
  }

  const response = await postJson("/chat/completions", corpo);

  const choice = response.choices?.[0];
  const text = choice?.message?.content?.trim() || "";

  return {
    text,
    toolCalls: normalizarToolCalls(choice?.message?.tool_calls),
    // O llama-server devolve o caminho do .gguf; encurta para o nome do arquivo.
    model: nomeCurtoDoModelo(response.model),
    provider: "local",
    usage: {
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      totalTokens: response.usage?.total_tokens,
      cachedTokens: response.usage?.prompt_tokens_details?.cached_tokens,
    },
    finishReason: choice?.finish_reason,
  };
}

/**
 * Igual ao chat(), mas em streaming: chama onDelta(trecho) a cada token e
 * devolve o mesmo objeto de resultado ao final. O timeout aqui e de
 * inatividade (entre um token e outro), nao sobre a resposta inteira —
 * resposta longa no 3B passa facil de 2 minutos somando tudo.
 */
async function chatStream(messages, options = {}, onDelta = () => {}) {
  /* ⚠️ 1024 era pouco para GERAR ARQUIVO e o sintoma enganava: medido em
     2026-11-01, ao pedir um .jrxml o modelo entra em tool calling, monta o JSON
     de `criar_arquivo` com o conteudo inteiro dentro e estoura o teto. O JSON
     sai TRUNCADO no meio, o JSON.parse falha e o usuario ve "o modelo montou um
     pedido invalido", que sugere erro de raciocinio quando na verdade foi
     corte por limite. 42 segundos gastos para nao entregar nada.
     3072 cabe um .jrxml pequeno ou medio; o contexto de 8192 suporta. */
  const maxTokens = options.maxTokens || 3072;
  const temperature = options.temperature ?? 0.7;

  const controller = new AbortController();
  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let timer = setTimeout(() => controller.abort(), timeoutAtual());
  const rearmar = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutAtual());
  };

  try {
    const res = await fetch(`${enderecoAtual()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model || MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        // Sem isto o llama-server NAO manda o bloco `usage` no streaming (testado
        // no b10240: sem a flag nenhum chunk traz usage). E o que alimenta o
        // painel de tokens e a barra de contexto.
        stream_options: { include_usage: true },
        ...(options.tools?.length
          ? { tools: options.tools, tool_choice: options.toolChoice || "auto" }
          : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const detalhe = await res.text().catch(() => "");
      throw new Error(`llama-server respondeu ${res.status}: ${detalhe.slice(0, 200)}`);
    }

    let texto = "";
    let modelo = null;
    let finishReason = null;
    let usage = null;
    // tool_calls no streaming chegam picadas: o nome vem num delta e os
    // "arguments" em varios pedacos. Acumula por indice ate o fim.
    const toolCallsParciais = [];

    // Parse manual do SSE: eventos separados por linha em branco, payload em
    // linhas "data:". O llama-server encerra com "data: [DONE]".
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const pedaco of res.body) {
      rearmar();
      buffer += decoder.decode(pedaco, { stream: true });
      let corte;
      while ((corte = buffer.indexOf("\n\n")) !== -1) {
        const bloco = buffer.slice(0, corte);
        buffer = buffer.slice(corte + 2);
        for (const linha of bloco.split("\n")) {
          if (!linha.startsWith("data:")) continue;
          const payload = linha.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let json;
          try { json = JSON.parse(payload); } catch (_) { continue; }
          if (json.model) modelo = json.model;
          if (json.usage) usage = json.usage;
          const escolha = json.choices?.[0];
          if (escolha?.finish_reason) finishReason = escolha.finish_reason;
          const delta = escolha?.delta?.content || "";
          if (delta) {
            texto += delta;
            onDelta(delta);
          }
          for (const tc of escolha?.delta?.tool_calls || []) {
            const i = tc.index ?? 0;
            if (!toolCallsParciais[i]) toolCallsParciais[i] = { id: null, nome: "", argumentos: "" };
            if (tc.id) toolCallsParciais[i].id = tc.id;
            if (tc.function?.name) toolCallsParciais[i].nome = tc.function.name;
            if (tc.function?.arguments) toolCallsParciais[i].argumentos += tc.function.arguments;
          }
        }
      }
    }

    return {
      text: texto.trim(),
      toolCalls: montarToolCallsDoStream(toolCallsParciais),
      model: nomeCurtoDoModelo(modelo),
      provider: "local",
      usage: {
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
        // Prefixo do prompt reaproveitado do KV cache: o llama-server nao
        // reprocessa esses tokens, e por isso a 2a mensagem responde mais rapido.
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
      },
      finishReason,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normaliza o tool_calls do modo nao-streaming para o formato interno
 * {id, nome, argumentos}. "arguments" vem como string JSON.
 */
function normalizarToolCalls(brutos) {
  if (!Array.isArray(brutos) || !brutos.length) return [];
  return brutos
    .map((tc, i) => ({
      id: tc.id || `call_${i}`,
      nome: tc.function?.name || "",
      argumentos: tc.function?.arguments || "",
    }))
    .filter((tc) => tc.nome);
}

/** Fecha as tool_calls acumuladas no streaming, descartando as sem nome. */
function montarToolCallsDoStream(parciais) {
  return (parciais || [])
    .filter(Boolean)
    .map((tc, i) => ({ id: tc.id || `call_${i}`, nome: tc.nome, argumentos: tc.argumentos }))
    .filter((tc) => tc.nome);
}

function nomeCurtoDoModelo(valor) {
  if (!valor) return MODEL;
  const base = String(valor).split("/").pop() || String(valor);
  return base.replace(/\.gguf$/i, "");
}

/**
 * Teto do health check. 2500 ms basta de sobra no loopback (responde em ~10 ms).
 *
 * ⚠️ Pela tailnet NAO basta: medido em 31/10/2026, a PRIMEIRA requisicao depois
 * de um periodo de inatividade levou 473 ms de fetch mas o health check chegou a
 * estourar os 2500 ms, porque o WireGuard precisa refazer o handshake e as vezes
 * furar NAT. O sintoma e cruel: o Cipher responde 503 "suba o llama-server" com
 * o modelo de pe e funcionando, e a segunda tentativa funciona. Exatamente o
 * caso de uso do celular, que sempre pega a conexao fria.
 *
 * Por isso e configuravel, e o /etc/cipher.env do Sentinel usa 6000.
 */
const HEALTH_TIMEOUT_MS =
  Number(getEnvString("LOCAL_LLM_HEALTH_TIMEOUT_MS", "2500")) || 2500;

/**
 * Usa /health do llama-server: e barato e nao gasta inferencia. Se o processo
 * nao estiver de pe, o fetch falha na conexao e devolvemos false.
 */
async function healthCheck() {
  /* ⚠️ Varre a lista NA ORDEM e fixa o primeiro que responder. O indice fica
     guardado para as proximas mensagens usarem o mesmo endpoint sem repetir a
     varredura, e o chat/chatStream nao precisam saber que existe mais de um.

     Testa sempre a partir do PRIMEIRO, nao do atual: assim, quando o Mac volta
     a ficar de pe, o Cipher sobe de volta para o modelo bom sozinho. Sem isso
     ele ficaria preso no modelo pequeno ate alguem reiniciar o servico. */
  for (let i = 0; i < ENDPOINTS.length; i++) {
    const alvo = ENDPOINTS[i];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const url = alvo.replace(/\/v1$/, "") + "/health";
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (data?.status !== "ok") continue;

      if (indiceAtual !== i) {
        const de = apelidoDe(ENDPOINTS[indiceAtual]);
        const para = apelidoDe(alvo);
        console.log(`[local] alternando de ${de} para ${para}`);
      }
      indiceAtual = i;
      return true;
    } catch (_) {
      // Endpoint fora: tenta o proximo da lista.
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

/**
 * Ficha tecnica do que o llama-server realmente carregou, lida do /props. Tudo
 * daqui vem do processo de pe, nao do .env: o script pode ter subido com outro
 * -c, e o .gguf pode ter sido trocado sem ninguem mexer na configuracao.
 * Devolve {} se o modelo estiver fora.
 */
async function infoModelo() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const url = enderecoAtual().replace(/\/v1$/, "") + "/props";
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return {};
    const data = await res.json();

    const n = data?.default_generation_settings?.n_ctx;
    const caminho = data?.model_path;

    // Tamanho em disco: o /props nao informa, entao vem do stat do proprio .gguf.
    // Falha em silencio — o arquivo pode estar noutra maquina (o Cipher aponta
    // para o modelo que mora no odysseus-dev).
    let bytes = null;
    if (caminho) {
      try { bytes = (await fs.stat(caminho)).size; } catch (_) { /* sem tamanho */ }
    }

    return {
      contextoMax: Number.isFinite(n) ? n : null,
      quantizacao: data?.model_ftype || null,
      motor: data?.build_info || null,
      slots: data?.total_slots ?? null,
      bytes,
    };
  } catch (_) {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** Nome do modelo carregado, para exibir no painel. Null se estiver fora. */
async function modeloCarregado() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${enderecoAtual()}/models`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const primeiro = data?.models?.[0] || data?.data?.[0];
    const nome = primeiro?.name || primeiro?.id;
    return nome ? nomeCurtoDoModelo(nome) : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  chat, chatStream, healthCheck, modeloCarregado, infoModelo,
  BASE_URL,
  ENDPOINTS,
  enderecoAtual,
  ehFallback,
  apelidoDe,
};
