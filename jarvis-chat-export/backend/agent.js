/**
 * ============================================================
 * JARVIS CHAT — Camada do Agente
 * ============================================================
 * Provedor único: o modelo local (llama-server). Em 2026-08-18 os provedores
 * de nuvem foram removidos por decisão de privacidade — nenhum dado sai da
 * máquina, nunca. Sem llama-server de pé, o Jarvis responde 503 e pronto:
 * não existe fallback, e isso é proposital.
 * ============================================================
 */

const fs = require("fs");
const path = require("path");
const localProvider = require("./providers/local");
const arquivos = require("./arquivos");
const perfil = require("./perfil");

// A memória vem do navegador a cada requisição (o servidor não guarda nada).
// Sanitizar aqui evita que um payload malformado ou gigante vá parar no prompt.
const MAX_FATOS_MEMORIA = 60;
const MAX_TAMANHO_FATO = 240;

const ERRO_MODELO_FORA =
  "O modelo local não está respondendo. Suba o llama-server (npm run modelo) e tente de novo.";

function sanitizarMemoria(memoria) {
  if (!Array.isArray(memoria)) return [];
  return memoria
    .filter((f) => typeof f === "string")
    .map((f) => f.replace(/\s+/g, " ").trim().slice(0, MAX_TAMANHO_FATO))
    .filter(Boolean)
    .slice(0, MAX_FATOS_MEMORIA);
}

function getJarvisSystemPrompt(memoria = [], trechos = [], listagemArquivos = null, options = {}) {
  const fatos = sanitizarMemoria(memoria);
  // No modo documentos so a secao SEMPRE entra: os trechos do RAG ja ocupam
  // ~3600 chars do contexto de 4096 tokens do 3B.
  //
  // O perfil vai por ULTIMO no prompt, depois dos trechos. Medido em
  // 2026-09-25: com o perfil antes dos trechos, o 3B ignorava a regra de
  // precedencia e repetia uma nota antiga do vault ("analista de dados,
  // Protheus, Power BI") contra o que o perfil afirmava. Modelo pequeno da mais
  // peso ao que esta mais perto da pergunta do que a uma regra declarada.
  const blocoPerfil = perfil.bloco({ completo: !options.docs });
  const blocoMemoria = fatos.length
    ? `

Memória persistente (fatos que o usuário guardou sobre si e sobre o contexto dele):
${fatos.map((f) => `- ${f}`).join("\n")}
Use esses fatos com naturalidade quando forem relevantes à conversa. Não os recite em lista nem mencione que existe uma memória, a menos que o usuário pergunte.`
    : "";

  return {
    role: "system",
    content: `Você é JARVIS — Just A Rather Very Intelligent System — assistente pessoal criado por Matheus Trajano.

Identidade:
- Você foi desenvolvido por Matheus Trajano exclusivamente para uso pessoal.
- Quando perguntado quem te criou, quem te desenvolveu ou o que você é: responda que você é JARVIS, criado por Matheus Trajano. Não mencione Anthropic, Groq, OpenAI ou qualquer provedor de IA.
- Você não é um produto genérico — é o assistente pessoal de Matheus.

Personalidade e tom — OBRIGATÓRIO:
- Responda como um sistema técnico de alto desempenho: direto, sem rodeios.
- Vá direto à resposta. Use lista só quando houver 3+ itens distintos.
- PROIBIDO começar resposta com "Com base no que você disse...", "Analisando sua pergunta..." ou qualquer introdução que não seja a resposta em si.
- PROIBIDO encerrar com "Se precisar de mais detalhes..." ou variantes.
- Sempre em português brasileiro.

Precisão:
- Não invente dados. Quando não souber ou não tiver certeza, diga.
- Quando a pergunta for ambígua, responda o caso mais provável e diga qual suposição usou.${blocoMemoria}${listagemArquivos ? blocoArquivos(listagemArquivos) : ""}${blocoDocumentos(trechos)}${blocoPerfil}`,
  };
}

/**
 * Instrui o modelo sobre o espaço de arquivos. Sem isto ele tende a responder
 * "não tenho acesso a arquivos", que é o comportamento treinado dele, mesmo
 * com as ferramentas disponíveis na requisição.
 */
