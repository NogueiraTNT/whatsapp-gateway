const path = require("path");
const os = require("os");
const fs = require("fs").promises;
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
const ALERT_EMAIL = process.env.ALERT_EMAIL;
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK;

// Configurar logger com filtro para mensagens "Closing stale open session"
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  hooks: {
    logMethod(inputArgs, method) {
      // Filtrar mensagens de log sobre "Closing stale open session" e mudar para warn
      const msg = inputArgs[inputArgs.length - 1];
      if (
        typeof msg === "string" &&
        msg.includes("Closing stale open session")
      ) {
        return method.call(
          this,
          { ...inputArgs[0], level: 30 },
          "Renovação normal de chave de sessão"
        );
      }
      return method.apply(this, inputArgs);
    },
  },
});

let sock;
let isReady = false;
let lastQrDataUrl = null;
let connectionStatus = "connecting"; // 'connecting', 'open', 'close'
let lastDisconnectError = null;
let disconnectedSince = null;
let reconnectionAttempts = 0;
let maxReconnectionAttempts = 5;
let isReconnecting = false;
let invalidJids = new Set(); // Cache de JIDs inválidos
let sendFailures = []; // Array de timestamps de falhas não-recuperáveis
let lastHealthCheck = null;
let pausedUntil = null; // Timestamp para pausar envios (rate limit)
let alertSent = false; // Flag para evitar spam de alertas

// Funções de monitoramento de recursos do sistema
const getSystemResources = () => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsagePercent = (usedMem / totalMem) * 100;

  const cpus = os.cpus();
  const cpuUsagePercent =
    (cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle / total;
      return acc + (1 - idle);
    }, 0) /
      cpus.length) *
    100;

  return {
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percent: memUsagePercent,
    },
    cpu: {
      percent: cpuUsagePercent,
      cores: cpus.length,
    },
  };
};

// Verificação de estado crítico (Health Check)
const performHealthCheck = async () => {
  const healthStatus = {
    connection: false,
    auth: false,
    systemResources: false,
    timestamp: Date.now(),
  };

  // 1. Verificação de Conexão Baileys
  if (connectionStatus === "open" && sock && isReady) {
    healthStatus.connection = true;
  } else {
    healthStatus.connection = false;
    if (connectionStatus === "close" && !isReconnecting) {
      logger.error(
        { lastDisconnectError },
        "Health check detectou conexão fechada"
      );
      await initiateReconnection();
    }
  }

  // 2. Verificação de Credenciais/QR Code
  try {
    const authPath = path.join(__dirname, "auth_info");
    const files = await fs.readdir(authPath).catch(() => []);
    healthStatus.auth = files.length > 0 || connectionStatus === "open";

    if (!healthStatus.auth && connectionStatus !== "open") {
      logger.warn("Health check detectou ausência de credenciais");
    }
  } catch (error) {
    healthStatus.auth = false;
    logger.error(
      { err: error },
      "Health check falhou ao verificar credenciais"
    );
  }

  // 3. Verificação de Recursos do Servidor
  const resources = getSystemResources();
  healthStatus.systemResources = resources.memory.percent < 90;

  if (!healthStatus.systemResources) {
    logger.error(
      {
        memoryPercent: resources.memory.percent,
        cpuPercent: resources.cpu.percent,
      },
      "Health check detectou recursos do servidor esgotados (>90% RAM)"
    );

    // Iniciar restart controlado (agendar para 30s para permitir finalização de operações)
    setTimeout(() => {
      logger.error("Executando restart controlado devido a recursos esgotados");
      process.exit(1); // Será reiniciado por PM2/systemd
    }, 30000);
  }

  lastHealthCheck = healthStatus;

  return healthStatus;
};

