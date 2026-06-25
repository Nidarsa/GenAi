require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
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
const COLLEGE_NAME = process.env.COLLEGE_NAME || "Sastra Deemed University";
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "college_secret_2026",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
  })
);

// Serve static files EXCEPT html – we handle those manually so we can guard them
app.use("/css", express.static(path.join(__dirname, "public/css")));
app.use("/js", express.static(path.join(__dirname, "public/js")));
app.use("/assets", express.static(path.join(__dirname, "public/assets")));

// ── Auth guards ───────────────────────────────────────────────────────────────
function requireStudent(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === "student") return next();
  res.redirect("/login.html");
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === "admin") return next();
  res.redirect("/login.html");
}

// ── Page routes ───────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  if (req.session?.user?.role === "admin") return res.redirect("/admin");
  if (req.session?.user?.role === "student") return res.redirect("/student");
  res.redirect("/login.html");
});

app.get("/login.html", (req, res) =>
  res.sendFile(path.join(__dirname, "public/login.html"))
);
app.get("/register.html", (req, res) =>
  res.sendFile(path.join(__dirname, "public/register.html"))
);

app.get("/student", requireStudent, (req, res) =>
  res.sendFile(path.join(__dirname, "public/student/index.html"))
);
app.get("/admin", requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "public/admin/index.html"))
);

// ── Auth API ──────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { full_name, email, password } = req.body;
  if (!full_name || !email || !password)
    return res.status(400).json({ error: "All fields are required." });

  const existing = await get(`SELECT id FROM users WHERE email = ?`, [email]);
  if (existing) return res.status(400).json({ error: "Email already registered." });

  const hash = await bcrypt.hash(password, 10);
  const result = await run(
    `INSERT INTO users (full_name, email, password, role) VALUES (?, ?, ?, 'student')`,
    [full_name.trim(), email.trim().toLowerCase(), hash]
  );
  req.session.user = { id: result.lastID, full_name: full_name.trim(), email, role: "student" };
  res.json({ success: true, redirect: "/student" });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required." });

  const user = await get(`SELECT * FROM users WHERE email = ?`, [email.trim().toLowerCase()]);
  if (!user) return res.status(401).json({ error: "Invalid email or password." });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid email or password." });

  req.session.user = { id: user.id, full_name: user.full_name, email: user.email, role: user.role };
  res.json({
    success: true,
    role: user.role,
    redirect: user.role === "admin" ? "/admin" : "/student",
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "Not logged in." });
  res.json({ user: req.session.user });
});

// ── Programs (public) ─────────────────────────────────────────────────────────
app.get("/api/programs", async (_req, res) => {
  const programs = await all(
    `SELECT id, college_name, name, total_seats, filled_seats,
     (total_seats - filled_seats) AS available_seats, min_score
     FROM programs ORDER BY name`
  );
  res.json({ college: COLLEGE_NAME, programs });
});

// ── Seat Grid ─────────────────────────────────────────────────────────────────
app.get("/api/seats/:programId", async (req, res) => {
  const seats = await all(
    `SELECT s.id, s.seat_number, s.status, u.full_name AS student_name
     FROM seats s
     LEFT JOIN users u ON s.student_id = u.id
     WHERE s.program_id = ?
     ORDER BY s.seat_number`,
    [req.params.programId]
  );
  res.json({ seats });
});

// ── Admin: Programs CRUD ──────────────────────────────────────────────────────
app.get("/api/admin/programs", requireAdmin, async (_req, res) => {
  const programs = await all(`SELECT * FROM programs ORDER BY name`);
  res.json({ programs });
});

app.post("/api/admin/programs", requireAdmin, async (req, res) => {
  const { name, total_seats, min_score, college_name } = req.body;
  if (!name || !total_seats || min_score === undefined)
    return res.status(400).json({ error: "name, total_seats, min_score are required." });

  const existing = await get(`SELECT id FROM programs WHERE name = ?`, [name]);
  if (existing) return res.status(400).json({ error: "Program already exists." });

  const result = await run(
    `INSERT INTO programs (college_name, name, total_seats, filled_seats, min_score) VALUES (?, ?, ?, 0, ?)`,
    [college_name || COLLEGE_NAME, name.trim(), Number(total_seats), Number(min_score)]
  );
  // create seat rows
  for (let i = 1; i <= Number(total_seats); i++) {
    await run(`INSERT INTO seats (program_id, seat_number, status) VALUES (?, ?, 'available')`, [
      result.lastID,
      i,
    ]);
  }
  res.json({ success: true, id: result.lastID });
});

