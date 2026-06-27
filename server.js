require("dotenv").config();
const path = require("path");
const fs   = require("fs");
const express = require("express");
const session = require("express-session");
const bcrypt  = require("bcryptjs");
const multer  = require("multer");
const OpenAI  = require("openai");
const { initDb, all, get, run } = require("./db");

const app  = express();
const PORT = process.env.PORT || 3000;
const COLLEGE_NAME = process.env.COLLEGE_NAME || "Sastra Deemed University";
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// uploads folder
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "college_secret_2026",
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));
app.use("/css",     express.static(path.join(__dirname, "public/css")));
app.use("/js",      express.static(path.join(__dirname, "public/js")));
app.use("/assets",  express.static(path.join(__dirname, "public/assets")));
app.use("/uploads", express.static(UPLOADS_DIR));


// ── Auth guards ───────────────────────────────────────────────────────────────
function requireStudent(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === "student") return next();
  res.redirect("/login.html");
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === "admin") return next();
  res.redirect("/login.html");
}

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  if (req.session && req.session.user && req.session.user.role === "admin")   return res.redirect("/admin");
  if (req.session && req.session.user && req.session.user.role === "student") return res.redirect("/student");
  res.redirect("/login.html");
});
app.get("/login.html",    (_, res) => res.sendFile(path.join(__dirname, "public/login.html")));
app.get("/register.html", (_, res) => res.sendFile(path.join(__dirname, "public/register.html")));
app.get("/student", requireStudent, (_, res) => res.sendFile(path.join(__dirname, "public/student/index.html")));
app.get("/admin",   requireAdmin,   (_, res) => res.sendFile(path.join(__dirname, "public/admin/index.html")));

// ── Auth API ──────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  const { full_name, email, password } = req.body;
  if (!full_name || !email || !password)
    return res.status(400).json({ error: "All fields are required." });
  const existing = await get(`SELECT id FROM users WHERE email=?`, [email]);
  if (existing) return res.status(400).json({ error: "Email already registered." });
  const hash   = await bcrypt.hash(password, 10);
  const result = await run(
    `INSERT INTO users (full_name,email,password,role) VALUES (?,?,?,'student')`,
    [full_name.trim(), email.trim().toLowerCase(), hash]
  );
  req.session.user = { id: result.lastID, full_name: full_name.trim(), email, role: "student" };
  res.json({ success: true, redirect: "/student" });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });
  const user = await get(`SELECT * FROM users WHERE email=?`, [email.trim().toLowerCase()]);
  if (!user) return res.status(401).json({ error: "Invalid email or password." });
  const match = await bcrypt.compare(password, user.password);
  if (!match)  return res.status(401).json({ error: "Invalid email or password." });
  req.session.user = { id: user.id, full_name: user.full_name, email: user.email, role: user.role };
  res.json({ success: true, role: user.role, redirect: user.role === "admin" ? "/admin" : "/student" });
});

app.post("/api/auth/logout", (req, res) => { req.session.destroy(() => res.json({ success: true })); });
app.get("/api/auth/me", (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: "Not logged in." });
  res.json({ user: req.session.user });
});


// ── Programs ──────────────────────────────────────────────────────────────────
app.get("/api/programs", async (_, res) => {
  const programs = await all(
    `SELECT id,college_name,name,total_seats,filled_seats,
     (total_seats-filled_seats) AS available_seats,min_score
     FROM programs ORDER BY min_score DESC`
  );
  res.json({ college: COLLEGE_NAME, programs });
});

app.get("/api/seats/:programId", requireAdmin, async (req, res) => {
  const seats = await all(
    `SELECT s.id,s.seat_number,s.status,u.full_name AS student_name
     FROM seats s LEFT JOIN users u ON s.student_id=u.id
     WHERE s.program_id=? ORDER BY s.seat_number`,
    [req.params.programId]
  );
  res.json({ seats });
});