// Procedimento de Reconexão (Recovery)
const initiateReconnection = async () => {
  if (isReconnecting) {
    return;
  }

  isReconnecting = true;
  const statusCode = lastDisconnectError?.output?.statusCode;

  logger.warn(
    { statusCode, attempt: reconnectionAttempts + 1 },
    "Iniciando procedimento de reconexão"
  );

  // Verificar se é erro de Stream/Chaves (401/Not Authorized)
  if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
    logger.error(
      { statusCode },
      "Erro de autenticação detectado - limpando credenciais e aguardando novo QR Code"
    );

    try {
      const authPath = path.join(__dirname, "auth_info");
      const files = await fs.readdir(authPath);
      for (const file of files) {
        await fs.unlink(path.join(authPath, file));
      }
      logger.info("Credenciais removidas com sucesso");
    } catch (error) {
      logger.error({ err: error }, "Falha ao limpar credenciais");
    }

    connectionStatus = "connecting";
    isReady = false;
    reconnectionAttempts = 0;
    isReconnecting = false;

    // Reconectar para gerar novo QR Code
    connectToWhatsApp().catch((error) => {
      logger.error(
        { err: error },
        "Falha ao reconectar após limpeza de credenciais"
      );
      isReconnecting = false;
    });
    return;
  }

  // Verificar se é reconectável (500, timeout, etc)
  const isReconnectable =
    statusCode === 500 ||
    statusCode === DisconnectReason.connectionClosed ||
    statusCode === DisconnectReason.connectionLost ||
    statusCode === DisconnectReason.timedOut ||
    !statusCode;

  if (isReconnectable) {
    if (reconnectionAttempts < maxReconnectionAttempts) {
      reconnectionAttempts++;
      logger.info(
        { attempt: reconnectionAttempts, maxAttempts: maxReconnectionAttempts },
        "Tentando reconectar imediatamente"
      );

      try {
        await connectToWhatsApp();
        // Reset contadores após conexão bem-sucedida
        setTimeout(() => {
          if (isReady) {
            reconnectionAttempts = 0;
            disconnectedSince = null;
          }
          isReconnecting = false;
        }, 5000);
      } catch (error) {
        logger.error(
          { err: error, attempt: reconnectionAttempts },
          "Falha na tentativa de reconexão"
        );
        isReconnecting = false;

        if (reconnectionAttempts >= maxReconnectionAttempts) {
          logger.warn(
            { attempts: reconnectionAttempts },
            "Máximo de tentativas de reconexão atingido - aguardando 5 minutos"
          );
          setTimeout(() => {
            reconnectionAttempts = 0;
            initiateReconnection();
          }, 5 * 60 * 1000); // 5 minutos
        }
      }
    } else {
      logger.warn(
        { attempts: reconnectionAttempts },
        "Aguardando 5 minutos antes de nova tentativa de reconexão"
      );
      setTimeout(() => {
        reconnectionAttempts = 0;
        isReconnecting = false;
        initiateReconnection();
      }, 5 * 60 * 1000); // 5 minutos
    }
  } else {
    logger.error(
      { statusCode },
      "Erro não reconectável detectado - requer intervenção manual"
    );
    isReconnecting = false;
  }
};

// Verificar condições críticas e enviar alertas
const checkCriticalConditions = () => {
  const now = Date.now();

  // Alertar se desconectado há mais de 3 minutos
  if (connectionStatus === "close" && disconnectedSince) {
    const disconnectedDuration = now - disconnectedSince;
    if (disconnectedDuration > 3 * 60 * 1000 && !alertSent) {
      sendCriticalAlert({
        type: "disconnected_timeout",
        message: "Sistema desconectado há mais de 3 minutos",
        duration: Math.floor(disconnectedDuration / 1000),
        statusCode: lastDisconnectError?.output?.statusCode,
      });
      alertSent = true;
    }
  } else if (connectionStatus === "open") {
    alertSent = false; // Reset quando reconectar
  }

  // Alertar se mais de 10 falhas não-recuperáveis em 5 minutos
  const fiveMinutesAgo = now - 5 * 60 * 1000;
  const recentFailures = sendFailures.filter(
    (timestamp) => timestamp > fiveMinutesAgo
  );

  if (recentFailures.length > 10 && !alertSent) {
    sendCriticalAlert({
      type: "excessive_failures",
      message: "Mais de 10 falhas não-recuperáveis em 5 minutos",
      failureCount: recentFailures.length,
      failures: recentFailures.slice(-10),
    });
    alertSent = true;
  }
};