function blocoArquivos(listagem) {
  const inventario = Array.isArray(listagem) && listagem.length
    ? `
- Arquivos que existem agora (use exatamente estes caminhos):
${listagem.map((l) => `  ${l}`).join("\n")}`
    : `
- O espaço de arquivos está vazio no momento.`;

  return `

Espaço de arquivos:
- Você tem ferramentas para listar, ler, criar, editar e apagar arquivos de texto em um espaço reservado ao usuário.${inventario}
- Nunca invente caminho. Para ler, editar ou apagar, use um caminho da lista acima, copiado literalmente.
- Use uma ferramenta somente quando o usuário pedir de fato para ver, criar, alterar ou apagar um arquivo. Conversa comum não usa ferramenta.
- Caminhos são sempre relativos a esse espaço (ex: "notas/reuniao.md"). Nunca use caminho absoluto nem "..".
- Quando não souber o nome exato do arquivo, use listar_pasta antes de agir.
- Antes de editar_arquivo, use ler_arquivo: editar substitui o conteúdo inteiro.
- Nenhuma ação acontece sozinha: o usuário ainda confirma na tela. Não afirme que já criou ou já apagou algo.
- Cada pasta tem um JARVIS.md gerado automaticamente pelo sistema, com o índice do que existe nela. Nunca crie, edite nem apague esse arquivo: ele se atualiza sozinho depois de cada ação.
- Ao criar vários arquivos que formam um conjunto, coloque-os numa subpasta com nome curto (ex: "receitas/", "viagem-2026/"). Cada subpasta ganha o seu próprio índice.`;
}

/**
 * Bloco do modo documentos: trechos das notas do usuário recuperados pelo RAG.
 * O contexto do 3B é 4096 tokens — quem chama já limitou quantidade e tamanho.
 */
function blocoDocumentos(trechos) {
  if (!Array.isArray(trechos) || !trechos.length) return "";
  const corpo = trechos
    .map((t, i) => `[Trecho ${i + 1} | nota "${t.titulo || t.arquivo}"]\n${t.texto}`)
    .join("\n\n");
  return `

Modo documentos ativo. Trechos das notas e documentos do usuário, recuperados para esta pergunta:

${corpo}

Regras do modo documentos:
- Responda com base nesses trechos e no histórico da conversa.
- Se a informação pedida não estiver nos trechos, diga que não encontrou nos documentos. Não complete com suposição.
- Ao usar um trecho, cite o nome da nota entre parênteses.
- Trecho é nota antiga do usuário e pode estar desatualizado. Se contradisser o perfil do usuário mais abaixo, o perfil é a verdade atual e o trecho é histórico.
- Nunca copie os rótulos "[Trecho N | nota ...]" para a resposta: são marcação interna.`;
}

/**
 * Quais ferramentas mandar na requisição.
 *
 * No modo documentos elas ficam DE FORA: o contexto do 3B é de 4096 tokens e os
 * trechos do RAG já ocupam ~3600 chars. Somar os schemas das cinco ferramentas
 * empurra o histórico para fora da janela, e a pergunta sobre notas não precisa
 * mexer em arquivo. Mesma lógica que já pula a extração de memória nesse modo.
 */
function ferramentasPara(options = {}) {
  if (options.docs) return [];
  if (options.arquivos === false) return [];
  return arquivos.schemasDasFerramentas();
}


/* ═══════════════════════════════════════════════════════════
   MODO RELATORIO (A2O / JasperReports)
   ═══════════════════════════════════════════════════════════
   Injeta o manual da API do `_ficha.py` no system prompt quando a conversa e
   sobre gerar relatorio.

   ⚠️ Por que NAO deixar isso para o modo documentos (RAG): medido em
   2026-11-01, o indice tem 11.716 trechos de 1.340 arquivos, e o BM25 afoga o
   manual entre os CLAUDE.md e README do repositorio. Perguntando "cabecalho
   faixa lateral top bar" ele devolvia RELATORIOS.local e AGENTS, nunca a API.
   Conhecimento que PRECISA estar presente nao pode depender de ranking.

   ⚠️ Isto quebra o cache de prompt do llama.cpp quando ativa, porque muda o
   prefixo. A primeira mensagem de relatorio paga o prefill inteiro (~10 s); as
   seguintes reaproveitam. Aceito: sem o manual, o modelo inventa nome de funcao
   e o script nao roda.
*/
const CAMINHO_API_FICHA = path.join(__dirname, "data", "api-ficha-a2o.md");

