/**
 * ============================================================
 * JARVIS CHAT — Acesso a arquivos (sandbox)
 * ============================================================
 * Da ao modelo local a capacidade de criar, ler, editar e apagar arquivos,
 * restrita a UMA raiz. Nada aqui executa nada: so mexe em texto no disco.
 *
 * Por que a sandbox e inegociavel: o modelo e um Qwen 3B quantizado. Ele erra
 * caminho e alucina nome de arquivo com frequencia bem maior que um modelo
 * grande. Sem raiz unica, um caminho inventado alcanca ~/Dev (projeto em
 * producao) e o vault do Obsidian. Com raiz unica, o pior caso e lixo numa
 * pasta descartavel.
 *
 * Segunda linha de defesa, no server.js: NADA aqui e chamado durante o chat.
 * O modelo apenas PROPOE; quem executa e o clique do usuario.
 * ============================================================
 */

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { getEnvString } = require("./config");
const jrxml = require("./jrxml");
const montadorA2O = require("./montador-a2o");

/** Expande ~ no comeco do caminho, como o shell faz. */
function expandirTil(valor) {
  if (!valor) return valor;
  if (valor === "~") return os.homedir();
  if (valor.startsWith("~/")) return path.join(os.homedir(), valor.slice(2));
  return valor;
}

const RAIZ = path.resolve(
  expandirTil(getEnvString("JARVIS_ARQUIVOS_RAIZ") || path.join(os.homedir(), "Jarvis-Arquivos"))
);

/**
 * Onde o apagar_arquivo deposita o que foi removido. O padrao e a Lixeira do
 * macOS, que e o caso desta maquina.
 *
 * ⚠️ Configuravel por causa do Debian do Sentinel: ali `~/.Trash` nao existe (o
 * servidor nao tem interface grafica) e a unit roda com `ProtectHome=read-only`,
 * entao o rename falharia com FALHA_AO_APAGAR e o apagar viraria um recurso
 * quebrado em producao. La a variavel aponta para /opt/jarvis-lixeira.
 *
 * ⚠️ Tem de ficar no MESMO volume da raiz: `rename` nao atravessa sistema de
 * arquivos. Pasta em outro disco (ou em tmpfs) faz todo apagar falhar.
 */
const LIXEIRA = path.resolve(
  expandirTil(getEnvString("JARVIS_LIXEIRA") || path.join(os.homedir(), ".Trash"))
);

// Só texto. Sem binario, sem .app, sem nada que o macOS trate como executavel.
// O modelo pode escrever codigo (.js, .py, .sh) porque o Jarvis nunca o executa —
// o arquivo fica parado ate voce abrir.
const EXTENSOES = new Set([
  ".md", ".txt", ".json", ".csv", ".tsv", ".log", ".yml", ".yaml",
  ".html", ".css", ".js", ".ts", ".jsx", ".tsx", ".py", ".sh", ".sql", ".xml", ".env",
  // .jrxml entrou em 2026-11-01, para o Jarvis gerar relatorio do JasperReports.
  // E XML puro, nao executa nada, e o Jarvis so grava texto: mesmo risco do .xml
  // que ja estava aqui. Sem esta linha o modelo gera o conteudo certo e a
  // sandbox recusa gravar com EXTENSAO_NAO_PERMITIDA, que e um erro confuso
  // porque o problema nao esta no que ele escreveu.
  ".jrxml",
]);

/* Teto por arquivo. Subiu de 512 KB para 1 MB em 2026-11-01: o maior .jrxml da
   empresa tem 768 KB e seria recusado no upload, que e justamente o arquivo que
   mais precisa ser migrado para o padrao. E texto puro e a sandbox nao executa
   nada, entao o risco de dobrar o teto e de disco, nao de seguranca. */
const MAX_BYTES = 1024 * 1024;
const MAX_ITENS_LISTAGEM = 200;
const MAX_CHARS_LEITURA = 20000;   // o contexto do 3B e 4096 tokens

// Indice automatico por pasta, no espirito do CLAUDE.md. E DERIVADO: nunca
// recebe linha nova, e reescrito inteiro a partir do que existe no disco, e as
// datas saem do filesystem. Log incremental duplicaria a verdade, e duas copias
// "mantidas em sincronia na mao" divergem (foi o bug v1.7.1 do Capital).
const NOME_INDICE = "JARVIS.md";

class ErroArquivo extends Error {
  constructor(mensagem, codigo = "ARQUIVO_INVALIDO") {
    super(mensagem);
    this.name = "ErroArquivo";
    this.codigo = codigo;
  }
}

/** Diz se um caminho existe DENTRO da raiz. Usado pelo upload para decidir
    entre criar e substituir sem vazar mensagem interna para a tela. */
async function existeCaminho(caminho) {
  try {
    await fsp.stat(resolverSeguro(caminho));
    return true;
  } catch (_) {
    return false;
  }
}

/** Cria a raiz se ainda nao existir. Idempotente. */
function garantirRaiz() {
  fs.mkdirSync(RAIZ, { recursive: true });
  return RAIZ;
}

/**
 * Converte caminho relativo vindo do modelo em absoluto DENTRO da raiz.
 * Recusa: caminho absoluto, escape por "..", e symlink que aponte para fora.
 *
 * O symlink e checado no ancestral existente mais proximo, nao no alvo: o
 * arquivo final pode nao existir ainda (caso do criar_arquivo), mas a pasta
 * que o contem existe e e ela que poderia estar apontando para fora.
 */
function resolverSeguro(caminhoRelativo) {
  const bruto = String(caminhoRelativo || "").trim();
  if (!bruto) throw new ErroArquivo("Caminho vazio.");
  if (bruto.includes("\0")) throw new ErroArquivo("Caminho invalido.");

  if (path.isAbsolute(bruto) || bruto.startsWith("~")) {
    throw new ErroArquivo(
      "Use caminho relativo ao espaco de arquivos do Jarvis, sem barra no inicio e sem ~.",
      "FORA_DA_RAIZ"
    );
  }

  const alvo = path.resolve(RAIZ, bruto);
  if (alvo !== RAIZ && !alvo.startsWith(RAIZ + path.sep)) {
    throw new ErroArquivo("Esse caminho fica fora do espaco de arquivos do Jarvis.", "FORA_DA_RAIZ");
  }

  let ancestral = path.dirname(alvo);
  while (ancestral.startsWith(RAIZ) && !fs.existsSync(ancestral)) {
    ancestral = path.dirname(ancestral);
  }
  if (fs.existsSync(ancestral)) {
    const real = fs.realpathSync(ancestral);
    const raizReal = fs.realpathSync(RAIZ);
    if (real !== raizReal && !real.startsWith(raizReal + path.sep)) {
      throw new ErroArquivo("Esse caminho sai da raiz por um atalho.", "FORA_DA_RAIZ");
    }
  }
  return alvo;
}

