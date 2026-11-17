require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const RAGEngine = require("./lib/rag");

const app = express();
const PORT = process.env.PORT || 3001;
const IS_VERCEL = Boolean(process.env.VERCEL);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Helper resolusi path file agar aman di lokal maupun Vercel serverless
function resolveProjectFile(relativePath) {
  const localPath = path.join(__dirname, relativePath);
  if (fs.existsSync(localPath)) return localPath;
  const cwdPath = path.join(process.cwd(), relativePath);
  if (fs.existsSync(cwdPath)) return cwdPath;
  return localPath;
}

// Inisialisasi Groq SDK
let groq = null;
function getGroqClient() {
  if (!groq && process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq") {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groq;
}
getGroqClient();

// Inisialisasi RAG Engine dengan dataset Kick Avenue
const PRODUCTS_CSV_PATH = resolveProjectFile("data/products.csv");
const ragEngine = new RAGEngine(PRODUCTS_CSV_PATH);

// Load Basis Pengetahuan FAQ Manual
let knowledge = { keywords: {}, responses: {} };
function loadKnowledge() {
  try {
    const targetPath = resolveProjectFile("knowledge.json");
    if (fs.existsSync(targetPath)) {
      knowledge = JSON.parse(fs.readFileSync(targetPath, "utf-8"));
    }
  } catch (err) {
    console.error("Gagal membaca knowledge.json:", err.message);
  }
}
loadKnowledge();

// State WhatsApp Bot
let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;
let isCleaning = false;

// ================= MONITORING TOKEN & RATE LIMIT GROQ AI =================
let groqQuota = {
  model: process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
  remainingRequests: null,
  limitRequests: null,
  remainingTokens: null,
  limitTokens: null,
  resetRequests: null,
  lastChecked: null,
  configured: Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq"),
  totalTokensUsed: 0,
  promptTokensUsed: 0,
  completionTokensUsed: 0,
  totalChatsHandled: 0
};

function updateGroqQuotaFromHeaders(headers, modelName) {
  if (!headers) return;
  groqQuota.model = modelName || process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
  const remReq = headers.get ? headers.get("x-ratelimit-remaining-requests") : headers["x-ratelimit-remaining-requests"];
  const limReq = headers.get ? headers.get("x-ratelimit-limit-requests") : headers["x-ratelimit-limit-requests"];
  const remTok = headers.get ? headers.get("x-ratelimit-remaining-tokens") : headers["x-ratelimit-remaining-tokens"];
  const limTok = headers.get ? headers.get("x-ratelimit-limit-tokens") : headers["x-ratelimit-limit-tokens"];
  const rstReq = headers.get ? headers.get("x-ratelimit-reset-requests") : headers["x-ratelimit-reset-requests"];

  if (remReq) groqQuota.remainingRequests = Number(remReq);
  if (limReq) groqQuota.limitRequests = Number(limReq);
  if (remTok) groqQuota.remainingTokens = Number(remTok);
  if (limTok) groqQuota.limitTokens = Number(limTok);
  if (rstReq) groqQuota.resetRequests = rstReq;
  groqQuota.lastChecked = new Date().toLocaleTimeString("id-ID");
  groqQuota.configured = true;
}

async function fetchGroqQuotaFresh() {
  const groqClient = getGroqClient();
  if (!groqClient) return groqQuota;

  const modelToUse = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
  try {
    const { response } = await groqClient.chat.completions.create({
      model: modelToUse,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1
    }).withResponse();
    updateGroqQuotaFromHeaders(response.headers, modelToUse);
  } catch (err) {
    console.warn("Gagal mengecek kuota Groq:", err.message);
  }
  return groqQuota;
}

// ================= CONVERSATION HISTORY (MULTI-TURN MEMORY) =================
const conversationHistory = new Map();
const MAX_HISTORY_MESSAGES = 6;
const SESSION_TTL_MS = 20 * 60 * 1000;

function getUserHistory(senderId) {
  if (!senderId) return [];
  const session = conversationHistory.get(senderId);
  const now = Date.now();
  if (!session) return [];
  if (now - session.lastActive > SESSION_TTL_MS) {
    conversationHistory.delete(senderId);
    return [];
  }
  return session.messages || [];
}

function appendUserHistory(senderId, userMsg, botReply) {
  if (!senderId) return;
  const now = Date.now();
  let session = conversationHistory.get(senderId);
  if (!session || (now - session.lastActive > SESSION_TTL_MS)) {
    session = { messages: [], lastActive: now };
  }
  session.messages.push({ role: "user", content: userMsg });
  session.messages.push({ role: "assistant", content: botReply });
  if (session.messages.length > MAX_HISTORY_MESSAGES) {
    session.messages = session.messages.slice(-MAX_HISTORY_MESSAGES);
  }
  session.lastActive = now;
  conversationHistory.set(senderId, session);
}

// ================= DETEKSI BROWSER & INISIALISASI WHATSAPP =================
function getChromeExecutablePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const possiblePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : "",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function initializeClient() {
  if (IS_VERCEL) {
    throw new Error("WhatsApp Web client tidak dijalankan di lingkungan serverless Vercel.");
  }
  if (client) return client;

  const waPkg = "whatsapp-web.js";
  const qrPkg = "qrcode-terminal";
  const { Client, LocalAuth } = require(waPkg);
  const qrcode = require(qrPkg);

  const puppeteerOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu"
    ]
  };

  const detectedChrome = getChromeExecutablePath();
  if (detectedChrome) {
    puppeteerOptions.executablePath = detectedChrome;
    console.log(`[Puppeteer] Menggunakan browser: ${detectedChrome}`);
  }

  client = new Client({
    authStrategy: new LocalAuth({ clientId: "chatbot-rag" }),
    puppeteer: puppeteerOptions
  });

  client.on("qr", qr => {
    qrCodeData = qr;
    isInitializing = false;
    console.log("\n================ KODE QR WHATSAPP ================");
    qrcode.generate(qr, { small: true });
    console.log("Pindai QR code di atas atau melalui dashboard web.");
    console.log("==================================================\n");
  });

  client.on("authenticated", () => {
    console.log("Autentikasi WhatsApp berhasil.");
  });

  client.on("auth_failure", msg => {
    console.error("Autentikasi WhatsApp gagal:", msg);
    isInitializing = false;
  });

  client.on("ready", () => {
    isReady = true;
    isInitializing = false;
    qrCodeData = null;
    console.log("Bot WhatsApp Kick Avenue siap digunakan!");
  });

  client.on("disconnected", reason => {
    console.log("WhatsApp terputus:", reason);
    isReady = false;
    qrCodeData = null;
    client = null;
  });

  client.on("message", async msg => {
    try {
      if (msg.fromMe || !msg.body) return;
      const isPersonalChat = msg.from.endsWith("@c.us") || msg.from.endsWith("@lid");
      if (!isPersonalChat || msg.from.endsWith("@status")) return;

      const message = msg.body.trim();
      console.log(`[Pesan Masuk dari ${msg.from}]: ${message}`);

      const reply = await getAIResponse(msg.from, message);
      await msg.reply(reply);
      console.log(`[Balasan Terkirim]: ${reply}`);
    } catch (err) {
      console.error("Error memproses pesan:", err.message || err);
      try {
        await msg.reply("Mohon maaf, sistem asisten Kick Avenue sedang mengalami kendala teknis. Silakan coba sesaat lagi.");
      } catch (replyErr) {
        console.error("Gagal mengirim pesan fallback:", replyErr.message);
      }
    }
  });

  return client;
}