app.put("/api/admin/programs/:id", requireAdmin, async (req, res) => {
  const { name, total_seats, min_score, college_name } = req.body;
  const prog = await get(`SELECT * FROM programs WHERE id = ?`, [req.params.id]);
  if (!prog) return res.status(404).json({ error: "Program not found." });

  const newSeats = Number(total_seats) || prog.total_seats;
  const newMin = min_score !== undefined ? Number(min_score) : prog.min_score;
  const newName = name ? name.trim() : prog.name;
  const newCollege = college_name || prog.college_name;

  await run(
    `UPDATE programs SET name=?, total_seats=?, min_score=?, college_name=? WHERE id=?`,
    [newName, newSeats, newMin, newCollege, req.params.id]
  );

  // adjust seats table if total_seats changed
  const existingSeats = await get(`SELECT COUNT(*) as cnt FROM seats WHERE program_id=?`, [req.params.id]);
  const current = existingSeats.cnt;
  if (newSeats > current) {
    for (let i = current + 1; i <= newSeats; i++) {
      await run(`INSERT INTO seats (program_id, seat_number, status) VALUES (?, ?, 'available')`, [req.params.id, i]);
    }
  } else if (newSeats < current) {
    await run(
      `DELETE FROM seats WHERE program_id=? AND seat_number>? AND status='available'`,
      [req.params.id, newSeats]
    );
  }
  res.json({ success: true });
});

app.delete("/api/admin/programs/:id", requireAdmin, async (req, res) => {
  await run(`DELETE FROM seats WHERE program_id=?`, [req.params.id]);
  await run(`DELETE FROM programs WHERE id=?`, [req.params.id]);
  res.json({ success: true });
});

// ── Admin: All Bookings ───────────────────────────────────────────────────────
app.get("/api/admin/bookings", requireAdmin, async (_req, res) => {
  const rows = await all(
    `SELECT b.booking_id, b.status, b.created_at,
            st.full_name, st.email, st.phone, st.roll_no, st.marks_12,
            p.name AS program_name, sl.slot_date, sl.slot_time, b.seat_id
     FROM bookings b
     JOIN students st ON b.student_id = st.id
     JOIN programs p ON b.program_id = p.id
     JOIN slots sl ON b.slot_id = sl.id
     ORDER BY b.created_at DESC`
  );
  res.json({ bookings: rows });
});

// ── Admin: Dashboard stats ────────────────────────────────────────────────────
app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
  const totalStudents = await get(`SELECT COUNT(*) as cnt FROM users WHERE role='student'`);
  const totalBookings = await get(`SELECT COUNT(*) as cnt FROM bookings`);
  const totalPrograms = await get(`SELECT COUNT(*) as cnt FROM programs`);
  const availableSeats = await get(
    `SELECT SUM(total_seats - filled_seats) as cnt FROM programs`
  );
  res.json({
    students: totalStudents.cnt,
    bookings: totalBookings.cnt,
    programs: totalPrograms.cnt,
    available_seats: availableSeats.cnt || 0,
  });
});

// ── Student: Profile + check booking ─────────────────────────────────────────
app.get("/api/student/profile", requireStudent, async (req, res) => {
  const uid = req.session.user.id;
  const student = await get(`SELECT * FROM students WHERE user_id=?`, [uid]);
  const booking = student
    ? await get(
        `SELECT b.booking_id, b.status, p.name as program_name, sl.slot_date, sl.slot_time, b.seat_id
         FROM bookings b
         JOIN programs p ON b.program_id=p.id
         JOIN slots sl ON b.slot_id=sl.id
         WHERE b.student_id=?`,
        [student.id]
      )
    : null;
  res.json({ user: req.session.user, student: student || null, booking: booking || null });
});

// ── Slots (student) ───────────────────────────────────────────────────────────
app.get("/api/slots", async (_req, res) => {
  const slots = await all(
    `SELECT id, slot_date, slot_time, capacity, booked_count,
     (capacity - booked_count) AS available
     FROM slots WHERE is_active = 1 ORDER BY slot_date, slot_time`
  );
  res.json({ slots });
});

// ── Recommend ─────────────────────────────────────────────────────────────────
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
    }))
    .filter((p) => p.availableSeats > 0 && Number(score || 0) >= p.minScore - 10)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 3);
  res.json({ suggestions: ranked });
});

