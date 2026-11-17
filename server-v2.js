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