require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { getEnvString } = require("./config");
const agent = require("./agent");
const localProvider = require("./providers/local");
const rag = require("./rag");
const perfil = require("./perfil");
const arquivos = require("./arquivos");
const auth = require("./auth");

const app = express();

const PORT = Number(getEnvString("PORT", "3000")) || 3000;
const api = express.Router();

/**
 * Liga o que SO faz sentido quando o Cipher esta publicado atras do cloudflared
 * (hoje: cipher.trajano.tech, no Sentinel). Em `localhost` tudo isto fica
 * desligado, e nao por economia: HSTS e upgrade-insecure-requests QUEBRAM o
 * front no Safari local — ver o comentario do helmet logo abaixo.
 *
 * Variavel explicita em vez de deduzir de ALLOWED_ORIGIN: o dia em que alguem
 * restringir o CORS no dev nao deve religar CSP de HTTPS sem perceber.
 */
const ATRAS_DE_PROXY = getEnvString("ATRAS_DE_PROXY", "") === "1";

/**
 * Chave do rate limit.
 *
 * ⚠️ Atras do cloudflared TODA requisicao chega de 127.0.0.1, porque o tunel
 * entrega no loopback. Sem isto `req.ip` seria identico para o mundo inteiro e
 * os 30 req/min valeriam para a SOMA dos visitantes, nao por pessoa — um
 * visitante consumiria a cota de todos.
 *
 * Usa `CF-Connecting-IP` e nao `X-Forwarded-For` de proposito: a borda da
 * Cloudflare sobrescreve o primeiro sempre, e o segundo e forjavel por quem
 * alcanca a porta (falha H4 da auditoria do Sentinel). `app.set("trust proxy")`
 * fica de fora pelo mesmo motivo: ele mudaria `req.ip` no app inteiro com base
 * num header que o cliente controla.
 *
 * Requisicao sem o header nao veio da borda (curl no loopback, prova do deploy)
 * e cai numa chave unica compartilhada. Restritivo de proposito.
 */
function chaveDoCliente(req) {
  if (!ATRAS_DE_PROXY) return req.ip;
  return req.headers["cf-connecting-ip"] || "sem-borda";
}

/**
 * Fabrica dos rate limiters. A politica (janela, teto e, principalmente, COMO o
 * cliente e identificado) vive aqui e nao copiada em cada rota: rota nova nasce
 * com a chave certa sem quem a escreveu precisar lembrar de `chaveDoCliente`.
 *
 * Cada chamada cria o seu proprio contador. Duas rotas que usem o MESMO
 * limitador dividem cota, e e o caso hoje: `/arquivos/executar` reusa o
 * `chatRateLimiter` de proposito, porque executar acao de arquivo so acontece
 * depois de uma mensagem de chat que a propos.
 */
function criarLimitador(message, { max = 30 } = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: chaveDoCliente,
    // Desliga o aviso que o express-rate-limit emite a cada requisicao ao ver
    // X-Forwarded-For sem `trust proxy`. Ignorar esse header e a decisao, nao um
    // descuido: ver chaveDoCliente().
    validate: { xForwardedForHeader: false },
    message,
  });
}

const publicDir = path.join(__dirname, "public");
const legacyFrontendDir = path.join(__dirname, "../frontend");
const frontendDir = fs.existsSync(publicDir) ? publicDir : legacyFrontendDir;

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        // O helmet liga upgrade-insecure-requests por padrao. O Chrome isenta
        // localhost dela; o Safari NAO — ele reescreve css/js para https://localhost:3100,
        // o Express so fala HTTP, e a pagina abre em HTML cru sem estilo nem script.
        // Em local a diretiva so atrapalha; publicado, onde a borda da Cloudflare
        // termina o TLS, ela e desejavel. Por isso e condicional e nao removida.
        upgradeInsecureRequests: ATRAS_DE_PROXY ? [] : null,
      },
    },
    // HSTS em http e ignorado pelo navegador, mas se um dia o Cipher for aberto por
    // um proxy https ele fixaria localhost em HTTPS no navegador inteiro. Fora em
    // local; publicado em HTTPS de verdade, entra.
    strictTransportSecurity: ATRAS_DE_PROXY,
  })
);

