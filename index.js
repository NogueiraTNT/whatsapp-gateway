const path = require("path");
const express = require("express");
const axios = require("axios").default;
const FormData = require("form-data");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT;
const PHP_WEBHOOK_URL = process.env.PHP_WEBHOOK_URL;
const PHP_MEDIA_UPLOAD_URL = process.env.PHP_MEDIA_UPLOAD_URL;

// Configurar logger para filtrar erros conhecidos de descriptografia
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  hooks: {
    logMethod(inputArgs, method) {
      const msg = inputArgs[inputArgs.length - 1];
      const attributes = inputArgs[0]?.attributes || inputArgs[0]?.err;

      // Filtrar erros "No session record" e "failed to decrypt message" - são esperados com contatos novos
      if (attributes && typeof attributes === "object") {
        const errMessage = attributes.message || attributes.err?.message || "";
        const errName = attributes.err?.name || "";

        if (
          (errMessage.includes("No session record") ||
            errMessage.includes("failed to decrypt message") ||
            errName === "SessionError") &&
          typeof msg === "string" &&
          msg.includes("failed to decrypt message")
        ) {
          // Logar como debug/warn ao invés de error para não poluir os logs
          return method.call(
            this,
            {
              ...inputArgs[0],
              level: 30, // warn level
            },
            "Mensagem de contato novo não descriptografada (sessão ainda não estabelecida - normal)"
          );
        }
      }

      return method.apply(this, inputArgs);
    },
  },
});

let sock;
let isReady = false;
let lastQrDataUrl = null;

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

const identifyMediaMessage = (message = {}) => {
  if (message.imageMessage) {
    return {
      mediaType: "image",
      baileysType: "image",
      content: message.imageMessage,
      caption: message.imageMessage.caption || "",
    };
  }

  if (message.videoMessage) {
    return {
      mediaType: "video",
      baileysType: "video",
      content: message.videoMessage,
      caption: message.videoMessage.caption || "",
    };
  }

  if (message.audioMessage) {
    return {
      mediaType: "audio",
      baileysType: "audio",
      content: message.audioMessage,
      caption: "",
    };
  }

  if (message.documentMessage) {
    return {
      mediaType: "document",
      baileysType: "document",
      content: message.documentMessage,
      caption: message.documentMessage.caption || "",
    };
  }

  return null;
};

const downloadMediaBuffer = async (mediaContent, baileysType) => {
  const stream = await downloadContentFromMessage(mediaContent, baileysType);
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};

