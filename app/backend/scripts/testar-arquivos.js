/**
 * Smoke test da sandbox de arquivos.
 *
 * Aponta CIPHER_ARQUIVOS_RAIZ e CIPHER_LIXEIRA para /tmp ANTES de carregar
 * arquivos.js: o modulo le as duas uma vez, na importacao. Por isso a pasta real
 * do usuario nunca e tocada por este script.
 *
 * ⚠️ A lixeira tambem precisa ser redirecionada, e isto ja foi um defeito: a
 * assercao da Lixeira usava `~/.Trash` cravado, entao cada `npm run testar`
 * depositava lixo na Lixeira DE VERDADE (contrariando o paragrafo acima) e, pior,
 * quebrava quando CIPHER_LIXEIRA estava definida no ambiente — que e o caso em
 * producao. Como os 47 casos sao portao do deploy, isso barraria a publicacao com
 * uma mensagem que nao diz nada sobre a variavel.
 *
 * Rodar: npm run testar
 */
process.env.CIPHER_ARQUIVOS_RAIZ = "/tmp/cipher-sandbox-teste";
process.env.CIPHER_LIXEIRA = "/tmp/cipher-lixeira-teste";

const fs = require("fs");
const path = require("path");
fs.rmSync("/tmp/cipher-sandbox-teste", { recursive: true, force: true });
fs.rmSync("/tmp/cipher-lixeira-teste", { recursive: true, force: true });

const a = require("../arquivos.js");

let passou = 0, falhou = 0;
function ok(nome, cond) {
  if (cond) { passou++; console.log(`  ok   ${nome}`); }
  else { falhou++; console.log(`  FALHA ${nome}`); }
}
async function recusa(nome, fn, codigoEsperado) {
  try { await fn(); falhou++; console.log(`  FALHA ${nome} (deixou passar)`); }
  catch (e) {
    const bate = !codigoEsperado || e.codigo === codigoEsperado;
    if (bate) { passou++; console.log(`  ok   ${nome} -> ${e.codigo}`); }
    else { falhou++; console.log(`  FALHA ${nome} (codigo ${e.codigo})`); }
  }
}