/**
 * O indice e derivado: qualquer edicao manual sumiria na proxima geracao.
 * Recusar na entrada e mais honesto que aceitar e sobrescrever depois.
 */
function recusarSeForIndice(alvo) {
  if (path.basename(alvo) === NOME_INDICE) {
    throw new ErroArquivo(
      `${NOME_INDICE} e gerado automaticamente pelo Jarvis e nao pode ser alterado a mao.`,
      "ARQUIVO_RESERVADO"
    );
  }
}

function validarExtensao(alvo) {
  const ext = path.extname(alvo).toLowerCase();
  if (!EXTENSOES.has(ext)) {
    throw new ErroArquivo(
      `Extensao "${ext || "(nenhuma)"}" nao permitida. Permitidas: ${[...EXTENSOES].join(", ")}`,
      "EXTENSAO_NAO_PERMITIDA"
    );
  }
}

function validarTamanho(conteudo) {
  const bytes = Buffer.byteLength(String(conteudo ?? ""), "utf8");
  if (bytes > MAX_BYTES) {
    throw new ErroArquivo(`Conteudo grande demais (${bytes} bytes). Teto: ${MAX_BYTES}.`, "GRANDE_DEMAIS");
  }
}

/**
 * Tira a cerca de markdown que o modelo poe em volta do codigo.
 *
 * ⚠️ Medido em 2026-11-01: ao propor `criar_arquivo` com um script Python, o 3B
 * devolve o conteudo como "```python\n...\n```". O arquivo e gravado COM as
 * cercas e nao roda, e o erro que o Python mostra ("invalid syntax" na linha 1)
 * nao tem relacao obvia com a causa.
 *
 * So remove quando a cerca envolve o conteudo INTEIRO. Bloco de codigo no meio
 * de um .md e legitimo e fica intacto.
 */
