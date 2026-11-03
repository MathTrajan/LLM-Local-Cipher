/**
 * ============================================================
 * CIPHER - Perfil (conhecimento que vale em toda conversa)
 * ============================================================
 * Fatos que o Cipher precisa saber sempre: quem e o usuario, o que ele faz,
 * como ele trabalha. Vale em qualquer modo, sem depender do RAG nem do
 * localStorage do navegador.
 *
 * Mora em data/perfil.local.md porque `backend/data/` esta no .gitignore e
 * ESTE REPO E PUBLICO. Perfil no agent.js iria para o GitHub; aqui, nao.
 *
 * Duas secoes, porque o contexto do 3B e de 4096 tokens:
 *
 *   # SEMPRE     entra em toda requisicao, inclusive no modo documentos
 *   # EXPANDIDO  entra so fora do modo documentos, onde ha folga de contexto
 *
 * Arquivo sem esses cabecalhos e tratado inteiro como SEMPRE.
 * Recarrega sozinho quando muda no disco (mtime), igual ao rag.js.
 */

const fs = require("fs");
const path = require("path");

const PERFIL_PATH = path.join(__dirname, "data", "perfil.local.md");

// Orcamento de contexto. SEMPRE disputa espaco com os trechos do RAG (3600
// chars) no modo documentos; por isso e o mais apertado dos dois.
const MAX_SEMPRE = 1400;
const MAX_EXPANDIDO = 3000;

let cache = null; // { mtimeMs, sempre, expandido }

/** Divide pelos cabecalhos `# SEMPRE` / `# EXPANDIDO`. Sem eles, tudo e SEMPRE. */
function separarSecoes(bruto) {
  const linhas = bruto.split("\n");
  const secoes = { sempre: [], expandido: [] };
  let atual = "sempre";

  for (const linha of linhas) {
    const m = linha.match(/^#\s+(SEMPRE|EXPANDIDO)\s*$/i);
    if (m) {
      atual = m[1].toLowerCase();
      continue;
    }
    secoes[atual].push(linha);
  }

  return {
    sempre: secoes.sempre.join("\n").trim().slice(0, MAX_SEMPRE),
    expandido: secoes.expandido.join("\n").trim().slice(0, MAX_EXPANDIDO),
  };
}

function carregar() {
  let stat;
  try {
    stat = fs.statSync(PERFIL_PATH);
  } catch (_) {
    cache = null; // sem perfil o Cipher funciona, so nao sabe quem e o usuario
    return null;
  }

  if (cache && cache.mtimeMs === stat.mtimeMs) return cache;

  let bruto;
  try {
    bruto = fs.readFileSync(PERFIL_PATH, "utf8");
  } catch (erro) {
    console.error("[perfil] Ilegivel:", erro.message);
    cache = null;
    return null;
  }

  // Arquivo vindo de nuvem sem hidratar chega vazio ou com NUL: mesma guarda
  // do indexador de documentos.
  if (!bruto.trim() || bruto.includes("\u0000")) {
    cache = null;
    return null;
  }

  const { sempre, expandido } = separarSecoes(bruto);
  cache = { mtimeMs: stat.mtimeMs, sempre, expandido };
  console.log(
    `[perfil] Carregado: ${sempre.length} chars sempre + ${expandido.length} chars expandido`
  );
  return cache;
}

/**
 * Bloco pronto para o system prompt. `completo: false` (modo documentos) manda
 * so a secao SEMPRE, para nao roubar contexto dos trechos das notas.
 *
 * A regra de precedencia nao e enfeite: no teste de 2026-09-25 o RAG recuperou
 * uma nota antiga ("analista de dados na Colchoes Ind") e o modelo fundiu as
 * duas identidades numa so. Perfil manda mais que trecho recuperado.
 */
function bloco({ completo = true } = {}) {
  const p = carregar();
  if (!p || !p.sempre) return "";

  const corpo = completo && p.expandido ? `${p.sempre}\n\n${p.expandido}` : p.sempre;

  return `

Perfil do usuario (vale em toda conversa, independente do assunto):

${corpo}

Como usar o perfil:
- Trate isso como verdade atual sobre o usuario. Nao pergunte o que ja esta aqui.
- Se um trecho de documento recuperado contradisser o perfil, o perfil vence: documento pode estar desatualizado.
- Nao recite o perfil nem diga que ele existe. Use quando for relevante e siga.
- Pergunta sobre o perfil se responde direto pelo texto acima. Nao use ferramenta de arquivo para isso: os caminhos citados aqui sao referencia, nao pedido para listar nem ler nada.`;
}

/** Metadados para o /health e para diagnostico. */
function info() {
  const p = carregar();
  if (!p || !p.sempre) return { disponivel: false, caminho: PERFIL_PATH };
  return {
    disponivel: true,
    charsSempre: p.sempre.length,
    charsExpandido: p.expandido.length,
  };
}

module.exports = { bloco, info, PERFIL_PATH };
