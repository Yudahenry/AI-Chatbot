const fs = require("fs");
const path = require("path");

class RAGEngine {
  constructor(csvPath, options = {}) {
    this.csvPath = csvPath || path.join(__dirname, "../data/products.csv");
    this.topk = options.topk || Number(process.env.RAG_TOP_K || 8);
    this.products = [];
    this.loadData();
  }

  loadData() {
    try {
      if (!fs.existsSync(this.csvPath)) {
        console.warn(`[RAG] File CSV tidak ditemukan di: ${this.csvPath}`);
        this.products = [];
        return;
      }
      const content = fs.readFileSync(this.csvPath, "utf-8");
      const lines = content.trim().split(/\r?\n/);
      if (lines.length < 2) {
        this.products = [];
        return;
      }
      const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
      this.products = lines.slice(1).map(line => {
        const cols = line.split(",").map(c => c.trim());
        const row = {};
        headers.forEach((h, idx) => {
          row[h] = cols[idx] || "";
        });
        return row;
      });
      console.log(`[RAG] Berhasil memuat ${this.products.length} produk dari CSV`);
    } catch (err) {
      console.error("[RAG] Gagal memuat data CSV:", err);
      this.products = [];
    }
  }

  formatCurrency(numStr) {
    const num = Number(numStr);
    if (isNaN(num)) return numStr;
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0
    }).format(num);
  }

  isGreetingQuery(query) {
    if (!query) return false;
    const q = query.toLowerCase().trim();
    const greetings = [
      "halo", "hai", "hi", "hey", "hello", "hei", "p", "ping", "test",
      "pagi", "selamat pagi", "siang", "selamat siang", "sore", "selamat sore",
      "malam", "selamat malam", "assalamualaikum", "permisi"
    ];
    if (greetings.includes(q)) return true;
    if (/^(halo|hai|hi|hey|hello|selamat\s+(pagi|siang|sore|malam)|assalamu\s*alaikum)\b/i.test(q)) {
      const productKeywords = ["produk", "harga", "katalog", "jual", "beli", "sepatu", "sneakers", "nike", "adidas", "jordan"];
      return !productKeywords.some(pk => q.includes(pk));
    }
    return false;
  }

  isAllProductsQuery(query) {
    if (!query) return false;
    const q = query.toLowerCase().trim();
    const specificTerms = ["sepatu", "sneakers", "jordan", "dunk", "samba", "harga", "promo", "rekomendasi"];
    if (specificTerms.some(term => q.includes(term))) {
      return false;
    }
    const allPatterns = [
      /^semua(\s+produk(nya)?)?$/,
      /^(apa|ada)\s+(aja|saja)(\s+produk(nya)?)?$/,
      /^katalog(\s+produk)?$/,
      /^daftar\s+produk$/,
      /^list\s+produk$/,
      /^koleksi(\s+lengkap)?$/,
      /^semuanya$/
    ];
    return allPatterns.some(pattern => pattern.test(q)) || q === "semua produk" || q === "katalog lengkap";
  }

  search(query, k = this.topk) {
    if (!query || this.products.length === 0) return [];
    const normalized = query.toLowerCase().trim();

    if (this.isGreetingQuery(normalized)) return [];
    if (this.isAllProductsQuery(normalized)) return this.products.slice(0, 20);

    const categories = ["sneakers & shoes", "apparel", "aksesoris"];
    const matchedCategory = categories.find(cat => normalized.includes(cat));

    const queryTokens = normalized
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter(t => t.length > 2);

    let candidateProducts = this.products;
    if (matchedCategory) {
      candidateProducts = this.products.filter(p => p.kategori && p.kategori.toLowerCase() === matchedCategory);
    }

    if (queryTokens.length === 0) return candidateProducts.slice(0, k);

    const scored = candidateProducts.map(p => {
      let score = 0;
      const searchableText = `${p.nama} ${p.kategori} ${p.deskripsi} ${p.harga}`.toLowerCase();
      for (const token of queryTokens) {
        if (p.nama && p.nama.toLowerCase().includes(token)) score += 8;
        if (p.kategori && p.kategori.toLowerCase().includes(token)) score += 5;
        if (p.deskripsi && p.deskripsi.toLowerCase().includes(token)) score += 3;
        if (searchableText.includes(token)) score += 1;
      }
      return { product: p, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      return scored.slice(0, k).map(item => item.product);
    }
    return [];
  }

  buildContext(query) {
    const relevantProducts = this.search(query);
    if (!relevantProducts || relevantProducts.length === 0) return "";

    const grouped = {};
    for (const p of relevantProducts) {
      const cat = p.kategori || "Lainnya";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(p);
    }

    let output = "Daftar Katalog Produk Toko Resmi Kick Hype:\n";
    for (const [category, items] of Object.entries(grouped)) {
      output += `\n[Kategori: ${category}]\n`;
      items.forEach(p => {
        const hargaFmt = this.formatCurrency(p.harga);
        output += `- ${p.nama} | Harga: ${hargaFmt}\n  Deskripsi: ${p.deskripsi}\n`;
      });
    }
    return output.trim();
  }
}

module.exports = RAGEngine;