#!/usr/bin/env node
/**
 * ============================================================
 * JARVIS - Indexador de documentos (modo documentos / RAG)
 * ============================================================
 * Varre as pastas de RAG_FONTES (.env), quebra os .md em trechos e grava
 * data/indice-rag.json. Tudo local: nada sai da maquina, e o indice fica
 * fora do versionamento (o repo e publico).
 *
 * Uso:  npm run indexar            gera o indice
 *       npm run indexar -- --dry-run   so lista o que seria indexado
 *
 * O indice guarda apenas os trechos; as estatisticas BM25 sao montadas em
 * memoria pelo rag.js na primeira busca. Reindexar = rodar de novo.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Padrao: data/indice-rag.json, o indice que o rag.js le.
 *
 * JARVIS_INDICE_SAIDA existe para o deploy do Sentinel gerar um indice SEPARADO
 * e mais restrito (sem CLAUDE.md nem *.local.md) sem passar por cima deste.
 * Antes de existir, a unica forma seria backup + regerar + restaurar, e um
 * aborto no meio deixaria a maquina sem o indice completo.
 */
// expandirCaminho() e a mesma usada em RAG_FONTES: `~` e a convencao de caminho
// da casa, e sem ela `~/x.json` gravaria numa pasta chamada `~` dentro de
// backend/, com o log imprimindo um caminho que parece certo.
const SAIDA = path.resolve(
  expandirCaminho(process.env.JARVIS_INDICE_SAIDA || "") ||
    path.join(__dirname, "..", "data", "indice-rag.json")
);

// Trecho grande estoura o contexto de 4096 do 3B; pequeno demais perde sentido.
const MAX_TRECHO = 1600;

// Pastas que nunca valem indexar: dependencias, builds e o proprio lixo.
// `_arquivo-conflitos-onedrive` guarda copias antigas de notas do vault: no
// indice elas competem com a versao atual e o BM25 nao sabe qual e a boa.
const PASTAS_IGNORADAS = new Set([
  "node_modules", ".git", ".obsidian", ".trash", ".Trash", "dist", "build",
  "coverage", ".next", ".angular", "venv", ".venv", "data", ".idea", ".vscode",
  "_arquivo-conflitos-onedrive",
]);

/**
 * Padroes de RAG_IGNORAR (.env, separados por `:`): qualquer caminho que contenha
 * um deles fica fora do indice. Existe para excluir nota de contexto morto.
 *
 * Medido em 2026-09-25: uma nota antiga descrevendo outra ocupacao do usuario era
 * recuperada pelo BM25 e o modelo a tratava como verdade atual, contra o que o
 * perfil afirmava. Instrucao de precedencia no prompt nao resolve num 3B; a nota
 * precisa nao estar no indice.
 */
/**
 * RAG_IGNORAR_EXTRA e ADITIVO ao RAG_IGNORAR do .env.
 *
 * Existe porque o dotenv nao sobrescreve variavel ja presente no ambiente: quem
 * quisesse acrescentar um padrao teria de reler o .env e concatenar por fora, e
 * o `deploy-jarvis.sh` fazia isso com `grep | cut`, que nao entende valor entre
 * aspas nem comentario na mesma linha. O filtro pararia de casar em SILENCIO e a
 * nota excluida voltaria ao indice.
 */
const IGNORAR = [process.env.RAG_IGNORAR, process.env.RAG_IGNORAR_EXTRA]
  .filter(Boolean)
  .join(":")
  .split(":")
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);

function ignorado(caminho) {
  if (!IGNORAR.length) return false;
  const alvo = caminho.toLowerCase();
  return IGNORAR.some((p) => alvo.includes(p));
}

function expandirCaminho(p) {
  const limpo = p.trim();
  if (!limpo) return null;
  return limpo.startsWith("~") ? path.join(os.homedir(), limpo.slice(1)) : limpo;
}