const uploadMediaToPhp = async ({
  buffer,
  mediaType,
  caption,
  fileName,
  mimeType,
}) => {
  if (!PHP_MEDIA_UPLOAD_URL) {
    logger.warn(
      { mediaType },
      "PHP_MEDIA_UPLOAD_URL não configurada, ignorando upload da mídia"
    );
    return null;
  }

  const formData = new FormData();
  formData.append("file", buffer, {
    filename: fileName || `${mediaType}-${Date.now()}`,
    contentType: mimeType || "application/octet-stream",
  });
  formData.append("media_type", mediaType);

  if (caption) {
    formData.append("media_caption", caption);
  }

  try {
    const response = await axios.post(PHP_MEDIA_UPLOAD_URL, formData, {
      headers: formData.getHeaders(),
      timeout: 30000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    return response.data;
  } catch (error) {
    logger.error(
      {
        err: error?.response?.data || error.message,
        mediaType,
      },
      "Falha ao enviar mídia para o PHP"
    );
    return null;
  }
};

const processIncomingMedia = async (message) => {
  const mediaDetails = identifyMediaMessage(message);

  if (!mediaDetails) {
    return null;
  }

  try {
    const buffer = await downloadMediaBuffer(
      mediaDetails.content,
      mediaDetails.baileysType
    );

    const uploadResult = await uploadMediaToPhp({
      buffer,
      mediaType: mediaDetails.mediaType,
      caption: mediaDetails.caption,
      fileName:
        mediaDetails.content?.fileName ||
        `${mediaDetails.mediaType}-${Date.now()}`,
      mimeType: mediaDetails.content?.mimetype,
    });

    return {
      mediaType: mediaDetails.mediaType,
      caption: mediaDetails.caption,
      uploadResult,
    };
  } catch (error) {
    logger.error(
      {
        err: error.message,
        mediaType: mediaDetails.mediaType,
      },
      "Falha ao baixar mídia do WhatsApp"
    );
    return null;
  }
};

const notifyPhpWebhook = async (payload) => {
  try {
    await axios.post(PHP_WEBHOOK_URL, payload, {
      timeout: 10000,
    });
    logger.debug(
      { numero: payload.numero },
      "Webhook enviado ao PHP com sucesso"
    );
  } catch (error) {
    logger.error(
      {
        err: error?.response?.data || error.message,
        numero: payload.numero,
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

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        lastQrDataUrl = await QRCode.toDataURL(qr);
      } catch (error) {
        lastQrDataUrl = null;
        logger.error(
          { err: error },
          "Falha ao gerar QR Code para exibição na página web"
        );
      }
      logger.info("QR Code recebido, escaneie com o aplicativo do WhatsApp");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      isReady = true;
      lastQrDataUrl = null;
      logger.info("Conexão com WhatsApp estabelecida");
    } else if (connection === "close") {
      isReady = false;
      lastQrDataUrl = null;
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

  // Handler para mensagens atualizadas (incluindo pré-criptográficas de contatos novos)
  sock.ev.on("messages.update", async (updates) => {
    for (const update of updates) {
      // Processar senderKeyDistributionMessage para estabelecer sessão com contatos novos
      if (update.update?.message?.senderKeyDistributionMessage) {
        const remoteJid = jidNormalizedUser(update.key?.remoteJid || "");

        if (remoteJid && remoteJid.endsWith("@s.whatsapp.net")) {
          logger.debug(
            { remoteJid },
            "Sessão criptográfica estabelecida com contato novo"
          );
        }
      }
    }
  });

  sock.ev.on("messages.upsert", async (event) => {
    if (event.type !== "notify") {
      return;
    }

    for (const messageObj of event.messages) {
      try {
        const remoteJid = jidNormalizedUser(messageObj.key.remoteJid || "");

        if (!remoteJid.endsWith("@s.whatsapp.net")) {
          continue;
        }

        if (messageObj.key.fromMe) {
          continue;
        }

        // Verificar se a mensagem tem conteúdo válido ou é apenas uma atualização de pré-criptografia
        if (!messageObj.message) {
          continue;
        }

        const messageText = extractMessageText(messageObj.message);
        const mediaInfo = await processIncomingMedia(messageObj.message);

        // Se não tem texto nem mídia, pode ser uma mensagem pré-criptográfica
        // Tentar processar mesmo assim para não perder mensagens
        if (!messageText && !mediaInfo) {
          // Verificar se é mensagem pré-criptográfica (senderKeyDistributionMessage)
          if (messageObj.message.senderKeyDistributionMessage) {
            logger.debug(
              { remoteJid },
              "Mensagem pré-criptográfica recebida - sessão será estabelecida"
            );
            continue;
          }

          // Se não é nenhum tipo conhecido, pular
          continue;
        }

        const numero = sanitizeNumber(remoteJid);
        const nome = messageObj.pushName || numero;

        logger.info({ numero }, "Mensagem recebida do WhatsApp");

        const payload = {
          numero,
          nome,
          mensagem: messageText || "",
        };

        if (mediaInfo) {
          payload.media_type = mediaInfo.mediaType;
          payload.media_caption = mediaInfo.caption || "";

          const uploadData =
            mediaInfo.uploadResult?.data || mediaInfo.uploadResult || {};

          payload.media_url = uploadData.media_url || null;
          payload.media_local_url = uploadData.media_local_url || null;
          payload.media_remote_url = uploadData.media_remote_url || null;
        }

        await notifyPhpWebhook(payload);
      } catch (error) {
        // Tratar erros de descriptografia especificamente
        const errorMessage = error?.message || "";
        const errorName = error?.name || "";

        if (
          errorMessage.includes("No session record") ||
          errorMessage.includes("failed to decrypt message") ||
          errorName === "SessionError"
        ) {
          // Erro esperado com contatos novos - logar mas não quebrar o processamento
          const remoteJid = jidNormalizedUser(messageObj?.key?.remoteJid || "");
          logger.warn(
            {
              remoteJid,
              messageId: messageObj?.key?.id,
            },
            "Mensagem não descriptografada (contato novo - próxima mensagem será processada)"
          );
          // Continuar processando outras mensagens
          continue;
        }

        // Para outros erros, logar e continuar
        logger.error(
          {
            err: error,
            remoteJid: messageObj?.key?.remoteJid,
          },
          "Erro ao processar mensagem recebida"
        );
      }
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

app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WhatsApp Gateway</title>
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          sans-serif;
        background-color: #f5f5f5;
        margin: 0;
        padding: 2rem;
        color: #1f2933;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1.5rem;
      }
      main {
        width: 100%;
        max-width: 420px;
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
        padding: 2rem 2.5rem;
        box-sizing: border-box;
      }
      h1 {
        margin: 0 0 1rem;
        font-size: 1.75rem;
        text-align: center;
        color: #0f172a;
      }
      p {
        margin: 0 0 1rem;
        text-align: center;
        line-height: 1.5;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        margin: 0 auto 1.5rem;
        padding: 0.5rem 1rem;
        border-radius: 999px;
        font-weight: 600;
      }
      .status.ready {
        background: rgba(16, 185, 129, 0.15);
        color: #047857;
      }
      .status.pending {
        background: rgba(250, 204, 21, 0.2);
        color: #b45309;
      }
      .qr-wrapper {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
      }
      img {
        width: 280px;
        height: 280px;
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
        border: 1px solid #e2e8f0;
        display: none;
      }
      .hint {
        font-size: 0.95rem;
        color: #475569;
        text-align: center;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>WhatsApp Gateway</h1>
      <div id="status" class="status pending">Carregando status...</div>
      <div class="qr-wrapper">
        <img id="qrImage" alt="QR Code do WhatsApp" />
        <p class="hint" id="hint">
          Aguardando geração do QR Code. Assim que aparecer, escaneie com o
          WhatsApp para conectar.
        </p>
      </div>
    </main>
    <script>
      const statusEl = document.getElementById("status");
      const qrImageEl = document.getElementById("qrImage");
      const hintEl = document.getElementById("hint");

      async function refreshStatus() {
        try {
          const response = await fetch("/status", { cache: "no-store" });
          const data = await response.json();

          if (data.ready) {
            statusEl.textContent = "WhatsApp conectado";
            statusEl.className = "status ready";
            hintEl.textContent = "Conexão estabelecida. Nenhum QR Code disponível.";
            qrImageEl.style.display = "none";
          } else {
            statusEl.textContent = "Aguardando conexão";
            statusEl.className = "status pending";
            if (data.qr) {
              qrImageEl.src = data.qr;
              qrImageEl.style.display = "block";
              hintEl.textContent =
                "Escaneie o QR Code com o aplicativo do WhatsApp para concluir o login.";
            } else {
              qrImageEl.style.display = "none";
              hintEl.textContent =
                "Aguardando geração do QR Code. Verifique novamente em instantes.";
            }
          }
        } catch (error) {
          statusEl.textContent = "Erro ao consultar status";
          statusEl.className = "status pending";
          qrImageEl.style.display = "none";
          hintEl.textContent =
            "Não foi possível obter o status. Recarregue a página ou verifique o servidor.";
        }
      }

      refreshStatus();
      setInterval(refreshStatus, 5000);
    </script>
  </body>
</html>`);
});

app.get("/status", (_req, res) => {
  res.json({
    status: isReady ? "connected" : "connecting",
    ready: isReady,
    qr: lastQrDataUrl,
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
