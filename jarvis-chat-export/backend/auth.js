/**
 * ============================================================
 * JARVIS — Autenticacao por senha
 * ============================================================
 * Existe porque o Jarvis saiu do localhost e passou a ser publicado em
 * jarvis.trajano.tech (2026-10-31). Sem isto, qualquer visitante usaria o LLM,
 * leria o vault do Obsidian pelo modo documentos e gravaria arquivo na sandbox.
 *
 * A alternativa avaliada foi o Cloudflare Access, que barraria na borda e seria
 * melhor. Foi descartado porque o checkout dele exige cadastrar cartao de
 * credito mesmo no plano gratuito. Consequencia aceita: o trafego hostil agora
 * CHEGA no servidor em vez de morrer na borda da Cloudflare, e o rate limit do
 * login e que segura.
 *
 * Sem dependencia nova, de proposito: `crypto` nativo faz scrypt e HMAC, e o
 * projeto tem 5 dependencias que cabem num Celeron sem build nativo.
 *
 * ⚠️ NAO guarda a senha, nem reversivel nem em texto claro: guarda o hash
 * scrypt com salt, em /etc/jarvis.env (root 600). Gere com `npm run senha`.
 * ============================================================
 */

const crypto = require("crypto");
const { getEnvString } = require("./config");

