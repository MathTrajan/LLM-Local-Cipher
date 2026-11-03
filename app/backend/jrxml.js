/**
 * ============================================================
 * CIPHER — Validacao de .jrxml (JasperReports)
 * ============================================================
 * Roda ANTES de gravar, no mesmo ponto em que a sandbox valida extensao e
 * tamanho. Arquivo que nao passa nao chega ao disco.
 *
 * Por que isto existe: o modelo e um Qwen 3B. Medido em 2026-11-01, ele produz
 * fragmento de JasperReports correto em ~6 s, mas erra o que um XML exige e uma
 * prosa nao: fecha tag na ordem errada, repete uuid, esquece atributo de cor e
 * devolve `uuid="your-uuid-here"` como placeholder. Nenhum desses erros aparece
 * ao ler a resposta; todos quebram na hora de compilar no JasperSoft Studio.
 *
 * ⚠️ Isto NAO e compilar. O teste real continua sendo emitir no servidor, como
 * diz o CLAUDE.md dos relatorios. O que esta aqui pega o erro barato antes de
 * custar uma ida ao cliente.
 *
 * Sem dependencia nova de proposito: o projeto tem 5 e todas puro JS, o que e o
 * que permite `npm ci` rodar em segundos no Celeron do servidor. Um parser XML
 * de verdade resolveria mais casos, mas o balanceamento de tags cobre o modo de
 * falha que o 3B realmente produz.
 * ============================================================
 */

/** Tags que se fecham sozinhas no padrao JasperReports (`<tag .../>`). */
const AUTO_FECHAVEIS = /\/>\s*$/;

/**
 * Ordem obrigatoria das secoes dentro de <jasperReport>. O JasperReports recusa
 * o arquivo quando elas vem fora desta sequencia, e a mensagem que ele devolve
 * aponta a linha errada: ela cita a secao que veio depois, nao a que estava no
 * lugar errado.
 */
const ORDEM_SECOES = [
  "property", "import", "template", "style", "subDataset", "parameter",
  "queryString", "field", "sortField", "variable", "filterExpression", "group",
  "background", "title", "pageHeader", "columnHeader", "detail", "columnFooter",
  "pageFooter", "lastPageFooter", "summary", "noData",
];

class ErroJrxml extends Error {
  constructor(mensagem, linha = null) {
    super(mensagem);
    this.name = "ErroJrxml";
    this.linha = linha;
  }
}

/**
 * Verifica se as tags abrem e fecham na ordem certa.
 * Devolve array de problemas (vazio = ok).
 */
function conferirBalanceamento(xml) {
  const problemas = [];
  const pilha = [];
  // Ignora comentarios, CDATA, declaracao e DOCTYPE: tudo que pode conter `<`
  // sem ser tag e produziria falso positivo.
  const limpo = xml
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<\?[\s\S]*?\?>/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!DOCTYPE[^>]*>/gi, (m) => m.replace(/[^\n]/g, " "));

  const re = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*)>/g;
  let m;
  while ((m = re.exec(limpo)) !== null) {
    const fechando = m[1] === "/";
    const nome = m[2];
    const autoFecha = AUTO_FECHAVEIS.test(m[0]);
    const linha = limpo.slice(0, m.index).split("\n").length;

    if (autoFecha) continue;
    if (!fechando) {
      pilha.push({ nome, linha });
      continue;
    }
    const aberta = pilha.pop();
    if (!aberta) {
      problemas.push(`linha ${linha}: </${nome}> fecha uma tag que nunca foi aberta`);
    } else if (aberta.nome !== nome) {
      problemas.push(
        `linha ${linha}: </${nome}> fecha fora de ordem. A tag aberta era <${aberta.nome}> na linha ${aberta.linha}`
      );
    }
  }
  for (const sobrou of pilha) {
    problemas.push(`linha ${sobrou.linha}: <${sobrou.nome}> foi aberta e nunca fechada`);
  }
  return problemas;
}

