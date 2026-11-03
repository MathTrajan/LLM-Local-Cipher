#!/usr/bin/env node
/**
 * ============================================================
 * CIPHER — Gera o hash da senha de acesso
 * ============================================================
 * Uso:  npm run senha
 *
 * Pede a senha sem ecoar na tela e imprime as duas linhas para colar no
 * /etc/cipher.env do servidor (ou no .env local, para testar).
 *
 * ⚠️ A senha NAO vai por argumento de linha de comando de proposito: argumento
 * fica no histórico do shell (`~/.zsh_history`) e aparece inteiro para qualquer
 * `ps aux` rodando na maquina no momento.
 */

const readline = require("readline");
const crypto = require("crypto");
const { gerarHash } = require("../auth.js");

function perguntarOculto(texto) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Silencia o eco: o _writeToOutput do readline e o unico ponto onde da para
    // interceptar o que seria impresso a cada tecla.
    const escrever = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (txt) => {
      if (txt.includes(texto)) escrever(txt);
    };
    rl.question(texto, (resposta) => {
      rl.close();
      process.stdout.write("\n");
      resolve(resposta);
    });
  });
}

(async () => {
  const senha = await perguntarOculto("Senha de acesso ao Cipher: ");
  if (senha.length < 12) {
    console.error("\nerro: use pelo menos 12 caracteres.");
    console.error("Esta senha fica exposta a internet inteira; o rate limit atrasa a forca bruta, nao a impede.");
    process.exit(1);
  }
  const repetida = await perguntarOculto("Repita a senha: ");
  if (senha !== repetida) {
    console.error("\nerro: as senhas nao conferem.");
    process.exit(1);
  }

  console.log("\nCole as duas linhas no /etc/cipher.env do servidor:\n");
  console.log(`CIPHER_SENHA_HASH=${gerarHash(senha)}`);
  // Sem este segredo fixo, toda reinicializacao do servico desloga voce.
  console.log(`CIPHER_SESSAO_SEGREDO=${crypto.randomBytes(32).toString("hex")}`);
  console.log("\nDepois: sudo systemctl restart cipher");
  console.log("⚠️ Trocar o CIPHER_SESSAO_SEGREDO invalida todas as sessoes abertas, que e o jeito de deslogar tudo.");
})();