/* Parametros do scrypt. N=16384 leva ~50 ms num Celeron N2807, que e lento o
   bastante para atrapalhar forca bruta e rapido o bastante para o login nao
   parecer travado. Subir N encarece o ATACANTE e o dono na mesma proporcao. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const TAM_CHAVE = 64;

const NOME_COOKIE = "jarvis_sessao";
const DURACAO_MS = 30 * 24 * 60 * 60 * 1000;   // 30 dias

/** Gera `salt:hash` para gravar no env. */
function gerarHash(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .scryptSync(senha, salt, TAM_CHAVE, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
    .toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Confere a senha contra o hash armazenado.
 *
 * ⚠️ `timingSafeEqual` e nao `===`: comparacao normal de string sai no primeiro
 * byte diferente, e a diferenca de tempo vaza quantos bytes o atacante acertou.
 * Com hash de 64 bytes isso e teorico, mas e uma linha.
 */
function conferirSenha(senha, armazenado) {
  if (!armazenado || !armazenado.includes(":")) return false;
  const [salt, hashEsperado] = armazenado.split(":");
  if (!salt || !hashEsperado) return false;

  let hash;
  try {
    hash = crypto.scryptSync(senha, salt, TAM_CHAVE, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  } catch (_) {
    return false;
  }
  const esperado = Buffer.from(hashEsperado, "hex");
  if (esperado.length !== hash.length) return false;
  return crypto.timingSafeEqual(hash, esperado);
}

/**
 * Cria o middleware de autenticacao e as rotas de login/logout.
 * Devolve `null` quando a autenticacao esta desligada.
 */
function criar({ atrasDeProxy }) {
  const hashSenha = getEnvString("JARVIS_SENHA_HASH", "");

  /* ⚠️ Publicado SEM senha e recusa de subir, nao aviso.
     Esta e a trava que impede o cenario pior: alguem copia o /etc/jarvis.env,
     esquece a linha da senha, reinicia o servico e o chat fica aberto para a
     internet inteira sem nada na tela dizendo isso. Melhor o servico nao subir
     e o deploy falhar alto. */
  if (atrasDeProxy && !hashSenha) {
    throw new Error(
      "ATRAS_DE_PROXY=1 sem JARVIS_SENHA_HASH: o Jarvis ficaria exposto sem autenticacao. " +
        "Gere o hash com `npm run senha` e grave em /etc/jarvis.env."
    );
  }

  // Em local, sem hash configurado, a autenticacao fica fora do caminho: o
  // Jarvis continua abrindo direto em localhost, como sempre foi.
  if (!hashSenha) return null;

  /* Segredo que assina o cookie. Sem ele no env, gera um por processo: as
     sessoes morrem a cada restart, o que e inconveniente mas nao inseguro.
     Avisa, porque "fui deslogado de novo" e um sintoma que leva a investigar o
     lugar errado. */
  let segredo = getEnvString("JARVIS_SESSAO_SEGREDO", "");
  if (!segredo) {
    segredo = crypto.randomBytes(32).toString("hex");
    console.warn(
      "[auth] JARVIS_SESSAO_SEGREDO ausente: usando segredo efemero. " +
        "Toda reinicializacao vai deslogar voce."
    );
  }

  function assinar(valor) {
    return crypto.createHmac("sha256", segredo).update(valor).digest("hex");
  }

  function criarToken() {
    const expira = Date.now() + DURACAO_MS;
    const corpo = String(expira);
    return `${corpo}.${assinar(corpo)}`;
  }

  function tokenValido(token) {
    if (typeof token !== "string" || !token.includes(".")) return false;
    const corte = token.lastIndexOf(".");
    const corpo = token.slice(0, corte);
    const assinatura = token.slice(corte + 1);

    const esperada = Buffer.from(assinar(corpo), "utf8");
    const recebida = Buffer.from(assinatura, "utf8");
    if (esperada.length !== recebida.length) return false;
    if (!crypto.timingSafeEqual(esperada, recebida)) return false;

    const expira = Number(corpo);
    return Number.isFinite(expira) && Date.now() < expira;
  }

  /* Parser de cookie proprio: `cookie-parser` seria uma sexta dependencia para
     ler um unico valor. So precisa achar o nome exato e devolver o resto. */
  function lerCookie(req) {
    const cru = req.headers.cookie;
    if (!cru) return null;
    for (const parte of cru.split(";")) {
      const eq = parte.indexOf("=");
      if (eq === -1) continue;
      if (parte.slice(0, eq).trim() === NOME_COOKIE) {
        return decodeURIComponent(parte.slice(eq + 1).trim());
      }
    }
    return null;
  }

  function definirCookie(res, token) {
    const partes = [
      `${NOME_COOKIE}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",                        // fora do alcance de JS, logo de XSS
      "SameSite=Lax",                    // nao viaja em requisicao de outro site
      `Max-Age=${Math.floor(DURACAO_MS / 1000)}`,
    ];
    /* ⚠️ `Secure` SO atras do proxy: em localhost o Jarvis fala HTTP, e um
       cookie Secure simplesmente nao seria guardado pelo navegador. O login
       entraria em laco infinito, e o sintoma pareceria senha errada. */
    if (atrasDeProxy) partes.push("Secure");
    res.setHeader("Set-Cookie", partes.join("; "));
  }

  function limparCookie(res) {
    res.setHeader("Set-Cookie", `${NOME_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  /** Caminhos que precisam responder sem sessao, senao nao da para logar. */
  const LIVRES = new Set([
    "/login",
    "/login.html",
    "/api/login",
    "/api/health",      // o deploy valida por aqui, e nao expoe conteudo
    "/css/style.css",
    "/favicon.svg",
  ]);

  function ehLivre(caminho) {
    return LIVRES.has(caminho) || caminho.startsWith("/fonts/");
  }

  function autenticado(req) {
    return tokenValido(lerCookie(req));
  }

  /**
   * ⚠️ Responde 401 para API e redireciona para /login so em NAVEGACAO.
   * Redirecionar uma chamada de `fetch` faria o front receber o HTML do login
   * com status 200 e tentar parsear como JSON: o erro na tela seria de JSON
   * invalido, que nao diz nada sobre sessao expirada.
   */
  function middleware(req, res, next) {
    if (ehLivre(req.path) || autenticado(req)) return next();

    const querJson =
      req.path.startsWith("/api/") ||
      (req.headers.accept || "").includes("application/json");

    if (querJson) {
      return res.status(401).json({ error: "Sessao expirada. Entre de novo.", code: "NAO_AUTENTICADO" });
    }
    return res.redirect(302, "/login");
  }

  /* ─── Trava GLOBAL progressiva ───
     ⚠️ O rate limit da rota e por IP, e isso NAO protege um codigo curto: um
     PIN de 4 digitos tem 10.000 combinacoes, e quem usa proxies rotativos ganha
     um balde novo a cada requisicao. Varrer tudo vira questao de minutos.

     Esta trava conta as falhas do PROCESSO INTEIRO, sem olhar de onde vieram.
     A partir de 10 erros, cada falha nova dobra a espera (30s, 1min, 2min...,
     teto de 30min) e o login fecha para TODO MUNDO durante a espera. Para o
     dono isso e invisivel (ele erra duas ou tres vezes no maximo); para a forca
     bruta, transforma 10.000 tentativas em semanas.

     Em memoria de proposito: reiniciar o servico zera, e reiniciar exige acesso
     ao servidor, que o atacante nao tem. Persistir em disco exigiria escrita no
     /opt/jarvis, que e read-only pela unit.

     O acerto zera o contador: nao da para alguem te trancar de fora errando a
     senha de proposito e depois voce ficar sem entrar. */
  const TRAVA_APOS = 10;
  const ESPERA_BASE_MS = 30 * 1000;
  const ESPERA_TETO_MS = 30 * 60 * 1000;
  let falhasSeguidas = 0;
  let travadoAte = 0;

  function tempoDeTrava() {
    if (falhasSeguidas < TRAVA_APOS) return 0;
    const dobras = falhasSeguidas - TRAVA_APOS;
    return Math.min(ESPERA_BASE_MS * Math.pow(2, dobras), ESPERA_TETO_MS);
  }

  function travado() {
    return Date.now() < travadoAte;
  }

  function segundosRestantes() {
    return Math.max(1, Math.ceil((travadoAte - Date.now()) / 1000));
  }

  function registrarFalha() {
    falhasSeguidas += 1;
    const espera = tempoDeTrava();
    if (espera > 0) {
      travadoAte = Date.now() + espera;
      console.warn(`[auth] trava global: ${falhasSeguidas} falhas seguidas, login fechado por ${Math.round(espera / 1000)}s`);
    }
  }

  function registrarAcerto() {
    falhasSeguidas = 0;
    travadoAte = 0;
  }

  return {
    middleware,
    conferir: (s) => conferirSenha(s, hashSenha),
    criarToken,
    definirCookie,
    limparCookie,
    autenticado,
    travado,
    segundosRestantes,
    registrarFalha,
    registrarAcerto,
  };
}

module.exports = { criar, gerarHash, conferirSenha, NOME_COOKIE };