function listarMarkdown(raiz) {
  const achados = [];
  const fila = [raiz];
  while (fila.length) {
    const atual = fila.pop();
    let entradas;
    try {
      entradas = fs.readdirSync(atual, { withFileTypes: true });
    } catch (_) {
      continue; // sem permissao ou apagada no meio do caminho
    }
    for (const e of entradas) {
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (e.isDirectory()) {
        if (!PASTAS_IGNORADAS.has(e.name)) fila.push(path.join(atual, e.name));
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        const completo = path.join(atual, e.name);
        if (!ignorado(completo)) achados.push(completo);
      }
    }
  }
  return achados;
}

/**
 * Quebra o markdown em trechos por titulo (#, ## e ###). Bloco maior que
 * MAX_TRECHO e repartido por paragrafo, para nenhum trecho estourar sozinho
 * o orcamento de contexto do modelo.
 */
function chunkar(conteudo, nomeNota) {
  const blocos = [];
  let tituloAtual = nomeNota;
  let linhasAtuais = [];

  const fecharBloco = () => {
    const texto = linhasAtuais.join("\n").trim();
    if (texto) blocos.push({ titulo: tituloAtual, texto });
    linhasAtuais = [];
  };

  for (const linha of conteudo.split("\n")) {
    const m = linha.match(/^#{1,3}\s+(.+)/);
    if (m) {
      fecharBloco();
      tituloAtual = `${nomeNota} › ${m[1].trim()}`;
    } else {
      linhasAtuais.push(linha);
    }
  }
  fecharBloco();

  // Reparte blocos grandes por paragrafo
  const trechos = [];
  for (const bloco of blocos) {
    if (bloco.texto.length <= MAX_TRECHO) {
      trechos.push(bloco);
      continue;
    }
    let atual = "";
    for (const paragrafo of bloco.texto.split(/\n\s*\n/)) {
      if (atual && (atual.length + paragrafo.length + 2) > MAX_TRECHO) {
        trechos.push({ titulo: bloco.titulo, texto: atual.trim() });
        atual = "";
      }
      // Paragrafo sozinho maior que o teto (tabela gigante, base64): corta seco.
      atual += (atual ? "\n\n" : "") + paragrafo.slice(0, MAX_TRECHO);
    }
    if (atual.trim()) trechos.push({ titulo: bloco.titulo, texto: atual.trim() });
  }
  return trechos;
}

function main() {
  const fontes = (process.env.RAG_FONTES || "")
    .split(":")
    .map(expandirCaminho)
    .filter(Boolean);

  if (!fontes.length) {
    console.error("RAG_FONTES vazio no .env. Exemplo:");
    console.error('  RAG_FONTES=~/Obsidian/Obsidian Vault:~/Dev/Jarvis');
    process.exit(1);
  }

  const trechos = [];
  let totalArquivos = 0;

  for (const fonte of fontes) {
    if (!fs.existsSync(fonte)) {
      console.warn(`⚠ Fonte nao existe, pulando: ${fonte}`);
      continue;
    }
    const arquivos = listarMarkdown(fonte);
    console.log(`${fonte}: ${arquivos.length} arquivos .md`);
    totalArquivos += arquivos.length;

    for (const arquivo of arquivos) {
      let conteudo;
      try {
        conteudo = fs.readFileSync(arquivo, "utf8");
      } catch (_) {
        continue;
      }
      // Arquivo vindo de nuvem sem hidratar chega vazio ou com NUL: fora.
      if (!conteudo.trim() || conteudo.includes("\u0000")) continue;

      const nomeNota = path.basename(arquivo, ".md");
      for (const t of chunkar(conteudo, nomeNota)) {
        trechos.push({ arquivo: nomeNota, caminho: arquivo, titulo: t.titulo, texto: t.texto });
      }
    }
  }

  console.log(`\n${totalArquivos} arquivos → ${trechos.length} trechos`);

  if (DRY_RUN) {
    console.log("(dry-run: indice NAO gravado)");
    return;
  }

  fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
  fs.writeFileSync(SAIDA, JSON.stringify({
    versao: 1,
    geradoEm: new Date().toISOString(),
    fontes,
    trechos,
  }));

  const kb = Math.round(fs.statSync(SAIDA).size / 1024);
  console.log(`Indice gravado em ${SAIDA} (${kb} KB)`);
}

main();