// Enviar alerta crítico
const sendCriticalAlert = async (alertData) => {
  logger.error(alertData, "🚨 ALERTA CRÍTICO DO SISTEMA");

  // Enviar para webhook se configurado
  if (ALERT_WEBHOOK) {
    try {
      await axios.post(
        ALERT_WEBHOOK,
        {
          service: "whatsapp-gateway",
          severity: "critical",
          timestamp: new Date().toISOString(),
          ...alertData,
        },
        { timeout: 5000 }
      );
    } catch (error) {
      logger.error({ err: error }, "Falha ao enviar alerta para webhook");
    }
  }

  // Aqui você pode adicionar envio de email usando nodemailer ou outro serviço
  // if (ALERT_EMAIL) { ... }
};

// Health check periódico a cada 60 segundos
setInterval(async () => {
  await performHealthCheck();
  checkCriticalConditions();
}, 60000);

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
      connectionStatus = "open";
      isReady = true;
      lastQrDataUrl = null;
      disconnectedSince = null;
      reconnectionAttempts = 0;
      pausedUntil = null; // Reset rate limit pause
      invalidJids.clear(); // Limpar cache de JIDs inválidos (pode ter sido um problema temporário)
      logger.info("Conexão com WhatsApp estabelecida");
    } else if (connection === "close") {
      connectionStatus = "close";
      isReady = false;
      lastQrDataUrl = null;

      if (!disconnectedSince) {
        disconnectedSince = Date.now();
      }

      lastDisconnectError = lastDisconnect?.error;
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      logger.error(
        {
          statusCode,
          error: lastDisconnect?.error?.message,
          output: lastDisconnect?.error?.output,
        },
        "Conexão com WhatsApp encerrada"
      );

      // Registrar o erro para análise posterior
      if (lastDisconnect?.error) {
        logger.error(
          {
            statusCode,
            error: lastDisconnect.error,
            stack: lastDisconnect.error.stack,
          },
          "Detalhes completos do erro de desconexão"
        );
      }

      // Não reconectar imediatamente aqui - deixar o health check e initiateReconnection cuidarem disso
      // Isso evita loops infinitos de reconexão
      if (statusCode !== DisconnectReason.loggedOut && !isReconnecting) {
        // Aguardar um pouco antes de tentar reconectar (para evitar reconexão imediata em caso de erro transitório)
        setTimeout(() => {
          if (connectionStatus === "close" && !isReconnecting) {
            initiateReconnection();
          }
        }, 2000);
      } else if (statusCode === DisconnectReason.loggedOut) {
        logger.error(
          "Usuário deslogado - requer nova autenticação via QR Code"
        );
        // Limpar credenciais e aguardar novo QR Code
        isReconnecting = false;
      }
    } else if (connection === "connecting") {
      connectionStatus = "connecting";
      isReady = false;
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
      const mediaInfo = await processIncomingMedia(messageObj.message);

      if (!messageText && !mediaInfo) {
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
    }
  });

  return sock;
};