(async () => {
  a.garantirRaiz();
  console.log("\n== escapes de caminho ==");
  await recusa("caminho absoluto", () => a.executarFerramenta("criar_arquivo", { caminho: "/etc/x.md", conteudo: "x" }), "FORA_DA_RAIZ");
  await recusa("til", () => a.executarFerramenta("criar_arquivo", { caminho: "~/x.md", conteudo: "x" }), "FORA_DA_RAIZ");
  await recusa("dot dot", () => a.executarFerramenta("criar_arquivo", { caminho: "../fuga.md", conteudo: "x" }), "FORA_DA_RAIZ");
  await recusa("dot dot fundo", () => a.executarFerramenta("criar_arquivo", { caminho: "a/b/../../../fuga.md", conteudo: "x" }), "FORA_DA_RAIZ");
  await recusa("byte nulo", () => a.executarFerramenta("criar_arquivo", { caminho: "x\0.md", conteudo: "x" }));
  await recusa("vazio", () => a.executarFerramenta("criar_arquivo", { caminho: "", conteudo: "x" }));

  console.log("\n== symlink apontando para fora ==");
  fs.mkdirSync("/tmp/cipher-alvo-externo", { recursive: true });
  fs.symlinkSync("/tmp/cipher-alvo-externo", path.join(a.RAIZ, "atalho"));
  await recusa("escrita via symlink", () => a.executarFerramenta("criar_arquivo", { caminho: "atalho/x.md", conteudo: "x" }), "FORA_DA_RAIZ");
  ok("nada vazou para o alvo externo", fs.readdirSync("/tmp/cipher-alvo-externo").length === 0);

  console.log("\n== extensao e tamanho ==");
  await recusa("extensao proibida", () => a.executarFerramenta("criar_arquivo", { caminho: "virus.exe", conteudo: "x" }), "EXTENSAO_NAO_PERMITIDA");
  await recusa("sem extensao", () => a.executarFerramenta("criar_arquivo", { caminho: "semext", conteudo: "x" }), "EXTENSAO_NAO_PERMITIDA");
  // ⚠️ Deriva do teto real em vez de cravar um numero. A versao anterior usava
  // 600 KB contra o teto de 512 KB; quando o teto subiu para 1 MB (2026-11-01,
  // para caber o maior .jrxml da empresa) o caso passou a FALHAR em silencio
  // conceitual: o arquivo cabia e o teste esperava recusa. Com `a.MAX_BYTES` o
  // caso acompanha qualquer mudanca futura do limite.
  await recusa("grande demais", () => a.executarFerramenta("criar_arquivo", { caminho: "g.md", conteudo: "x".repeat(a.MAX_BYTES + 1024) }), "GRANDE_DEMAIS");

  console.log("\n== caminho feliz ==");
  const criado = await a.executarFerramenta("criar_arquivo", { caminho: "notas/reuniao.md", conteudo: "# Reuniao\nlinha um" });
  ok("criou em subpasta", fs.existsSync(path.join(a.RAIZ, "notas/reuniao.md")));
  ok("devolve caminho relativo", criado.caminho === "notas/reuniao.md");
  await recusa("criar duas vezes", () => a.executarFerramenta("criar_arquivo", { caminho: "notas/reuniao.md", conteudo: "outro" }), "JA_EXISTE");

  const lido = await a.executarFerramenta("ler_arquivo", { caminho: "notas/reuniao.md" });
  ok("leu o conteudo", lido.conteudo.includes("linha um"));

  const listado = await a.executarFerramenta("listar_pasta", { caminho: "." });
  ok("listou a raiz", listado.itens.some((i) => i.nome === "notas" && i.tipo === "pasta"));

  const editado = await a.executarFerramenta("editar_arquivo", { caminho: "notas/reuniao.md", conteudo: "novo texto" });
  ok("editou", fs.readFileSync(path.join(a.RAIZ, "notas/reuniao.md"), "utf8") === "novo texto");
  ok("gerou backup", editado.backup && fs.existsSync(path.join(a.RAIZ, editado.backup)));
  ok("backup tem o conteudo antigo", fs.readFileSync(path.join(a.RAIZ, editado.backup), "utf8").includes("linha um"));

  await recusa("editar inexistente", () => a.executarFerramenta("editar_arquivo", { caminho: "nao-existe.md", conteudo: "x" }), "NAO_ENCONTRADO");
  await recusa("ler inexistente", () => a.executarFerramenta("ler_arquivo", { caminho: "nao-existe.md" }), "NAO_ENCONTRADO");

  console.log("\n== apagar vai para a Lixeira ==");
  const apagado = await a.executarFerramenta("apagar_arquivo", { caminho: "notas/reuniao.md" });
  ok("sumiu da sandbox", !fs.existsSync(path.join(a.RAIZ, "notas/reuniao.md")));
  ok("foi para a Lixeira", apagado.destino === "Lixeira");
  // Com a lixeira redirecionada para /tmp a prova e direta: antes era indireta
  // porque o macOS exige permissao TCC para listar ~/.Trash.
  ok("existe no destino da Lixeira", fs.existsSync(path.join(a.LIXEIRA, "reuniao.md")));
  await recusa("apagar a raiz", () => a.executarFerramenta("apagar_arquivo", { caminho: "." }), "FORA_DA_RAIZ");

  console.log("\n== ferramenta desconhecida ==");
  await recusa("nome inventado", () => a.executarFerramenta("rm_rf", { caminho: "x" }), "FERRAMENTA_DESCONHECIDA");

  console.log(`\nRESULTADO: ${passou} ok, ${falhou} falha(s)`);
  process.exit(falhou ? 1 : 0);
})();