/** Confere a ordem das secoes de primeiro nivel dentro de <jasperReport>. */
function conferirOrdemDasSecoes(xml) {
  const problemas = [];
  const vistas = [];
  /* ⚠️ Remove os <subDataset> antes de olhar a ordem. Um subDataset tem
     `queryString`, `parameter` e `field` PROPRIOS, com indentacao que a regex
     de primeiro nivel nao distingue dos de fora. Sem isto, todo relatorio com
     subDataset era acusado de ordem errada: 59 dos 169 arquivos reais da
     empresa, todos funcionando em producao. Substitui por espacos para os
     numeros de linha continuarem corretos. */
  xml = xml.replace(/<subDataset\b[\s\S]*?<\/subDataset>/g, (m) => m.replace(/[^\n]/g, " "));
  // `[\s/>]` e nao `[\s>]`: secao auto-fechavel (`<title/>`) tem `/` logo
  // depois do nome e escapava da deteccao.
  const re = /^\s{0,4}<(\w+)[\s/>]/gm;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const idx = ORDEM_SECOES.indexOf(m[1]);
    if (idx === -1) continue;
    vistas.push({ nome: m[1], idx, linha: xml.slice(0, m.index).split("\n").length });
  }
  /* ⚠️ `property` fica FORA da checagem de ordem. O JasperReports aceita
     <property> em quase todo elemento (band, textField, reportElement), e a
     regex de primeiro nivel nao distingue a do topo das aninhadas. Validar a
     posicao dela acusava 31 dos 169 arquivos reais, todos corretos: o padrao
     era sempre "property veio depois de summary", que e uma property dentro da
     ultima banda. A ordem das OUTRAS secoes continua valendo. */
  const relevantes = vistas.filter((v) => v.nome !== "property");

  for (let i = 1; i < relevantes.length; i++) {
    const vistas = relevantes;   // mantem o resto do laco legivel
    // Secao repetida (varios <field>, varios <parameter>) e normal e nao conta.
    if (vistas[i].idx < vistas[i - 1].idx && vistas[i].nome !== vistas[i - 1].nome) {
      problemas.push(
        `linha ${vistas[i].linha}: <${vistas[i].nome}> veio depois de <${vistas[i - 1].nome}>. ` +
          `A ordem exigida e: ${ORDEM_SECOES.join(", ")}`
      );
    }
  }
  return problemas;
}

/**
 * Regras do padrao A2O que o 3B erra com frequencia.
 * Cada uma nasceu de uma armadilha ja paga, documentada no CLAUDE.md dos
 * relatorios.
 */
function conferirPadraoA2O(xml) {
  const problemas = [];

  // 1. `style` fora do <reportElement>. O JasperReports ignora em silencio e o
  //    layout sai sem formatacao nenhuma, sem erro em lugar nenhum.
  const styleForaDoLugar = xml.match(/<(textField|staticText|rectangle|line|image)\s[^>]*\bstyle=/g);
  if (styleForaDoLugar) {
    problemas.push(
      `${styleForaDoLugar.length} elemento(s) com \`style\` fora do <reportElement>. ` +
        `O atributo vai no <reportElement>, senao o estilo e ignorado SEM erro.`
    );
  }

  // 2. UUID placeholder. O modelo adora devolver "your-uuid-here" ou "uuid".
  const placeholders = xml.match(/uuid="(?!([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")[^"]*"/gi);
  if (placeholders) {
    problemas.push(
      `${placeholders.length} uuid invalido (ex.: ${placeholders[0]}). ` +
        `Use UUID v4 de verdade, no formato 8-4-4-4-12 hexadecimal.`
    );
  }

  // 3. UUID repetido. O Studio abre, mas o comportamento fica imprevisivel.
  const uuids = [...xml.matchAll(/uuid="([0-9a-f-]{36})"/gi)].map((m) => m[1].toLowerCase());
  const repetidos = uuids.filter((u, i) => uuids.indexOf(u) !== i);
  if (repetidos.length) {
    problemas.push(`uuid repetido ${repetidos.length} vez(es): ${[...new Set(repetidos)].slice(0, 3).join(", ")}`);
  }

  // 4. Caracteres que nao existem na Helvetica do PDF: saem como quadrado vazio.
  const foraDaHelvetica = [...new Set((xml.match(/[−➜✂]/g) || []))];
  if (foraDaHelvetica.length) {
    problemas.push(
      `caractere(s) que a Helvetica do PDF nao tem: ${foraDaHelvetica.join(" ")}. ` +
        `Troque por - ou por texto.`
    );
  }

  // 5. isIgnorePagination. Reprovado pelo conferidor de padrao da A2O.
  if (/isIgnorePagination\s*=\s*"true"/.test(xml)) {
    problemas.push(`isIgnorePagination="true" nao e aceito no padrao A2O.`);
  }

  // 6. Pagina fora do A4 retrato (595x842) ou paisagem (842x595).
  const larg = xml.match(/pageWidth="(\d+)"/);
  const alt = xml.match(/pageHeight="(\d+)"/);
  if (larg && alt) {
    const w = Number(larg[1]), h = Number(alt[1]);
    const ehA4 = (w === 595 && h === 842) || (w === 842 && h === 595);
    if (!ehA4) {
      problemas.push(`pagina ${w}x${h} nao e A4. Use 595x842 (retrato) ou 842x595 (paisagem).`);
    }
  }

  // 7. A cor recusada pelo usuario em 2026-10-16.
  if (/#4C537B/i.test(xml)) {
    problemas.push(`cor #4C537B foi recusada ("nao ficou no azul"). O azul A2O e #415F83.`);
  }

  return problemas;
}