// ================= LOGIKA RESPONS AI & RAG KICK AVENUE =================
function formatWhatsAppMessage(text) {
  if (!text) return "";
  let formatted = text.replace(/\*\*(.*?)\*\*/g, "*$1*");
  return formatted.replace(/\n{3,}/g, "\n\n").trim();
}

function isGreetingMessage(text) {
  if (!text) return false;
  const q = text.toLowerCase().trim();
  const greetings = [
    "halo", "hai", "hi", "hey", "hello", "hei", "p", "ping", "test",
    "pagi", "selamat pagi", "siang", "selamat siang", "sore", "selamat sore",
    "malam", "selamat malam", "assalamualaikum", "assalamu'alaikum", "permisi"
  ];
  if (greetings.includes(q)) return true;
  if (/^(halo|hai|hi|hey|hello|selamat\s+(pagi|siang|sore|malam)|assalamu\s*alaikum|permisi)\b/i.test(q)) {
    const productKeywords = ["produk", "harga", "katalog", "jual", "beli", "sepatu", "sneakers", "nike", "adidas", "jordan", "puma", "new balance"];
    return !productKeywords.some(pk => q.includes(pk));
  }
  return false;
}

function isGratitudeMessage(text) {
  if (!text) return false;
  const q = text.toLowerCase().trim();
  const gratitudeList = ["terima kasih", "terimakasih", "makasih", "makasi", "thx", "thanks", "thank you", "matur nuwun"];
  if (gratitudeList.includes(q)) return true;
  return /^(terima\s*kasih|makasih|makasi|thanks|thank\s*you|thx)\b/i.test(q);
}

