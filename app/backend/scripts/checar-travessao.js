#!/usr/bin/env node
/**
 * ============================================================
 * CIPHER - Checagem de travessao em frase visivel
 * ============================================================
 * Regra da casa: frase que o usuario final le NAO usa travessao (—). Reescrever
 * com ponto, dois-pontos, virgula ou parenteses.
 *
 * Isto existe porque a regra estava escrita e nao era verificada, que e o motivo
 * de ela ser reincidente. O `grep -vE ":[0-9]+:\s*(//|\*|/\*)"` da regra global
 * NAO serve aqui e da 25 falsos positivos neste front:
 *
 *   - comentario de BLOCO multi-linha, cuja linha do meio nao comeca com `*`
 *     (`   Cipher — Neural Core v5.0`);
 *   - placeholder de valor vazio, que e uso legitimo (`<span id="rs-peso">—</span>`
 *     e `setText(el, info.bytes ? formatarBytes(info.bytes) : "—")`).
 *
 * Uso:  node scripts/checar-travessao.js [arquivo...]
 *       sem argumento, checa o front servido (public/).
 *       --autoteste  prova que o checador detecta (roda no `npm run testar`).
 *
 * Saida: 0 se limpo, 1 listando arquivo:linha de cada caso real.
 *
 * ⚠️ O `--autoteste` nao e zelo: as duas heuristicas abaixo sao regex, e regex
 * que engole demais faz este script responder "nenhum caso" para sempre. Um
 * verificador que nunca acusa e indistinguivel de codigo limpo, que e a mesma
 * armadilha que ele existe para consertar, um nivel acima.
 */

const fs = require("fs");
const path = require("path");

const PADRAO = [
  "public/index.html",
  "public/js/app.js",
  "public/css/style.css",
];

/**
 * Apaga comentarios preservando a contagem de linhas (troca o conteudo por
 * espaco e mantem os \n), para o numero de linha reportado continuar batendo
 * com o arquivo real.
 */
function semComentarios(texto, ext) {
  const vazio = (m) => m.replace(/[^\n]/g, " ");

  if (ext === ".html") {
    return texto.replace(/<!--[\s\S]*?-->/g, vazio);
  }
  // .js e .css: bloco /* */ e, no js, linha //.
  let saida = texto.replace(/\/\*[\s\S]*?\*\//g, vazio);
  if (ext === ".js") {
    // Lookbehind negativo para nao casar o // de dentro de string nem de uma URL
    // (https://): ele testa o caractere anterior sem consumi-lo. Heuristica
    // suficiente para este front; nao e um parser de JS.
    saida = saida.replace(/(?<![:"'`\\])\/\/[^\n]*/g, vazio);
  }
  return saida;
}

/**
 * Placeholder de valor vazio e uso LEGITIMO: celula sem dado. Reconhece o
 * travessao sozinho como conteudo de um elemento (`>—<`) ou de uma string
 * (`"—"`, `'—'`, `` `—` ``), com espaco em volta tolerado.
 */
function ehPlaceholder(linha, indice) {
  return /["'`>]\s*$/.test(linha.slice(0, indice)) && /^\s*["'`<]/.test(linha.slice(indice + 1));
}

/** Acha os casos reais num texto. Devolve [{linha, texto}]. */
function analisar(texto, ext) {
  const achados = [];
  semComentarios(texto, ext)
    .split("\n")
    .forEach((linha, i) => {
      let de = linha.indexOf("—");
      while (de !== -1) {
        if (!ehPlaceholder(linha, de)) {
          achados.push({ linha: i + 1, texto: linha.trim().slice(0, 100) });
        }
        de = linha.indexOf("—", de + 1);
      }
    });
  return achados;
}

// ─────────────────────────────────────────────────────────────
// AUTOTESTE
// ─────────────────────────────────────────────────────────────

if (process.argv.includes("--autoteste")) {
  const CASOS = [
    // [nome, ext, texto, quantos achados esperados]
    ["frase visivel em html", ".html", "<p>Erro ao salvar — tente de novo</p>", 1],
    ["frase visivel em string js", ".js", 'const a = "Falha — revise";', 1],
    ["option, o caso perigoso da regra", ".html", '<option value="">— selecione —</option>', 2],
    ["aria-label", ".html", '<button aria-label="Fechar — cancela">x</button>', 1],
    ["placeholder entre tags", ".html", '<span id="rs-peso">—</span>', 0],
    ["placeholder em string", ".js", 'setText(el, info.bytes ? fmt(info.bytes) : "—");', 0],
    ["comentario de linha", ".js", "// isto — pode ter travessao", 0],
    ["comentario de bloco, linha do meio sem asterisco", ".js", "/* titulo\n   Cipher — Neural Core\n*/", 0],
    ["url com barras nao vira comentario", ".js", 'const u = "https://x.com/a";\nconst t = "Erro — veja";', 1],
    ["comentario html", ".html", "<!-- nota — interna -->", 0],
  ];

  let ok = 0;
  let falhou = 0;
  for (const [nome, ext, texto, esperado] of CASOS) {
    const obtido = analisar(texto, ext).length;
    if (obtido === esperado) {
      ok++;
      console.log(`  ok   ${nome}`);
    } else {
      falhou++;
      console.error(`  FALHA ${nome}: esperado ${esperado}, obtido ${obtido}`);
    }
  }
  console.log(`\nRESULTADO: ${ok} ok, ${falhou} falha(s)`);
  process.exit(falhou === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────
// CHECAGEM
// ─────────────────────────────────────────────────────────────

const alvos = process.argv.slice(2);
const arquivos = (alvos.length ? alvos : PADRAO).map((p) =>
  path.isAbsolute(p) ? p : path.join(__dirname, "..", p)
);

const achados = [];
let checados = 0;

for (const arquivo of arquivos) {
  if (!fs.existsSync(arquivo)) {
    console.error(`aviso: ${arquivo} nao existe, pulado`);
    continue;
  }
  checados++;
  const encontrados = analisar(fs.readFileSync(arquivo, "utf8"), path.extname(arquivo));
  achados.push(...encontrados.map((a) => ({ ...a, arquivo })));
}

if (achados.length === 0) {
  // Conta os que realmente foram lidos, nao os que foram pedidos: arquivo
  // inexistente seria contado como "checado" e esconderia caminho errado.
  console.log(`travessao: nenhum caso em frase visivel (${checados} arquivo(s) checado(s))`);
  process.exit(0);
}

console.error(`travessao: ${achados.length} caso(s) em frase visivel\n`);
for (const a of achados) {
  console.error(`  ${path.relative(path.join(__dirname, ".."), a.arquivo)}:${a.linha}  ${a.texto}`);
}
console.error("\nReescreva com ponto, dois-pontos, virgula ou parenteses.");
process.exit(1);