/**
 * Valida o conteudo de um .jrxml. Lanca ErroJrxml com TODOS os problemas
 * juntos, nao so o primeiro: o modelo precisa ver a lista inteira para corrigir
 * numa tentativa, e cada nova tentativa custa segundos de inferencia.
 */
/**
 * @param {string} conteudo
 * @param {{ padraoA2O?: boolean }} opcoes
 *
 * ⚠️ `padraoA2O` e FALSO por padrao, e essa escolha vem de um erro medido.
 * A primeira versao checava o padrao sempre, inclusive no upload. Mas o arquivo
 * que o usuario sobe e justamente o que esta FORA do padrao: e o que vai ser
 * migrado. Resultado: 81% dos 169 .jrxml reais da empresa eram recusados no
 * upload (83 por pagina fora do A4, 35 pela cor recusada, 27 por
 * isIgnorePagination), e o fluxo inteiro de migracao ficava bloqueado.
 *
 * Estrutura (XML bem formado, ordem das secoes) vale SEMPRE: arquivo quebrado
 * nao serve nem para ser lido. Padrao A2O vale so para o que o Cipher CRIA.
 */
function validar(conteudo, { padraoA2O = false } = {}) {
  const xml = String(conteudo || "");

  if (!/<jasperReport[\s>]/.test(xml)) {
    throw new ErroJrxml("o arquivo nao tem <jasperReport>. Um .jrxml precisa da raiz jasperReport.");
  }

  const problemas = [
    ...conferirBalanceamento(xml),
    ...conferirOrdemDasSecoes(xml),
    ...(padraoA2O ? conferirPadraoA2O(xml) : []),
  ];

  if (problemas.length) {
    throw new ErroJrxml(
      `O .jrxml tem ${problemas.length} problema(s):\n` +
        problemas.map((p, i) => `  ${i + 1}. ${p}`).join("\n")
    );
  }
  return true;
}

module.exports = { validar, ErroJrxml, ORDEM_SECOES };

/* ═══════════════════════════════════════════════════════════
   RESUMIR: de .jrxml existente para especificacao compacta
   ═══════════════════════════════════════════════════════════
   O caso de uso e "pegue este relatorio e ponha no padrao A2O". O arquivo
   enviado tem, em media, 17 mil tokens (medido nos 175 .jrxml da empresa) e o
   contexto do modelo e de 8.192. Mandar o XML inteiro e impossivel, e truncar
   seria pior: o modelo veria metade do arquivo e inventaria o resto.

   A saida daqui e o CONTRATO e o INVENTARIO do relatorio: o que ele recebe
   (parametros), o que ele le (fields), o que ele escreve (textos e expressoes),
   e como esta dividido (bandas). Com isso o modelo escreve o gerador Python; o
   XML velho nunca precisa ser lido por ele.

   ⚠️ Isto NAO preserva layout (x, y, largura, cor). E deliberado: o objetivo e
   justamente refazer o visual no padrao A2O. Guardar as coordenadas antigas
   empurraria o modelo a reproduzir o layout fora do padrao, que e o oposto do
   pedido.
*/

