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
let lastConnectionTime = null;

// Sistema de fila de retry para mensagens perdidas
const messageRetryQueue = new Map();

// Mapa para rastrear tentativas de primeiro contato
const newContactAttempts = new Map();

// ✅ DEBUG: Mapa para rastrear mensagens rejeitadas (últimas 100)
const rejectedMessages = [];
const MAX_REJECTED_TRACK = 100;

// Sistema de reconexão com backoff exponencial
let reconnectAttempts = 0;
let reconnectTimeout = null;
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000; // 1 segundo
const MAX_RECONNECT_DELAY = 60000; // 60 segundos
const MAX_WAIT_TIME = 10000; // 10 segundos para fila de retry

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

  // Texto simples
  if (message.conversation) {
    return message.conversation;
  }

  // Texto estendido
  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  // Captions de mídia
  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }

  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }

  if (message.documentMessage?.caption) {
    return message.documentMessage.caption;
  }

  // Respostas de botões e listas
  if (message.buttonsResponseMessage?.selectedButtonId) {
    return `[Botão: ${message.buttonsResponseMessage.selectedButtonId}]`;
  }

  if (message.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return `[Lista: ${message.listResponseMessage.singleSelectReply.selectedRowId}]`;
  }

  // ✅ NOVO: Suporte para mais tipos de mensagem
  if (message.stickerMessage) {
    return "📎 Sticker recebido";
  }

  if (message.contactMessage) {
    const name = message.contactMessage?.displayName || "Contato";
    const phone =
      message.contactMessage?.vcard?.match(/TEL[:\+]*(\d+)/)?.[1] || "";
    return `📇 Contato compartilhado: ${name}${phone ? ` (${phone})` : ""}`;
  }

  if (message.locationMessage) {
    const lat = message.locationMessage?.degreesLatitude || 0;
    const lng = message.locationMessage?.degreesLongitude || 0;
    return `📍 Localização: https://maps.google.com/?q=${lat},${lng}`;
  }

  if (message.liveLocationMessage) {
    const lat = message.liveLocationMessage?.degreesLatitude || 0;
    const lng = message.liveLocationMessage?.degreesLongitude || 0;
    return `📍 Localização em tempo real: https://maps.google.com/?q=${lat},${lng}`;
  }

  if (message.pollCreationMessage) {
    return "📊 Enquete criada";
  }

  if (message.pollUpdateMessage) {
    return "📊 Voto em enquete";
  }

  if (message.reactionMessage) {
    const reaction = message.reactionMessage?.text || "👍";
    return `Reagiu: ${reaction}`;
  }

  // Protocol messages (geralmente não precisam ser processadas como mensagem)
  if (message.protocolMessage) {
    return null; // Retornar null indica que é mensagem de protocolo
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
  retries = 0,
}) => {
  if (!PHP_MEDIA_UPLOAD_URL) {
    logger.warn(
      { mediaType },
      "PHP_MEDIA_UPLOAD_URL não configurada, ignorando upload da mídia"
    );
    return null;
  }

  const MAX_RETRIES = 2;

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
      timeout: 60000, // ✅ AUMENTADO para 60 segundos
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    // ✅ VALIDAR resposta antes de retornar
    if (
      response.data &&
      response.data.success &&
      response.data.media_local_url
    ) {
      return {
        success: true,
        media_local_url: response.data.media_local_url,
        media_url: response.data.media_url,
        relative_path: response.data.relative_path,
        mime: response.data.mime || mimeType,
      };
    }

    logger.warn(
      { response: response.data },
      "Upload retornou resposta inválida"
    );
    return null;
  } catch (error) {
    // ✅ Retry para erros de timeout ou rede
    if (
      retries < MAX_RETRIES &&
      (error.code === "ECONNABORTED" || // Timeout
        error.code === "ECONNRESET" || // Conexão resetada
        error.code === "ETIMEDOUT") // Timeout de conexão
    ) {
      logger.warn(
        {
          mediaType,
          attempt: retries + 1,
          maxRetries: MAX_RETRIES,
        },
        "Retentando upload de mídia após falha de rede"
      );

      // Aguardar antes de retry (backoff exponencial)
      await new Promise((resolve) => setTimeout(resolve, 1000 * (retries + 1)));

      return uploadMediaToPhp({
        buffer,
        mediaType,
        caption,
        fileName,
        mimeType,
        retries: retries + 1,
      });
    }

    // Se não for erro recuperável, logar e retornar null
    logger.error(
      {
        err: error?.response?.data || error.message,
        mediaType,
        retries,
      },
      "Falha ao enviar mídia para o PHP após retries"
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

// ==================== SISTEMA DE FILA DE RETRY ====================

/**
 * Adiciona mensagem à fila de retry
 */
function addToRetryQueue(remoteJid, messageKey) {
  if (!messageRetryQueue.has(remoteJid)) {
    messageRetryQueue.set(remoteJid, []);
  }

  const queue = messageRetryQueue.get(remoteJid);

  // Verificar duplicatas (evitar adicionar mesma mensagem 2x)
  const exists = queue.some(
    (item) =>
      item.messageKey.id === messageKey.id &&
      item.messageKey.fromMe === messageKey.fromMe
  );

  if (!exists) {
    queue.push({
      messageKey,
      remoteJid,
      timestamp: Date.now(),
      retries: 0,
      lastRetry: null,
    });

    logger.debug(
      { remoteJid, messageId: messageKey.id, queueSize: queue.length },
      "Mensagem adicionada à fila de retry"
    );
  }
}

/**
 * Remove mensagem da fila após processamento bem-sucedido
 */
function removeFromRetryQueue(remoteJid, messageKey) {
  const queue = messageRetryQueue.get(remoteJid);
  if (!queue) return;

  const index = queue.findIndex(
    (item) =>
      item.messageKey.id === messageKey.id &&
      item.messageKey.fromMe === messageKey.fromMe
  );

  if (index !== -1) {
    const removed = queue.splice(index, 1)[0];
    logger.info(
      {
        remoteJid,
        messageId: messageKey.id,
        retries: removed.retries,
        waitTime: Date.now() - removed.timestamp,
      },
      "Mensagem recuperada e removida da fila de retry"
    );
  }

  // Limpar JID da fila se não houver mais mensagens
  if (queue.length === 0) {
    messageRetryQueue.delete(remoteJid);
  }
}

/**
 * Limpa mensagens expiradas da fila (timeout de 10 segundos)
 */
function cleanupExpiredMessages() {
  const now = Date.now();

  for (const [remoteJid, queue] of messageRetryQueue.entries()) {
    const beforeSize = queue.length;

    // Remover mensagens expiradas
    const filtered = queue.filter((item) => {
      const age = now - item.timestamp;
      if (age > MAX_WAIT_TIME) {
        logger.warn(
          {
            remoteJid,
            messageId: item.messageKey.id,
            age,
            retries: item.retries,
          },
          "Mensagem expirada na fila de retry - removida"
        );
        return false;
      }
      return true;
    });

    if (filtered.length !== beforeSize) {
      messageRetryQueue.set(remoteJid, filtered);
    }

    // Remover JID se fila estiver vazia
    if (filtered.length === 0) {
      messageRetryQueue.delete(remoteJid);
    }
  }
}

/**
 * Tenta reprocessar mensagens da fila para um JID específico
 */
async function retryQueuedMessages(remoteJid) {
  const queue = messageRetryQueue.get(remoteJid);
  if (!queue || queue.length === 0) {
    return;
  }

  logger.debug(
    { remoteJid, queueSize: queue.length },
    "Iniciando retry de mensagens na fila"
  );

  // Processar cada mensagem na fila
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];

    // Verificar se excedeu número máximo de tentativas
    if (item.retries >= 3) {
      logger.error(
        {
          remoteJid,
          messageId: item.messageKey.id,
          retries: item.retries,
        },
        "Mensagem falhou após múltiplas tentativas - removendo da fila"
      );
      queue.splice(i, 1);
      continue;
    }

    // Verificar se deve aguardar antes de retry (rate limiting)
    const now = Date.now();
    if (item.lastRetry && now - item.lastRetry < 1000) {
      continue; // Aguardar pelo menos 1 segundo entre retries
    }

    item.retries++;
    item.lastRetry = now;

    try {
      logger.debug(
        {
          remoteJid,
          messageId: item.messageKey.id,
          attempt: item.retries,
        },
        "Tentando reprocessar mensagem da fila"
      );

      // Aguardar um pouco para garantir que o Baileys processou a sessão
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      logger.error(
        {
          remoteJid,
          messageId: item.messageKey.id,
          attempt: item.retries,
          err: error,
        },
        "Erro ao tentar reprocessar mensagem da fila"
      );
    }
  }

  // Atualizar fila após processamento
  if (queue.length === 0) {
    messageRetryQueue.delete(remoteJid);
  } else {
    messageRetryQueue.set(remoteJid, queue);
  }
}

