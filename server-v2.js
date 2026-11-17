require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const RAGEngine = require("./lib/rag");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

let groq = null;
if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq") {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
}

const ragEngine = new RAGEngine(path.join(__dirname, "data/products.csv"));

const KNOWLEDGE_PATH = path.join(__dirname, "knowledge.json");
let knowledge = { keywords: {}, responses: {} };
function loadKnowledge() {
  try {
    if (fs.existsSync(KNOWLEDGE_PATH)) {
      knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("Gagal membaca knowledge.json:", err);
  }
}
loadKnowledge();

let client = null;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;
let isCleaning = false;

let groqQuota = {
  model: process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
  remainingRequests: null,
  limitRequests: null,
  remainingTokens: null,
  limitTokens: null,
  resetRequests: null,
  lastChecked: null,
  configured: Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq")
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
  if (!groq && process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq") {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  if (!groq) return groqQuota;

  const modelToUse = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
  try {
    const { response } = await groq.chat.completions.create({
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

function getChromeExecutablePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const possiblePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : "",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function initializeClient() {
  if (client) return client;
  const puppeteerOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  };
  const detectedChrome = getChromeExecutablePath();
  if (detectedChrome) puppeteerOptions.executablePath = detectedChrome;

  client = new Client({
    authStrategy: new LocalAuth({ clientId: "chatbot-rag" }),
    puppeteer: puppeteerOptions
  });

  client.on("qr", qr => {
    qrCodeData = qr;
    isInitializing = false;
    console.log("\n================ KODE QR WHATSAPP ================");
    qrcode.generate(qr, { small: true });
    console.log("==================================================\n");
  });

  client.on("ready", () => {
    isReady = true;
    isInitializing = false;
    qrCodeData = null;
    console.log("Bot WhatsApp siap digunakan!");
  });

  client.on("disconnected", reason => {
    isReady = false;
    qrCodeData = null;
    client = null;
  });

  client.on("message", async msg => {
    try {
      if (msg.fromMe || !msg.body) return;
      if (!msg.from.endsWith("@c.us") && !msg.from.endsWith("@lid")) return;
      const message = msg.body.trim();
      const reply = await getAIResponse(msg.from, message);
      await msg.reply(reply);
    } catch (err) {
      console.error("Error:", err);
    }
  });

  return client;
}

function formatWhatsAppMessage(text) {
  if (!text) return "";
  let formatted = text.replace(/\*\*(.*?)\*\*/g, "*$1*");
  return formatted.replace(/\n{3,}/g, "\n\n").trim();
}

function isGreetingMessage(text) {
  if (!text) return false;
  const q = text.toLowerCase().trim();
  const greetings = ["halo", "hai", "hi", "hey", "hello", "p", "ping", "pagi", "siang", "sore", "malam", "assalamualaikum", "permisi"];
  if (greetings.includes(q)) return true;
  if (/^(halo|hai|hi|hey|selamat\s+(pagi|siang|sore|malam)|assalamu\s*alaikum)\b/i.test(q)) {
    const productKeywords = ["produk", "harga", "katalog", "jual", "beli", "sepatu", "sneakers", "nike", "adidas", "jordan"];
    return !productKeywords.some(pk => q.includes(pk));
  }
  return false;
}

function isGratitudeMessage(text) {
  if (!text) return false;
  const q = text.toLowerCase().trim();
  const gratitudeList = ["terima kasih", "terimakasih", "makasih", "thx", "thanks", "thank you"];
  if (gratitudeList.includes(q)) return true;
  return /^(terima\s*kasih|makasih|thanks|thank\s*you|thx)\b/i.test(q);
}

async function getAIResponse(senderId, message) {
  const normalized = message.toLowerCase().trim();

  if (isGreetingMessage(normalized)) {
    const greetingReply = "Halo! Selamat datang di *Kick Hype Store*. ✨ Ada yang bisa kami bantu seputar koleksi sneakers dan streetwear kami hari ini? 😊";
    if (senderId) appendUserHistory(senderId, message, greetingReply);
    return greetingReply;
  }

  if (isGratitudeMessage(normalized)) {
    const gratitudeReply = "Sama-sama! Senang bisa membantu Anda di *Kick Hype Store*. Jika ada pertanyaan lain atau ingin memesan, silakan hubungi kami kembali ya! 😊";
    if (senderId) appendUserHistory(senderId, message, gratitudeReply);
    return gratitudeReply;
  }

  if (knowledge.responses && knowledge.responses[normalized]) {
    const manualReply = formatWhatsAppMessage(knowledge.responses[normalized]);
    if (senderId) appendUserHistory(senderId, message, manualReply);
    return manualReply;
  }

  const history = senderId ? getUserHistory(senderId) : [];
  let ragContext = ragEngine.buildContext(message);

  if (!ragContext && history.length > 0) {
    const prevUserQueries = history.filter(h => h.role === "user").slice(-2).map(h => h.content).join(" ");
    ragContext = ragEngine.buildContext(`${prevUserQueries} ${message}`);
  }

  try {
    if (!groq && process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "isi_api_key_groq") {
      groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    }
    if (!groq) return "Halo! API Key Groq belum dikonfigurasi di file .env.";

    const systemPrompt = `Anda adalah konsultan sneakers dan streetwear resmi dari "Kick Hype Store". Jawab dalam Bahasa Indonesia yang ramah, hangat, natural, dan to the point.
PRINSIP KEAKURATAN DATA PRODUK:
Jawab HANYA berdasarkan informasi produk pada Konteks Katalog di bawah. Jangan mengarang spesifikasi di luar katalog.
Gunakan format WhatsApp bold (*teks*) dan bullet points (-) untuk daftar produk. Jangan satukan dalam paragraf panjang.
Jika informasi tidak ada, arahkan untuk menghubungi kontak resmi: Jl. Sudirman No. 45, Jakarta Selatan (Telp/WA: 021-555-8899).
${ragContext ? ragContext : "Konteks Katalog: (Tidak ada produk spesifik yang dicari)."}`;

    const messagesPayload = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message }
    ];

    const candidateModels = [process.env.GROQ_MODEL || "qwen/qwen3.8-27b", "openai/gpt-oss-20b", "allam-2-7b"];
    for (const modelName of candidateModels) {
      try {
        const { data: completion, response } = await groq.chat.completions.create({
          model: modelName,
          messages: messagesPayload,
          max_tokens: Number(process.env.GROQ_MAX_TOKENS || 1500)
        }).withResponse();

        if (response && response.headers) updateGroqQuotaFromHeaders(response.headers, modelName);
        if (completion.choices && completion.choices[0] && completion.choices[0].message) {
          const aiReply = formatWhatsAppMessage(completion.choices[0].message.content);
          if (senderId) appendUserHistory(senderId, message, aiReply);
          return aiReply;
        }
      } catch (err) {}
    }
    throw new Error("Semua model Groq gagal merespon.");
  } catch (error) {
    if (ragContext) return formatWhatsAppMessage(`Berikut informasi dari katalog kami:\n\n${ragContext}`);
    return formatWhatsAppMessage("Halo! Selamat datang di *Kick Hype Store*. Ada yang bisa kami bantu?");
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

app.get("/api/bot/status", (req, res) => {
  let botNumber = null;
  if (isReady && client && client.info && client.info.wid) {
    botNumber = maskPhoneNumber(client.info.wid.user);
  }
  res.json({ isReady, isInitializing, isCleaning, hasQRCode: Boolean(qrCodeData), botNumber });
});

app.get("/api/groq/quota", async (req, res) => {
  const isFresh = req.query.fresh === "true" || groqQuota.remainingRequests === null;
  if (isFresh) await fetchGroqQuotaFresh();
  res.json(groqQuota);
});

app.get("/api/bot/qr", (req, res) => res.json({ qr: qrCodeData }));

app.post("/api/bot/start", async (req, res) => {
  if (isReady) return res.json({ success: true, message: "Bot sudah berjalan." });
  if (isInitializing) return res.json({ success: true, message: "Inisialisasi..." });
  isInitializing = true;
  const waClient = initializeClient();
  await waClient.initialize();
  res.json({ success: true });
});

app.post("/api/bot/stop", async (req, res) => {
  isCleaning = true;
  isReady = false;
  qrCodeData = null;
  if (client) await client.destroy();
  client = null;
  isCleaning = false;
  res.json({ success: true });
});

app.post("/api/bot/reset", async (req, res) => {
  isCleaning = true;
  isReady = false;
  isInitializing = false;
  qrCodeData = null;
  if (client) { try { await client.destroy(); } catch (e) {} client = null; }
  if (fs.existsSync(".wwebjs_auth")) fs.rmSync(".wwebjs_auth", { recursive: true, force: true });
  if (fs.existsSync(".wwebjs_cache")) fs.rmSync(".wwebjs_cache", { recursive: true, force: true });
  conversationHistory.clear();
  isCleaning = false;
  res.json({ success: true, message: "Sesi berhasil dibersihkan." });
});

app.get("/api/knowledge", (req, res) => { loadKnowledge(); res.json(knowledge); });
app.get("/api/products", (req, res) => { ragEngine.loadData(); res.json({ products: ragEngine.products }); });

app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));