/** Tira CDATA e normaliza espaco de uma expressao, para caber numa linha. */
function limparExpr(txt) {
  return String(txt || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Decodifica as cinco entidades XML, para o texto sair legivel. */
function desescapar(txt) {
  return String(txt || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Conta os rotulos de todas as bandas de um tipo (`detail`, `columnHeader`...).
 *
 * ⚠️ Usa o MESMO filtro da secao "Secoes" do resumo (`limparExpr` + `desescapar`
 * + descarta vazio). Contar `<text>` cru daria um numero diferente do que o
 * resumo mostra duas linhas acima, no mesmo prompt: o modelo leria "columnHeader
 * com 6 rotulos" na instrucao e um inventario com outra contagem em cima, e nao
 * tem como saber qual acreditar.
 */
function rotulosDaBanda(xml, banda) {
  const re = new RegExp(`<${banda}\\b[\\s\\S]*?</${banda}>`, "g");
  return [...xml.matchAll(re)].reduce(
    (n, m) =>
      n +
      [...m[0].matchAll(/<text>([\s\S]*?)<\/text>/g)]
        .map((t) => desescapar(limparExpr(t[1])))
        .filter(Boolean).length,
    0
  );
}

/**
 * Decide se o arquivo e FICHA CADASTRAL ou LISTAGEM, que e a pergunta que muda
 * tudo: ficha quer campo empilhado e listagem quer tabela, e os dois nao se
 * convertem um no outro.
 *
 * ⚠️ A contagem de `<field>` NAO serve para isso, e usa-la foi um erro medido
 * em 2026-11-03: `pessoa_imprimir_3` (ficha) tem 73 campos e `relconhecimento_7`
 * (listagem de CT-e) tem 75. O limiar de 20 campos classificava os dois como
 * ficha, e o sistema mandou o modelo recusar um pedido que o montador atendia.
 * Campo declarado no dataset nao e coluna exibida: um relatorio pode declarar 75
 * e mostrar 6.
 *
 * O que separa de verdade, medido nos dois arquivos:
 *
 * |                | listagem | ficha |
 * |----------------|----------|-------|
 * | columnHeader   | 6 rotulos| ausente |
 * | detail         | vazio    | 89 rotulos empilhados, altura 56 |
 * | Sum/Count      | 13       | 0 |
 * | grupos         | 2        | 0 |
 *
 * Tabela tem linha de cabecalho e repete so o dado; ficha repete o ROTULO em
 * cada registro, porque cada campo leva o seu nome ao lado.
 */
function classificarLayout(xml) {
  const sinais = {
    rotulosColHeader: rotulosDaBanda(xml, "columnHeader"),
    rotulosDetail: rotulosDaBanda(xml, "detail"),
    totalizadores: (xml.match(/calculation="(Sum|Count|Average)"/g) || []).length,
    grupos: (xml.match(/<group name="/g) || []).length,
    campos: (xml.match(/<field name="/g) || []).length,
    // O que o relatorio REALMENTE mostra, por banda. Ver exibicoesPorBanda().
    ...exibicoesPorBanda(xml),
  };

  /* Ficha exige os DOIS sinais: sem cabecalho de tabela E com rotulo empilhado
     no detail. Só a ausencia de columnHeader nao basta — relatorio que desenha
     tudo em groupFooter tambem nao tem, e e listagem. */
  if (sinais.rotulosColHeader < 2 && sinais.rotulosDetail >= 8) {
    return { tipo: "ficha", sinais };
  }

  /* ⚠️ TERCEIRO tipo, e a falta dele me fez errar o diagnostico em 2026-11-03.
     Eu tinha dois baldes (ficha e listagem) e disse ao usuario que o
     `relconhecimento_7` era "listagem, o montador atende". Nao e: o `detail`
     dele esta VAZIO (nenhuma expressao de campo), os numeros saem de 13
     variaveis `$V{SUM...}` nos `groupFooter`, e o corpo e totais por UF e por
     CFOP. Isso e relatorio AGREGADO.
     A diferenca importa porque o montador monta tabela de LINHAS: passar um
     agregado por ele devolve um relatorio valido, bonito e estruturalmente
     diferente do que o cliente usa. E o mesmo "valido e inutil" de sempre, so
     que num nivel que nenhuma das outras guardas alcanca.
     O sinal e direto: nada de campo no detail, e agregacao exibida fora dele. */
  if (sinais.camposNoDetail === 0 && sinais.variaveisExibidas > 0) {
    return { tipo: "agregado", sinais };
  }

  if (sinais.rotulosColHeader >= 2 || sinais.totalizadores > 0 || sinais.grupos > 0) {
    return { tipo: "listagem", sinais };
  }
  return { tipo: "indefinido", sinais };
}

/**
 * O que o relatorio EXIBE, separado do que ele declara.
 *
 * ⚠️ Declarar nao e exibir, e confundir os dois foi a raiz de dois diagnosticos
 * errados: um relatorio pode declarar 75 `<field>` e mostrar 2. O que diz o
 * formato e a expressao dentro da banda, nao a lista do contrato.
 */
function exibicoesPorBanda(xml) {
  /* ⚠️ So conta variavel que o relatorio DECLARA com `calculation`. Contar todo
     `$V{}` exibido classificava errado, e isso foi medido antes de subir: o
     `nfs-listagem.jrxml` caiu em "agregado" por causa de DUAS variaveis que
     nenhum relatorio escapa de ter, `PAGE_NUMBER` e companhia, que o
     JasperReports injeta sozinho no rodape e ninguem declara.
     Agregacao de verdade e `<variable calculation="Sum">` escrita no arquivo. */
  const agregadasDeclaradas = new Set(
    [...xml.matchAll(/<variable name="([^"]+)"[^>]*calculation="(Sum|Count|Average|Highest|Lowest)"/g)]
      .map((m) => m[1])
  );

  const bandas = [...xml.matchAll(
    /<(title|pageHeader|columnHeader|detail|columnFooter|pageFooter|summary|groupHeader|groupFooter)\b[\s\S]*?<\/\1>/g
  )];
  const camposExibidos = new Set();
  const variaveis = new Set();
  let camposNoDetail = 0;

  for (const b of bandas) {
    const exprs = [...b[0].matchAll(/<textFieldExpression>([\s\S]*?)<\/textFieldExpression>/g)]
      .map((m) => limparExpr(m[1]));
    for (const e of exprs) {
      for (const m of e.matchAll(/\$F\{([^}]+)\}/g)) {
        camposExibidos.add(m[1]);
        if (b[1] === "detail") camposNoDetail++;
      }
      for (const m of e.matchAll(/\$V\{([^}]+)\}/g)) {
        if (agregadasDeclaradas.has(m[1])) variaveis.add(m[1]);
      }
    }
  }
  return {
    camposExibidos: [...camposExibidos],
    camposNoDetail,
    variaveisExibidas: variaveis.size,
    variaveis: [...variaveis],
  };
}

/**
 * Le um .jrxml e devolve a especificacao em markdown compacto.
 * `limiteTextos` corta a lista de rotulos: num relatorio com 53 staticText, os
 * primeiros ja mostram o padrao de nomenclatura e o resto e repeticao.
 * `caminho` entra na secao "O que fazer" como valor pronto de `herdarDe`, que e
 * justamente o argumento que o modelo mais esquece.
 */
function resumir(conteudo, { limiteTextos = 40, limiteExpr = 30, tetoTokens = 2600, caminho = null } = {}) {
  const xml = String(conteudo || "");

  /* ⚠️ Teto DURO de tamanho. Medido em 2026-11-03 com o pessoa_imprimir_3.jrxml
     (313 KB, 100 mil tokens): o resumo saiu com 12.187 tokens, MAIOR que o
     contexto inteiro do modelo (8.192). Comprimir 92% nao basta quando o
     arquivo e grande o suficiente, e o sintoma seria o pior possivel: o
     llama.cpp descarta o inicio do prompt em silencio e o modelo responde sobre
     a metade do arquivo que sobrou, sem nada indicando a perda.
     Arquivo grande entra em modo enxuto: so o contrato e a contagem por secao,
     sem rotulo nem expressao. */
  const enxuto = xml.length / 3.2 > 40000;
  if (enxuto) { limiteTextos = 0; limiteExpr = 0; }

  const linhas = [];

  const nome = xml.match(/<jasperReport[^>]*\bname="([^"]+)"/);
  const pw = xml.match(/pageWidth="(\d+)"/);
  const ph = xml.match(/pageHeight="(\d+)"/);
  const cw = xml.match(/columnWidth="(\d+)"/);

  linhas.push(`# Relatorio: ${nome ? nome[1] : "(sem nome)"}`);
  if (pw && ph) {
    const orient = Number(pw[1]) > Number(ph[1]) ? "paisagem" : "retrato";
    const ehA4 = (pw[1] === "595" && ph[1] === "842") || (pw[1] === "842" && ph[1] === "595");
    linhas.push(`Pagina: ${pw[1]}x${ph[1]} (${orient})${ehA4 ? "" : " [FORA DO A4, corrigir]"}`);
  }
  if (cw) linhas.push(`Largura util: ${cw[1]}`);

  // ─── Contrato: o que nao pode mudar ───
  const params = [...xml.matchAll(/<parameter name="([^"]+)"[^>]*class="([^"]+)"/g)]
    .map((m) => `${m[1]}: ${m[2].replace(/^java\.lang\./, "")}`);
  if (params.length) {
    linhas.push(`\n## Parametros (${params.length}) - copiar intactos do padrao`);
    linhas.push(params.join(", "));
  }

  const fields = [...xml.matchAll(/<field name="([^"]+)"[^>]*class="([^"]+)"/g)]
    .map((m) => `${m[1]}: ${m[2].replace(/^java\.lang\./, "").replace(/^java\.util\./, "")}`);
  if (fields.length) {
    linhas.push(`\n## Campos (${fields.length}) - copiar intactos do padrao`);
    linhas.push(fields.join(", "));
  }

  const vars = [...xml.matchAll(/<variable name="([^"]+)"[^>]*calculation="([^"]+)"/g)]
    .map((m) => `${m[1]} (${m[2]})`);
  if (vars.length) linhas.push(`\n## Variaveis (${vars.length})\n${vars.join(", ")}`);

  const grupos = [...xml.matchAll(/<group name="([^"]+)"/g)].map((m) => m[1]);
  if (grupos.length) linhas.push(`\n## Grupos\n${grupos.join(", ")}`);

  // ─── Inventario por banda: e o que diz o que o relatorio MOSTRA ───
  const bandas = [...xml.matchAll(
    /<(title|pageHeader|columnHeader|detail|columnFooter|pageFooter|summary|background|groupHeader|groupFooter)\b[\s\S]*?<\/\1>/g
  )];
  if (bandas.length) {
    linhas.push(`\n## Secoes`);
    for (const b of bandas) {
      const secao = b[1];
      const corpo = b[0];
      const textos = [...corpo.matchAll(/<text>([\s\S]*?)<\/text>/g)]
        .map((m) => desescapar(limparExpr(m[1]))).filter(Boolean);
      const exprs = [...corpo.matchAll(/<textFieldExpression>([\s\S]*?)<\/textFieldExpression>/g)]
        .map((m) => desescapar(limparExpr(m[1]))).filter(Boolean);
      const alt = corpo.match(/<band height="(\d+)"/);
      linhas.push(`\n### ${secao}${alt ? ` (altura ${alt[1]})` : ""}`);
      if (textos.length) {
        linhas.push(`Rotulos: ${textos.slice(0, limiteTextos).join(" | ")}` +
          (textos.length > limiteTextos ? ` ... +${textos.length - limiteTextos}` : ""));
      }
      if (exprs.length) {
        linhas.push(`Expressoes: ${exprs.slice(0, limiteExpr).join(" | ")}` +
          (exprs.length > limiteExpr ? ` ... +${exprs.length - limiteExpr}` : ""));
      }
      if (!textos.length && !exprs.length) linhas.push("(sem texto)");
    }
  }

  // ─── Sinais de problema, para o modelo saber o que corrigir ───
  const alertas = [];

  if (/<subreport\b/.test(xml)) {
    alertas.push("USA SUBRELATORIO: na base A2O isso falha com Resource not found. Troque por tabela() com jr:list.");
  }
  if (/isIgnorePagination\s*=\s*"true"/.test(xml)) alertas.push("isIgnorePagination=true: remover.");
  if (/language="groovy"/.test(xml)) alertas.push('language="groovy": trocar para java.');
  if (/#4C537B/i.test(xml)) alertas.push("usa #4C537B, que foi recusado. O azul A2O e #415F83.");
  const fontes = [...new Set([...xml.matchAll(/fontName="([^"]+)"/g)].map((m) => m[1]))];
  if (fontes.length) alertas.push(`declara fontName (${fontes.join(", ")}): o padrao A2O nao declara fonte.`);
  if (alertas.length) linhas.push(`\n## Corrigir ao migrar\n` + alertas.map((a, i) => `${i + 1}. ${a}`).join("\n"));

  let saida = linhas.join("\n");

  /* Ultimo corte: se mesmo enxuto passar do teto, trunca pela metade das listas
     de campo e parametro, que sao o que mais cresce. */
  const tokens = () => saida.length / 3.2;
  if (tokens() > tetoTokens) {
    saida = saida.replace(/^(## (?:Campos|Parametros)[^\n]*\n)([^\n]+)$/gm, (m, cab, lista) => {
      const itens = lista.split(", ");
      const metade = itens.slice(0, Math.max(12, Math.floor(itens.length / 3)));
      return cab + metade.join(", ") + ` ... +${itens.length - metade.length} (lista cortada)`;
    });
  }
  if (tokens() > tetoTokens) {
    saida = saida.slice(0, Math.floor(tetoTokens * 3.2))
      + "\n\n[resumo cortado no teto de contexto]";
  }

  /* ⚠️ A instrucao e colada DEPOIS do corte, de proposito. Ela e a parte que
     muda o comportamento, e os dois truncamentos acima cortam pelo fim: num
     arquivo grande ela seria justamente o que se perde, deixando o modelo com
     os dados e sem o que fazer com eles. */
  return saida + instrucaoDeUso(xml, caminho);
}

/**
 * O passo seguinte, escrito para o modelo e nao para o usuario.
 *
 * ⚠️ Isto existe porque entregar a especificacao sozinha nao bastou. Medido em
 * 2026-11-03 com o `relconhecimento_7`: o modelo recebeu o resumo, nao chamou
 * ferramenta nenhuma e devolveu a especificacao REESCRITA de memoria como se
 * fosse o arquivo pronto, com numeros trocados (disse 8 campos onde ha 75) e um
 * nome de arquivo que nunca existiu. Dados sem instrucao, um modelo pequeno
 * preenche com o que parece plausivel.
 */
function instrucaoDeUso(xml, caminho) {
  const { tipo, sinais } = classificarLayout(xml);
  const origem = caminho ? `"${caminho}"` : "o caminho do arquivo que voce leu";
  /* ⚠️ O nome de saida vai MASCADO, nao como regra a interpretar. Dizer "use um
     nome diferente do original" nao funcionou: em 2026-11-03 o modelo pediu
     saida com o nome do proprio arquivo de origem e o .jrxml de 28 KB do
     cliente foi sobrescrito por 11 KB gerados. A guarda no montador agora
     recusa isso, mas recusa custa uma inferencia inteira; entregar o nome
     pronto acerta na primeira. */
  const sugestao = caminho
    ? `"${String(caminho).replace(/\.jrxml$/i, "")}-a2o.jrxml"`
    : '"<nome-do-original>-a2o.jrxml"';

  if (tipo === "ficha") {
    return (
      `\n\n## O que fazer\n` +
      `ISTO E FICHA CADASTRAL: nao tem columnHeader e empilha ${sinais.rotulosDetail} ` +
      `rotulos no detail, um ao lado de cada campo.\n` +
      `A ferramenta gerar_relatorio_a2o faz TABELA e NAO serve aqui. ` +
      `Diga isso ao usuario em uma frase e aponte o _ficha.py, que monta campo ` +
      `empilhado em secoes.\n` +
      `NAO gere arquivo e NAO diga que gerou: nenhum arquivo existe nesta resposta.`
    );
  }

  if (tipo === "agregado") {
    return (
      `\n\n## O que fazer\n` +
      `ISTO E RELATORIO AGREGADO, nao listagem: o detail nao mostra campo ` +
      `nenhum e os numeros saem de ${sinais.variaveisExibidas} variaveis ` +
      `(${sinais.variaveis.slice(0, 6).join(", ")}${sinais.variaveis.length > 6 ? ", ..." : ""}) ` +
      `nos grupos e no summary. O corpo sao TOTAIS por grupo, nao linhas.\n` +
      `O gerar_relatorio_a2o monta tabela de LINHAS. Ele NAO reproduz este ` +
      `relatorio: o que sair vai ser valido e estruturalmente diferente do que ` +
      `o cliente usa hoje.\n` +
      `Nao gere sem confirmar. Diga ao usuario, em uma frase, que o original e ` +
      `um relatorio de totais agrupados e pergunte qual dos dois ele quer:\n` +
      `  (a) a listagem detalhada dos registros, que o montador faz; ou\n` +
      `  (b) o mesmo agregado, que hoje sai pelo _ficha.py.\n` +
      `Os unicos campos exibidos no original sao: ` +
      `${sinais.camposExibidos.join(", ") || "nenhum"}.`
    );
  }

  if (tipo === "listagem") {
    const porque = [
      sinais.rotulosColHeader >= 2 ? `columnHeader com ${sinais.rotulosColHeader} rotulos` : null,
      sinais.totalizadores ? `${sinais.totalizadores} totalizadores Sum/Count` : null,
      sinais.grupos ? `${sinais.grupos} grupo(s)` : null,
    ].filter(Boolean).join(", ");
    return (
      `\n\n## O que fazer\n` +
      `ISTO E LISTAGEM (${porque}), e o gerar_relatorio_a2o atende.\n` +
      `Chame a ferramenta AGORA, nesta mesma resposta. Nao responda em texto e ` +
      `nao reescreva a especificacao acima: ela e o material, nao o resultado.\n` +
      `Argumentos:\n` +
      /* Sem travessao: o modelo copia o texto da instrucao para a resposta, e a
         resposta e frase visivel ao usuario. */
      `- herdarDe: ${origem}. O contrato sai dele, nao liste campos a mao.\n` +
      `- saida: ${sugestao}. Nunca o nome do original: gravar ali destroi o ` +
      `arquivo que o usuario enviou, e o montador recusa.\n` +
      `- colunas: so as que o pedido exige, de 2 a 14 (acima de 8 vira paisagem). ` +
      `Uma coluna so e recusado: tabela de uma coluna nao mostra nada.\n` +
      /* ⚠️ Medido em 2026-11-03: os rotulos sairam certos e o `campo` de cada
         coluna veio inventado ($F{G}, $F{dt}, $F{op}). Rotulo e texto livre;
         `campo` e chave do dataset e tem de ser copiado letra por letra. */
      `  O "campo" de cada coluna, KPI, total, agruparPor e grafico precisa ser ` +
      `um nome COPIADO da lista "## Campos" acima, letra por letra. Nome ` +
      `abreviado ou inventado e recusado: $F{G} nao existe, razaoSocialTomador ` +
      `existe. O rotulo pode ser livre; o campo nao.\n` +
      /* ⚠️ Medido em 2026-11-03: pedido generico ("coloque no padrao a2o"), sem
         dizer colunas, e o modelo inventou `numero`, `descricao` e `valorTotal`.
         Nenhum existe. Quando ninguem diz quais colunas, as certas sao as que o
         ORIGINAL ja exibe, e isso esta no arquivo: basta nao deixar ele
         adivinhar. */
      (sinais.camposExibidos.length
        ? `  Se o pedido NAO disser quais colunas, use as que o original ja ` +
          `exibe: ${sinais.camposExibidos.join(", ")}. Nao invente nome ` +
          `generico como "numero" ou "valorTotal".\n`
        : "") +
      `Os ${sinais.campos} campos listados acima sao o dataset inteiro, NAO ` +
      `${sinais.campos} colunas.`
    );
  }

  /* ⚠️ Este ramo nao e exceção rara: medido nos 6 .jrxml da sandbox em
     2026-11-03, TRES caem aqui. Sao arquivos que nao exibem nada nas bandas
     padrao (modelo/esqueleto, ou corpo montado em componente que este extrator
     nao le). Afirmar o tipo nesse caso seria inventar; pedir confirmacao e a
     resposta certa, e por isso a mensagem precisa ser util e nao so evasiva. */
  return (
    `\n\n## O que fazer\n` +
    `NAO DA PARA DIZER o tipo por este arquivo: as bandas padrao nao exibem ` +
    `campo nem agregacao (columnHeader: ${sinais.rotulosColHeader} rotulos, ` +
    `detail: ${sinais.camposNoDetail} campos, ${sinais.camposExibidos.length} ` +
    `campo(s) exibido(s) em ${sinais.campos} declarados). Pode ser modelo sem ` +
    `corpo, ou corpo montado em componente (jr:table, jr:list) que o extrator ` +
    `nao le.\n` +
    `Nao gere no escuro. Diga ao usuario o que voce viu, em uma frase, e ` +
    `pergunte quais colunas ele quer.\n` +
    `Nao diga que gerou arquivo sem ter chamado a ferramenta.`
  );
}

module.exports.resumir = resumir;
module.exports.classificarLayout = classificarLayout;