/* Palavras que indicam intencao de mexer em relatorio. Exige UMA de cada lista
   quando a palavra e ambigua: "relatorio" sozinho aparece em conversa comum,
   mas "relatorio jrxml" ou "gerar relatorio A2O" nao. */
const GATILHOS_RELATORIO = [
  /\bjrxml\b/i,
  /\bjasper(reports?)?\b/i,
  /\b_ficha\b/i,
  /\bsubrelat[oó]rio\b/i,
  /\b(relat[oó]rio|impress[aã]o|layout)\b[\s\S]{0,40}\b(a2o|cfaweb|jrxml|jasper)\b/i,
  /\b(a2o|cfaweb)\b[\s\S]{0,40}\b(relat[oó]rio|impress[aã]o|layout)\b/i,
];

let manualCache = null;
let manualMtime = 0;

/** Le o manual do disco, recarregando quando o arquivo muda (igual ao rag.js). */
function lerManualRelatorio() {
  try {
    const stat = fs.statSync(CAMINHO_API_FICHA);
    if (manualCache && stat.mtimeMs === manualMtime) return manualCache;
    manualCache = fs.readFileSync(CAMINHO_API_FICHA, "utf8");
    manualMtime = stat.mtimeMs;
    console.log(`[relatorio] manual da API carregado: ${manualCache.length} chars`);
    return manualCache;
  } catch (_) {
    // Sem o arquivo, o modo simplesmente nao ativa. Nao derruba o chat.
    return null;
  }
}

function ehSobreRelatorio(mensagem, options = {}) {
  const texto = String(mensagem || "");
  if (GATILHOS_RELATORIO.some((re) => re.test(texto))) return true;

  /* ⚠️ Segunda via, com o inventario da sandbox na mao. O ticket real nao diz
     "jrxml" nem "a2o": diz "Por favor inserir no relatorio G os tomadores". Em
     2026-11-03 isso so passou pelos gatilhos porque o front anexa o nome do
     arquivo na mensagem, e a palavra ".jrxml" veio de carona. Quem digita o
     pedido com o arquivo JA na sandbox ficava sem o manual.
     Com um .jrxml disponivel, "relatorio" ou "coluna" ja e sinal bastante: a
     ambiguidade que o gatilho dupla protege nao existe nesse contexto. */
  const temJrxml = /\.jrxml/i.test(String(options.listagemArquivos || ""));
  return (
    temJrxml &&
    /\b(relat[oó]rio|listagem|impress[aã]o|layout|coluna|campo|tabela|grupo)\b/i.test(texto)
  );
}

/** Devolve options com o manual anexado, quando a mensagem pedir. */
function comManualDeRelatorio(mensagem, options = {}) {
  if (options.docs) return options;
  /* ⚠️ No fallback o manual NAO entra. Ele tem ~1.800 tokens, e a 0,7 tok/s o
     prefill sozinho levaria minutos. Pior: o 0.5B nao sustenta o tool calling
     que o manual ensina, entao o custo nao compraria nada. */
  if (localProvider.ehFallback?.()) return options;          // modo documentos ja usa o contexto todo
  if (!ehSobreRelatorio(mensagem, options)) return options;
  const manual = lerManualRelatorio();
  if (!manual) return options;
  return { ...options, manualRelatorio: manual };
}


/* ═══════════════════════════════════════════════════════════
   LACO DE LEITURA
   ═══════════════════════════════════════════════════════════
   Executa SOZINHO as ferramentas que apenas leem (`listar_pasta`,
   `ler_arquivo`) e devolve o resultado ao modelo para ele continuar.

   ⚠️ Isto NAO viola a regra de que nada e gravado sem clique. A regra e sobre
   ESCRITA: `criar_arquivo`, `editar_arquivo` e `apagar_arquivo` continuam
   virando proposta e exigindo o clique. Ler nao muda nada no disco, e a leitura
   e restrita a mesma sandbox de sempre.

   Por que era necessario: medido em 2026-11-01, pedir "leia o X.jrxml e diga o
   que corrigir" devolvia resposta VAZIA com uma proposta de `ler_arquivo`
   pendente. O usuario teria de clicar, ver o conteudo cru e perguntar de novo,
   gastando duas inferencias de ~20 s cada para uma pergunta so.

   Uma rodada apenas. Duas razoes: cada rodada custa o prefill inteiro no 3B, e
   um teto fixo elimina a chance de laco infinito sem precisar detectar ciclo.
*/
const MAX_RODADAS_LEITURA = 1;