// ==================== SISTEMA DE NOVOS CONTATOS ====================

function trackNewContactAttempt(remoteJid) {
  if (!newContactAttempts.has(remoteJid)) {
    newContactAttempts.set(remoteJid, {
      firstAttempt: Date.now(),
      notified: false,
    });

    logger.info({ remoteJid }, "Primeira tentativa de contato detectada");
  }
}

function markContactNotified(remoteJid) {
  const info = newContactAttempts.get(remoteJid);
  if (info) {
    info.notified = true;
  }
}

function isNewContact(remoteJid) {
  const info = newContactAttempts.get(remoteJid);
  return info && !info.notified;
}

// ==================== SISTEMA DE RECONEXÃO ====================

const scheduleReconnect = (statusCode) => {
  // Limpar timeout anterior se existir
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  // Verificar se excedeu máximo de tentativas
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logger.error(
      {
        attempts: reconnectAttempts,
        statusCode,
      },
      "Máximo de tentativas de reconexão excedido. Requer intervenção manual."
    );
    return;
  }

  // Calcular delay com backoff exponencial
  const delay = Math.min(
    INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );

  reconnectAttempts++;

  logger.info(
    {
      attempt: reconnectAttempts,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      delay,
      statusCode,
    },
    `Reconectando em ${delay}ms...`
  );

  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connectToWhatsApp();
  }, delay);
};

