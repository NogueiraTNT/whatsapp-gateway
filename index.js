const path = require("path");
const express = require("express");
const axios = require("axios").default;
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT;
const PHP_WEBHOOK_URL = process.env.PHP_WEBHOOK_URL;

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

let sock;
let isReady = false;

const sanitizeNumber = (numero) => {
  if (!numero) return "";
  return numero.replace(/\D/g, "");
};

const buildJidFromNumber = (numero) => {
  const digits = sanitizeNumber(numero);
  if (!digits) {
    return null;
  }
  return `${digits}@s.whatsapp.net`;
};

const extractMessageText = (message) => {
  if (!message) {
    return "";
  }

  if (message.conversation) {
    return message.conversation;
  }

  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }

  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }

  if (message.buttonsResponseMessage?.selectedButtonId) {
    return message.buttonsResponseMessage.selectedButtonId;
  }

  if (message.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return message.listResponseMessage.singleSelectReply.selectedRowId;
  }

  return "";
};

const notifyPhpWebhook = async ({ numero, nome, mensagem }) => {
  try {
    await axios.post(
      PHP_WEBHOOK_URL,
      {
        numero,
        nome,
        mensagem,
      },
      {
        timeout: 10000,
      }
    );
    logger.debug({ numero }, "Webhook enviado ao PHP com sucesso");
  } catch (error) {
    logger.error(
      {
        err: error?.response?.data || error.message,
      },
      "Falha ao chamar webhook PHP"
    );
  }
};

const connectToWhatsApp = async () => {
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, "auth_info")
  );

  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    browser: Browsers.macOS("Safari"),
    logger,
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("QR Code recebido, escaneie com o aplicativo do WhatsApp");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      isReady = true;
      logger.info("Conexão com WhatsApp estabelecida");
    } else if (connection === "close") {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn(
        { statusCode, shouldReconnect },
        "Conexão com WhatsApp encerrada"
      );

      if (shouldReconnect) {
        connectToWhatsApp();
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (event) => {
    if (event.type !== "notify") {
      return;
    }

    for (const messageObj of event.messages) {
      const remoteJid = jidNormalizedUser(messageObj.key.remoteJid || "");

      if (!remoteJid.endsWith("@s.whatsapp.net")) {
        continue;
      }

      if (messageObj.key.fromMe) {
        continue;
      }

      const messageText = extractMessageText(messageObj.message);

      if (!messageText) {
        continue;
      }

      const numero = sanitizeNumber(remoteJid);
      const nome = messageObj.pushName || numero;

      logger.info({ numero }, "Mensagem recebida do WhatsApp");

      await notifyPhpWebhook({
        numero,
        nome,
        mensagem: messageText,
      });
    }
  });

  return sock;
};

const sendMessage = async ({ numero, mensagem }) => {
  if (!sock || !isReady) {
    throw new Error("Conexão com WhatsApp não está pronta");
  }

  const jid = buildJidFromNumber(numero);

  if (!jid) {
    throw new Error("Número inválido");
  }

  await sock.sendMessage(jid, { text: mensagem });
  logger.info({ numero }, "Mensagem enviada ao WhatsApp");
};

const app = express();
app.use(express.json());

app.get("/status", (_req, res) => {
  res.json({
    status: isReady ? "connected" : "connecting",
    ready: isReady,
  });
});

app.post("/enviar-msg", async (req, res) => {
  const numero = req.body?.numero;
  const mensagem = req.body?.mensagem;

  if (!numero || !mensagem) {
    return res.status(400).json({
      success: false,
      message: "Campos 'numero' e 'mensagem' são obrigatórios",
    });
  }

  try {
    await sendMessage({ numero, mensagem });
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Erro ao enviar mensagem via API");
    res.status(500).json({
      success: false,
      message: error.message || "Falha ao enviar mensagem",
    });
  }
});

app.listen(PORT, () => {
  logger.info(`Servidor Express rodando na porta ${PORT}`);
});

connectToWhatsApp()
  .then(() => logger.info("Inicializando gateway WhatsApp..."))
  .catch((error) => {
    logger.error({ err: error }, "Erro ao iniciar conexão com WhatsApp");
    process.exitCode = 1;
  });
