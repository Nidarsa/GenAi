require("dotenv").config();
const path = require("path");
const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const { initDb, all, get, run } = require("./db");
const {
  extractTextFromFile,
  generateRuleBasedQuestions,
  generateQuestionsWithAi,
} = require("./documentQuestions");

const app = express();
const PORT = process.env.PORT || 3000;
const COLLEGE_NAME = "Sastra Deemed University";
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const name = file.originalname || "";
    const ok =
      file.mimetype === "application/pdf" ||
      file.mimetype === "text/plain" ||
      file.mimetype === "text/markdown" ||
      /\.(pdf|txt|md)$/i.test(name);
    cb(null, ok);
  },
});

const programInterestMap = {
  CSE: ["coding", "software", "programming", "web", "app", "ai"],
  "AI & Data Science": ["ai", "machine learning", "data", "analytics", "python"],
  ECE: ["electronics", "circuits", "embedded", "hardware"],
  Mechanical: ["machines", "automobile", "manufacturing", "design"],
  Civil: ["construction", "infrastructure", "architecture", "structures"],
  Biotechnology: ["biology", "healthcare", "genetics", "research"],
};

function normalizeList(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((v) => String(v).toLowerCase());
  return String(input)
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function scoreProgram(programName, userInterests, scoreValue) {
  const tags = programInterestMap[programName] || [];
  const interestMatch = userInterests.filter((i) =>
    tags.some((tag) => i.includes(tag) || tag.includes(i))
  ).length;
  const base = interestMatch * 20;
  const scoreBoost = Math.floor((Number(scoreValue) || 0) / 20);
  return base + scoreBoost;
}

function bookingCode() {
  return `SASTRA-${Date.now().toString().slice(-8)}`;
}

/** Parse "92", "92%", "450/500", "450 out of 500" → percentage 0–100 */
function parseMarks12th(input) {
  const s = String(input || "").trim();
  const slash = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (slash) {
    const num = Number(slash[1]);
    const den = Number(slash[2]);
    if (den > 0) return Math.round((num / den) * 1000) / 10;
  }
  const n = parseFloat(s.replace(/%/g, ""));
  if (Number.isNaN(n)) return null;
  if (n <= 100) return Math.round(n * 10) / 10;
  if (n <= 600) return Math.round((n / 500) * 1000) / 10;
  return Math.min(100, Math.round(n));
}

function buildAdmissionGuidance(programName, minScore, marksPct) {
  const lines = [];
  lines.push(`Hello! Here is your personalized guidance for ${programName} at ${COLLEGE_NAME}.`);
  lines.push("");
  lines.push(`• Your 12th board performance (approx. ${marksPct}%):`);

  if (marksPct >= minScore + 15) {
    lines.push(
      `  You are well above the typical eligibility band (reference min. ${minScore}%). Strong profile for ${programName}.`
    );
    lines.push("  Next steps: keep original mark sheets & roll number proof ready; attend counseling on your allotted slot.");
  } else if (marksPct >= minScore) {
    lines.push(
      `  Your marks meet the reference threshold (${minScore}%) for ${programName}. You can proceed with admission formalities.`
    );
    lines.push("  Next steps: verify documents (12th marksheet, transfer certificate); complete fee payment within the deadline.");
  } else if (marksPct >= minScore - 10) {
    lines.push(
      `  Your marks are close to the reference threshold (${minScore}%). You may still apply; seat allocation depends on availability and entrance/rank if applicable.`
    );
    lines.push("  Next steps: contact admissions for clarification; consider alternative programs with lower cutoffs.");
  } else {
    lines.push(
      `  Your current 12th marks are below the typical reference (${minScore}%) for ${programName}.`
    );
    lines.push("  Next steps: explore other programs at Sastra or improve scores via supplementary exams if applicable; speak to the admissions office.");
  }

  lines.push("");
  lines.push("General instructions:");
  lines.push("• Carry valid ID, 12th marksheet, and board roll number proof on the admission day.");
  lines.push("• Follow the official Sastra admissions portal for deadlines and fee structure.");
  return lines.join("\n");
}

async function getAiReply(message) {
  if (!openai) return null;
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content:
          "You are an admission assistant for Sastra Deemed University. Keep answers short, clear, and focused on booking guidance.",
      },
      { role: "user", content: message },
    ],
  });
  return response.output_text || null;
}

