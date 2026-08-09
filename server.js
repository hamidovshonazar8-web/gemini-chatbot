import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("XATOLIK: GEMINI_API_KEY topilmadi. .env faylini tekshiring.");
  process.exit(1);
}

// Model nomi - kerak bo'lsa o'zgartirishingiz mumkin
const MODEL = "gemini-3.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?key=${GEMINI_API_KEY}`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/**
 * /api/chat - frontend'dan xabar va suhbat tarixini oladi,
 * Gemini API'ga yuboradi va javobni STREAM qilib qaytaradi.
 *
 * Body: { messages: [{ role: "user"|"model", text: "..." }, ...] }
 */
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages massivi kerak" });
    }

    // Frontend formatini Gemini API formatiga o'giramiz
    // Har bir xabar matn va (ixtiyoriy) rasm qismlaridan iborat bo'lishi mumkin
    const contents = messages.map((m) => {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      if (m.image) {
        // m.image format: "data:image/png;base64,AAAA..."
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

    const reader = geminiResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Gemini streamGenerateContent JSON massiv elementlarini qaytaradi.
      // Har bir to'liq JSON obyektini topib, matnini ajratib olamiz.
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
        if (endIdx === -1) break; // hali to'liq obyekt kelmagan

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

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
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
