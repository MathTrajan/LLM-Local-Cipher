/**
 * ============================================================
 * CIPHER - Busca nos documentos (modo documentos / RAG)
 * ============================================================
 * BM25 puro em JS sobre o indice gerado por npm run indexar. Sem dependencia,
 * sem processo extra, sem modelo de embedding: numa maquina de 8 GB, busca
 * lexical e o que cabe — e em nota pessoal ela rende mais que a fama.
 *
 * O indice inteiro vive em memoria (so os trechos + estatisticas de termo).
 * Recarrega sozinho quando o arquivo muda no disco (mtime).
 */

const fs = require("fs");
const path = require("path");

const INDICE_PATH = path.join(__dirname, "data", "indice-rag.json");

// Quantos trechos entram no prompt e quanto texto no total. O contexto do 3B
// e 4096 tokens: ~3600 chars de documento (~1000 tokens) deixa espaco para
// prompt, historico e resposta.
const TOP_K = 4;
const MAX_CHARS_TOTAL = 3600;

const K1 = 1.5;
const B = 0.75;

// Stopwords pt-BR minimas: so o que aparece em toda frase e nao discrimina nada.
const STOPWORDS = new Set([
  "a", "o", "as", "os", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das",
  "em", "no", "na", "nos", "nas", "por", "para", "com", "sem", "sob", "sobre",
  "que", "qual", "quais", "quando", "onde", "como", "porque", "se", "ao", "aos",
  "e", "ou", "mas", "nem", "ja", "nao", "sim", "tambem", "muito", "mais", "menos",
  "ser", "ter", "estar", "foi", "sao", "esta", "este", "esse", "isso", "isto",
  "ele", "ela", "eles", "elas", "eu", "voce", "meu", "minha", "seu", "sua",
]);

let cache = null; // { mtimeMs, trechos, docs, df, avgdl, n }

function tokenizar(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function carregarIndice() {
  let stat;
  try {
    stat = fs.statSync(INDICE_PATH);
  } catch (_) {
    cache = null;
    return null;
  }

  if (cache && cache.mtimeMs === stat.mtimeMs) return cache;

  let dados;
  try {
    dados = JSON.parse(fs.readFileSync(INDICE_PATH, "utf8"));
  } catch (erro) {
    console.error("[rag] Indice ilegivel:", erro.message);
    cache = null;
    return null;
  }

  const trechos = Array.isArray(dados?.trechos) ? dados.trechos : [];
  const docs = [];
  const df = new Map();
  let somaDl = 0;

  for (const trecho of trechos) {
    const termos = tokenizar(`${trecho.titulo} ${trecho.texto}`);
    const tf = new Map();
    for (const termo of termos) tf.set(termo, (tf.get(termo) || 0) + 1);
    for (const termo of tf.keys()) df.set(termo, (df.get(termo) || 0) + 1);
    somaDl += termos.length;
    docs.push({ tf, dl: termos.length });
  }

  cache = {
    mtimeMs: stat.mtimeMs,
    geradoEm: dados.geradoEm || null,
    trechos,
    docs,
    df,
    avgdl: docs.length ? somaDl / docs.length : 0,
    n: docs.length,
  };
  console.log(`[rag] Indice carregado: ${cache.n} trechos (gerado em ${cache.geradoEm})`);
  return cache;
}

function disponivel() {
  const idx = carregarIndice();
  return !!idx && idx.n > 0;
}

/** Metadados para o /health e para o painel do front. */
function info() {
  const idx = carregarIndice();
  if (!idx || !idx.n) return { disponivel: false };
  return { disponivel: true, trechos: idx.n, geradoEm: idx.geradoEm };
}

/**
 * BM25 padrao. Devolve ate TOP_K trechos com score > 0, cortados para caber
 * em MAX_CHARS_TOTAL somados.
 */
function buscar(consulta, k = TOP_K) {
  const idx = carregarIndice();
  if (!idx || !idx.n) return [];

  const termos = [...new Set(tokenizar(consulta))];
  if (!termos.length) return [];

  const scores = new Array(idx.n).fill(0);
  for (const termo of termos) {
    const dfTermo = idx.df.get(termo);
    if (!dfTermo) continue;
    const idf = Math.log(1 + (idx.n - dfTermo + 0.5) / (dfTermo + 0.5));
    for (let i = 0; i < idx.n; i++) {
      const tf = idx.docs[i].tf.get(termo);
      if (!tf) continue;
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * idx.docs[i].dl / idx.avgdl));
      scores[i] += idf * norm;
    }
  }

  const ranqueados = scores
    .map((score, i) => ({ score, i }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  const resultado = [];
  let charsUsados = 0;
  for (const r of ranqueados) {
    const trecho = idx.trechos[r.i];
    const orcamento = MAX_CHARS_TOTAL - charsUsados;
    if (orcamento < 200) break; // resto de orcamento pequeno demais para valer
    const texto = trecho.texto.slice(0, orcamento);
    charsUsados += texto.length;
    resultado.push({ arquivo: trecho.arquivo, titulo: trecho.titulo, texto, score: r.score });
  }
  return resultado;
}

module.exports = { buscar, disponivel, info, INDICE_PATH };