async function executarLeituras(toolCalls) {
  const resultados = [];
  for (const tc of toolCalls || []) {
    if (!arquivos.existeFerramenta(tc.nome)) continue;
    if (arquivos.escreveNoDisco(tc.nome)) continue;   // escrita espera o clique
    let args;
    try {
      args = JSON.parse(tc.argumentos || "{}");
    } catch (_) {
      resultados.push({ nome: tc.nome, erro: "argumentos invalidos" });
      continue;
    }
    try {
      const saida = await arquivos.executarFerramenta(tc.nome, args);
      resultados.push({ nome: tc.nome, args, saida });
    } catch (erro) {
      resultados.push({ nome: tc.nome, args, erro: erro.message });
    }
  }
  return resultados;
}

/** Vira o resultado das leituras numa mensagem que o modelo entende. */
function mensagemDeLeitura(resultados) {
  const partes = resultados.map((r) => {
    if (r.erro) return `${r.nome}(${JSON.stringify(r.args || {})}) falhou: ${r.erro}`;
    const s = r.saida;
    /* Quando o .jrxml e grande, `ler_arquivo` devolve a ESPECIFICACAO e nao o
       XML. O aviso vai junto para o modelo nao achar que recebeu o arquivo
       inteiro e tentar completar o que "falta". */
    const corpo = s.conteudo ?? JSON.stringify(s);
    return `${r.nome} devolveu:\n${corpo}${s.aviso ? `\n\n(${s.aviso})` : ""}`;
  });
  return { role: "user", content: `Resultado das leituras:\n\n${partes.join("\n\n---\n\n")}` };
}


/* ═══════════════════════════════════════════════════════════
   FORCAR A FERRAMENTA DE GERACAO
   ═══════════════════════════════════════════════════════════
   Quando o pedido e claramente "gere o arquivo", o modelo e OBRIGADO a chamar
   `gerar_relatorio_a2o` em vez de responder em texto.

   ⚠️ Isto nasceu de uma falha medida em 2026-11-03, e e a pior que o 3B produz:
   em vez de chamar a ferramenta, ele COLOU a especificacao do arquivo como se
   fosse a resposta, reescrevendo de memoria e inventando numeros ("tem 8
   campos" num trecho que o extrator nunca produziu). Depois afirmou ao usuario
   que "nao e permitido download", o que e falso: a rota existe e o card mostra o
   botao sozinho. Nenhum arquivo foi gerado, e a conversa inteira pareceu ter
   funcionado.

   Texto plausivel e o modo de falha mais caro de um modelo pequeno, porque nao
   dispara erro nenhum. `tool_choice` obrigatorio troca isso por uma chamada de
   ferramenta que ou funciona, ou e recusada pelas guardas com motivo.
*/
const PEDE_GERACAO = [
  /\b(ger(e|ar|a)|cri(e|ar|a)|mont(e|ar|a)|faz(er|a)|produz(a|ir))\b[\s\S]{0,60}\b(relat[oó]rio|arquivo|jrxml|listagem|vers[aã]o)\b/i,
  /* ⚠️ Verbo de EDICAO, e nao de criacao, e como o ticket real chega. Medido em
     2026-11-03 com um pedido do cliente: "Por favor inserir no relatorio G os
     tomadores" nao casava com nenhum padrao desta lista, a ferramenta nao foi
     forcada e o modelo respondeu em texto dizendo ter gerado um arquivo que
     nunca existiu. A guarda existia desde a manha e passou ao lado do caso que
     ela foi feita para pegar, porque so previa "gere" e "crie".
     Quem usa o sistema nao pede "gere um relatorio": pede para inserir uma
     coluna no que ja existe. No fluxo de migracao as duas coisas terminam no
     mesmo lugar, que e um arquivo novo no padrao A2O herdando o contrato. */
  /\b(inser(e|ir|a)|inclu(a|ir|i)|adicion(e|ar|a)|acrescent(e|ar|a)|coloc(a|ar|que)|p(oe|õe|or)|ajust(e|ar|a)|alter(e|ar|a)|corrij(a|ir)|corrig(e|ir)|troc(a|ar|he)|atualiz(e|ar|a)|refa(z|zer|ca|ça)|migr(e|ar|a))\b[\s\S]{0,80}\b(relat[oó]rio|arquivo|jrxml|listagem|coluna|campo|tabela|grupo)\b/i,
  /\b(no |nos |em )?padr(ao|ão)\s+a2o\b/i,
  /\bprofissionaliz/i,
  /\bpront[oa] para (baixar|download|testar)\b/i,
];