// ── Admin Programs CRUD ───────────────────────────────────────────────────────
app.get("/api/admin/programs", requireAdmin, async (_, res) => {
  res.json({ programs: await all(`SELECT * FROM programs ORDER BY min_score DESC`) });
});
app.post("/api/admin/programs", requireAdmin, async (req, res) => {
  const { name, total_seats, min_score, college_name } = req.body;
  if (!name || !total_seats || min_score === undefined)
    return res.status(400).json({ error: "name, total_seats, min_score required." });
  const existing = await get(`SELECT id FROM programs WHERE name=?`, [name.trim()]);
  if (existing) return res.status(400).json({ error: "Program already exists." });
  const result = await run(
    `INSERT INTO programs (college_name,name,total_seats,filled_seats,min_score) VALUES (?,?,?,0,?)`,
    [college_name || COLLEGE_NAME, name.trim(), Number(total_seats), Number(min_score)]
  );
  for (let i = 1; i <= Number(total_seats); i++)
    await run(`INSERT INTO seats (program_id,seat_number,status) VALUES (?,?,'available')`, [result.lastID, i]);
  res.json({ success: true, id: result.lastID });
});
app.put("/api/admin/programs/:id", requireAdmin, async (req, res) => {
  const { name, total_seats, min_score, college_name } = req.body;
  const prog = await get(`SELECT * FROM programs WHERE id=?`, [req.params.id]);
  if (!prog) return res.status(404).json({ error: "Not found." });
  const newSeats = Number(total_seats) || prog.total_seats;
  await run(`UPDATE programs SET name=?,total_seats=?,min_score=?,college_name=? WHERE id=?`,
    [name||prog.name, newSeats, min_score!==undefined?Number(min_score):prog.min_score, college_name||prog.college_name, req.params.id]);
  const cur = (await get(`SELECT COUNT(*) as cnt FROM seats WHERE program_id=?`,[req.params.id])).cnt;
  if (newSeats > cur)
    for (let i=cur+1;i<=newSeats;i++)
      await run(`INSERT INTO seats (program_id,seat_number,status) VALUES (?,?,'available')`,[req.params.id,i]);
  else if (newSeats < cur)
    await run(`DELETE FROM seats WHERE program_id=? AND seat_number>? AND status='available'`,[req.params.id,newSeats]);
  res.json({ success: true });
});
app.delete("/api/admin/programs/:id", requireAdmin, async (req, res) => {
  try {
    await run(`DELETE FROM bookings WHERE program_id=?`,[req.params.id]);
    await run(`UPDATE seats SET status='available',student_id=NULL WHERE program_id=?`,[req.params.id]);
    await run(`DELETE FROM seats WHERE program_id=?`,[req.params.id]);
    await run(`DELETE FROM programs WHERE id=?`,[req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Admin Students CRUD ───────────────────────────────────────────────────────
app.get("/api/admin/students", requireAdmin, async (_, res) => {
  const students = await all(
    `SELECT s.id,s.full_name,s.email,s.phone,s.roll_no,s.marks_12,s.doc_verified,s.doc_path,
            u.created_at, b.booking_id, p.name AS program_name
     FROM students s
     LEFT JOIN users u ON s.user_id=u.id
     LEFT JOIN bookings b ON b.student_id=s.id
     LEFT JOIN programs p ON b.program_id=p.id
     ORDER BY s.id DESC`
  );
  res.json({ students });
});
app.put("/api/admin/students/:id", requireAdmin, async (req, res) => {
  const { full_name,email,phone,roll_no,marks_12 } = req.body;
  const s = await get(`SELECT * FROM students WHERE id=?`,[req.params.id]);
  if (!s) return res.status(404).json({ error: "Not found." });
  await run(`UPDATE students SET full_name=?,email=?,phone=?,roll_no=?,marks_12=? WHERE id=?`,
    [full_name||s.full_name, email||s.email, phone||s.phone,
     roll_no!==undefined?roll_no:s.roll_no,
     marks_12!==undefined?Number(marks_12):s.marks_12, req.params.id]);
  res.json({ success: true });
});
app.delete("/api/admin/students/:id", requireAdmin, async (req, res) => {
  try {
    const booking = await get(`SELECT * FROM bookings WHERE student_id=?`,[req.params.id]);
    if (booking) {
      if (booking.seat_id) await run(`UPDATE seats SET status='available',student_id=NULL WHERE id=?`,[booking.seat_id]);
      await run(`UPDATE programs SET filled_seats=MAX(0,filled_seats-1) WHERE id=?`,[booking.program_id]);
      await run(`DELETE FROM bookings WHERE student_id=?`,[req.params.id]);
    }
    await run(`DELETE FROM students WHERE id=?`,[req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin Bookings CRUD ───────────────────────────────────────────────────────
app.get("/api/admin/bookings", requireAdmin, async (_, res) => {
  const rows = await all(
    `SELECT b.id,b.booking_id,b.status,b.created_at,b.seat_id,
            st.id AS student_db_id,st.full_name,st.email,st.phone,st.roll_no,st.marks_12,st.doc_verified,
            p.name AS program_name,p.id AS program_id,sl.slot_date,sl.slot_time
     FROM bookings b
     JOIN students st ON b.student_id=st.id
     JOIN programs p  ON b.program_id=p.id
     JOIN slots sl    ON b.slot_id=sl.id
     ORDER BY b.created_at DESC`
  );
  res.json({ bookings: rows });
});
app.put("/api/admin/bookings/:id", requireAdmin, async (req, res) => {
  const booking = await get(`SELECT * FROM bookings WHERE id=?`,[req.params.id]);
  if (!booking) return res.status(404).json({ error: "Not found." });
  await run(`UPDATE bookings SET status=? WHERE id=?`,[req.body.status||booking.status, req.params.id]);
  res.json({ success: true });
});
app.delete("/api/admin/bookings/:id", requireAdmin, async (req, res) => {
  const booking = await get(`SELECT * FROM bookings WHERE id=?`,[req.params.id]);
  if (!booking) return res.status(404).json({ error: "Not found." });
  try {
    if (booking.seat_id) await run(`UPDATE seats SET status='available',student_id=NULL WHERE id=?`,[booking.seat_id]);
    await run(`UPDATE programs SET filled_seats=MAX(0,filled_seats-1) WHERE id=?`,[booking.program_id]);
    await run(`DELETE FROM bookings WHERE id=?`,[req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin Stats ───────────────────────────────────────────────────────────────
app.get("/api/admin/stats", requireAdmin, async (_, res) => {
  const [s,b,p,a] = await Promise.all([
    get(`SELECT COUNT(*) as cnt FROM users WHERE role='student'`),
    get(`SELECT COUNT(*) as cnt FROM bookings`),
    get(`SELECT COUNT(*) as cnt FROM programs`),
    get(`SELECT SUM(total_seats-filled_seats) as cnt FROM programs`),
  ]);
  res.json({ students:s.cnt, bookings:b.cnt, programs:p.cnt, available_seats:a.cnt||0 });
});


// ── FAQ CRUD (Admin) ──────────────────────────────────────────────────────────
app.get("/api/admin/faq", requireAdmin, async (_, res) => {
  res.json({ faq: await all(`SELECT * FROM faq ORDER BY category, id`) });
});
app.post("/api/admin/faq", requireAdmin, async (req, res) => {
  const { question, answer, category } = req.body;
  if (!question || !answer) return res.status(400).json({ error: "Question and answer required." });
  const result = await run(`INSERT INTO faq (question,answer,category) VALUES (?,?,?)`,
    [question.trim(), answer.trim(), category||"General"]);
  res.json({ success: true, id: result.lastID });
});
app.put("/api/admin/faq/:id", requireAdmin, async (req, res) => {
  const f = await get(`SELECT * FROM faq WHERE id=?`,[req.params.id]);
  if (!f) return res.status(404).json({ error: "Not found." });
  await run(`UPDATE faq SET question=?,answer=?,category=? WHERE id=?`,
    [req.body.question||f.question, req.body.answer||f.answer, req.body.category||f.category, req.params.id]);
  res.json({ success: true });
});
app.delete("/api/admin/faq/:id", requireAdmin, async (req, res) => {
  await run(`DELETE FROM faq WHERE id=?`,[req.params.id]);
  res.json({ success: true });
});

// ── FAQ (public — chatbot uses this) ─────────────────────────────────────────
app.get("/api/faq", async (_, res) => {
  res.json({ faq: await all(`SELECT * FROM faq ORDER BY category, id`) });
});

// ── Student Profile ───────────────────────────────────────────────────────────
app.get("/api/student/profile", requireStudent, async (req, res) => {
  const uid     = req.session.user.id;
  const student = await get(`SELECT * FROM students WHERE user_id=?`,[uid]);
  const booking = student
    ? await get(`SELECT b.booking_id,b.status,p.name as program_name,sl.slot_date,sl.slot_time,b.seat_id
                 FROM bookings b JOIN programs p ON b.program_id=p.id
                 JOIN slots sl ON b.slot_id=sl.id WHERE b.student_id=?`,[student.id])
    : null;
  res.json({ user: req.session.user, student: student||null, booking: booking||null });
});

// ── Slots (public) ────────────────────────────────────────────────────────────
app.get("/api/slots", async (_, res) => {
  const slots = await all(
    `SELECT id,slot_date,slot_time,capacity,booked_count,(capacity-booked_count) AS available
     FROM slots WHERE is_active=1 ORDER BY slot_date,slot_time`
  );
  res.json({ slots });
});

// ── Admin: Slots CRUD ─────────────────────────────────────────────────────────
app.get("/api/admin/slots", requireAdmin, async (_, res) => {
  const slots = await all(`SELECT * FROM slots ORDER BY slot_date, slot_time`);
  res.json({ slots });
});
app.post("/api/admin/slots", requireAdmin, async (req, res) => {
  const { slot_date, slot_time, capacity } = req.body;
  if (!slot_date || !slot_time || !capacity)
    return res.status(400).json({ error: "slot_date, slot_time, capacity required." });
  const result = await run(
    `INSERT INTO slots (slot_date,slot_time,capacity,booked_count,is_active) VALUES (?,?,?,0,1)`,
    [slot_date, slot_time, Number(capacity)]
  );
  res.json({ success: true, id: result.lastID });
});
app.put("/api/admin/slots/:id", requireAdmin, async (req, res) => {
  const s = await get(`SELECT * FROM slots WHERE id=?`, [req.params.id]);
  if (!s) return res.status(404).json({ error: "Not found." });
  const { slot_date, slot_time, capacity, is_active } = req.body;
  await run(
    `UPDATE slots SET slot_date=?,slot_time=?,capacity=?,is_active=? WHERE id=?`,
    [slot_date||s.slot_date, slot_time||s.slot_time,
     capacity!==undefined?Number(capacity):s.capacity,
     is_active!==undefined?Number(is_active):s.is_active, req.params.id]
  );
  res.json({ success: true });
});
app.delete("/api/admin/slots/:id", requireAdmin, async (req, res) => {
  const booked = await get(`SELECT COUNT(*) as cnt FROM bookings WHERE slot_id=?`,[req.params.id]);
  if (booked && booked.cnt > 0)
    return res.status(400).json({ error: `Cannot delete — ${booked.cnt} booking(s) use this slot.` });
  await run(`DELETE FROM slots WHERE id=?`, [req.params.id]);
  res.json({ success: true });
});


// ── Marksheet Upload & OCR Verification ───────────────────────────────────────
const marksheetStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename:    (_, file, cb) => cb(null, `marksheet_${Date.now()}${path.extname(file.originalname)}`),
});
const marksheetUpload = multer({
  storage: marksheetStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_, file, cb) {
    const ok = /\.(pdf|jpg|jpeg|png)$/i.test(file.originalname);
    cb(null, ok);
  },
});

app.post("/api/verify-marksheet", requireStudent, marksheetUpload.single("marksheet"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    const declaredMarks = parseFloat(req.body.declared_marks);
    if (isNaN(declaredMarks)) return res.status(400).json({ error: "Declared marks required." });

    const filePath = req.file.path;
    const ext      = path.extname(req.file.originalname).toLowerCase();
    let extractedText = "";

    // ── Extract text based on file type ──
    if (ext === ".pdf") {
      try {
        const pdfParse = require("pdf-parse");
        const buf  = fs.readFileSync(filePath);
        const data = await pdfParse(buf);
        extractedText = data.text || "";
      } catch { extractedText = ""; }
    } else if ([".jpg",".jpeg",".png"].includes(ext)) {
      try {
        const Tesseract = require("tesseract.js");
        const result = await Tesseract.recognize(filePath, "eng", { logger: () => {} });
        extractedText = result.data.text || "";
      } catch { extractedText = ""; }
    }

    // ── Try to find marks in extracted text ──
    let foundMarks = null;
    if (extractedText) {
      // patterns: "88.5%", "88.5 %", "440/500", "Total: 440", "Percentage: 88.5"
      const patterns = [
        /percentage[:\s]+(\d{2,3}(?:\.\d{1,2})?)/i,
        /(\d{2,3}(?:\.\d{1,2})?)\s*%/,
        /total[:\s]+(\d{3,3})\s*\/\s*500/i,
        /(\d{3})\s*\/\s*500/,
        /(\d{3})\s*\/\s*600/,
        /marks[:\s]+(\d{2,3}(?:\.\d{1,2})?)/i,
      ];
      for (const pattern of patterns) {
        const m = extractedText.match(pattern);
        if (m) {
          let val = parseFloat(m[1]);
          // if it looks like a raw score out of 500 or 600, convert
          if (val > 100 && val <= 600) val = Math.round((val / 500) * 1000) / 10;
          if (val >= 0 && val <= 100) { foundMarks = val; break; }
        }
      }
    }

    // ── Compare with declared marks (allow ±2% tolerance) ──
    const tolerance = 2;
    let verified = false;
    let message  = "";

    if (foundMarks !== null) {
      const diff = Math.abs(foundMarks - declaredMarks);
      if (diff <= tolerance) {
        verified = true;
        message  = `✅ Marks verified! Document shows **${foundMarks}%**, you entered **${declaredMarks}%**.`;
      } else {
        verified = false;
        message  = `❌ Marks mismatch! Document shows **${foundMarks}%** but you entered **${declaredMarks}%**. Please re-check.`;
      }
    } else {
      // Could not read marks from doc — warn but allow (admin can manually verify)
      verified = true;
      message  = `⚠️ Could not auto-read marks from document. Document saved for manual verification by admin. You may proceed.`;
    }

    // ── Save doc path to student record if already exists ──
    const uid     = req.session.user.id;
    const student = await get(`SELECT id FROM students WHERE user_id=?`,[uid]);
    if (student) {
      await run(`UPDATE students SET doc_verified=?,doc_path=? WHERE user_id=?`,
        [verified?1:0, `/uploads/${req.file.filename}`, uid]);
    }

    return res.json({
      success: true,
      verified,
      foundMarks,
      declaredMarks,
      message,
      filePath: `/uploads/${req.file.filename}`,
    });
  } catch(err) {
    return res.status(500).json({ error: err.message || "Verification failed." });
  }
});


// ── Chat (FAQ-powered) ────────────────────────────────────────────────────────
app.post("/api/chat", requireStudent, async (req, res) => {
  const rawMessage = (req.body && (req.body.message || req.body.text)) || "";
  const text = rawMessage.toLowerCase().replace(/\s+/g," ").trim();

  // search FAQ first
  const faqs = await all(`SELECT * FROM faq`);
  let bestMatch = null, bestScore = 0;
  for (const f of faqs) {
    const qWords = f.question.toLowerCase().split(/\s+/);
    const score  = qWords.filter(w => w.length > 3 && text.includes(w)).length;
    if (score > bestScore) { bestScore = score; bestMatch = f; }
  }
  if (bestMatch && bestScore >= 2) {
    return res.json({ reply: `**${bestMatch.question}**\n\n${bestMatch.answer}` });
  }

  // program/slot keywords
  if (text.includes("slot") || text.includes("schedule")) {
    const slots = await all(
      `SELECT slot_date,slot_time,(capacity-booked_count) AS available
       FROM slots WHERE is_active=1 AND (capacity-booked_count)>0 ORDER BY slot_date,slot_time`
    );
    const list = slots.map(s=>`• ${s.slot_date} at ${s.slot_time} (${s.available} left)`).join("\n");
    return res.json({ reply: list ? `Available counseling slots:\n${list}` : "No slots available right now." });
  }
  if (text.includes("program") || text.includes("course") || text.includes("branch")) {
    const programs = await all(`SELECT name,min_score,total_seats,filled_seats FROM programs ORDER BY min_score DESC`);
    const list = programs.map(p=>`• **${p.name}** — Min: ${p.min_score}% | Seats left: ${p.total_seats-p.filled_seats}`).join("\n");
    return res.json({ reply: `Here are all available programs:\n${list}\n\nType **I want CSE** to start booking!` });
  }

  // AI fallback
  if (openai) {
    try {
      const faqContext = faqs.map(f=>`Q: ${f.question}\nA: ${f.answer}`).join("\n\n");
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role:"system", content:`You are an admission assistant for ${COLLEGE_NAME}.\n\nFAQ:\n${faqContext}\n\nAnswer only based on the FAQ above. If not found, say you don't have that info.` },
          { role:"user", content: rawMessage },
        ],
      });
      const reply = response.choices[0] && response.choices[0].message && response.choices[0].message.content;
      if (reply) return res.json({ reply });
    } catch {}
  }

  return res.json({
    reply: `I don't have specific info about that. Here's what I can help with:\n\n• Type **show programs** — see courses\n• Type **show slots** — counseling dates\n• Type **fee** or **hostel** or **placement** — get college info\n• Type **I want CSE** — start booking`,
  });
});

// ── Book a seat ───────────────────────────────────────────────────────────────
app.post("/api/book", requireStudent, async (req, res) => {
  const { fullName,email,phone,marks12,rollNo,programName,slotId } = req.body;
  if (!fullName||!email||!phone||!programName||!marks12)
    return res.status(400).json({ error: "Missing required fields." });
  const marksPct = parseMarks12th(marks12);
  if (marksPct===null) return res.status(400).json({ error: "Invalid marks format." });
  try {
    await run("BEGIN TRANSACTION");
    const program = await get(`SELECT * FROM programs WHERE name=?`,[programName]);
    if (!program) throw new Error("Program not found.");
    if (program.filled_seats>=program.total_seats) throw new Error("No seats left.");
    if (marksPct<program.min_score)
      throw new Error(`Your marks (${marksPct}%) are below the minimum required (${program.min_score}%) for ${programName}.`);
    let slot;
    if (slotId) {
      slot = await get(`SELECT * FROM slots WHERE id=? AND is_active=1`,[slotId]);
      if (!slot||slot.booked_count>=slot.capacity) throw new Error("Slot unavailable.");
    } else {
      slot = await get(`SELECT * FROM slots WHERE is_active=1 AND booked_count<capacity ORDER BY slot_date,slot_time LIMIT 1`);
      if (!slot) throw new Error("No slots available.");
    }
    const uid = req.session.user.id;
    const existingSt = await get(`SELECT id FROM students WHERE user_id=?`,[uid]);
    if (existingSt) {
      const existBk = await get(`SELECT id FROM bookings WHERE student_id=?`,[existingSt.id]);
      if (existBk) throw new Error("You already have a booking.");
    }
    const stResult = await run(
      `INSERT INTO students (user_id,full_name,email,phone,score,interests,career_goal,roll_no,marks_12)
       VALUES (?,?,?,?,?,'','',?,?)`,
      [uid,fullName,email,phone,marksPct,String(rollNo||""),marksPct]
    );
    const seat = await get(`SELECT id FROM seats WHERE program_id=? AND status='available' ORDER BY seat_number LIMIT 1`,[program.id]);
    if (!seat) throw new Error("No seats available.");
    await run(`UPDATE seats SET status='booked',student_id=? WHERE id=?`,[uid,seat.id]);
    await run(`UPDATE programs SET filled_seats=filled_seats+1 WHERE id=?`,[program.id]);
    await run(`UPDATE slots SET booked_count=booked_count+1 WHERE id=?`,[slot.id]);
    const bookingId = `ADM-${Date.now().toString().slice(-8)}`;
    await run(`INSERT INTO bookings (booking_id,student_id,program_id,slot_id,seat_id,created_at) VALUES (?,?,?,?,?,?)`,
      [bookingId,stResult.lastID,program.id,slot.id,seat.id,new Date().toISOString()]);
    await run("COMMIT");
    return res.json({ success:true, booking:{ bookingId,college:COLLEGE_NAME,program:program.name,marks:marksPct,slotDate:slot.slot_date,slotTime:slot.slot_time } });
  } catch(error) {
    try { await run("ROLLBACK"); } catch {}
    return res.status(400).json({ error: error.message||"Booking failed." });
  }
});

function parseMarks12th(input) {
  const s = String(input||"").trim();
  const slash = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (slash) { const n=Number(slash[1]),d=Number(slash[2]); if(d>0) return Math.round((n/d)*1000)/10; }
  const n = parseFloat(s.replace(/%/g,""));
  if (isNaN(n)) return null;
  if (n<=100) return Math.round(n*10)/10;
  if (n<=600) return Math.round((n/500)*1000)/10;
  return null;
}

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🎓 ${COLLEGE_NAME} Admission Portal`);
    console.log(`   Running at http://localhost:${PORT}`);
    console.log(`   Admin → admin@college.edu / admin123\n`);
  });
});