app.get("/api/programs", async (_req, res) => {
  const programs = await all(
    `SELECT id, college_name, name, total_seats, filled_seats,
     (total_seats - filled_seats) AS available_seats, min_score
     FROM programs ORDER BY name`
  );
  res.json({ college: COLLEGE_NAME, programs });
});

app.get("/api/slots", async (_req, res) => {
  const slots = await all(
    `SELECT id, slot_date, slot_time, capacity, booked_count,
     (capacity - booked_count) AS available
     FROM slots WHERE is_active = 1 ORDER BY slot_date, slot_time`
  );
  res.json({ slots });
});

app.post("/api/recommend", async (req, res) => {
  const { score, interests } = req.body;
  const list = normalizeList(interests);
  const programs = await all(`SELECT * FROM programs ORDER BY name`);
  const ranked = programs
    .map((p) => ({
      id: p.id,
      name: p.name,
      minScore: p.min_score,
      availableSeats: p.total_seats - p.filled_seats,
      matchScore: scoreProgram(p.name, list, score),
      reason: `Matches interests: ${list.join(", ") || "general profile"}`,
    }))
    .filter((p) => p.availableSeats > 0 && Number(score || 0) >= p.minScore - 10)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 3);

  res.json({ suggestions: ranked });
});

/** Normalize so "I want CSE" always matches (Unicode, odd spaces, zero-width chars). */
function normalizeChatInput(message) {
  return String(message ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function detectProgram(message) {
  const t = normalizeChatInput(message);
  if (!t) return null;

  if (
    /\b(ai\s*&\s*data|data\s*science|aids)\b/.test(t) ||
    t.includes("ai and data") ||
    t.includes("ai & data")
  ) {
    return "AI & Data Science";
  }
  if (/\bcse\b/.test(t) || t.includes("computer science") || /\bcomputer\b/.test(t)) {
    return "CSE";
  }
  if (/\bece\b/.test(t) || t.includes("electronics and communication") || /\belectronics\b/.test(t)) {
    return "ECE";
  }
  if (t.includes("mechanical") || /\bmech\b/.test(t)) {
    return "Mechanical";
  }
  if (t.includes("civil engineering") || /\bcivil\b/.test(t)) {
    return "Civil";
  }
  if (t.includes("biotechnology") || /\bbio\s*tech\b/.test(t)) {
    return "Biotechnology";
  }

  return null;
}

app.post("/api/guidance", async (req, res) => {
  const { programName, fullName, rollNo, marks12 } = req.body;
  if (!programName || !fullName) {
    return res.status(400).json({ error: "Program and name are required." });
  }
  const program = await get(`SELECT * FROM programs WHERE name = ?`, [programName]);
  if (!program) return res.status(400).json({ error: "Unknown program." });

  const marksPct = parseMarks12th(marks12);
  if (marksPct === null) {
    return res.status(400).json({ error: "Could not read marks. Enter percentage (e.g. 88) or fraction (e.g. 440/500)." });
  }

  const instructions = buildAdmissionGuidance(program.name, program.min_score, marksPct);
  return res.json({
    program: program.name,
    minScoreReference: program.min_score,
    marksPercent: marksPct,
    rollNo: String(rollNo || "").trim(),
    fullName: String(fullName || "").trim(),
    instructions,
  });
});

app.post("/api/chat", async (req, res) => {
  const rawMessage = req.body?.message ?? req.body?.text ?? "";
  const text = normalizeChatInput(rawMessage);
  const detected = detectProgram(rawMessage);

  if (detected) {
    return res.json({
      reply: `Great choice — ${detected}! I will ask a few quick questions one by one.\n\nFirst: What is your full name?`,
      action: "start_conversation",
      suggestedProgram: detected,
    });
  }

  if (text.includes("interest")) {
    return res.json({
      reply:
        "Sure. Share your score and interest areas (example: AI, coding, electronics), and I will suggest the best programs.",
      action: "recommendation",
    });
  }

  if (text.includes("slot")) {
    const slot = await get(
      `SELECT id, slot_date, slot_time, (capacity-booked_count) AS available
       FROM slots WHERE is_active = 1 AND (capacity-booked_count) > 0
       ORDER BY slot_date, slot_time LIMIT 1`
    );
    if (!slot) {
      return res.json({ reply: "No slots are currently available." });
    }
    return res.json({
      reply: `Next available slot is ${slot.slot_date} at ${slot.slot_time}.`,
      action: "show_slot",
      slot,
    });
  }

  const aiReply = await getAiReply(rawMessage);
  if (aiReply) {
    return res.json({ reply: aiReply });
  }

  return res.json({
    reply:
      "Tell me which program you want — for example: I want CSE, I want ECE, or I want AI and Data Science. Then I will ask your name, roll number, and 12th marks. You can also say suggest based on my interests or show available slots.",
  });
});

app.post("/api/book", async (req, res) => {
  const {
    fullName,
    email,
    phone,
    score,
    interests,
    careerGoal = "",
    rollNo = "",
    programName,
    slotId,
    autoAssignSlot = true,
  } = req.body;

  if (!fullName || !email || !phone || !programName) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  await run("BEGIN TRANSACTION");
  try {
    const program = await get(`SELECT * FROM programs WHERE name = ?`, [programName]);
    if (!program) throw new Error("Program not found.");
    if (program.filled_seats >= program.total_seats) throw new Error("No seats left in this program.");

    let slot = null;
    if (slotId) {
      slot = await get(
        `SELECT * FROM slots WHERE id = ? AND is_active = 1`,
        [slotId]
      );
      if (!slot || slot.booked_count >= slot.capacity) throw new Error("Selected slot is unavailable.");
    } else if (autoAssignSlot) {
      slot = await get(
        `SELECT * FROM slots WHERE is_active = 1 AND booked_count < capacity
         ORDER BY slot_date, slot_time LIMIT 1`
      );
      if (!slot) throw new Error("No available slots.");
    } else {
      throw new Error("Slot is required.");
    }

    const studentResult = await run(
      `INSERT INTO students (full_name, email, phone, score, interests, career_goal, roll_no)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        fullName,
        email,
        phone,
        Number(score || 0),
        String(interests || ""),
        careerGoal,
        String(rollNo || ""),
      ]
    );

    await run(`UPDATE programs SET filled_seats = filled_seats + 1 WHERE id = ?`, [program.id]);
    await run(`UPDATE slots SET booked_count = booked_count + 1 WHERE id = ?`, [slot.id]);

    const bookingId = bookingCode();
    const createdAt = new Date().toISOString();
    await run(
      `INSERT INTO bookings (booking_id, student_id, program_id, slot_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [bookingId, studentResult.lastID, program.id, slot.id, createdAt]
    );

    await run("COMMIT");
    return res.json({
      success: true,
      booking: {
        bookingId,
        college: COLLEGE_NAME,
        program: program.name,
        slotDate: slot.slot_date,
        slotTime: slot.slot_time,
      },
    });
  } catch (error) {
    await run("ROLLBACK");
    return res.status(400).json({ error: error.message || "Booking failed." });
  }
});

app.get("/api/admin/bookings", async (_req, res) => {
  const rows = await all(
    `SELECT b.booking_id, b.status, b.created_at, s.full_name, s.email, s.phone, s.roll_no,
            p.name AS program_name, sl.slot_date, sl.slot_time
     FROM bookings b
     JOIN students s ON b.student_id = s.id
     JOIN programs p ON b.program_id = p.id
     JOIN slots sl ON b.slot_id = sl.id
     ORDER BY b.created_at DESC`
  );
  res.json({ bookings: rows });
});

/**
 * Upload a notice (PDF/TXT/MD). Server extracts text and returns suggested questions
 * (OpenAI if OPENAI_API_KEY is set, otherwise keyword-based).
 */
app.post("/api/analyze-document", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "No file uploaded. Use form field name: file" });
    }
    const text = await extractTextFromFile(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname
    );
    if (!text || text.length < 20) {
      return res.status(400).json({
        error:
          "Could not read enough text from this file. Try a .txt file or a PDF with selectable text.",
      });
    }

    let questions = await generateQuestionsWithAi(text, openai);
    let source = "ai";
    if (!questions || !questions.length) {
      questions = generateRuleBasedQuestions(text);
      source = "rules";
    }

    return res.json({
      ok: true,
      filename: req.file.originalname,
      textLength: text.length,
      questions,
      source,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Upload failed" });
  }
});

initDb().then(() => {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Admission chatbot app running at http://localhost:${PORT}`);
  });
});