// ── Chat ──────────────────────────────────────────────────────────────────────
app.post("/api/chat", requireStudent, async (req, res) => {
  const rawMessage = req.body?.message ?? req.body?.text ?? "";
  const text = normalizeChatInput(rawMessage);
  const detected = detectProgram(rawMessage);

  if (detected) {
    return res.json({
      reply: `Great choice — **${detected}**!\n\nI'll ask a few quick questions.\n\nFirst: What is your full name?`,
      action: "start_conversation",
      suggestedProgram: detected,
    });
  }

  if (text.includes("interest") || text.includes("suggest")) {
    return res.json({
      reply: "Sure! Share your 12th marks percentage and your interest areas (e.g., coding, electronics, biology), and I'll suggest the best matching programs for you.",
      action: "recommendation",
    });
  }

  if (text.includes("slot") || text.includes("schedule")) {
    const slots = await all(
      `SELECT id, slot_date, slot_time, (capacity-booked_count) AS available
       FROM slots WHERE is_active=1 AND (capacity-booked_count)>0
       ORDER BY slot_date, slot_time`
    );
    if (!slots.length) return res.json({ reply: "No counseling slots are currently available. Please check back later." });
    const list = slots.map((s) => `• ${s.slot_date} at ${s.slot_time} (${s.available} seats left)`).join("\n");
    return res.json({ reply: `Available counseling slots:\n${list}` });
  }

  if (text.includes("program") || text.includes("course") || text.includes("branch")) {
    const programs = await all(`SELECT name, min_score, total_seats, filled_seats FROM programs ORDER BY min_score DESC`);
    const list = programs.map((p) => `• **${p.name}** — Min. marks: ${p.min_score}% | Seats left: ${p.total_seats - p.filled_seats}`).join("\n");
    return res.json({ reply: `Here are all available programs:\n${list}\n\nTell me which one you're interested in!` });
  }

  if (text.includes("book") || text.includes("seat") || text.includes("apply") || text.includes("admission")) {
    return res.json({
      reply: "To book a seat, tell me which program you want (e.g., **I want CSE**) and I'll guide you through the process step by step!",
    });
  }

  const aiReply = await getAiReply(rawMessage);
  if (aiReply) return res.json({ reply: aiReply });

  return res.json({
    reply: `Welcome! I'm your admission assistant for **${COLLEGE_NAME}**.\n\nHere's what I can help you with:\n• Say **I want CSE** (or any program) to start booking\n• Say **show programs** to see all courses and cutoffs\n• Say **suggest based on my interests** for recommendations\n• Say **show slots** to see available counseling dates`,
  });
});

// ── Book a seat ───────────────────────────────────────────────────────────────
app.post("/api/book", requireStudent, async (req, res) => {
  const { fullName, email, phone, marks12, rollNo, programName, slotId } = req.body;
  if (!fullName || !email || !phone || !programName || !marks12)
    return res.status(400).json({ error: "Missing required fields." });

  const marksPct = parseMarks12th(marks12);
  if (marksPct === null)
    return res.status(400).json({ error: "Invalid marks format. Use percentage (e.g. 88) or fraction (e.g. 440/500)." });

  await run("BEGIN TRANSACTION");
  try {
    const program = await get(`SELECT * FROM programs WHERE name = ?`, [programName]);
    if (!program) throw new Error("Program not found.");
    if (program.filled_seats >= program.total_seats) throw new Error("No seats left in this program.");
    if (marksPct < program.min_score)
      throw new Error(`Your marks (${marksPct}%) are below the minimum required (${program.min_score}%) for ${programName}.`);

    let slot;
    if (slotId) {
      slot = await get(`SELECT * FROM slots WHERE id=? AND is_active=1`, [slotId]);
      if (!slot || slot.booked_count >= slot.capacity) throw new Error("Selected slot is unavailable.");
    } else {
      slot = await get(`SELECT * FROM slots WHERE is_active=1 AND booked_count<capacity ORDER BY slot_date,slot_time LIMIT 1`);
      if (!slot) throw new Error("No available slots.");
    }

    // check if user already booked
    const uid = req.session.user.id;
    const existingStudent = await get(`SELECT id FROM students WHERE user_id=?`, [uid]);
    if (existingStudent) {
      const existingBooking = await get(`SELECT id FROM bookings WHERE student_id=?`, [existingStudent.id]);
      if (existingBooking) throw new Error("You already have a booking. Visit your profile to view it.");
    }

    const studentResult = await run(
      `INSERT INTO students (user_id, full_name, email, phone, score, interests, career_goal, roll_no, marks_12)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid, fullName, email, phone, marksPct, "", "", String(rollNo || ""), marksPct]
    );

    // grab next available seat
    const seat = await get(
      `SELECT id FROM seats WHERE program_id=? AND status='available' ORDER BY seat_number LIMIT 1`,
      [program.id]
    );
    if (!seat) throw new Error("No seats available in this program.");

    await run(`UPDATE seats SET status='booked', student_id=? WHERE id=?`, [uid, seat.id]);
    await run(`UPDATE programs SET filled_seats=filled_seats+1 WHERE id=?`, [program.id]);
    await run(`UPDATE slots SET booked_count=booked_count+1 WHERE id=?`, [slot.id]);

    const bookingId = `ADM-${Date.now().toString().slice(-8)}`;
    const createdAt = new Date().toISOString();
    await run(
      `INSERT INTO bookings (booking_id, student_id, program_id, slot_id, seat_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [bookingId, studentResult.lastID, program.id, slot.id, seat.id, createdAt]
    );

    await run("COMMIT");
    return res.json({
      success: true,
      booking: {
        bookingId,
        college: COLLEGE_NAME,
        program: program.name,
        marks: marksPct,
        slotDate: slot.slot_date,
        slotTime: slot.slot_time,
      },
    });
  } catch (error) {
    await run("ROLLBACK");
    return res.status(400).json({ error: error.message || "Booking failed." });
  }
});

// ── Document upload ───────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const name = file.originalname || "";
    const ok =
      file.mimetype === "application/pdf" ||
      file.mimetype === "text/plain" ||
      /\.(pdf|txt|md)$/i.test(name);
    cb(null, ok);
  },
});