// Função de envio com retry exponencial e tratamento específico de erros
const sendMessage = async ({ numero, mensagem }) => {
  // Health check antes de cada envio
  const healthCheck = await performHealthCheck();
  if (!healthCheck.connection) {
    throw new Error(
      "Conexão com WhatsApp não está pronta (health check falhou)"
    );
  }

  // Verificar se estamos pausados devido a rate limit
  if (pausedUntil && Date.now() < pausedUntil) {
    const remainingSeconds = Math.ceil((pausedUntil - Date.now()) / 1000);
    throw new Error(
      `Serviço pausado devido a rate limit. Aguarde ${remainingSeconds} segundos.`
    );
  }

  const jid = buildJidFromNumber(numero);

  if (!jid) {
    throw new Error("Número inválido");
  }

  // Verificar se JID está na lista de inválidos
  if (invalidJids.has(jid)) {
    throw new Error(
      "Número marcado como inválido (não registrado no WhatsApp)"
    );
  }

  // Retry com delay exponencial: 1s, 5s, 15s
  const retryDelays = [1000, 5000, 15000];
  let lastError = null;

  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    try {
      await sock.sendMessage(jid, { text: mensagem });
      logger.info(
        { numero, attempt: attempt + 1 },
        "Mensagem enviada ao WhatsApp"
      );
      return; // Sucesso - sair da função
    } catch (error) {
      lastError = error;
      const errorMessage = error?.message || "";
      const statusCode = error?.output?.statusCode || error?.statusCode;
      const errorCode = error?.status || error?.code;

      logger.error(
        {
          err: error,
          numero,
          attempt: attempt + 1,
          statusCode,
          errorCode,
        },
        "Erro ao enviar mensagem"
      );

      // Tratamento específico de erros

      // 404 Not Found - JID Inexistente
      if (
        statusCode === 404 ||
        errorCode === 404 ||
        errorMessage.includes("404") ||
        errorMessage.includes("Not Found")
      ) {
        invalidJids.add(jid);
        sendFailures.push(Date.now());
        logger.error(
          { numero, jid },
          "Número inválido ou não registrado no WhatsApp (404) - não retentando"
        );
        throw new Error("Número inválido ou não registrado no WhatsApp");
      }

      // 403 Forbidden / Not Authorized - Rate Limit ou problema de sessão
      if (
        statusCode === 403 ||
        errorCode === 403 ||
        errorMessage.includes("403") ||
        errorMessage.includes("Forbidden") ||
        errorMessage.includes("Not Authorized")
      ) {
        logger.warn(
          { numero, attempt: attempt + 1 },
          "Erro 403 detectado - pausando envios por 60 segundos e verificando sessão"
        );

        pausedUntil = Date.now() + 60000; // Pausar por 60 segundos

        // Verificar estado da sessão
        await performHealthCheck();

        // Não retentar este envio específico
        sendFailures.push(Date.now());
        throw new Error(
          "Problema de autorização ou rate limit detectado - envios pausados temporariamente"
        );
      }

      // Timeout / Socket Hang Up
      if (
        errorMessage.includes("timeout") ||
        errorMessage.includes("ETIMEDOUT") ||
        errorMessage.includes("socket hang up") ||
        errorMessage.includes("ECONNRESET") ||
        errorCode === "ETIMEDOUT" ||
        errorCode === "ECONNRESET"
      ) {
        if (attempt < retryDelays.length - 1) {
          const delay = retryDelays[attempt];
          logger.warn(
            { numero, attempt: attempt + 1, delay },
            "Timeout detectado - aguardando antes de retentar"
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue; // Tentar novamente
        } else {
          // Última tentativa falhou
          sendFailures.push(Date.now());
          throw new Error(
            `Falha ao enviar mensagem após ${retryDelays.length} tentativas: ${errorMessage}`
          );
        }
      }

      // Outros erros - retentar se ainda houver tentativas
      if (attempt < retryDelays.length - 1) {
        const delay = retryDelays[attempt];
        logger.warn(
          { numero, attempt: attempt + 1, delay, error: errorMessage },
          "Erro detectado - aguardando antes de retentar"
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      } else {
        // Última tentativa falhou
        sendFailures.push(Date.now());
        throw error; // Relançar o erro original
      }
    }
  }

  // Se chegou aqui, todas as tentativas falharam
  sendFailures.push(Date.now());
  throw (
    lastError || new Error("Falha ao enviar mensagem após múltiplas tentativas")
  );
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
