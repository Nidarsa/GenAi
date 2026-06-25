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
    cookie: { maxAge: 8 * 60 * 60 * 1000 },
  })
);
app.use("/css",    express.static(path.join(__dirname, "public/css")));
app.use("/js",     express.static(path.join(__dirname, "public/js")));
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
  if (req.session && req.session.user && req.session.user.role === "admin")   return res.redirect("/admin");
  if (req.session && req.session.user && req.session.user.role === "student") return res.redirect("/student");
  res.redirect("/login.html");
});
app.get("/login.html",    (req, res) => res.sendFile(path.join(__dirname, "public/login.html")));
app.get("/register.html", (req, res) => res.sendFile(path.join(__dirname, "public/register.html")));
app.get("/student",  requireStudent, (req, res) => res.sendFile(path.join(__dirname, "public/student/index.html")));
app.get("/admin",    requireAdmin,   (req, res) => res.sendFile(path.join(__dirname, "public/admin/index.html")));

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
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });
  const user = await get(`SELECT * FROM users WHERE email = ?`, [email.trim().toLowerCase()]);
  if (!user) return res.status(401).json({ error: "Invalid email or password." });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid email or password." });
  req.session.user = { id: user.id, full_name: user.full_name, email: user.email, role: user.role };
  res.json({ success: true, role: user.role, redirect: user.role === "admin" ? "/admin" : "/student" });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: "Not logged in." });
  res.json({ user: req.session.user });
});

// ── Programs (public) ─────────────────────────────────────────────────────────
app.get("/api/programs", async (_req, res) => {
  const programs = await all(
    `SELECT id, college_name, name, total_seats, filled_seats,
     (total_seats - filled_seats) AS available_seats, min_score
     FROM programs ORDER BY min_score DESC`
  );
  res.json({ college: COLLEGE_NAME, programs });
});

// ── Seat Grid (admin only) ────────────────────────────────────────────────────
app.get("/api/seats/:programId", requireAdmin, async (req, res) => {
  const seats = await all(
    `SELECT s.id, s.seat_number, s.status, u.full_name AS student_name
     FROM seats s LEFT JOIN users u ON s.student_id = u.id
     WHERE s.program_id = ? ORDER BY s.seat_number`,
    [req.params.programId]
  );
  res.json({ seats });
});

// ── Admin: Programs CRUD ──────────────────────────────────────────────────────
app.get("/api/admin/programs", requireAdmin, async (_req, res) => {
  const programs = await all(`SELECT * FROM programs ORDER BY min_score DESC`);
  res.json({ programs });
});

app.post("/api/admin/programs", requireAdmin, async (req, res) => {
  const { name, total_seats, min_score, college_name } = req.body;
  if (!name || !total_seats || min_score === undefined)
    return res.status(400).json({ error: "name, total_seats, min_score are required." });
  const existing = await get(`SELECT id FROM programs WHERE name = ?`, [name.trim()]);
  if (existing) return res.status(400).json({ error: "Program already exists." });
  const result = await run(
    `INSERT INTO programs (college_name, name, total_seats, filled_seats, min_score) VALUES (?, ?, ?, 0, ?)`,
    [college_name || COLLEGE_NAME, name.trim(), Number(total_seats), Number(min_score)]
  );
  for (let i = 1; i <= Number(total_seats); i++) {
    await run(`INSERT INTO seats (program_id, seat_number, status) VALUES (?, ?, 'available')`, [result.lastID, i]);
  }
  res.json({ success: true, id: result.lastID });
});