async function getAIResponse(senderId, message) {
  const normalized = message.toLowerCase().trim();

  if (isGreetingMessage(normalized)) {
    const greetingReply = "Halo! Selamat datang di *Kick Avenue*. ✨ Ada yang bisa kami bantu seputar koleksi sneakers dan streetwear original kami hari ini?";
    if (senderId) appendUserHistory(senderId, message, greetingReply);
    return greetingReply;
  }

  if (isGratitudeMessage(normalized)) {
    const gratitudeReply = "Sama-sama! Senang bisa membantu Anda di *Kick Avenue*. Jika ada pertanyaan lain atau ingin melakukan pemesanan, silakan hubungi kami kembali!";
    if (senderId) appendUserHistory(senderId, message, gratitudeReply);
    return gratitudeReply;
  }

  if (knowledge.responses && knowledge.responses[normalized]) {
    const manualReply = formatWhatsAppMessage(knowledge.responses[normalized]);
    if (senderId) appendUserHistory(senderId, message, manualReply);
    return manualReply;
  }

  if (knowledge.keywords) {
    for (const [kw, targetKey] of Object.entries(knowledge.keywords)) {
      if (normalized.includes(kw.toLowerCase())) {
        if (knowledge.responses && knowledge.responses[targetKey]) {
          const manualReply = formatWhatsAppMessage(knowledge.responses[targetKey]);
          if (senderId) appendUserHistory(senderId, message, manualReply);
          return manualReply;
        }
      }
    }
  }

  const history = senderId ? getUserHistory(senderId) : [];
  let ragContext = ragEngine.buildContext(message);

  if (!ragContext && history.length > 0) {
    const prevUserQueries = history
      .filter(h => h.role === "user")
      .slice(-2)
      .map(h => h.content)
      .join(" ");
    ragContext = ragEngine.buildContext(`${prevUserQueries} ${message}`);
  }

  try {
    const groqClient = getGroqClient();
    if (!groqClient) {
      return "Halo! Sistem asisten *Kick Avenue* sedang offline karena API Key Groq belum dikonfigurasi pada file .env.";
    }

    const systemPrompt = `Anda adalah konsultan sneakers dan streetwear resmi dari "Kick Avenue". Jawab dalam Bahasa Indonesia yang ramah, hangat, natural, dan to the point.

PRINSIP KEAKURATAN DATA PRODUK:
- Jawab HANYA berdasarkan informasi produk resmi pada Konteks Katalog di bawah. Jangan mengarang harga, ukuran (size), atau spesifikasi di luar katalog.
- Gunakan format cetak tebal WhatsApp satu bintang (*teks*) dan daftar poin (-) untuk menampilkan produk. Jangan satukan dalam paragraf panjang.
- Jangan menyebut istilah internal sistem seperti "file CSV" atau "konteks RAG".
- Jika pelanggan menanyakan ketersediaan ukuran (size), stok fisik terkini, atau produk yang tidak tercantum di katalog, sampaikan dengan sopan dan sertakan kontak resmi toko:
  Alamat: Jl. Sudirman No. 45, Jakarta Selatan
  Telepon / WA: (021) 555-8899 / Chat WhatsApp ini
  Jam Operasional: Senin - Sabtu (10.00 - 21.00 WIB)

${ragContext ? ragContext : "Konteks Katalog: (Tidak ada produk spesifik yang ditemukan untuk kueri ini)."}`;

    const messagesPayload = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message }
    ];

    const candidateModels = [
      process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b",
      "allam-2-7b"
    ];

    let lastError = null;
    for (const modelName of candidateModels) {
      try {
        const { data: completion, response } = await groqClient.chat.completions.create({
          model: modelName,
          messages: messagesPayload,
          max_tokens: Number(process.env.GROQ_MAX_TOKENS || 1500)
        }).withResponse();

        if (response && response.headers) {
          updateGroqQuotaFromHeaders(response.headers, modelName);
        }

        if (completion.usage) {
          groqQuota.promptTokensUsed += Number(completion.usage.prompt_tokens || 0);
          groqQuota.completionTokensUsed += Number(completion.usage.completion_tokens || 0);
          groqQuota.totalTokensUsed += Number(completion.usage.total_tokens || 0);
          groqQuota.totalChatsHandled += 1;
        }

        if (completion.choices && completion.choices[0] && completion.choices[0].message) {
          const aiReply = formatWhatsAppMessage(completion.choices[0].message.content);
          if (senderId) appendUserHistory(senderId, message, aiReply);
          return aiReply;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Groq Model ${modelName}] Gagal: ${err.message}`);
      }
    }

    throw lastError || new Error("Semua model Groq gagal merespon.");
  } catch (error) {
    console.error("Error Groq API:", error.message || error);
    if (ragContext) {
      return formatWhatsAppMessage(`Halo! Berikut informasi produk dari katalog *Kick Avenue*:\n\n${ragContext}`);
    }
    return formatWhatsAppMessage("Halo! Selamat datang di *Kick Avenue*. Ada koleksi sneakers atau apparel yang sedang Anda cari hari ini?");
  }
}

function maskPhoneNumber(rawNumber) {
  if (!rawNumber) return null;
  let formatted = String(rawNumber).replace(/^62/, "08");
  if (formatted.length >= 8) {
    return `${formatted.slice(0, 2)}${"x".repeat(formatted.length - 6)}${formatted.slice(-4)}`;
  }
  return formatted;
}

// ================= API ENDPOINTS =================
app.get("/api/bot/status", (req, res) => {
  let botNumber = null;
  if (isReady && client && client.info && client.info.wid) {
    botNumber = maskPhoneNumber(client.info.wid.user);
  }
  res.json({
    isReady,
    isInitializing,
    isCleaning,
    hasQRCode: Boolean(qrCodeData),
    botNumber,
    environment: IS_VERCEL ? "vercel" : "local"
  });
});

app.get("/api/groq/quota", async (req, res) => {
  try {
    const isFresh = req.query.fresh === "true" || groqQuota.remainingRequests === null;
    if (isFresh && !IS_VERCEL) {
      await fetchGroqQuotaFresh();
    }
    res.json(groqQuota);
  } catch (err) {
    res.status(500).json({ error: err.message, ...groqQuota });
  }
});

app.get("/api/bot/qr", (req, res) => {
  res.json({ qr: qrCodeData });
});

app.post("/api/bot/start", async (req, res) => {
  if (IS_VERCEL) {
    return res.status(400).json({
      success: false,
      message: "Gateway WhatsApp hanya dijalankan di server lokal. Vercel berfungsi sebagai katalog web publik."
    });
  }
  try {
    if (isReady) return res.json({ success: true, message: "Bot sudah berjalan." });
    if (isInitializing) return res.json({ success: true, message: "Bot sedang proses inisialisasi..." });

    isInitializing = true;
    const waClient = initializeClient();
    await waClient.initialize();
    res.json({ success: true });
  } catch (err) {
    isInitializing = false;
    console.error("Gagal memulai bot:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/bot/stop", async (req, res) => {
  if (IS_VERCEL) return res.json({ success: false });
  try {
    isCleaning = true;
    isReady = false;
    qrCodeData = null;
    if (client) await client.destroy();
    client = null;
    isCleaning = false;
    res.json({ success: true });
  } catch (err) {
    isCleaning = false;
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/bot/reset", async (req, res) => {
  if (IS_VERCEL) return res.json({ success: false });
  try {
    isCleaning = true;
    isReady = false;
    isInitializing = false;
    qrCodeData = null;

    if (client) {
      try { await client.destroy(); } catch (e) {}
      client = null;
    }

    const authDir = path.join(__dirname, ".wwebjs_auth");
    const cacheDir = path.join(__dirname, ".wwebjs_cache");
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });

    conversationHistory.clear();
    isCleaning = false;
    res.json({ success: true, message: "Sesi WhatsApp berhasil dibersihkan. Silakan scan QR baru." });
  } catch (err) {
    isCleaning = false;
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/knowledge", (req, res) => {
  loadKnowledge();
  res.json(knowledge);
});

app.get("/api/products", (req, res) => {
  try {
    ragEngine.csvPath = resolveProjectFile("data/products.csv");
    ragEngine.loadData();
    res.json({ products: ragEngine.products });
  } catch (err) {
    console.error("Error memuat produk:", err.message);
    res.status(500).json({ products: [], error: err.message });
  }
});

// ================= STARTUP & ERROR PROTECTION =================
if (!IS_VERCEL) {
  const server = app.listen(PORT, () => {
    console.log(`Server Kick Avenue berjalan di http://localhost:${PORT}`);
    if (process.env.AUTO_START_BOT === "true") {
      isInitializing = true;
      const waClient = initializeClient();
      waClient.initialize().catch(err => {
        isInitializing = false;
        console.error("Auto start gagal:", err.message);
      });
    }
  });

  server.on("error", err => {
    if (err.code === "EADDRINUSE") {
      console.error(`[FATAL] Port ${PORT} sudah terpakai. Ganti PORT di .env atau matikan proses lama.`);
    } else {
      console.error("[FATAL] Server error:", err.message);
    }
    process.exit(1);
  });

  process.on("unhandledRejection", reason => {
    console.error("[Peringatan Unhandled Rejection]:", reason);
  });

  process.on("uncaughtException", err => {
    console.error("[Peringatan Uncaught Exception]:", err.message);
  });

  async function gracefulShutdown(signal) {
    console.log(`\nMenerima sinyal ${signal}, menutup koneksi...`);
    if (client) {
      try { await client.destroy(); } catch (e) {}
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

module.exports = app;