app.use(
  cors({
    origin: getEnvString("ALLOWED_ORIGIN", "*"),
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const chatRateLimiter = criarLimitador({
  error: "Muitas requisicoes. Aguarde um momento.",
  code: "RATE_LIMIT_EXCEEDED",
});

/* ⚠️ 4mb e nao 2mb: o upload manda o arquivo como JSON, e JSON escapa aspas,
   quebras de linha e acentos. Um .jrxml de 768 KB (o maior da empresa) chega
   perto de 1 MB depois do escape, e o `limit` conta o corpo cru. Com 2mb o
   upload falhava com "request entity too large", erro que nao diz qual arquivo
   nem qual limite. */
app.use(express.json({ limit: "4mb" }));

// Sem cache no front: em dev o navegador ja serviu HTML/JS/CSS velhos como se fossem
// os atuais, e o sintoma parece bug de codigo. Tira o cache da equacao.
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

/**
 * Detecta configuracao incompleta de publicacao.
 *
 * ⚠️ Esquecer `ATRAS_DE_PROXY=1` atras do tunel e a falha SILENCIOSA pior do
 * modo servidor: o `chaveDoCliente` cai em `req.ip`, que e `127.0.0.1` para o
 * mundo inteiro, e os 30 req/min passam a ser a cota SOMADA dos visitantes.
 * Nada quebra e nada aparece — a unica pista seria o chat ficar "lento para
 * todos" quando uma pessoa usa demais.
 *
 * A chegada de `cf-connecting-ip` prova que existe uma borda Cloudflare na
 * frente, o que torna a ausencia da variavel um erro de configuracao detectavel
 * em runtime. Avisa uma vez por processo para nao inundar o journal.
 */
let avisouProxy = false;
app.use((req, res, next) => {
  if (!avisouProxy && !ATRAS_DE_PROXY && req.headers["cf-connecting-ip"]) {
    avisouProxy = true;
    console.error(
      "[config] ATENCAO: requisicao com CF-Connecting-IP e ATRAS_DE_PROXY desligado. " +
        "O rate limit esta somando TODOS os visitantes numa cota so. Defina ATRAS_DE_PROXY=1."
    );
  }
  next();
});

// Log de requisicoes: mostra o que o navegador realmente pede. Sem isso, "a tela esta
// branca" nao distingue asset com 404 de pagina que nunca foi buscada no servidor.
app.use((req, res, next) => {
  res.on("finish", () => {
    console.log(`[req] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
  });
  next();
});

/* ─────────────────────────────────────────────────────────────
   AUTENTICACAO
   ─────────────────────────────────────────────────────────────
   ⚠️ Entra ANTES do express.static, e a ordem e o ponto: depois do static, o
   `index.html`, o `app.js` e o `style.css` ja teriam sido servidos para quem
   nao fez login. A tela do chat apareceria inteira, e so as chamadas de API
   responderiam 401 — o visitante veria a interface e a lista de conversas
   montando do localStorage dele.

   Em local, sem CIPHER_SENHA_HASH, `auth.criar` devolve null e nada disto entra
   no caminho: o Cipher continua abrindo direto em localhost, como sempre foi.
   Com ATRAS_DE_PROXY=1 e sem hash, ele LANCA e o servico nao sobe. */
const sessao = auth.criar({ atrasDeProxy: ATRAS_DE_PROXY });

if (sessao) {
  /* Limite proprio e MUITO mais apertado que o do chat: esta rota e a unica
     porta da casa e o alvo obvio de forca bruta. 8 tentativas por minuto por
     IP, contra as 30 do chat. O scrypt ja custa ~50 ms por tentativa, entao os
     dois juntos tornam o ataque inviavel sem derrubar quem errou a senha. */
  const loginRateLimiter = criarLimitador(
    { error: "Muitas tentativas. Aguarde um minuto.", code: "RATE_LIMIT_EXCEEDED" },
    { max: 8 }
  );

  app.post("/api/login", loginRateLimiter, (req, res) => {
    /* ⚠️ A trava GLOBAL vem antes de tudo, inclusive antes de olhar o corpo.
       Ela e o que protege um codigo curto: o limite por IP acima nao segura
       quem roda a forca bruta de muitos IPs. Ver o comentario em auth.js. */
    if (sessao.travado()) {
      return res.status(429).json({
        error: `Muitas tentativas erradas. Tente de novo em ${sessao.segundosRestantes()}s.`,
        code: "TRAVADO",
      });
    }

    const { senha } = req.body || {};
    if (typeof senha !== "string" || senha.length === 0 || senha.length > 200) {
      return res.status(400).json({ error: "Senha invalida.", code: "SENHA_INVALIDA" });
    }
    if (!sessao.conferir(senha)) {
      sessao.registrarFalha();
      // Mensagem generica e sem dica: nao confirma nada para quem esta tentando.
      console.warn(`[auth] tentativa de login recusada de ${chaveDoCliente(req)}`);
      return res.status(401).json({ error: "Senha incorreta.", code: "SENHA_INCORRETA" });
    }
    sessao.registrarAcerto();
    sessao.definirCookie(res, sessao.criarToken());
    return res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    sessao.limparCookie(res);
    return res.json({ ok: true });
  });

  app.get("/login", (req, res) => {
    // Quem ja tem sessao nao precisa ver a tela de novo.
    if (sessao.autenticado(req)) return res.redirect(302, "/");
    return res.sendFile(path.join(frontendDir, "login.html"));
  });

  app.use(sessao.middleware);
}

app.use(express.static(frontendDir, { etag: false, lastModified: false }));

/** Valida o corpo do /chat e do /chat/stream. Devolve null se invalido (ja respondeu). */
function validarCorpoDeChat(req, res) {
  const { message, history = [], options = {}, memory = [] } = req.body;

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Mensagem invalida.", code: "INVALID_MESSAGE" });
    return null;
  }

  const trimmedMessage = message.trim();
  if (trimmedMessage.length === 0 || trimmedMessage.length > 8000) {
    res.status(400).json({ error: "Tamanho de mensagem invalido.", code: "BAD_SIZE" });
    return null;
  }

  return {
    trimmedMessage,
    history: Array.isArray(history) ? history : [],
    // A memoria vem do navegador (localStorage) e entra no system prompt.
    // O agent sanitiza tamanho e quantidade.
    options: { ...options, memory: Array.isArray(memory) ? memory : [] },
  };
}

/**
 * Modo documentos: recupera trechos do indice BM25 e anexa ao corpo.
 * Devolve false se ja respondeu erro (indice ausente). Chamar ANTES de
 * virar SSE — o 503 daqui precisa sair como JSON normal.
 */
function prepararModoDocs(corpo, res) {
  if (!corpo.options.docs) return true;

  if (!rag.disponivel()) {
    res.status(503).json({
      error: "Modo documentos sem indice. Rode npm run indexar e tente de novo.",
      code: "RAG_SEM_INDICE",
    });
    return false;
  }

  corpo.trechos = rag.buscar(corpo.trimmedMessage);
  corpo.options.trechos = corpo.trechos;
  return true;
}

/** Nomes unicos das notas usadas, para o front exibir as fontes. */
function fontesDe(trechos) {
  return [...new Set((trechos || []).map((t) => t.arquivo))];
}

// ─────────────────────────────────────────────────────────────
// ACOES DE ARQUIVO: propor no chat, executar so no clique
// ─────────────────────────────────────────────────────────────

/**
 * Propostas pendentes, em memoria. O chat NUNCA executa ferramenta: ele
 * registra a intencao aqui e devolve um id. O /arquivos/executar so aceita id
 * existente.
 *
 * Isso e o que impede a rota de virar uma API de escrita arbitraria aberta na
 * rede local: nao da para pedir "grave neste caminho", so "confirme a proposta
 * X", e o caminho da proposta X foi validado quando ela nasceu.
 */
const propostas = new Map();
const TTL_PROPOSTA_MS = 10 * 60 * 1000;

function limparPropostasVencidas() {
  const agora = Date.now();
  for (const [id, p] of propostas) {
    if (agora - p.criadaEm > TTL_PROPOSTA_MS) propostas.delete(id);
  }
}

/**
 * Converte as tool_calls do modelo em propostas exibiveis. Argumento com JSON
 * quebrado (acontece com modelo pequeno) vira proposta invalida, que o front
 * mostra como erro em vez de sumir sem explicacao.
 */
function registrarPropostas(toolCalls, finishReason) {
  limparPropostasVencidas();
  const saida = [];

  /* ⚠️ Deduplica por ferramenta, mantendo a PRIMEIRA de cada.
     Com `tool_choice: "required"` o 3B chamou 28 ferramentas em serie (medido em
     2026-11-03): gerar, listar, ler, criar, apagar, listar, ler, editar... A
     tela virava uma pilha de 28 cards, e entre eles havia `apagar_arquivo`, que
     e destrutivo. Pior que inutil: perigoso, porque o usuario poderia clicar num
     card de apagar achando que fazia parte da geracao. */
  const jaVistas = new Set();

  for (const tc of toolCalls || []) {
    if (jaVistas.has(tc.nome)) continue;
    jaVistas.add(tc.nome);
    if (!arquivos.existeFerramenta(tc.nome)) continue;

    let args;
    try {
      args = JSON.parse(tc.argumentos || "{}");
    } catch (_) {
      /* ⚠️ A causa quase sempre e TRUNCAMENTO, nao confusao do modelo. Quando o
         arquivo pedido e grande, os argumentos da ferramenta (que carregam o
         conteudo inteiro) estouram o max_tokens e o JSON chega cortado no meio.
         A mensagem antiga dizia so "pedido invalido", o que mandava investigar o
         raciocinio do modelo quando o problema era limite de saida. Medido em
         2026-11-01 gerando um .jrxml: 1024 tokens, 42 s, nada entregue. */
      const truncou = finishReason === "length";
      saida.push({
        id: null,
        ferramenta: tc.nome,
        invalida: true,
        resumo: truncou
          ? `O arquivo ficou grande demais para uma resposta so e foi cortado no meio. Peca em partes menores, ou um bloco por vez.`
          : `O modelo montou um pedido invalido para ${tc.nome}.`,
      });
      continue;
    }

    const id = crypto.randomUUID();
    propostas.set(id, { ferramenta: tc.nome, args, criadaEm: Date.now() });
    saida.push({
      id,
      ferramenta: tc.nome,
      args,
      destrutiva: arquivos.ehDestrutiva(tc.nome),
      geraIndice: arquivos.escreveNoDisco(tc.nome),
      resumo: arquivos.resumirAcao(tc.nome, args),
      // Pre-visualizacao do conteudo, para conferir antes de gravar.
      previa: typeof args.conteudo === "string" ? args.conteudo.slice(0, 2000) : null,
    });
  }
  return saida;
}

api.post("/chat", chatRateLimiter, async (req, res) => {
  const corpo = validarCorpoDeChat(req, res);
  if (!corpo) return;
  if (!prepararModoDocs(corpo, res)) return;

  try {
    const response = await agent.processMessage(corpo.trimmedMessage, corpo.history, corpo.options);
    return res.json({
      text: response.text,
      provider: response.provider,
      model: response.model,
      latencyMs: response.latencyMs,
      usage: response.usage || null,
      fontes: fontesDe(corpo.trechos),
      acoes: registrarPropostas(response.toolCalls, response.finishReason),
      timestamp: response.timestamp,
    });
  } catch (err) {
    console.error("[/api/chat] Erro:", err.message, err.details || "");
    if (err.name === "AgentError") {
      return res.status(503).json({ error: err.message, code: "AGENT_UNAVAILABLE" });
    }
    return res.status(500).json({ error: "Erro interno no Cipher.", code: "INTERNAL_ERROR" });
  }
});

/**
 * Chat em streaming (SSE). Eventos:
 *   inicio → { provider, usedFallback }        provedor que comecou a responder
 *   (sem nome) → { delta }                     trecho de texto
 *   fim   → { provider, model, latencyMs... }  resposta completa
 *   erro  → { error, code, parcial }           falha (parcial=true se ja havia texto)
 */
api.post("/chat/stream", chatRateLimiter, async (req, res) => {
  const corpo = validarCorpoDeChat(req, res);
  if (!corpo) return;
  if (!prepararModoDocs(corpo, res)) return;

  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const enviar = (evento, dados) => {
    if (res.writableEnded) return;
    if (evento) res.write(`event: ${evento}\n`);
    res.write(`data: ${JSON.stringify(dados)}\n\n`);
  };

  // Se o navegador fechar a aba no meio, aborta a inferencia: sem isso o
  // llama-server continua gerando tokens para ninguem.
  const aborto = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) aborto.abort();
  });

  try {
    const response = await agent.processMessageStream(
      corpo.trimmedMessage,
      corpo.history,
      { ...corpo.options, signal: aborto.signal },
      {
        onStart: (info) => enviar("inicio", info),
        onDelta: (delta) => enviar(null, { delta }),
      }
    );

    enviar("fim", {
      provider: response.provider,
      model: response.model,
      latencyMs: response.latencyMs,
      usage: response.usage || null,
      fontes: fontesDe(corpo.trechos),
      acoes: registrarPropostas(response.toolCalls, response.finishReason),
      timestamp: response.timestamp,
    });
  } catch (err) {
    console.error("[/api/chat/stream] Erro:", err.message, err.details || "");
    enviar("erro", {
      error: err.name === "AgentError" ? err.message : "Erro interno no Cipher.",
      code: err.name === "AgentError" ? "AGENT_UNAVAILABLE" : "INTERNAL_ERROR",
      parcial: err.details?.parcial === true,
    });
  } finally {
    res.end();
  }
});

// Limiter proprio: cada mensagem enviada dispara tambem uma extracao, e usar o
// mesmo limiter do chat cortaria o teto efetivo de mensagens pela metade.
const memoriaRateLimiter = criarLimitador({
  error: "Muitas requisicoes.",
  code: "RATE_LIMIT_EXCEEDED",
});

/** Extrai fatos duraveis da mensagem. Melhor esforco: falha vira lista vazia. */
api.post("/memoria/extrair", memoriaRateLimiter, async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string" || message.trim().length === 0 || message.length > 8000) {
    return res.status(400).json({ error: "Mensagem invalida.", code: "INVALID_MESSAGE", fatos: [] });
  }

  try {
    const fatos = await agent.extrairFatos(message.trim());
    return res.json({ fatos });
  } catch (err) {
    console.error("[/api/memoria/extrair] Erro:", err.message);
    return res.json({ fatos: [] });
  }
});

/**
 * Executa uma proposta ja registrada. E o unico ponto do sistema que escreve
 * em disco a pedido do modelo, e so roda depois do clique do usuario.
 * A proposta e consumida: um clique, uma execucao.
 */
api.post("/arquivos/executar", chatRateLimiter, async (req, res) => {
  const { id } = req.body || {};
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Acao invalida.", code: "ACAO_INVALIDA" });
  }

  limparPropostasVencidas();
  const proposta = propostas.get(id);
  if (!proposta) {
    return res.status(404).json({
      error: "Essa acao expirou ou ja foi executada. Peca de novo ao Cipher.",
      code: "ACAO_NAO_ENCONTRADA",
    });
  }
  propostas.delete(id);

  try {
    const resultado = await arquivos.executarFerramenta(proposta.ferramenta, proposta.args);
    console.log(`[arquivos] ${proposta.ferramenta} executado:`, resultado.caminho ?? "");
    return res.json({ ok: true, ferramenta: proposta.ferramenta, resultado });
  } catch (err) {
    console.error(`[arquivos] ${proposta.ferramenta} falhou:`, err.message);
    const conhecido = err.name === "ErroArquivo";
    return res.status(conhecido ? 400 : 500).json({
      ok: false,
      error: conhecido ? err.message : "Nao consegui concluir a acao.",
      code: conhecido ? err.codigo : "ERRO_INTERNO",
    });
  }
});


/**
 * Upload de arquivo para a sandbox.
 *
 * ⚠️ Esta e a SEGUNDA rota que escreve em disco, e a excecao a regra de que
 * nada e gravado sem clique. A regra continua valida: aqui o clique e o proprio
 * upload. Quem escolhe o arquivo e o nome e o usuario, nao o modelo. O modelo
 * nao tem como chamar esta rota.
 *
 * Recebe o conteudo como TEXTO em JSON, nao multipart. Multipart exigiria
 * `multer`, uma sexta dependencia, para um caso em que todo arquivo aceito ja e
 * texto (a whitelist da sandbox nao tem binario). O front le com FileReader.
 *
 * Toda a validacao e a mesma do modelo: `criarArquivo` confere caminho,
 * extensao, tamanho e, em .jrxml, a estrutura. Upload nao e caminho privilegiado.
 */
api.post("/arquivos/upload", chatRateLimiter, async (req, res) => {
  const { nome, conteudo, sobrescrever } = req.body || {};

  if (typeof nome !== "string" || !nome.trim()) {
    return res.status(400).json({ error: "Nome de arquivo invalido.", code: "NOME_INVALIDO" });
  }
  if (typeof conteudo !== "string") {
    return res.status(400).json({ error: "Conteudo invalido.", code: "CONTEUDO_INVALIDO" });
  }

  try {
    /* ⚠️ `sobrescrever` pedido num arquivo que nao existe cai em criar, nao em
       erro. O usuario que confirmou "substituir" nao tem como saber que o
       arquivo foi apagado entre a primeira tentativa e a confirmacao, e
       "Esse arquivo nao existe. Use criar_arquivo" e uma mensagem interna
       vazando para a tela. */
    const existe = await arquivos.existeCaminho(nome.trim()).catch(() => false);
    const ferramenta = sobrescrever === true && existe ? "editar_arquivo" : "criar_arquivo";
    /* ⚠️ `padraoA2O: false`: o arquivo que sobe e justamente o que esta FORA do
       padrao, e e o que vai ser migrado. Exigir o padrao aqui recusava 81% dos
       .jrxml reais da empresa e bloqueava o fluxo inteiro. A estrutura (XML bem
       formado) continua obrigatoria. */
    const resultado = await arquivos.executarFerramenta(ferramenta, {
      caminho: nome.trim(),
      conteudo,
      padraoA2O: false,
    });
    console.log(`[upload] ${resultado.caminho} (${resultado.bytes ?? "?"} bytes)`);
    return res.json({ ok: true, ...resultado });
  } catch (err) {
    const conhecido = err.name === "ErroArquivo";
    if (!conhecido) console.error("[upload] falhou:", err.message);
    return res.status(conhecido ? 400 : 500).json({
      ok: false,
      error: conhecido ? err.message : "Nao consegui gravar o arquivo.",
      code: conhecido ? err.codigo : "ERRO_INTERNO",
    });
  }
});


/**
 * Baixar um arquivo da sandbox.
 *
 * ⚠️ `resolverSeguro` do arquivos.js e quem autoriza o caminho, e nao um
 * `path.join` daqui. Sem isso, `?caminho=../../etc/passwd` sairia da sandbox:
 * e a mesma validacao de escape, symlink e raiz unica que o modelo enfrenta.
 *
 * GET e nao POST porque o navegador precisa navegar ate a URL para disparar o
 * download. A rota exige sessao como todas as outras (ver auth.middleware).
 */
api.get("/arquivos/baixar", async (req, res) => {
  const caminho = String(req.query.caminho || "").trim();
  if (!caminho) return res.status(400).json({ error: "Informe o caminho.", code: "SEM_CAMINHO" });

  try {
    const alvo = arquivos.resolverSeguro(caminho);
    const nome = path.basename(alvo);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(nome)}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    return res.sendFile(alvo, (erro) => {
      if (erro && !res.headersSent) res.status(404).json({ error: "Arquivo nao encontrado.", code: "NAO_ENCONTRADO" });
    });
  } catch (err) {
    const conhecido = err.name === "ErroArquivo";
    return res.status(conhecido ? 400 : 500).json({
      error: conhecido ? err.message : "Nao consegui ler o arquivo.",
      code: conhecido ? err.codigo : "ERRO_INTERNO",
    });
  }
});

/** Cancela uma proposta sem executar. Libera a memoria na hora do "Cancelar". */
api.post("/arquivos/cancelar", (req, res) => {
  const { id } = req.body || {};
  if (id && typeof id === "string") propostas.delete(id);
  return res.json({ ok: true });
});

api.get("/health", async (req, res) => {
  try {
    const status = await agent.checkProvidersHealth();
    return res.json({
      status: status.anyAvailable ? "healthy" : "degraded",
      local: status.local,
      localModel: status.localModel,
      contextoMax: status.modelo?.contextoMax ?? null,
      modelo: status.modelo || {},
      activeProvider: status.local ? "local" : null,
      docs: rag.info(),
      perfil: perfil.info(),
      arquivos: { raiz: arquivos.RAIZ },
      /* Qual dos endpoints respondeu. Sem isto nao ha como saber, olhando a
         tela, que a resposta veio do modelo pequeno do servidor em vez do 3B do
         Mac: a diferenca de qualidade apareceria sem explicacao. */
      endpoint: localProvider.apelidoDe(localProvider.enderecoAtual()),
      endpoints: localProvider.ENDPOINTS.map(localProvider.apelidoDe),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(503).json({ status: "error", local: false });
  }
});

api.get("/info", (req, res) => {
  res.json({
    name: "Cipher Chat API",
    version: "2.2.0",
    providers: ["local"],
    local: {
      baseUrl: localProvider.BASE_URL,
    },
  });
});

app.use("/api", api);
app.use("/", api);

app.get("*", (req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

if (require.main === module) {
  arquivos.garantirRaiz();
  // Em local fica sem HOST e o Express escuta em todas as interfaces, como
  // sempre foi (da para abrir pelo celular na rede de casa). No Sentinel o
  // /etc/cipher.env crava 127.0.0.1: quem expoe para fora e o Cloudflare
  // Tunnel, e porta em interface externa seria um caminho paralelo sem TLS e
  // sem o Cloudflare Access na frente. O deploy prova esse bind.
  // `undefined` como host e identico a omitir o argumento (medido no Node
  // 20.20.2: os dois bindam em `::`).
  const HOST = getEnvString("HOST", "");
  app.listen(PORT, HOST || undefined, () => {
    console.log(`Cipher iniciado em http://${HOST || "localhost"}:${PORT}`);
    console.log(`Frontend servido de: ${frontendDir}`);
    console.log(`Arquivos do Cipher em: ${arquivos.RAIZ}`);
    if (ATRAS_DE_PROXY) console.log("Modo atras de proxy: HSTS/CSP de HTTPS ligados, rate limit por CF-Connecting-IP");
  });
}

module.exports = app;