function limparCercaDeCodigo(conteudo) {
  const texto = String(conteudo ?? "");
  const m = texto.match(/^\s*```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
  return m ? m[1] : texto;
}

/**
 * Validacao especifica por tipo de arquivo, antes de gravar.
 *
 * ⚠️ Roda no CRIAR e no EDITAR, e nao so no criar: o caminho mais comum de um
 * .jrxml quebrar e o modelo editar um arquivo que estava bom. Validar so na
 * criacao daria a falsa sensacao de que o arquivo no disco esta sempre valido.
 *
 * Hoje so .jrxml tem regra. O resto passa direto: a sandbox nunca pretendeu ser
 * linter de linguagem, e validar .js ou .py exigiria parser por linguagem.
 */
function validarConteudoPorTipo(alvo, conteudo, { padraoA2O = false } = {}) {
  if (path.extname(alvo).toLowerCase() !== ".jrxml") return;
  try {
    jrxml.validar(conteudo, { padraoA2O });
  } catch (erro) {
    // Converte para ErroArquivo: o server.js responde 400 com a mensagem para
    // erro conhecido e 500 generico para o resto. A lista de problemas tem de
    // chegar ao usuario, senao ele nao sabe o que pedir para corrigir.
    throw new ErroArquivo(erro.message, "JRXML_INVALIDO");
  }
}

function relativo(alvo) {
  return path.relative(RAIZ, alvo) || ".";
}

// ─────────────────────────────────────────────────────────────
// OPERACOES
// ─────────────────────────────────────────────────────────────

async function listarPasta({ caminho = "." } = {}) {
  garantirRaiz();
  const alvo = caminho === "." || caminho === "" ? RAIZ : resolverSeguro(caminho);
  let entradas;
  try {
    entradas = await fsp.readdir(alvo, { withFileTypes: true });
  } catch (erro) {
    if (erro.code === "ENOENT") throw new ErroArquivo("Essa pasta nao existe.", "NAO_ENCONTRADO");
    throw erro;
  }
  const itens = entradas
    .filter((e) => !e.name.startsWith(".") && e.name !== NOME_INDICE)
    .slice(0, MAX_ITENS_LISTAGEM)
    .map((e) => ({ nome: e.name, tipo: e.isDirectory() ? "pasta" : "arquivo" }));
  return { caminho: relativo(alvo), itens, total: itens.length };
}

async function lerArquivo({ caminho } = {}) {
  garantirRaiz();
  const alvo = resolverSeguro(caminho);
  let conteudo;
  try {
    conteudo = await fsp.readFile(alvo, "utf8");
  } catch (erro) {
    if (erro.code === "ENOENT") throw new ErroArquivo("Esse arquivo nao existe.", "NAO_ENCONTRADO");
    if (erro.code === "EISDIR") throw new ErroArquivo("Isso e uma pasta, nao um arquivo.", "E_PASTA");
    throw erro;
  }
  /* ⚠️ .jrxml grande vira ESPECIFICACAO, nao XML truncado.
     Medido em 2026-11-01 nos 175 arquivos da empresa: a media tem 17 mil tokens
     e o contexto do modelo e de 8.192. Devolver os primeiros 20 mil caracteres
     seria pior que inutil: o modelo veria o cabecalho e metade das bandas, nao
     saberia que falta o resto, e completaria inventando.
     O resumo entrega o contrato (parametros, campos), o inventario (rotulos e
     expressoes por secao) e a lista do que corrigir ao migrar, em ~1.400 tokens
     para um arquivo de 54 KB: 92% menos. O layout antigo NAO vem de proposito,
     porque o objetivo e refazer no padrao A2O. */
  const ehJrxmlGrande =
    path.extname(alvo).toLowerCase() === ".jrxml" && conteudo.length > MAX_CHARS_LEITURA;
  if (ehJrxmlGrande) {
    return {
      caminho: relativo(alvo),
      /* O caminho vai junto porque o resumo monta a instrucao de `herdarDe` com
         ele. Sem isso a instrucao sai generica ("o arquivo que voce leu") e o
         modelo volta a esquecer o argumento. */
      conteudo: jrxml.resumir(conteudo, { caminho: relativo(alvo) }),
      resumido: true,
      truncado: false,
      aviso:
        `Arquivo de ${Math.round(conteudo.length / 1024)} KB, grande demais para o contexto. ` +
        `Acima esta a ESPECIFICACAO extraida (contrato, secoes e o que fazer), nao o XML. ` +
        `Siga a secao "O que fazer" do resumo.`,
    };
  }

  const truncado = conteudo.length > MAX_CHARS_LEITURA;
  return {
    caminho: relativo(alvo),
    conteudo: truncado ? conteudo.slice(0, MAX_CHARS_LEITURA) : conteudo,
    truncado,
  };
}

async function criarArquivo({ caminho, conteudo = "", ...opcoes } = {}) {
  garantirRaiz();
  conteudo = limparCercaDeCodigo(conteudo);
  const alvo = resolverSeguro(caminho);
  recusarSeForIndice(alvo);
  validarExtensao(alvo);
  validarTamanho(conteudo);
  validarConteudoPorTipo(alvo, conteudo, { padraoA2O: opcoes.padraoA2O !== false });

  await fsp.mkdir(path.dirname(alvo), { recursive: true });
  try {
    // wx falha se o arquivo ja existe: criar nunca sobrescreve em silencio.
    await fsp.writeFile(alvo, String(conteudo), { encoding: "utf8", flag: "wx" });
  } catch (erro) {
    if (erro.code === "EEXIST") {
      throw new ErroArquivo("Ja existe um arquivo nesse caminho. Use editar_arquivo.", "JA_EXISTE");
    }
    throw erro;
  }
  return { caminho: relativo(alvo), bytes: Buffer.byteLength(String(conteudo), "utf8") };
}

async function editarArquivo({ caminho, conteudo = "", ...opcoes } = {}) {
  garantirRaiz();
  conteudo = limparCercaDeCodigo(conteudo);
  const alvo = resolverSeguro(caminho);
  recusarSeForIndice(alvo);
  validarExtensao(alvo);
  validarTamanho(conteudo);
  /* ⚠️ Esta linha FALTAVA e o buraco era real, nao teorico: em 2026-11-01 o
     modelo propos substituir um .jrxml pelo SCRIPT PYTHON que deveria gera-lo,
     o usuario confirmou e o arquivo foi sobrescrito. A validacao existia so no
     criarArquivo, e editar e justamente o caminho perigoso, porque destroi
     conteudo que ja estava certo. O backup em .backups/ salvou o original, mas
     a guarda tem de impedir antes. */
  validarConteudoPorTipo(alvo, conteudo, { padraoA2O: opcoes.padraoA2O !== false });

  let anterior = null;
  try {
    anterior = await fsp.readFile(alvo, "utf8");
  } catch (erro) {
    if (erro.code === "ENOENT") throw new ErroArquivo("Esse arquivo nao existe. Use criar_arquivo.", "NAO_ENCONTRADO");
    throw erro;
  }

  // Backup antes de sobrescrever: a unica forma de desfazer o erro do modelo.
  const backupDir = path.join(RAIZ, ".backups");
  await fsp.mkdir(backupDir, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(backupDir, `${path.basename(alvo)}.${carimbo}`);
  await fsp.writeFile(backup, anterior, "utf8");

  await fsp.writeFile(alvo, String(conteudo), "utf8");
  return {
    caminho: relativo(alvo),
    bytes: Buffer.byteLength(String(conteudo), "utf8"),
    backup: relativo(backup),
  };
}

/**
 * Apagar = mover para a Lixeira do macOS, nunca unlink. O rename so funciona no
 * mesmo volume; a home e a Lixeira do usuario estao no mesmo, entao serve.
 */
async function apagarArquivo({ caminho } = {}) {
  garantirRaiz();
  const alvo = resolverSeguro(caminho);
  recusarSeForIndice(alvo);
  if (alvo === RAIZ) throw new ErroArquivo("Nao da para apagar a raiz.", "FORA_DA_RAIZ");

  try {
    await fsp.stat(alvo);
  } catch (erro) {
    if (erro.code === "ENOENT") throw new ErroArquivo("Esse caminho nao existe.", "NAO_ENCONTRADO");
    throw erro;
  }

  // No macOS a Lixeira sempre existe; no Debian do servidor a pasta e nossa e
  // pode nao existir ainda. Idempotente.
  //
  // ⚠️ Dentro do try: com JARVIS_LIXEIRA ausente o default cai em ~/.Trash, e a
  // unit roda com ProtectHome=true, entao o mkdir lanca EPERM cru. Fora do try
  // isso saia como 500 "Nao consegui concluir a acao", que nao diz nada; aqui
  // vira FALHA_AO_APAGAR com o motivo real na mensagem.
  const nome = path.basename(alvo);
  let destino;
  try {
    fs.mkdirSync(LIXEIRA, { recursive: true });
  } catch (erro) {
    throw new ErroArquivo(`Nao consegui preparar a Lixeira (${LIXEIRA}): ${erro.message}`, "FALHA_AO_APAGAR");
  }
  destino = path.join(LIXEIRA, nome);
  if (fs.existsSync(destino)) {
    const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
    destino = path.join(LIXEIRA, `${nome}.${carimbo}`);
  }
  try {
    await fsp.rename(alvo, destino);
  } catch (erro) {
    throw new ErroArquivo(`Nao consegui mover para a Lixeira: ${erro.message}`, "FALHA_AO_APAGAR");
  }
  return { caminho: relativo(alvo), destino: "Lixeira" };
}

// ─────────────────────────────────────────────────────────────
// INDICE AUTOMATICO (JARVIS.md)
// ─────────────────────────────────────────────────────────────

/**
 * Assunto do arquivo, tirado do proprio conteudo: primeiro titulo markdown, ou
 * a primeira linha com texto. Sem IA — e instantaneo e nunca inventa.
 */
function extrairAssunto(conteudo) {
  const linhas = String(conteudo || "").split("\n");
  const titulo = linhas.find((l) => /^#{1,6}\s+\S/.test(l));
  const escolhida = titulo || linhas.find((l) => l.trim().length > 0) || "";
  return escolhida
    .replace(/^#{1,6}\s+/, "")
    .replace(/[|`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function dataCurta(valor) {
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatarTamanho(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Reescreve o JARVIS.md de UMA pasta a partir do que existe nela agora.
 * Pasta sem arquivo proprio nao ganha indice, e o indice velho e removido.
 */
async function gerarIndiceDaPasta(dirAbs) {
  let entradas;
  try {
    entradas = await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch (_) {
    return null;
  }

  const arquivosDaPasta = [];
  const subpastas = [];

  for (const e of entradas) {
    if (e.name.startsWith(".") || e.name === NOME_INDICE) continue;
    if (e.isDirectory()) { subpastas.push(e.name); continue; }

    const abs = path.join(dirAbs, e.name);
    let info;
    try { info = await fsp.stat(abs); } catch (_) { continue; }

    let assunto = "";
    if (info.size <= MAX_BYTES) {
      try { assunto = extrairAssunto(await fsp.readFile(abs, "utf8")); } catch (_) { assunto = ""; }
    }
    arquivosDaPasta.push({
      nome: e.name,
      assunto: assunto || "(sem título)",
      criado: dataCurta(info.birthtime || info.mtime),
      alterado: dataCurta(info.mtime),
      tamanho: formatarTamanho(info.size),
    });
  }

  const indiceAbs = path.join(dirAbs, NOME_INDICE);

  if (!arquivosDaPasta.length && !subpastas.length) {
    await fsp.rm(indiceAbs, { force: true });
    return null;
  }

  const ehRaiz = path.resolve(dirAbs) === RAIZ;
  const rotulo = ehRaiz
    ? "do espaço de arquivos"
    : `da pasta \`${path.relative(RAIZ, dirAbs)}/\``;

  const linhas = [
    `# ${NOME_INDICE}`,
    "",
    `Índice ${rotulo}, mantido pelo Jarvis.`,
    "",
    "> Este arquivo é gerado automaticamente a cada ação confirmada e reescrito por",
    "> inteiro. Não edite à mão: a próxima geração descarta a alteração.",
    "",
    `Última geração: ${new Date().toLocaleString("pt-BR")}`,
    "",
  ];

  if (arquivosDaPasta.length) {
    linhas.push(`## Arquivos (${arquivosDaPasta.length})`, "");
    linhas.push("| Arquivo | Assunto | Criado | Alterado | Tamanho |");
    linhas.push("|---|---|---|---|---|");
    for (const a of arquivosDaPasta.sort((x, y) => x.nome.localeCompare(y.nome))) {
      linhas.push(`| \`${a.nome}\` | ${a.assunto} | ${a.criado} | ${a.alterado} | ${a.tamanho} |`);
    }
    linhas.push("");
  }

  if (subpastas.length) {
    linhas.push(`## Subpastas (${subpastas.length})`, "");
    for (const s of subpastas.sort()) {
      // Pasta vazia nao tem indice proprio: apontar para um arquivo que nao
      // existe seria pior que nao apontar.
      const temIndice = fs.existsSync(path.join(dirAbs, s, NOME_INDICE));
      linhas.push(
        temIndice
          ? `- \`${s}/\` (índice próprio em \`${s}/${NOME_INDICE}\`)`
          : `- \`${s}/\` (vazia)`
      );
    }
    linhas.push("");
  }

  await fsp.writeFile(indiceAbs, linhas.join("\n"), "utf8");
  return path.relative(RAIZ, indiceAbs);
}

/**
 * Regenera o indice da pasta afetada e o de cada ancestral ate a raiz: mexer em
 * "projetos/site/index.html" muda a contagem que aparece no indice da raiz.
 */
async function atualizarIndices(caminhoRelativo) {
  garantirRaiz();
  const alvoAbs = path.resolve(RAIZ, caminhoRelativo || ".");
  let dir = fs.existsSync(alvoAbs) && fs.statSync(alvoAbs).isDirectory() ? alvoAbs : path.dirname(alvoAbs);

  const gerados = [];
  while (dir.startsWith(RAIZ)) {
    if (fs.existsSync(dir)) {
      const gerado = await gerarIndiceDaPasta(dir);
      if (gerado) gerados.push(gerado);
    }
    if (path.resolve(dir) === RAIZ) break;
    dir = path.dirname(dir);
  }
  return gerados;
}

// ─────────────────────────────────────────────────────────────
// FERRAMENTAS EXPOSTAS AO MODELO
// ─────────────────────────────────────────────────────────────

/**
 * Gera um .jrxml COMPLETO no padrao A2O a partir de uma especificacao.
 *
 * ⚠️ O modelo NAO escreve o XML aqui: ele descreve o relatorio e o
 * montador-a2o.js produz o arquivo. Essa divisao e o que torna o resultado
 * confiavel. Nas quatro rodadas de treino de 2026-11-01 o 3B acertou a forma e
 * errou o conteudo quando escrevia codigo; descrevendo dados ele acerta,
 * porque e a tarefa em que modelo pequeno e bom.
 *
 * O arquivo sai pronto para baixar e testar no servidor.
 */
/**
 * Extrai parametros e campos de um .jrxml existente, para o novo herdar o
 * contrato sem o modelo precisar transcrever nada.
 */
async function contratoDe(caminho) {
  const alvo = resolverSeguro(caminho);
  const xml = await fsp.readFile(alvo, "utf8");
  const parametros = [...xml.matchAll(/<parameter name="([^"]+)"[^>]*class="([^"]+)"/g)]
    .map((m) => ({ nome: m[1], classe: m[2] }));
  const campos = [...xml.matchAll(/<field name="([^"]+)"[^>]*class="([^"]+)"/g)]
    .map((m) => ({ nome: m[1], classe: m[2] }));
  // Dedup por nome: subDataset repete parametro, e nome duplicado quebra a
  // compilacao com "Duplicate declaration".
  const unico = (lista) => [...new Map(lista.map((x) => [x.nome, x])).values()];
  return { parametros: unico(parametros), campos: unico(campos) };
}

async function gerarRelatorioA2O(spec = {}) {
  garantirRaiz();

  /* ⚠️ `herdarDe` copia o contrato do arquivo original automaticamente.
     Sem isto o modelo tinha de transcrever 17 parametros e 61 campos na
     chamada da ferramenta, e medido em 2026-11-01 ele simplesmente NAO
     transcreveu: o .jrxml saiu com 0 field e 0 parameter, bonito e inutil,
     porque sem os campos o sistema nao tem o que preencher.
     Transcricao longa e justamente o que um modelo pequeno erra; leitura de
     arquivo e deterministica. */
  /* ⚠️ `saida` nunca pode ser igual a `herdarDe`: seria sobrescrever o arquivo
     original pelo que deveria ser a versao nova dele. O modelo propos isso em
     2026-11-03, pedindo saida e herdarDe ambos como pessoa_imprimir_3.jrxml. */
  if (spec.herdarDe && path.basename(String(spec.saida || "")) === path.basename(String(spec.herdarDe))) {
    throw new ErroArquivo(
      `A saida "${spec.saida}" e o mesmo arquivo de origem. Escolha outro nome, ` +
        `senao o original e destruido.`,
      "SAIDA_IGUAL_ORIGEM"
    );
  }

  /* ⚠️ `herdarDe` apontando para arquivo que NAO EXISTE quase sempre significa
     que o modelo copiou o nome do exemplo do manual. Aconteceu em 2026-11-03:
     pediram `pessoa_imprimir_3.jrxml` e ele mandou `herdarDe:
     "nfs-listagem.jrxml"`, que e o nome literal do exemplo. O relatorio sairia
     com os 61 campos de nota fiscal no lugar dos de pessoa, e nada acusaria:
     o arquivo e valido, so esta errado.
     Em vez de confiar, confere se existe; nao existindo, cai no palpite pelo
     mais recente, que e o fluxo real de "subi o arquivo e pedi a versao nova". */
  if (spec.herdarDe && !(await existeCaminho(spec.herdarDe))) {
    console.warn(`[a2o] herdarDe "${spec.herdarDe}" nao existe; vou procurar o .jrxml mais recente`);
    spec = { ...spec, herdarDe: null };
  }

  if (spec.herdarDe) {
    try {
      const herdado = await contratoDe(spec.herdarDe);
      spec = {
        ...spec,
        parametros: (spec.parametros?.length ? spec.parametros : herdado.parametros),
        campos: (spec.campos?.length ? spec.campos : herdado.campos),
      };
    } catch (erro) {
      throw new ErroArquivo(
        `Nao consegui ler o contrato de "${spec.herdarDe}": ${erro.message}`,
        "HERDAR_FALHOU"
      );
    }
  }

  /* ⚠️ A validacao de COLUNAS vem antes da de campos. Com a ordem invertida,
     um pedido de 18 colunas era recusado com SEM_CAMPOS, mandando corrigir o
     contrato quando o problema era a tabela larga demais. Mensagem errada faz
     o modelo consertar a coisa errada e tentar de novo igual. */
  if (!Array.isArray(spec.colunas) || spec.colunas.length === 0) {
    throw new ErroArquivo("Informe ao menos uma coluna, com titulo e campo.", "SEM_COLUNAS");
  }

  /* ⚠️ Teto de colunas, porque largura normalizada nao salva layout ilegivel.
     Em 2026-11-03 o modelo propos 18 colunas em A4 retrato para uma ficha
     cadastral: cada uma ficaria com ~30 pontos, menos que o necessario para
     escrever "Razao Social". O numero vem da conta: com F_TEXTO em 7pt cabem
     ~6 caracteres por 30 pontos.
     Acima de 8 colunas, paisagem passa a ser obrigatoria (802 em vez de 555).
     Acima de 14, nem paisagem resolve e o pedido e recusado com orientacao:
     ficha cadastral quer campos empilhados, nao tabela larga. */
  if (spec.colunas.length > 14) {
    throw new ErroArquivo(
      `${spec.colunas.length} colunas nao cabem numa tabela legivel (teto 14). ` +
        `Se isto e uma ficha cadastral e nao uma listagem, ela precisa de campos ` +
        `empilhados, que o montador nao faz: use o _ficha.py. Para listagem, ` +
        `escolha as colunas que importam.`,
      "COLUNAS_DEMAIS"
    );
  }
  if (spec.colunas.length > 8 && spec.paisagem !== true) {
    console.log(`[a2o] ${spec.colunas.length} colunas: forcando paisagem`);
    spec = { ...spec, paisagem: true };
  }

  /* ⚠️ PISO de colunas, irmao do teto acima e pela mesma razao: layout que nao
     serve. Medido em 2026-11-03: o modelo mandou UMA coluna para um relatorio
     cujo contrato tem 59 campos, e o arquivo saiu valido e inutil (uma tabela
     de uma coluna nao e listagem de nada).
     O piso vale so quando o contrato e largo: relatorio de 3 campos pode
     legitimamente ter 1 ou 2 colunas. Com 10 campos ou mais, uma coluna so e
     omissao, nao escolha. */
  if (spec.colunas.length < 2 && (spec.campos || []).length >= 10) {
    throw new ErroArquivo(
      `Uma coluna so, num contrato de ${spec.campos.length} campos: isso gera uma ` +
        `tabela que nao mostra nada. Escolha as colunas que o pedido exige ` +
        `(titulo e campo de cada uma), no maximo 14.`,
      "COLUNAS_DE_MENOS"
    );
  }

  /* ⚠️ Ultimo recurso: herdar do .jrxml mais recente da sandbox.
     O modelo esquece `herdarDe` com frequencia (medido em 2026-11-01: acertou
     numa chamada e esqueceu na seguinte, com o mesmo pedido). Quando isso
     acontece a geracao falha e o usuario ve um erro tecnico, mesmo tendo
     acabado de subir o arquivo de origem.
     Como o fluxo real e "subo um arquivo, peco a versao nova", o .jrxml mais
     recente que NAO e a saida e quase sempre a origem certa. O palpite vai
     declarado no resultado, para o usuario poder desmentir. */
  /* ⚠️ Campos informados a mao SAO SUSPEITOS numa migracao. Medido em
     2026-11-03: o modelo mandou 2 campos para um relatorio cujo original tem 61,
     e o arquivo saiu valido e inutil (o sistema preenche por nome; 59 campos
     ausentes = 59 colunas vazias).
     Quando ha menos de 5 campos informados E existe .jrxml na pasta, o contrato
     do arquivo vale mais que a lista do modelo: transcrever 61 nomes e
     justamente o que um modelo pequeno nao faz. */
  if (!spec.herdarDe && (spec.campos || []).length > 0 && spec.campos.length < 5) {
    console.warn(`[a2o] so ${spec.campos.length} campos informados; vou herdar do .jrxml mais recente`);
    spec = { ...spec, campos: [], parametros: [] };
  }

  let herdouPorPalpite = null;
  if (!(spec.campos || []).length && !spec.herdarDe) {
    try {
      const saidaNome = path.basename(String(spec.saida || ""));
      const entradas = await fsp.readdir(RAIZ, { withFileTypes: true });
      const candidatos = [];
      for (const e of entradas) {
        if (!e.isFile() || !e.name.toLowerCase().endsWith(".jrxml")) continue;
        if (e.name === saidaNome) continue;
        const caminho = path.join(RAIZ, e.name);
        const st = await fsp.stat(caminho);
        /* Pula o que o proprio montador gerou: nao e fonte de contrato, e usar
           como tal propaga um contrato ja reduzido. O marcador e inserido pelo
           montador-a2o.js. */
        const cabeca = (await fsp.readFile(caminho, "utf8")).slice(0, 4000);
        if (cabeca.includes("jarvis-montador-a2o")) continue;
        candidatos.push({ nome: e.name, mtime: st.mtimeMs });
      }
      candidatos.sort((a, b) => b.mtime - a.mtime);
      if (candidatos.length) {
        const herdado = await contratoDe(candidatos[0].nome);
        if (herdado.campos.length) {
          spec = { ...spec, parametros: herdado.parametros, campos: herdado.campos };
          herdouPorPalpite = candidatos[0].nome;
        }
      }
    } catch (_) {
      // Palpite e melhor esforco: falhando, cai na recusa abaixo.
    }
  }

  /* Relatorio sem campo nenhum nao emite nada. Recusar aqui e melhor que
     entregar um arquivo que so falha no servidor do cliente. */
  if (!(spec.campos || []).length) {
    throw new ErroArquivo(
      "O relatorio ficaria sem nenhum <field> e nao emitiria nada. " +
        "Passe `herdarDe` com o arquivo original, ou informe os campos.",
      "SEM_CAMPOS"
    );
  }

  /* ⚠️ Toda referencia a campo tem de EXISTIR no contrato, e isto nao e
     preciosismo: e o unico defeito desta serie que o validador de XML e o de
     padrao A2O nao pegam, porque o arquivo fica perfeito.
     Medido em 2026-11-03, no arquivo que o usuario quase baixou e mandou para o
     cliente: os rotulos sairam certos ("Tomador", "Data", "Operacao") e o
     detalhe referenciava $F{G}, $F{dt} e $F{op}, nomes que o modelo inventou.
     O contrato herdado tinha razaoSocialTomador e dataEmitido. O JasperReports
     emitiria colunas vazias ou falharia no cliente, e nada aqui acusava.
     A lista de campos disponiveis vai na mensagem de erro de proposito: sem
     ela o modelo tenta adivinhar de novo e erra igual. */
  {
    const nomes = new Set((spec.campos || []).map((c) => String(c.nome)));
    const refs = [
      ...(spec.colunas || []).map((c) => ({ onde: `coluna "${c.titulo || c.campo}"`, campo: c.campo })),
      ...(spec.kpis || []).map((k) => ({ onde: `KPI "${k.rotulo || k.campo}"`, campo: k.campo })),
      ...(spec.totais || []).map((t) => ({ onde: "total do rodape", campo: t.coluna })),
      ...(spec.agruparPor ? [{ onde: "agruparPor", campo: spec.agruparPor }] : []),
      ...(spec.grafico?.categoria ? [{ onde: "categoria do grafico", campo: spec.grafico.categoria }] : []),
      ...(spec.grafico?.valor ? [{ onde: "valor do grafico", campo: spec.grafico.valor }] : []),
    ].filter((r) => r.campo);

    const invalidas = refs.filter((r) => !nomes.has(String(r.campo)));
    if (invalidas.length) {
      const amostra = [...nomes].slice(0, 25).join(", ");
      throw new ErroArquivo(
        `Estes campos nao existem no contrato: ` +
          invalidas.map((r) => `${r.campo} (${r.onde})`).join("; ") +
          `. Use SO nomes do contrato. Disponiveis (${nomes.size}): ${amostra}` +
          (nomes.size > 25 ? ", ..." : ""),
        "CAMPO_INEXISTENTE"
      );
    }
  }

  const saida = String(spec.saida || "").trim();
  if (!saida) throw new ErroArquivo("Informe o nome do arquivo de saida (.jrxml).", "SEM_SAIDA");
  if (!saida.toLowerCase().endsWith(".jrxml")) {
    throw new ErroArquivo("A saida precisa terminar em .jrxml.", "EXTENSAO_NAO_PERMITIDA");
  }
  const xml = montadorA2O.montar(spec);

  /* Valida a propria saida antes de gravar. O montador e deterministico, mas a
     checagem custa milissegundos e transforma um bug futuro dele em erro na
     hora, em vez de arquivo quebrado descoberto na emissao. */
  jrxml.validar(xml, { padraoA2O: true });

  const alvo = resolverSeguro(saida);

  /* ⚠️ Guarda GERAL: nunca gravar sobre um .jrxml que o montador NAO produziu.
     A checagem `SAIDA_IGUAL_ORIGEM` lá em cima só vale quando `herdarDe` vem
     explícito, e foi por essa fresta que o arquivo de um cliente foi destruido
     em 2026-11-03: o modelo OMITIU `herdarDe`, o contrato entrou pelo palpite,
     a comparacao de nomes nunca rodou e a saida levou o nome do original. Os
     28 KB enviados viraram 11 KB gerados; só o `.backups/` salvou.
     A pergunta certa nao e "de onde veio o contrato" e sim "o que existe nesse
     caminho". Arquivo com o marcador e saida nossa e pode ser regerado;
     qualquer outro e material do usuario. */
  try {
    const existente = (await fsp.readFile(alvo, "utf8")).slice(0, 4000);
    if (!existente.includes("jarvis-montador-a2o")) {
      const base = path.basename(saida).replace(/\.jrxml$/i, "");
      throw new ErroArquivo(
        `"${relativo(alvo)}" ja existe e NAO foi gerado pelo montador: e o arquivo ` +
          `de origem. Gravar ali destruiria o original. Use outro nome, por ` +
          `exemplo "${base}-a2o.jrxml".`,
        "SOBRESCREVERIA_ORIGEM"
      );
    }
  } catch (erro) {
    if (erro.name === "ErroArquivo") throw erro;
    // ENOENT e o caso normal: alvo novo.
  }

  await fsp.mkdir(path.dirname(alvo), { recursive: true });
  await fsp.writeFile(alvo, xml, "utf8");
  return {
    caminho: relativo(alvo),
    bytes: Buffer.byteLength(xml, "utf8"),
    colunas: spec.colunas.length,
    campos: (spec.campos || []).length,
    ...(herdouPorPalpite
      ? { aviso: `O contrato foi herdado de "${herdouPorPalpite}", o .jrxml mais recente da pasta. Se nao era esse, peca de novo informando herdarDe.` }
      : {}),
  };
}

const FERRAMENTAS = {
  gerar_relatorio_a2o: {
    executar: gerarRelatorioA2O,
    destrutiva: false,
    escreve: true,
    resumo: (a) => {
      const extras = [];
      if ((a.kpis || []).length) extras.push(`${a.kpis.length} KPI`);
      if ((a.totais || []).length) extras.push("totais");
      if (a.agruparPor) extras.push(`agrupado por ${a.agruparPor}`);
      if (a.grafico) extras.push(`grafico de ${a.grafico.tipo}`);
      return `Gerar "${a.saida}" no padrao A2O (${(a.colunas || []).length} colunas`
        + (extras.length ? `, ${extras.join(", ")}` : "") + ")";
    },
    schema: {
      type: "function",
      function: {
        name: "gerar_relatorio_a2o",
        description:
          "Gera um arquivo .jrxml completo no padrao visual da A2O (cabecalho com logo e dados da filial, " +
          "faixa azul #415F83 nas colunas, linha zebrada, rodape com emissao e pagina). " +
          "Use SEMPRE esta ferramenta para criar relatorio A2O: nunca escreva XML a mao.",
        parameters: {
          type: "object",
          properties: {
            saida: { type: "string", description: "Nome do arquivo a gerar, terminando em .jrxml" },
            herdarDe: {
              type: "string",
              description:
                "Nome do .jrxml ORIGINAL. O sistema copia dele todos os parametros e campos " +
                "automaticamente. Use SEMPRE que estiver migrando um relatorio existente: " +
                "assim voce nao precisa transcrever a lista.",
            },
            nome: { type: "string", description: "Nome interno do relatorio, sem espaco" },
            titulo: { type: "string", description: "Rotulo pequeno do cabecalho, ex: LISTAGEM" },
            subtitulo: { type: "string", description: "Titulo principal, ex: Notas Fiscais de Servico" },
            paisagem: { type: "boolean", description: "true para A4 paisagem" },
            rodape: { type: "string", description: "Texto do rodape" },
            parametros: {
              type: "array",
              description: "So quando NAO usar herdarDe. Parametros com nome e classe exatos",
              items: {
                type: "object",
                properties: { nome: { type: "string" }, classe: { type: "string" } },
                required: ["nome"],
              },
            },
            campos: {
              type: "array",
              description: "So quando NAO usar herdarDe. Campos com nome e classe exatos",
              items: {
                type: "object",
                properties: { nome: { type: "string" }, classe: { type: "string" } },
                required: ["nome"],
              },
            },
            kpis: {
              type: "array",
              description:
                "Cartoes de indicador no fim do relatorio. Use quando o pedido falar em KPI, " +
                "indicador, resumo, total geral ou painel.",
              items: {
                type: "object",
                properties: {
                  rotulo: { type: "string", description: "Texto do cartao, ex: Total faturado" },
                  campo: { type: "string", description: "Campo somado ou contado, sem $F{}" },
                  calculo: { type: "string", enum: ["Sum", "Count", "Average", "Highest", "Lowest"] },
                  al: { type: "string", enum: ["Left", "Center", "Right"] },
                },
                required: ["rotulo", "campo"],
              },
            },
            totais: {
              type: "array",
              description:
                "Totais no rodape da tabela, alinhados com as colunas. Use quando pedirem " +
                "somatorio, total por coluna ou fechamento.",
              items: {
                type: "object",
                properties: {
                  coluna: { type: "string", description: "Mesmo nome de campo usado na coluna" },
                  calculo: { type: "string", enum: ["Sum", "Count", "Average"] },
                },
                required: ["coluna"],
              },
            },
            agruparPor: {
              type: "string",
              description:
                "Campo que agrupa as linhas. Cria faixa de cabecalho por valor e, se houver " +
                "totais, subtotal por grupo. O sistema ordena pelo campo sozinho.",
            },
            grafico: {
              type: "object",
              description: "Grafico no fim do relatorio. Use quando pedirem grafico ou visualizacao.",
              properties: {
                tipo: { type: "string", enum: ["barras", "pizza"] },
                titulo: { type: "string" },
                categoria: { type: "string", description: "Campo do eixo de categoria, sem $F{}" },
                valor: { type: "string", description: "Campo do valor, sem $F{}" },
                altura: { type: "number", description: "Altura em pontos, padrao 180" },
              },
              required: ["tipo", "categoria", "valor"],
            },
            colunas: {
              type: "array",
              description: "Colunas da tabela, na ordem em que aparecem",
              items: {
                type: "object",
                properties: {
                  titulo: { type: "string", description: "Cabecalho da coluna" },
                  campo: { type: "string", description: "Nome do campo, sem $F{}" },
                  largura: { type: "number", description: "Peso relativo da largura" },
                  formato: {
                    type: "string",
                    enum: ["texto", "data", "datahora", "numero", "inteiro", "dinheiro", "simnao"],
                  },
                  al: { type: "string", enum: ["Left", "Center", "Right"] },
                },
                required: ["titulo", "campo"],
              },
            },
          },
          required: ["saida", "subtitulo", "colunas"],
        },
      },
    },
  },

  listar_pasta: {
    executar: listarPasta,
    destrutiva: false,
    escreve: false,
    resumo: (a) => `Listar a pasta "${a.caminho || "."}"`,
    schema: {
      type: "function",
      function: {
        name: "listar_pasta",
        description:
          "Lista arquivos e pastas dentro do espaco de arquivos do usuario. Use antes de ler ou editar quando nao souber o nome exato.",
        parameters: {
          type: "object",
          properties: {
            caminho: { type: "string", description: 'Pasta relativa. Use "." para a raiz.' },
          },
          required: [],
        },
      },
    },
  },

  ler_arquivo: {
    executar: lerArquivo,
    destrutiva: false,
    escreve: false,
    resumo: (a) => `Ler o arquivo "${a.caminho}"`,
    schema: {
      type: "function",
      function: {
        name: "ler_arquivo",
        description: "Le o conteudo de um arquivo de texto do espaco de arquivos do usuario.",
        parameters: {
          type: "object",
          properties: {
            caminho: { type: "string", description: "Caminho relativo do arquivo, com extensao." },
          },
          required: ["caminho"],
        },
      },
    },
  },

  criar_arquivo: {
    executar: criarArquivo,
    destrutiva: false,
    escreve: true,
    resumo: (a) => `Criar o arquivo "${a.caminho}"`,
    schema: {
      type: "function",
      function: {
        name: "criar_arquivo",
        description:
          "Cria um arquivo de texto NOVO. Falha se ja existir um arquivo no caminho. Use quando o usuario pedir para escrever, anotar ou salvar algo.",
        parameters: {
          type: "object",
          properties: {
            caminho: { type: "string", description: 'Caminho relativo com extensao, ex: "notas/reuniao.md".' },
            conteudo: { type: "string", description: "Conteudo completo do arquivo." },
          },
          required: ["caminho", "conteudo"],
        },
      },
    },
  },

  editar_arquivo: {
    executar: editarArquivo,
    destrutiva: true,
    escreve: true,
    resumo: (a) => `Substituir o conteudo de "${a.caminho}"`,
    schema: {
      type: "function",
      function: {
        name: "editar_arquivo",
        description:
          "Substitui o conteudo INTEIRO de um arquivo que ja existe. Leia o arquivo antes para nao perder o que estava la.",
        parameters: {
          type: "object",
          properties: {
            caminho: { type: "string", description: "Caminho relativo do arquivo existente." },
            conteudo: { type: "string", description: "Novo conteudo completo do arquivo." },
          },
          required: ["caminho", "conteudo"],
        },
      },
    },
  },

  apagar_arquivo: {
    executar: apagarArquivo,
    destrutiva: true,
    escreve: true,
    resumo: (a) => `Mover "${a.caminho}" para a Lixeira`,
    schema: {
      type: "function",
      function: {
        name: "apagar_arquivo",
        description: "Move um arquivo ou pasta para a Lixeira do sistema. Use apenas quando o usuario pedir de forma explicita.",
        parameters: {
          type: "object",
          properties: {
            caminho: { type: "string", description: "Caminho relativo do que sera movido para a Lixeira." },
          },
          required: ["caminho"],
        },
      },
    },
  },
};

/**
 * Arvore resumida do espaco de arquivos, para injetar no system prompt.
 *
 * Sem isto o modelo inventa o caminho: pediu "apague teste-x.md" e ele mandou
 * "notas/teste-x.md", porque foi o padrao que ele mesmo usou ao criar antes.
 * A sandbox recusa o caminho errado, mas o usuario so ve a acao falhar. Ver a
 * lista real resolve na origem.
 */
async function arvoreResumida(maxItens = 60) {
  garantirRaiz();
  const linhas = [];

  async function andar(dir, prefixo, profundidade) {
    if (linhas.length >= maxItens || profundidade > 2) return;
    let entradas;
    try {
      entradas = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entradas.sort((a, b) => a.name.localeCompare(b.name))) {
      if (linhas.length >= maxItens) return;
      if (e.name.startsWith(".") || e.name === NOME_INDICE) continue;
      const rel = prefixo ? `${prefixo}/${e.name}` : e.name;
      if (e.isDirectory()) {
        linhas.push(`${rel}/`);
        await andar(path.join(dir, e.name), rel, profundidade + 1);
      } else {
        linhas.push(rel);
      }
    }
  }

  await andar(RAIZ, "", 0);
  return linhas;
}

function schemasDasFerramentas() {
  return Object.values(FERRAMENTAS).map((f) => f.schema);
}

function existeFerramenta(nome) {
  return Object.prototype.hasOwnProperty.call(FERRAMENTAS, nome);
}

/** Texto curto que o front mostra no card de confirmacao. */
function resumirAcao(nome, args) {
  if (!existeFerramenta(nome)) return `Acao desconhecida "${nome}"`;
  try {
    return FERRAMENTAS[nome].resumo(args || {});
  } catch (_) {
    return nome;
  }
}

/** A ferramenta mexe no disco? Define se o indice sera regerado. */
function escreveNoDisco(nome) {
  return existeFerramenta(nome) ? FERRAMENTAS[nome].escreve === true : false;
}

function ehDestrutiva(nome) {
  return existeFerramenta(nome) ? FERRAMENTAS[nome].destrutiva : true;
}

/**
 * Executa a ferramenta. So o server chama, e so depois do clique do usuario.
 *
 * Quando a acao mexe no disco, o JARVIS.md da pasta e o dos ancestrais sao
 * regerados. Essa segunda escrita e efeito da MESMA confirmacao: o usuario
 * autorizou a acao, e o indice e derivado dela. O card avisa disso.
 *
 * Falha ao gerar indice nao derruba a acao: o arquivo do usuario ja esta no
 * lugar, e indice desatualizado e menos grave que acao reportada como erro
 * depois de ter dado certo.
 */
async function executarFerramenta(nome, args = {}) {
  if (!existeFerramenta(nome)) {
    throw new ErroArquivo(`Ferramenta desconhecida: ${nome}`, "FERRAMENTA_DESCONHECIDA");
  }

  const ferramenta = FERRAMENTAS[nome];
  const resultado = await ferramenta.executar(args);

  if (ferramenta.escreve) {
    try {
      resultado.indices = await atualizarIndices(resultado.caminho);
    } catch (erro) {
      console.error("[arquivos] Falha ao gerar o indice:", erro.message);
      resultado.indices = [];
    }
  }
  return resultado;
}

module.exports = {
  RAIZ,
  existeCaminho,
  LIXEIRA,
  // Exportado para o smoke test derivar o caso de "grande demais" do teto
  // real, em vez de cravar um numero que envelhece quando o limite muda.
  MAX_BYTES,
  NOME_INDICE,
  garantirRaiz,
  atualizarIndices,
  resolverSeguro,
  arvoreResumida,
  schemasDasFerramentas,
  executarFerramenta,
  existeFerramenta,
  resumirAcao,
  ehDestrutiva,
  escreveNoDisco,
  ErroArquivo,
  EXTENSOES,
};