const resetReconnectAttempts = () => {
  reconnectAttempts = 0;
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
};

const connectToWhatsApp = async () => {
  // ✅ Limpar socket anterior se existir
  if (sock) {
    try {
      sock.end();
    } catch (error) {
      // Ignorar erros ao encerrar socket anterior
    }
    sock = null;
  }

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
    // ✅ Opções adicionais para estabilidade
    connectTimeoutMs: 60000, // 60 segundos
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000, // Keep-alive a cada 30 segundos
    qrTimeout: 60000, // QR code expira em 60 segundos
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
      lastConnectionTime = Date.now();
      resetReconnectAttempts(); // ✅ Resetar contador ao conectar com sucesso
      logger.info("Conexão com WhatsApp estabelecida");
    } else if (connection === "close") {
      isReady = false;
      lastQrDataUrl = null;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const error = lastDisconnect?.error;

      // ✅ Tratamento específico por tipo de desconexão
      switch (statusCode) {
        case DisconnectReason.loggedOut:
          logger.error(
            "Logout detectado. Usuário fez logout manualmente. Reconexão não será tentada."
          );
          // ❌ Não reconectar
          return;

        case DisconnectReason.restartRequired:
          logger.warn(
            { statusCode },
            "WhatsApp requer restart. Reconectando com delay maior..."
          );
          // ✅ Reconectar, mas com delay maior
          setTimeout(() => {
            scheduleReconnect(statusCode);
          }, 5000); // 5 segundos para restart required
          return;

        case DisconnectReason.badSession:
          logger.warn(
            { statusCode },
            "Sessão corrompida detectada. Reconectando..."
          );
          scheduleReconnect(statusCode);
          return;

        case DisconnectReason.timedOut:
          logger.warn({ statusCode }, "Timeout de conexão. Reconectando...");
          scheduleReconnect(statusCode);
          return;

        case DisconnectReason.connectionClosed:
        case DisconnectReason.connectionLost:
          logger.warn({ statusCode }, "Conexão perdida. Reconectando...");
          scheduleReconnect(statusCode);
          return;

        case DisconnectReason.replaced:
          logger.error(
            { statusCode },
            "Outro dispositivo conectou. Reconexão não será tentada."
          );
          // ❌ Não reconectar (outro dispositivo está usando)
          return;

        default:
          logger.warn(
            { statusCode, error },
            "Conexão encerrada por motivo desconhecido. Tentando reconectar..."
          );
          scheduleReconnect(statusCode);
          return;
      }
    } else if (connection === "connecting") {
      logger.info("Conectando ao WhatsApp...");
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

          // ✅ NOVO: Aguardar um pouco e tentar reprocessar mensagens da fila
          setTimeout(async () => {
            await retryQueuedMessages(remoteJid);

            // ✅ Se ainda há mensagens na fila, enviar mensagem automática opcional
            const stillInQueue = messageRetryQueue.get(remoteJid);
            if (stillInQueue && stillInQueue.length > 0) {
              const numero = sanitizeNumber(remoteJid);

              try {
                await sock.sendMessage(remoteJid, {
                  text: "Olá! Recebemos sua mensagem, mas pode ter havido um problema técnico na primeira tentativa. Por favor, envie novamente caso não tenha recebido resposta. Obrigado! 😊",
                });

                logger.info(
                  { remoteJid, numero },
                  "Mensagem automática enviada para novo contato após falha de descriptografia"
                );
              } catch (error) {
                logger.error(
                  { err: error, remoteJid },
                  "Falha ao enviar mensagem automática para novo contato"
                );
              }
            }
          }, 2000); // Aguardar 2 segundos para garantir que a sessão está pronta
        }
      }
    }
  });

  sock.ev.on("messages.upsert", async (event) => {
    if (event.type !== "notify") {
      return;
    }

    // ✅ DEBUG: Log de todas as mensagens recebidas
    logger.debug(
      {
        totalMessages: event.messages?.length || 0,
        eventType: event.type,
      },
      `Evento messages.upsert recebido com ${
        event.messages?.length || 0
      } mensagem(ns)`
    );

    for (const messageObj of event.messages) {
      let remoteJid = null;
      let rejectReason = null;

      try {
        // ✅ Verificação segura do key
        if (!messageObj?.key) {
          rejectReason = "messageObj.key é null/undefined";
          logger.warn({ messageObj }, "Mensagem sem key - rejeitada");
          continue;
        }

        // ✅ Verificação segura do remoteJid
        try {
          remoteJid = jidNormalizedUser(messageObj.key.remoteJid || "");
        } catch (error) {
          rejectReason = `Erro ao normalizar JID: ${error.message}`;
          logger.error(
            {
              err: error,
              rawRemoteJid: messageObj.key.remoteJid,
            },
            "Erro ao normalizar remoteJid"
          );
          continue;
        }

        // ✅ ACEITAR também mensagens de grupos (@g.us) e broadcasts (@broadcast)
        // Mas processar apenas mensagens individuais (@s.whatsapp.net)
        if (
          !remoteJid ||
          (!remoteJid.endsWith("@s.whatsapp.net") &&
            !remoteJid.endsWith("@g.us") &&
            !remoteJid.endsWith("@broadcast"))
        ) {
          rejectReason = `JID não suportado: ${remoteJid}`;
          logger.debug(
            { remoteJid, messageId: messageObj.key?.id },
            "Mensagem rejeitada - JID não é individual, grupo ou broadcast"
          );
          continue;
        }

        // ✅ Processar apenas mensagens individuais (@s.whatsapp.net)
        if (!remoteJid.endsWith("@s.whatsapp.net")) {
          continue; // Ignorar grupos e broadcasts por enquanto
        }

        if (messageObj.key.fromMe) {
          continue; // Ignorar mensagens próprias
        }

        // ✅ NOVO: Verificar se mensagem está na fila de retry
        // Se estiver, remover da fila (já foi recuperada)
        removeFromRetryQueue(remoteJid, messageObj.key);

        // ✅ Rastrear tentativas de novos contatos
        trackNewContactAttempt(remoteJid);

        // ✅ Verificação mais detalhada do message
        if (!messageObj.message) {
          rejectReason = "messageObj.message é null/undefined";
          logger.debug(
            {
              remoteJid,
              messageId: messageObj.key?.id,
              messageKey: messageObj.key,
            },
            "Mensagem sem conteúdo - pode ser update ou protocolo"
          );

          // ✅ Rastrear mensagens rejeitadas
          rejectedMessages.unshift({
            timestamp: Date.now(),
            remoteJid: remoteJid || "unknown",
            messageId: messageObj.key?.id,
            reason: rejectReason,
            key: messageObj.key,
          });
          if (rejectedMessages.length > MAX_REJECTED_TRACK) {
            rejectedMessages.pop();
          }
          continue;
        }

        // Verificar se é mensagem pré-criptográfica
        if (messageObj.message.senderKeyDistributionMessage) {
          logger.debug(
            { remoteJid },
            "Mensagem pré-criptográfica recebida - sessão será estabelecida"
          );
          continue;
        }

        // ✅ Processar texto PRIMEIRO (pode ter texto mesmo sem mídia)
        let messageText = null;
        try {
          messageText = extractMessageText(messageObj.message);
          // Se retornar null, é mensagem de protocolo - ignorar
          if (messageText === null) {
            continue;
          }
        } catch (error) {
          logger.warn(
            {
              err: error,
              remoteJid,
              messageId: messageObj.key?.id,
            },
            "Erro ao extrair texto da mensagem - continuando com processamento de mídia"
          );
          // Continuar mesmo se erro na extração de texto
        }

        // ✅ Processar mídia com tratamento de erro melhorado
        let mediaInfo = null;
        try {
          mediaInfo = await processIncomingMedia(messageObj.message);
        } catch (error) {
          logger.warn(
            {
              err: error.message,
              remoteJid,
              messageId: messageObj.key?.id,
            },
            "Erro ao processar mídia - continuando sem mídia"
          );
          // ✅ NÃO rejeitar mensagem se mídia falhar mas tiver texto
          mediaInfo = null;
        }

        // ✅ ACEITAR mensagem se tiver texto OU mídia (ou ambos)
        // Se não tiver nenhum, pode ser um tipo não suportado
        if (
          (messageText === null || messageText === "" || !messageText) &&
          !mediaInfo
        ) {
          rejectReason = "Sem texto e sem mídia detectada";
          const messageKeys = Object.keys(messageObj.message || {});
          logger.warn(
            {
              remoteJid,
              messageId: messageObj.key?.id,
              messageTypes: messageKeys,
              fullMessage: JSON.stringify(messageObj.message).substring(0, 500),
            },
            "Mensagem rejeitada - tipo não suportado ou vazio"
          );

          // ✅ Rastrear mensagens rejeitadas
          rejectedMessages.unshift({
            timestamp: Date.now(),
            remoteJid: remoteJid || "unknown",
            messageId: messageObj.key?.id,
            reason: rejectReason,
            messageTypes: messageKeys,
            pushName: messageObj.pushName,
          });
          if (rejectedMessages.length > MAX_REJECTED_TRACK) {
            rejectedMessages.pop();
          }
          continue;
        }

        const numero = sanitizeNumber(remoteJid);
        const nome = messageObj.pushName || numero;

        logger.info(
          {
            numero,
            remoteJid,
            messageId: messageObj.key?.id,
            hasText: !!messageText,
            hasMedia: !!mediaInfo,
          },
          "Mensagem recebida do WhatsApp - processando"
        );

        const payload = {
          numero,
          nome,
          mensagem: messageText && messageText !== null ? messageText : "",
        };

        // ✅ Processar mídia apenas se uploadResult existir
        if (mediaInfo) {
          if (mediaInfo.uploadResult) {
            const upload = mediaInfo.uploadResult;

            // ✅ Garantir que local_url está presente
            if (upload.media_local_url || upload.media_url) {
              payload.media_type = mediaInfo.mediaType;
              payload.media_caption = mediaInfo.caption || "";
              payload.media_local_url =
                upload.media_local_url || upload.media_url;
              payload.media_url = upload.media_url || upload.media_local_url;
              payload.relative_path = upload.relative_path || null;
              payload.media_mime = upload.mime || null;
            } else {
              // ⚠️ Fallback: Se upload falhou, incluir apenas metadados
              logger.warn(
                {
                  mediaType: mediaInfo.mediaType,
                  remoteJid,
                  messageId: messageObj.key?.id,
                },
                "Upload de mídia falhou - incluindo apenas metadados no webhook"
              );
              payload.media_type = mediaInfo.mediaType;
              payload.media_caption = mediaInfo.caption || "";
            }
          } else {
            // ✅ Se processIncomingMedia retornou objeto mas sem uploadResult
            // (pode ter falhado silenciosamente)
            logger.warn(
              {
                mediaType: mediaInfo.mediaType,
                remoteJid,
                messageId: messageObj.key?.id,
              },
              "Mídia detectada mas uploadResult ausente - incluindo apenas metadados"
            );
            payload.media_type = mediaInfo.mediaType;
            payload.media_caption = mediaInfo.caption || "";
          }
        }

        // ✅ Tentar enviar webhook com retry
        try {
          await notifyPhpWebhook(payload);
          logger.info(
            {
              numero,
              messageId: messageObj.key?.id,
            },
            "Webhook enviado com sucesso"
          );
          markContactNotified(remoteJid);
        } catch (webhookError) {
          logger.error(
            {
              err: webhookError,
              remoteJid,
              messageId: messageObj.key?.id,
              payload,
            },
            "Falha ao enviar webhook - mensagem pode ter sido perdida"
          );
          // ✅ Não rejeitar - tentar novamente pode ser implementado
        }
      } catch (error) {
        // ✅ Logging mais detalhado de TODOS os erros
        const errorMessage = error?.message || "";
        const errorName = error?.name || "";
        const errorStack = error?.stack || "";

        logger.error(
          {
            err: {
              message: errorMessage,
              name: errorName,
              stack: errorStack.substring(0, 500),
            },
            remoteJid: remoteJid || messageObj?.key?.remoteJid || "unknown",
            messageId: messageObj?.key?.id,
            messageKey: messageObj?.key,
            pushName: messageObj?.pushName,
          },
          "ERRO GERAL ao processar mensagem recebida"
        );

        // ✅ Tratar erros de descriptografia especificamente
        const isDecryptionError =
          errorMessage.includes("No session record") ||
          errorMessage.includes("failed to decrypt message") ||
          errorMessage.includes("SessionError") ||
          errorName === "SessionError" ||
          errorStack.includes("SessionError");

        if (isDecryptionError) {
          const remoteJidFallback =
            remoteJid || jidNormalizedUser(messageObj?.key?.remoteJid || "");

          if (
            remoteJidFallback &&
            remoteJidFallback.endsWith("@s.whatsapp.net")
          ) {
            // ✅ Se é novo contato e mensagem falhou, notificar PHP mesmo sem conteúdo
            if (isNewContact(remoteJidFallback)) {
              const numero = sanitizeNumber(remoteJidFallback);

              try {
                // Notificar PHP sobre tentativa de contato (mesmo sem mensagem descriptografada)
                await notifyPhpWebhook({
                  numero,
                  nome: `Contato ${numero.substring(numero.length - 4)}`,
                  mensagem: "",
                  is_decryption_failed: true,
                  is_new_contact: true,
                  timestamp: Date.now(),
                });

                markContactNotified(remoteJidFallback);
              } catch (notifyError) {
                logger.error(
                  {
                    err: notifyError,
                    remoteJid: remoteJidFallback,
                  },
                  "Falha ao notificar PHP sobre novo contato"
                );
              }
            }

            // ✅ MODIFICADO: Ao invés de apenas logar, adicionar à fila
            if (remoteJidFallback && messageObj?.key) {
              addToRetryQueue(remoteJidFallback, messageObj.key);
            }

            logger.warn(
              {
                remoteJid: remoteJidFallback,
                messageId: messageObj?.key?.id,
                errorMessage,
                errorName,
              },
              "Mensagem não descriptografada - adicionada à fila de retry"
            );
          }
        } else {
          // ✅ Rastrear outros erros como mensagens rejeitadas
          rejectedMessages.unshift({
            timestamp: Date.now(),
            remoteJid: remoteJid || messageObj?.key?.remoteJid || "unknown",
            messageId: messageObj?.key?.id,
            reason: `Erro: ${errorName} - ${errorMessage.substring(0, 100)}`,
            error: {
              name: errorName,
              message: errorMessage.substring(0, 200),
            },
          });
          if (rejectedMessages.length > MAX_REJECTED_TRACK) {
            rejectedMessages.pop();
          }
        }
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

// ✅ Health check endpoint
app.get("/health", (_req, res) => {
  const health = {
    status: isReady ? "healthy" : "unhealthy",
    ready: isReady,
    reconnectAttempts: reconnectAttempts,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    lastConnection: lastConnectionTime || null,
    uptime: process.uptime(),
  };

  const statusCode = isReady ? 200 : 503;
  res.status(statusCode).json(health);
});

// ✅ Endpoint de estatísticas da fila de retry
app.get("/retry-queue/stats", (_req, res) => {
  const stats = {
    totalJids: messageRetryQueue.size,
    totalMessages: 0,
    messagesByJid: {},
  };

  for (const [remoteJid, queue] of messageRetryQueue.entries()) {
    stats.totalMessages += queue.length;
    stats.messagesByJid[remoteJid] = {
      count: queue.length,
      oldestTimestamp: Math.min(...queue.map((m) => m.timestamp)),
      avgRetries:
        queue.length > 0
          ? queue.reduce((sum, m) => sum + m.retries, 0) / queue.length
          : 0,
    };
  }

  res.json(stats);
});

// ✅ DEBUG: Endpoint para ver mensagens rejeitadas
app.get("/debug/rejected-messages", (_req, res) => {
  res.json({
    total: rejectedMessages.length,
    maxTrack: MAX_REJECTED_TRACK,
    messages: rejectedMessages.slice(0, 50), // Últimas 50 para não sobrecarregar
  });
});

// ✅ Limpar mensagens rejeitadas (endpoint de manutenção)
app.post("/debug/clear-rejected", (_req, res) => {
  const before = rejectedMessages.length;
  rejectedMessages.length = 0;
  res.json({
    success: true,
    cleared: before,
    message: "Mensagens rejeitadas limpas",
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

// Limpar mensagens expiradas a cada 30 segundos
setInterval(() => {
  cleanupExpiredMessages();
}, 30000);

app.listen(PORT, () => {
  logger.info(`Servidor Express rodando na porta ${PORT}`);
});

connectToWhatsApp()
  .then(() => logger.info("Inicializando gateway WhatsApp..."))
  .catch((error) => {
    logger.error({ err: error }, "Erro ao iniciar conexão com WhatsApp");
    process.exitCode = 1;
  });