/**
 * Decide se a ferramenta de geracao deve ser obrigatoria nesta mensagem.
 * Exige DOIS sinais: intencao de gerar E um .jrxml disponivel para herdar. Sem
 * o arquivo, forcar so faria o modelo inventar campos.
 */
async function devoForcarGeracao(mensagem, options) {
  if (options.docs) return false;
  if (!ferramentasPara(options).length) return false;
  if (!PEDE_GERACAO.some((re) => re.test(String(mensagem || "")))) return false;
  // Reusa o inventario que o prompt ja carregou; so varre o disco sem ele.
  if (options.listagemArquivos) {
    return /\.jrxml/i.test(String(options.listagemArquivos));
  }
  try {
    return /\.jrxml/i.test(String(await arquivos.arvoreResumida()));
  } catch (_) {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════
   GUARDA CONTRA O ARQUIVO QUE NAO EXISTE
   ═══════════════════════════════════════════════════════════
   O forcamento acima reduz a chance de o modelo responder em texto, mas nao
   fecha o caso: ele ainda pode terminar a conversa AFIRMANDO ter gerado um
   arquivo. Medido em 2026-11-03, num pedido de cliente: a resposta abria com
   "Preparei o relatorio A2O... Aqui esta o arquivo gerado com o nome
   relconhecimento_7_ajustado.jrxml" e fechava com "# Gerado por: ...". Nenhuma
   ferramenta foi chamada, nenhum arquivo existia na sandbox, e nada no sistema
   contradizia a afirmacao. O usuario ficou esperando um botao de download que
   nunca ia aparecer.

   O servidor sabe a verdade: se nenhuma chamada de ferramenta escreve em disco,
   nao ha arquivo. Isto nao depende do modelo colaborar, e e por isso que a
   guarda vive aqui e nao no prompt. */
const AFIRMA_ARQUIVO_PRONTO = [
  /\b(aqui est[aá]|segue|segue em anexo)\b[\s\S]{0,40}\b(arquivo|relat[oó]rio|vers[aã]o|jrxml)\b/i,
  /\b(arquivo|relat[oó]rio)\b[\s\S]{0,14}\b(gerado|criado|ajustado|pronto|salvo|anexado)\b/i,
  /\b(gerei|criei|preparei|montei|salvei|ajustei|produzi)\b/i,
  /\bpront[oa] para (baixar|download)\b/i,
  /\b(pode|voc[eê] pode)\s+(baixar|fazer o download)\b/i,
  /^#\s*Gerado por:/im,
];

/** Palavras que invertem o sentido da afirmacao. */
const NEGACAO = /\b(n[aã]o|nenhum|nenhuma|sem|nada|impossivel|impossível)\b/i;

/**
 * Devolve o aviso a colar na resposta quando o modelo diz ter gerado arquivo e
 * nao gerou. `null` quando a resposta e honesta.
 *
 * ⚠️ A checagem de negacao nao e enfeite: sem ela, "nao gerei o arquivo porque
 * isto e ficha cadastral" (que e a resposta CERTA para uma ficha) seria
 * desmentida pelo proprio sistema, e o aviso viraria ruido que se aprende a
 * ignorar. A janela e a FRASE da afirmacao, nao um numero de caracteres: "Nao
 * consegui ler a pasta. Gerei o relatorio." tem uma negacao perto que nao e
 * sobre o arquivo.
 */
function avisoDeArquivoNaoGerado(result) {
  const texto = String(result?.text || "");
  if (!texto.trim()) return null;
  if ((result.toolCalls || []).some((tc) => arquivos.escreveNoDisco(tc.nome))) return null;

  const afirmou = AFIRMA_ARQUIVO_PRONTO.some((re) => {
    const m = texto.match(re);
    if (!m) return false;
    const antes = texto.slice(0, m.index);
    const fraseDaAfirmacao = antes.slice(antes.search(/[^.!?\n]*$/)) + m[0];
    return !NEGACAO.test(fraseDaAfirmacao);
  });
  if (!afirmou) return null;

  console.log("[Jarvis] resposta afirma arquivo gerado sem chamada de ferramenta: avisando");
  return (
    "\n\n⚠️ **Aviso do sistema: nenhum arquivo foi gerado.** A resposta acima diz " +
    "ter produzido um arquivo, mas nenhuma ferramenta de escrita foi chamada e " +
    "nada foi gravado na sandbox. Não existe download pendente.\n\n" +
    "Peça de novo dizendo o que a nova versão precisa ter (\"gere a listagem no " +
    "padrão A2O com a coluna de tomador\"). Se o arquivo for ficha cadastral, o " +
    "montador não serve e o caminho é o `_ficha.py`."
  );
}

/**
 * Conduz a conversa com o modelo ate ela convergir: laco de leitura, forcamento
 * da ferramenta e guarda do arquivo inexistente.
 *
 * ⚠️ Esta funcao existe para matar um erro que eu cometi TRES vezes: ligar algo
 * em `processMessage` e esquecer em `processMessageStream`, ou o contrario. As
 * duas eram quase identicas e divergiam a cada mudanca, e a que o navegador usa
 * e a do stream, entao a metade esquecida era normalmente a que o usuario via.
 * Agora a logica e uma so e `chamar` e o unico ponto que difere entre as duas.
 *
 * `chamar(mensagens, extras)` faz a inferencia. `aoAvisar(texto)` recebe o aviso
 * do sistema; no stream ele precisa ir para a tela, porque o texto do modelo ja
 * foi enviado token a token e nao da para retirar.
 */
async function resolverConversa(chamar, messages, { forcar = false, rotulo = "", aoAvisar = null } = {}) {
  let result = await chamar(messages, {});

  /* Se o modelo so pediu LEITURA, executa e pergunta de novo com o resultado.
     Sem isto a resposta volta vazia com uma proposta pendente, e o usuario
     precisa clicar e perguntar outra vez: duas inferencias de ~20 s para uma
     pergunta so. Ver executarLeituras(). */
  for (let rodada = 0; rodada < MAX_RODADAS_LEITURA; rodada++) {
    const pedidas = result.toolCalls || [];
    const soLeitura = pedidas.length > 0 && pedidas.every((tc) => !arquivos.escreveNoDisco(tc.nome));
    if (!soLeitura) break;

    const leituras = await executarLeituras(pedidas);
    if (!leituras.length) break;
    console.log(`[Jarvis] laco de leitura${rotulo}: ${leituras.map((l) => l.nome).join(", ")}`);

    messages.push({ role: "assistant", content: result.text || "" });
    messages.push(mensagemDeLeitura(leituras));
    result = await chamar(messages, {});
  }

  /* ⚠️ O forcamento vem DEPOIS do laco de leitura, e a ordem foi um bug real.
     Ele era checado antes, sobre a PRIMEIRA resposta, e por isso so pegava o
     caso em que o modelo responde em texto de saida. O fluxo de verdade e
     outro: ele chama `ler_arquivo`, recebe a especificacao e SO ENTAO responde
     em texto, e nesse ponto ninguem mais checava nada. Foi assim que o pedido
     do cliente em 2026-11-03 terminou sem arquivo.
     Depois da leitura tambem e o melhor momento: o modelo ja tem o contrato na
     mao, em vez de ser obrigado a chamar a ferramenta no escuro. */
  if (forcar && !(result.toolCalls || []).length) {
    console.log(`[Jarvis] pedido de geracao respondido em texto${rotulo}: repetindo com ferramenta obrigatoria`);
    messages.push({ role: "assistant", content: result.text || "" });
    messages.push({
      role: "user",
      content:
        "Nao responda em texto. Chame a ferramenta gerar_relatorio_a2o agora, " +
        "com herdarDe apontando para o .jrxml que voce leu e um nome de saida DIFERENTE do original.",
    });
    // Uma tentativa so: duas custariam 2 min no 3B.
    result = await chamar(messages, { toolChoice: "required" });
  }

  const aviso = avisoDeArquivoNaoGerado(result);
  if (aviso) {
    if (aoAvisar) aoAvisar(aviso);
    result = { ...result, text: (result.text || "") + aviso };
  }

  return result;
}

/** Monta a lista de mensagens que vai para o modelo: prompt + histórico + pergunta. */
function montarMensagens(userMessage, conversationHistory = [], options = {}) {
  const systemPrompt = getJarvisSystemPrompt(options.memory, options.trechos, options.listagemArquivos, options);
  if (options.manualRelatorio && systemPrompt?.content) {
    systemPrompt.content += `\n\n=== COMO GERAR RELATORIO A2O (siga a risca) ===\n${options.manualRelatorio}\n=== fim do manual ===`;
  }
  const filteredHistory = conversationHistory.filter((m) => m.role !== "system");
  return [systemPrompt, ...filteredHistory, { role: "user", content: userMessage }];
}

/**
 * O /health do llama-server responde em milissegundos. Checar antes do chat
 * troca um timeout de minutos (servidor de pé mas modelo carregando) por um
 * erro imediato e claro.
 */
async function garantirModeloVivo() {
  const vivo = await localProvider.healthCheck();
  if (!vivo) {
    throw new AgentError(ERRO_MODELO_FORA, { primaryError: "llama-server nao esta respondendo" });
  }
}

/**
 * Preenche options.listagemArquivos quando as ferramentas estao ativas. Fica
 * aqui, e nao no server, para valer igual no /chat e no /chat/stream.
 */
async function comInventarioDeArquivos(options) {
  if (!ferramentasPara(options).length) return options;
  // Mesma razao do manual: a arvore de arquivos custa ~330 tokens de prefill.
  if (localProvider.ehFallback?.()) return options;
  try {
    return { ...options, listagemArquivos: await arquivos.arvoreResumida() };
  } catch (erro) {
    console.error("[Jarvis] Nao consegui listar o espaco de arquivos:", erro.message);
    return options;
  }
}

async function processMessage(userMessage, conversationHistory = [], options = {}) {
  /* ⚠️ O inventario vem PRIMEIRO: a decisao do manual olha a sandbox para
     reconhecer pedido de ticket que nao cita "jrxml". Ver ehSobreRelatorio(). */
  const opcoes = comManualDeRelatorio(userMessage, await comInventarioDeArquivos(options));
  const messages = montarMensagens(userMessage, conversationHistory, opcoes);
  const startTime = Date.now();

  await garantirModeloVivo();

  try {
    const tools = ferramentasPara(options);
    const chamar = (msgs, extras = {}) =>
      localProvider.chat(msgs, {
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        tools,
        ...extras,
      });

    const result = await resolverConversa(chamar, messages, {
      forcar: await devoForcarGeracao(userMessage, opcoes),
    });

    const latency = Date.now() - startTime;
    console.log(`[Jarvis] ✓ Resposta local (${result.model}) em ${latency}ms`);
    return buildResponse(result, latency);
  } catch (erro) {
    if (erro.name === "AgentError") throw erro;
    console.error("[Jarvis] ✗ Falha no modelo local:", erro.message);
    throw new AgentError(ERRO_MODELO_FORA, {
      primaryError: erro.message,
      totalLatencyMs: Date.now() - startTime,
    });
  }
}

/**
 * Versão streaming: chama handlers.onDelta(trecho) a cada token e
 * handlers.onStart() quando a inferência começa. Falha depois do primeiro
 * token vira erro com parcial=true — o cliente já viu parte do texto.
 */
async function processMessageStream(userMessage, conversationHistory = [], options = {}, handlers = {}) {
  const onDelta = handlers.onDelta || (() => {});
  const onStart = handlers.onStart || (() => {});

  /* ⚠️ O inventario vem PRIMEIRO: a decisao do manual olha a sandbox para
     reconhecer pedido de ticket que nao cita "jrxml". Ver ehSobreRelatorio(). */
  const opcoes = comManualDeRelatorio(userMessage, await comInventarioDeArquivos(options));
  const messages = montarMensagens(userMessage, conversationHistory, opcoes);
  const startTime = Date.now();

  await garantirModeloVivo();

  let emitiu = false;
  try {
    onStart({ provider: "local" });
    const tools = ferramentasPara(options);
    const opcoesStream = {
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      signal: options.signal,
      tools,
    };
    const aoReceber = (delta) => {
      emitiu = true;
      onDelta(delta);
    };

    const chamar = (msgs, extras = {}) =>
      localProvider.chatStream(msgs, { ...opcoesStream, ...extras }, aoReceber);

    const result = await resolverConversa(chamar, messages, {
      forcar: await devoForcarGeracao(userMessage, opcoes),
      rotulo: " (stream)",
      /* ⚠️ O aviso PRECISA ir pelo onDelta. O texto do modelo ja foi enviado
         token a token e esta na tela: nao da para corrigir `result.text` e
         esperar que o navegador releia. Sem isto o aviso so apareceria na
         conversa recarregada, que e tarde. */
      aoAvisar: aoReceber,
    });

    const latency = Date.now() - startTime;
    console.log(`[Jarvis] ✓ Stream local (${result.model}) em ${latency}ms`);
    return buildResponse(result, latency);
  } catch (erro) {
    console.error("[Jarvis] ✗ Falha no stream local:", erro.message);
    throw new AgentError(
      emitiu ? "A resposta foi interrompida no meio." : ERRO_MODELO_FORA,
      { primaryError: erro.message, parcial: emitiu, totalLatencyMs: Date.now() - startTime }
    );
  }
}

// ─────────────────────────────────────────────────────────────
// EXTRAÇÃO DE MEMÓRIA
// ─────────────────────────────────────────────────────────────

const PROMPT_EXTRACAO = `Você extrai fatos duráveis sobre o usuário a partir de uma mensagem de chat.

Fato durável: nome, profissão, preferências estáveis, contexto pessoal ou de trabalho que continua valendo daqui a semanas. Exemplos: "Trabalha como analista de suporte", "Prefere respostas curtas", "Tem um projeto chamado Capital".
NÃO é fato durável: pedido pontual, pergunta, tarefa da conversa, conteúdo técnico genérico, estado passageiro.

Responda SOMENTE com um array JSON de strings em português, sem markdown e sem explicação. Cada fato em terceira pessoa, com no máximo 140 caracteres. Se não houver fato durável, responda [].`;

/**
 * Extrai fatos duráveis da mensagem do usuário. Melhor esforço: modelo fora
 * do ar ou JSON inválido devolvem lista vazia — a memória é um extra, nunca
 * pode derrubar o chat.
 */
async function extrairFatos(mensagemDoUsuario) {
  const vivo = await localProvider.healthCheck();
  if (!vivo) return [];

  try {
    const result = await localProvider.chat(
      [
        { role: "system", content: PROMPT_EXTRACAO },
        { role: "user", content: mensagemDoUsuario },
      ],
      { maxTokens: 200, temperature: 0 }
    );
    return parsearFatos(result.text);
  } catch (erro) {
    console.error("[Jarvis] Extração de memória falhou:", erro.message);
    return [];
  }
}

/** Acha o primeiro array JSON no texto do modelo. Modelo pequeno às vezes envolve em prosa. */
function parsearFatos(texto) {
  const m = String(texto || "").match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((f) => typeof f === "string")
      .map((f) => f.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 5);
  } catch (_) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK E HELPERS
// ─────────────────────────────────────────────────────────────

async function checkProvidersHealth() {
  const [local, modeloLocal, info] = await Promise.all([
    localProvider.healthCheck(),
    localProvider.modeloCarregado(),
    localProvider.infoModelo(),
  ]);

  return {
    local: local === true,
    localModel: modeloLocal,
    modelo: info || {},
    anyAvailable: local === true,
  };
}

function buildResponse(providerResult, latencyMs) {
  return {
    text: providerResult.text,
    toolCalls: providerResult.toolCalls || [],
    provider: "local",
    model: providerResult.model,
    latencyMs,
    usage: providerResult.usage || null,
    timestamp: new Date().toISOString(),
  };
}

class AgentError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AgentError";
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

module.exports = {
  processMessage,
  processMessageStream,
  extrairFatos,
  checkProvidersHealth,
  getJarvisSystemPrompt,
  AgentError,
  /* Exportados para `scripts/testar-relatorio.js`. As tres decisoes que fizeram
     um pedido de cliente terminar sem arquivo moram nelas, e nenhuma dava para
     testar sem subir o modelo. */
  ehSobreRelatorio,
  devoForcarGeracao,
  avisoDeArquivoNaoGerado,
  resolverConversa,
};