app.put("/api/admin/programs/:id", requireAdmin, async (req, res) => {
  const { name, total_seats, min_score, college_name } = req.body;
  const prog = await get(`SELECT * FROM programs WHERE id = ?`, [req.params.id]);
  if (!prog) return res.status(404).json({ error: "Program not found." });
  const newSeats   = Number(total_seats) || prog.total_seats;
  const newMin     = min_score !== undefined ? Number(min_score) : prog.min_score;
  const newName    = name ? name.trim() : prog.name;
  const newCollege = college_name || prog.college_name;
  await run(
    `UPDATE programs SET name=?, total_seats=?, min_score=?, college_name=? WHERE id=?`,
    [newName, newSeats, newMin, newCollege, req.params.id]
  );
  const existingSeats = await get(`SELECT COUNT(*) as cnt FROM seats WHERE program_id=?`, [req.params.id]);
  const current = existingSeats.cnt;
  if (newSeats > current) {
    for (let i = current + 1; i <= newSeats; i++) {
      await run(`INSERT INTO seats (program_id, seat_number, status) VALUES (?, ?, 'available')`, [req.params.id, i]);
    }
  } else if (newSeats < current) {
    await run(`DELETE FROM seats WHERE program_id=? AND seat_number>? AND status='available'`, [req.params.id, newSeats]);
  }
  res.json({ success: true });
});

// ── FIX: cascade delete — clears bookings & seats before deleting program ────
app.delete("/api/admin/programs/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    // get all student_ids linked to bookings for this program so we can free seats
    const bookingsForProg = await all(`SELECT student_id FROM bookings WHERE program_id=?`, [id]);
    // delete bookings first (foreign key chain)
    await run(`DELETE FROM bookings WHERE program_id=?`, [id]);
    // update filled_seats back to 0 (safety)
    await run(`UPDATE seats SET status='available', student_id=NULL WHERE program_id=?`, [id]);
    await run(`DELETE FROM seats WHERE program_id=?`, [id]);
    await run(`DELETE FROM programs WHERE id=?`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || "Delete failed." });
  }
});

// ── Admin: Students CRUD ──────────────────────────────────────────────────────
app.get("/api/admin/students", requireAdmin, async (_req, res) => {
  const students = await all(
    `SELECT s.id, s.full_name, s.email, s.phone, s.roll_no, s.marks_12,
            u.email AS login_email, u.created_at,
            b.booking_id, p.name AS program_name
     FROM students s
     LEFT JOIN users u ON s.user_id = u.id
     LEFT JOIN bookings b ON b.student_id = s.id
     LEFT JOIN programs p ON b.program_id = p.id
     ORDER BY s.id DESC`
  );
  res.json({ students });
});

app.put("/api/admin/students/:id", requireAdmin, async (req, res) => {
  const { full_name, email, phone, roll_no, marks_12 } = req.body;
  const student = await get(`SELECT * FROM students WHERE id=?`, [req.params.id]);
  if (!student) return res.status(404).json({ error: "Student not found." });
  await run(
    `UPDATE students SET full_name=?, email=?, phone=?, roll_no=?, marks_12=? WHERE id=?`,
    [
      full_name  || student.full_name,
      email      || student.email,
      phone      || student.phone,
      roll_no    !== undefined ? roll_no    : student.roll_no,
      marks_12   !== undefined ? Number(marks_12) : student.marks_12,
      req.params.id
    ]
  );
  res.json({ success: true });
});

app.delete("/api/admin/students/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    // find booking for this student
    const booking = await get(`SELECT * FROM bookings WHERE student_id=?`, [id]);
    if (booking) {
      // free the seat
      if (booking.seat_id) {
        await run(`UPDATE seats SET status='available', student_id=NULL WHERE id=?`, [booking.seat_id]);
      }
      // decrement filled_seats
      await run(`UPDATE programs SET filled_seats=MAX(0,filled_seats-1) WHERE id=?`, [booking.program_id]);
      // delete booking
      await run(`DELETE FROM bookings WHERE student_id=?`, [id]);
    }
    // delete student record
    await run(`DELETE FROM students WHERE id=?`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || "Delete failed." });
  }
});

// ── Admin: Bookings CRUD ──────────────────────────────────────────────────────
app.get("/api/admin/bookings", requireAdmin, async (_req, res) => {
  const rows = await all(
    `SELECT b.id, b.booking_id, b.status, b.created_at, b.seat_id,
            st.id AS student_db_id, st.full_name, st.email, st.phone, st.roll_no, st.marks_12,
            p.name AS program_name, p.id AS program_id,
            sl.slot_date, sl.slot_time
     FROM bookings b
     JOIN students st ON b.student_id = st.id
     JOIN programs p  ON b.program_id = p.id
     JOIN slots sl    ON b.slot_id    = sl.id
     ORDER BY b.created_at DESC`
  );
  res.json({ bookings: rows });
});

