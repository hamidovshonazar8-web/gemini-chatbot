import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!GEMINI_API_KEY) {
  console.error("XATOLIK: GEMINI_API_KEY topilmadi. .env faylini tekshiring.");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("XATOLIK: SUPABASE_URL yoki SUPABASE_SERVICE_KEY topilmadi. .env faylini tekshiring.");
  process.exit(1);
}

// Server tomonida to'liq huquqli Supabase klienti (Row Level Security'ni chetlab o'tadi)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Bepul foydalanuvchilar uchun kunlik xabar limiti
const FREE_DAILY_LIMIT = 15;

// Model nomi - kerak bo'lsa o'zgartirishingiz mumkin
const MODEL = "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?key=${GEMINI_API_KEY}`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/**
 * Autentifikatsiya middleware:
 * Frontend'dan kelgan "Authorization: Bearer <token>" headerini tekshiradi,
 * foydalanuvchini aniqlaydi va req.user ga yozadi.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Tizimga kirish talab qilinadi" });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: "Sessiya yaroqsiz, qayta kiring" });
    }

    req.user = data.user;
    next();
  } catch (err) {
    console.error("Auth xatosi:", err);
    res.status(500).json({ error: "Autentifikatsiya xatosi" });
  }
}

/**
 * Xabar limiti tekshiruvi:
 * Foydalanuvchi profilini oladi, agar kun o'zgargan bo'lsa hisoblagichni nolga tushiradi,
 * limitdan oshgan bo'lsa xato qaytaradi, aks holda hisoblagichni +1 oshiradi.
 */
async function checkAndIncrementUsage(userId) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("message_count, message_date, is_premium")
    .eq("id", userId)
    .single();

  if (error || !profile) {
    throw new Error("Profil topilmadi");
  }

  if (profile.is_premium) {
    return { allowed: true, remaining: null, isPremium: true };
  }

  let currentCount = profile.message_count;
  const isNewDay = profile.message_date !== today;
  if (isNewDay) {
    currentCount = 0;
  }

  if (currentCount >= FREE_DAILY_LIMIT) {
    return { allowed: false, remaining: 0, isPremium: false };
  }

  const newCount = currentCount + 1;
  await supabaseAdmin
    .from("profiles")
    .update({ message_count: newCount, message_date: today })
    .eq("id", userId);

  return { allowed: true, remaining: FREE_DAILY_LIMIT - newCount, isPremium: false };
}

/**
 * /api/usage - foydalanuvchining joriy limit holatini qaytaradi (sahifa ochilganda ko'rsatish uchun)
 */
app.get("/api/usage", requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: profile, error } = await supabaseAdmin
      .from("profiles")
      .select("message_count, message_date, is_premium")
      .eq("id", req.user.id)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: "Profil topilmadi" });
    }

    if (profile.is_premium) {
      return res.json({ isPremium: true, remaining: null, limit: null });
    }

    const isNewDay = profile.message_date !== today;
    const currentCount = isNewDay ? 0 : profile.message_count;

    res.json({
      isPremium: false,
      remaining: Math.max(0, FREE_DAILY_LIMIT - currentCount),
      limit: FREE_DAILY_LIMIT,
    });
  } catch (err) {
    console.error("Usage xatosi:", err);
    res.status(500).json({ error: "Ichki server xatosi" });
  }
});

/**
 * /api/chat - frontend'dan xabar va suhbat tarixini oladi,
 * Gemini API'ga yuboradi va javobni STREAM qilib qaytaradi.
 *
 * Body: { messages: [{ role: "user"|"model", text: "..." }, ...] }
 */
app.post("/api/chat", requireAuth, async (req, res) => {
  try {
    // Limitni tekshiramiz va hisoblagichni oshiramiz
    let usage;
    try {
      usage = await checkAndIncrementUsage(req.user.id);
    } catch (e) {
      return res.status(500).json({ error: "Limitni tekshirishda xato", detail: e.message });
    }

    if (!usage.allowed) {
      return res.status(429).json({
        error: "LIMIT_EXCEEDED",
        message: "Kunlik bepul xabarlar limitingiz tugadi. Premium olib, cheklovsiz suhbatlashing.",
      });
    }

    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages massivi kerak" });
    }

    // Frontend formatini Gemini API formatiga o'giramiz
    const contents = messages.map((m) => {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      if (m.image) {
        const match = /^data:(.+);base64,(.+)$/.exec(m.image);
        if (match) {
          parts.push({
            inline_data: {
              mime_type: match[1],
              data: match[2],
            },
          });
        }
      }
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts,
      };
    });

    const geminiResponse = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: "Siz GrapeGPT ismli do'stona suhbatdoshsiz. Rasmiy, quruq yoki robotga o'xshash javob bermang — xuddi yaqin do'stingiz bilan gaplashayotgandek, tabiiy, jonli va samimiy gapiring. Qisqa va tabiiy jumlalar ishlating, ortiqcha rasmiylikdan qoching. Kerak bo'lsa hazil qiling, hissiyot bildiring, savol bering, suhbatni davom ettiring. FOYDALANUVCHI QAYSI TILDA YOZSA YOKI GAPIRSA (o'zbek, rus, ingliz, turk yoki boshqa istalgan til) — AYNAN O'SHA TILDA javob bering, tilni avtomatik aniqlab oling. Hech qachon boshqa tilga o'girmang, faqat foydalanuvchi tanlagan tilda javob bering."
          }]
        },
        contents,
        generationConfig: {
          temperature: 1,
        },
      }),
    });

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      console.error("Gemini API xatosi:", errText);
      return res.status(geminiResponse.status).json({ error: "Gemini API xatosi", detail: errText });
    }

    // Streamni to'g'ridan-to'g'ri frontend'ga uzatamiz (SSE uslubida)
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Remaining-Messages", usage.isPremium ? "unlimited" : String(usage.remaining));

    const reader = geminiResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let startIdx = buffer.indexOf("{");
      while (startIdx !== -1) {
        let depth = 0;
        let endIdx = -1;
        for (let i = startIdx; i < buffer.length; i++) {
          if (buffer[i] === "{") depth++;
          else if (buffer[i] === "}") {
            depth--;
            if (depth === 0) {
              endIdx = i;
              break;
            }
          }
        }
        if (endIdx === -1) break;

        const jsonStr = buffer.slice(startIdx, endIdx + 1);
        buffer = buffer.slice(endIdx + 1);

        try {
          const obj = JSON.parse(jsonStr);
          const text = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        } catch (e) {
          // to'liqsiz yoki noto'g'ri JSON - o'tkazib yuboramiz
        }

        startIdx = buffer.indexOf("{");
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, remaining: usage.isPremium ? null : usage.remaining, isPremium: usage.isPremium })}\n\n`);
    res.end();
  } catch (err) {
    console.error("Server xatosi:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Ichki server xatosi", detail: err.message });
    } else {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server ishga tushdi: http://localhost:${PORT}`);
});