app.post("/api/analyze-document", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: "No file uploaded." });
    const text = await extractTextFromFile(req.file.buffer, req.file.mimetype, req.file.originalname);
    if (!text || text.length < 20) return res.status(400).json({ error: "Could not read text from file." });
    let questions = await generateQuestionsWithAi(text, openai);
    let source = "ai";
    if (!questions?.length) { questions = generateRuleBasedQuestions(text); source = "rules"; }
    return res.json({ ok: true, filename: req.file.originalname, textLength: text.length, questions, source });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Upload failed" });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const programInterestMap = {
  CSE: ["coding", "software", "programming", "web", "app", "ai", "computer"],
  "AI & Data Science": ["ai", "machine learning", "data", "analytics", "python", "ml"],
  ECE: ["electronics", "circuits", "embedded", "hardware", "communication"],
  Mechanical: ["machines", "automobile", "manufacturing", "design", "robotics"],
  Civil: ["construction", "infrastructure", "architecture", "structures"],
  Biotechnology: ["biology", "healthcare", "genetics", "research", "pharma"],
};

function normalizeList(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((v) => String(v).toLowerCase());
  return String(input).split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
}

function scoreProgram(programName, userInterests, scoreValue) {
  const tags = programInterestMap[programName] || [];
  const interestMatch = userInterests.filter((i) => tags.some((tag) => i.includes(tag) || tag.includes(i))).length;
  return interestMatch * 20 + Math.floor((Number(scoreValue) || 0) / 20);
}

function parseMarks12th(input) {
  const s = String(input || "").trim();
  const slash = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (slash) {
    const num = Number(slash[1]), den = Number(slash[2]);
    if (den > 0) return Math.round((num / den) * 1000) / 10;
  }
  const n = parseFloat(s.replace(/%/g, ""));
  if (Number.isNaN(n)) return null;
  if (n <= 100) return Math.round(n * 10) / 10;
  if (n <= 600) return Math.round((n / 500) * 1000) / 10;
  return Math.min(100, Math.round(n));
}

function normalizeChatInput(message) {
  return String(message ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function detectProgram(message) {
  const t = normalizeChatInput(message);
  if (!t) return null;
  if (/\b(ai\s*&\s*data|data\s*science|aids|ai and data)\b/.test(t)) return "AI & Data Science";
  if (/\bcse\b/.test(t) || t.includes("computer science")) return "CSE";
  if (/\bece\b/.test(t) || t.includes("electronics")) return "ECE";
  if (t.includes("mechanical") || /\bmech\b/.test(t)) return "Mechanical";
  if (t.includes("civil engineering") || /\bcivil\b/.test(t)) return "Civil";
  if (t.includes("biotechnology") || /\bbiotech\b/.test(t)) return "Biotechnology";
  return null;
}

async function getAiReply(message) {
  if (!openai) return null;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are an admission assistant for ${COLLEGE_NAME}. Keep answers short and helpful. Focus on admission, courses, marks, and booking guidance.` },
        { role: "user", content: message },
      ],
    });
    return response.choices[0]?.message?.content || null;
  } catch { return null; }
}

// ── Start ─────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`College Admission App running at http://localhost:${PORT}`);
    console.log(`Admin login → admin@college.edu / admin123`);
  });
});