app.put("/api/admin/bookings/:id", requireAdmin, async (req, res) => {
  const { status } = req.body;
  const booking = await get(`SELECT * FROM bookings WHERE id=?`, [req.params.id]);
  if (!booking) return res.status(404).json({ error: "Booking not found." });
  await run(`UPDATE bookings SET status=? WHERE id=?`, [status || booking.status, req.params.id]);
  res.json({ success: true });
});

app.delete("/api/admin/bookings/:id", requireAdmin, async (req, res) => {
  const booking = await get(`SELECT * FROM bookings WHERE id=?`, [req.params.id]);
  if (!booking) return res.status(404).json({ error: "Booking not found." });
  try {
    // free seat
    if (booking.seat_id) {
      await run(`UPDATE seats SET status='available', student_id=NULL WHERE id=?`, [booking.seat_id]);
    }
    await run(`UPDATE programs SET filled_seats=MAX(0,filled_seats-1) WHERE id=?`, [booking.program_id]);
    await run(`DELETE FROM bookings WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || "Delete failed." });
  }
});

// ── Admin: Dashboard stats ────────────────────────────────────────────────────
app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
  const totalStudents  = await get(`SELECT COUNT(*) as cnt FROM users WHERE role='student'`);
  const totalBookings  = await get(`SELECT COUNT(*) as cnt FROM bookings`);
  const totalPrograms  = await get(`SELECT COUNT(*) as cnt FROM programs`);
  const availableSeats = await get(`SELECT SUM(total_seats - filled_seats) as cnt FROM programs`);
  res.json({
    students:        totalStudents.cnt,
    bookings:        totalBookings.cnt,
    programs:        totalPrograms.cnt,
    available_seats: availableSeats.cnt || 0,
  });
});

// ── Student: Profile ──────────────────────────────────────────────────────────
app.get("/api/student/profile", requireStudent, async (req, res) => {
  const uid     = req.session.user.id;
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

// ── Slots ─────────────────────────────────────────────────────────────────────
app.get("/api/slots", async (_req, res) => {
  const slots = await all(
    `SELECT id, slot_date, slot_time, capacity, booked_count,
     (capacity - booked_count) AS available
     FROM slots WHERE is_active = 1 ORDER BY slot_date, slot_time`
  );
  res.json({ slots });
});

// ── Chat ──────────────────────────────────────────────────────────────────────
app.post("/api/chat", requireStudent, async (req, res) => {
  const rawMessage = (req.body && (req.body.message || req.body.text)) || "";
  const text = normalizeChatInput(rawMessage);

  if (text.includes("slot") || text.includes("schedule")) {
    const slots = await all(
      `SELECT slot_date, slot_time, (capacity-booked_count) AS available
       FROM slots WHERE is_active=1 AND (capacity-booked_count)>0
       ORDER BY slot_date, slot_time`
    );
    const list = slots.map((s) => `• ${s.slot_date} at ${s.slot_time} (${s.available} left)`).join("\n");
    return res.json({ reply: list ? `Available counseling slots:\n${list}` : "No slots available right now." });
  }

  if (text.includes("program") || text.includes("course") || text.includes("branch")) {
    const programs = await all(`SELECT name, min_score, total_seats, filled_seats FROM programs ORDER BY min_score DESC`);
    const list = programs.map((p) => `• **${p.name}** — Min: ${p.min_score}% | Seats left: ${p.total_seats - p.filled_seats}`).join("\n");
    return res.json({ reply: `Here are all available programs:\n${list}\n\nType **I want CSE** (or any program) to start booking!` });
  }

  const aiReply = await getAiReply(rawMessage);
  if (aiReply) return res.json({ reply: aiReply });

  return res.json({
    reply: `Welcome to **${COLLEGE_NAME}** Admission Portal! 🎓\n\nType **I want CSE** to start booking, or **show programs** to see all courses.`,
  });
});

// ── Book a seat ───────────────────────────────────────────────────────────────
app.post("/api/book", requireStudent, async (req, res) => {
  const { fullName, email, phone, marks12, rollNo, programName, slotId } = req.body;
  if (!fullName || !email || !phone || !programName || !marks12)
    return res.status(400).json({ error: "Missing required fields." });

  const marksPct = parseMarks12th(marks12);
  if (marksPct === null)
    return res.status(400).json({ error: "Invalid marks. Use % (e.g. 88) or fraction (e.g. 440/500)." });

  try {
    await run("BEGIN TRANSACTION");

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

    const uid = req.session.user.id;
    const existingStudent = await get(`SELECT id FROM students WHERE user_id=?`, [uid]);
    if (existingStudent) {
      const existingBooking = await get(`SELECT id FROM bookings WHERE student_id=?`, [existingStudent.id]);
      if (existingBooking) throw new Error("You already have a booking.");
    }

    const studentResult = await run(
      `INSERT INTO students (user_id, full_name, email, phone, score, interests, career_goal, roll_no, marks_12)
       VALUES (?, ?, ?, ?, ?, '', '', ?, ?)`,
      [uid, fullName, email, phone, marksPct, String(rollNo || ""), marksPct]
    );

    const seat = await get(
      `SELECT id FROM seats WHERE program_id=? AND status='available' ORDER BY seat_number LIMIT 1`,
      [program.id]
    );
    if (!seat) throw new Error("No seats available.");

    await run(`UPDATE seats SET status='booked', student_id=? WHERE id=?`, [uid, seat.id]);
    await run(`UPDATE programs SET filled_seats=filled_seats+1 WHERE id=?`, [program.id]);
    await run(`UPDATE slots SET booked_count=booked_count+1 WHERE id=?`, [slot.id]);

    const bookingId  = `ADM-${Date.now().toString().slice(-8)}`;
    const createdAt  = new Date().toISOString();
    await run(
      `INSERT INTO bookings (booking_id, student_id, program_id, slot_id, seat_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [bookingId, studentResult.lastID, program.id, slot.id, seat.id, createdAt]
    );

    await run("COMMIT");
    return res.json({
      success: true,
      booking: { bookingId, college: COLLEGE_NAME, program: program.name, marks: marksPct, slotDate: slot.slot_date, slotTime: slot.slot_time },
    });
  } catch (error) {
    try { await run("ROLLBACK"); } catch (_) {}
    return res.status(400).json({ error: error.message || "Booking failed." });
  }
});

// ── Document upload ───────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = file.mimetype === "application/pdf" || file.mimetype === "text/plain" ||
      /\.(pdf|txt|md)$/i.test(file.originalname || "");
    cb(null, ok);
  },
});

app.post("/api/analyze-document", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: "No file uploaded." });
    const text = await extractTextFromFile(req.file.buffer, req.file.mimetype, req.file.originalname);
    if (!text || text.length < 20) return res.status(400).json({ error: "Could not read text from file." });
    let questions = await generateQuestionsWithAi(text, openai);
    let source = "ai";
    if (!questions || !questions.length) { questions = generateRuleBasedQuestions(text); source = "rules"; }
    return res.json({ ok: true, filename: req.file.originalname, textLength: text.length, questions, source });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Upload failed" });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
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
  return null;
}

function normalizeChatInput(message) {
  return String(message || "").toLowerCase().replace(/\s+/g, " ").trim();
}

async function getAiReply(message) {
  if (!openai) return null;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are an admission assistant for ${COLLEGE_NAME}. Keep answers short and helpful.` },
        { role: "user",   content: message },
      ],
    });
    return (response.choices[0] && response.choices[0].message && response.choices[0].message.content) || null;
  } catch { return null; }
}

// ── Start ─────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🎓 ${COLLEGE_NAME} Admission Portal`);
    console.log(`   Running at http://localhost:${PORT}`);
    console.log(`   Admin → admin@college.edu / admin123\n`);
  });
});
