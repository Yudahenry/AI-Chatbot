const API_URL = "/api";
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const qrSection = document.getElementById("qrSection");
const readySection = document.getElementById("readySection");
const botNumberText = document.getElementById("botNumberText");
const productsBody = document.getElementById("productsBody");

let currentQRCode = null;

async function checkBotStatus() {
  try {
    const response = await fetch(`${API_URL}/bot/status`);
    if (!response.ok) throw new Error("Gagal");
    const data = await response.json();
    if (data.isReady) {
      statusText.textContent = data.botNumber ? `Bot Connected (${data.botNumber})` : "Bot Connected";
      if (botNumberText) botNumberText.textContent = data.botNumber || "Terhubung";
      if (statusDot) statusDot.className = "status-indicator ready";
      startBtn.classList.add("hidden");
      stopBtn.classList.remove("hidden");
      readySection.classList.remove("hidden");
      qrSection.classList.add("hidden");
      currentQRCode = null;
    } else if (data.hasQRCode) {
      statusText.textContent = "Waiting for QR Scan";
      if (statusDot) statusDot.className = "status-indicator waiting";
      qrSection.classList.remove("hidden");
      readySection.classList.add("hidden");
      startBtn.classList.add("hidden");
      stopBtn.classList.remove("hidden");
      loadQRCode();
    } else {
      statusText.textContent = "Bot Offline";
      if (statusDot) statusDot.className = "status-indicator";
      startBtn.classList.remove("hidden");
      stopBtn.classList.add("hidden");
      readySection.classList.add("hidden");
      qrSection.classList.add("hidden");
    }
  } catch (error) {
    statusText.textContent = "Server Offline";
  }
}

async function loadQRCode() {
  try {
    const response = await fetch(`${API_URL}/bot/qr`);
    const data = await response.json();
    if (data.qr && data.qr !== currentQRCode) {
      currentQRCode = data.qr;
      document.getElementById("qrcode").innerHTML = `<img width="280" height="280" alt="QR Code WhatsApp" src="https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(data.qr)}">`;
    }
  } catch (error) {}
}

startBtn.onclick = async () => {
  await fetch(`${API_URL}/bot/start`, { method: "POST" });
  checkBotStatus();
};

stopBtn.onclick = async () => {
  await fetch(`${API_URL}/bot/stop`, { method: "POST" });
  checkBotStatus();
};

if (resetBtn) {
  resetBtn.onclick = async () => {
    if (!confirm("Hapus sesi WhatsApp? Anda harus scan QR ulang.")) return;
    await fetch(`${API_URL}/bot/reset`, { method: "POST" });
    checkBotStatus();
  };
}

async function loadProductsList() {
  if (!productsBody) return;
  try {
    const res = await fetch(`${API_URL}/products`);
    const data = await res.json();
    const products = data.products || [];
    if (products.length === 0) {
      productsBody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Tidak ada data produk.</td></tr>';
      return;
    }
    productsBody.innerHTML = products.map(p => {
      const harga = Number(p.harga);
      const formatted = isNaN(harga) ? p.harga : new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(harga);
      const waText = encodeURIComponent(`Halo, saya tertarik memesan produk "${p.nama}" (${formatted}) dari katalog Kick Hype.`);
      const waLink = `https://wa.me/6281234567890?text=${waText}`;
      return `
        <tr>
          <td><strong>${p.nama}</strong></td>
          <td><span class="tag-item">${p.kategori}</span></td>
          <td>${formatted}</td>
          <td>${p.deskripsi}<br><a href="${waLink}" target="_blank" class="wa-order-btn">Pesan via WA</a></td>
        </tr>
      `;
    }).join("");
  } catch (err) {
    productsBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: red;">Gagal memuat produk.</td></tr>';
  }
}

checkBotStatus();
loadProductsList();
setInterval(checkBotStatus, 5000);