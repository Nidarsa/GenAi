const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const dbPath = path.join(__dirname, "data.sqlite");
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
  });
}

async function initDb() {
  await run(`PRAGMA foreign_keys = ON`);

  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  await run(`CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    college_name TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE,
    total_seats INTEGER NOT NULL DEFAULT 0,
    filled_seats INTEGER NOT NULL DEFAULT 0,
    min_score INTEGER NOT NULL DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    program_id INTEGER NOT NULL,
    seat_number INTEGER NOT NULL,
    student_id INTEGER,
    status TEXT NOT NULL DEFAULT 'available',
    FOREIGN KEY(program_id) REFERENCES programs(id),
    FOREIGN KEY(student_id) REFERENCES users(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_date TEXT NOT NULL,
    slot_time TEXT NOT NULL,
    capacity INTEGER NOT NULL,
    booked_count INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1
  )`);

  await run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    interests TEXT NOT NULL DEFAULT '',
    career_goal TEXT NOT NULL DEFAULT '',
    roll_no TEXT NOT NULL DEFAULT '',
    marks_12 REAL NOT NULL DEFAULT 0,
    doc_verified INTEGER NOT NULL DEFAULT 0,
    doc_path TEXT DEFAULT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id TEXT NOT NULL UNIQUE,
    student_id INTEGER NOT NULL,
    program_id INTEGER NOT NULL,
    slot_id INTEGER NOT NULL,
    seat_id INTEGER,
    status TEXT NOT NULL DEFAULT 'CONFIRMED',
    created_at TEXT NOT NULL,
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(program_id) REFERENCES programs(id),
    FOREIGN KEY(slot_id) REFERENCES slots(id)
  )`);

  // ── FAQ table ─────────────────────────────────────────────────────────────
  await run(`CREATE TABLE IF NOT EXISTS faq (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // ── migrations ─────────────────────────────────────────────────────────────
  const studentCols = await all(`PRAGMA table_info(students)`);
  if (!studentCols.some(c => c.name === "roll_no"))
    await run(`ALTER TABLE students ADD COLUMN roll_no TEXT NOT NULL DEFAULT ''`);
  if (!studentCols.some(c => c.name === "marks_12"))
    await run(`ALTER TABLE students ADD COLUMN marks_12 REAL NOT NULL DEFAULT 0`);
  if (!studentCols.some(c => c.name === "user_id"))
    await run(`ALTER TABLE students ADD COLUMN user_id INTEGER`);
  if (!studentCols.some(c => c.name === "doc_verified"))
    await run(`ALTER TABLE students ADD COLUMN doc_verified INTEGER NOT NULL DEFAULT 0`);
  if (!studentCols.some(c => c.name === "doc_path"))
    await run(`ALTER TABLE students ADD COLUMN doc_path TEXT DEFAULT NULL`);

  const bookingCols = await all(`PRAGMA table_info(bookings)`);
  if (!bookingCols.some(c => c.name === "seat_id"))
    await run(`ALTER TABLE bookings ADD COLUMN seat_id INTEGER`);

  // ── seed admin ─────────────────────────────────────────────────────────────
  const bcrypt = require("bcryptjs");
  const adminExists = await get(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (!adminExists) {
    const hash = await bcrypt.hash("admin123", 10);
    await run(
      `INSERT INTO users (full_name, email, password, role) VALUES (?, ?, ?, 'admin')`,
      ["Administrator", "admin@college.edu", hash]
    );
  }

  // ── seed programs ──────────────────────────────────────────────────────────
  const programCount = await get(`SELECT COUNT(*) as count FROM programs`);
  if (!programCount || programCount.count === 0) {
    const programs = [
      ["Sastra Deemed University", "CSE", 50, 0, 85],
      ["Sastra Deemed University", "AI & Data Science", 40, 0, 80],
      ["Sastra Deemed University", "Mechanical", 40, 0, 80],
      ["Sastra Deemed University", "ECE", 40, 0, 75],
      ["Sastra Deemed University", "Civil", 30, 0, 70],
      ["Sastra Deemed University", "Biotechnology", 30, 0, 70],
    ];
    for (const p of programs) {
      const result = await run(
        `INSERT INTO programs (college_name, name, total_seats, filled_seats, min_score) VALUES (?, ?, ?, ?, ?)`, p
      );
      for (let i = 1; i <= p[2]; i++) {
        await run(`INSERT INTO seats (program_id, seat_number, status) VALUES (?, ?, 'available')`, [result.lastID, i]);
      }
    }
  }

  // ── seed slots ─────────────────────────────────────────────────────────────
  const slotCount = await get(`SELECT COUNT(*) as count FROM slots`);
  if (!slotCount || slotCount.count === 0) {
    const slots = [
      ["2026-07-10", "10:00 AM", 30, 0, 1],
      ["2026-07-10", "02:00 PM", 30, 0, 1],
      ["2026-07-11", "10:00 AM", 30, 0, 1],
      ["2026-07-11", "02:00 PM", 30, 0, 1],
    ];
    for (const s of slots) {
      await run(`INSERT INTO slots (slot_date, slot_time, capacity, booked_count, is_active) VALUES (?, ?, ?, ?, ?)`, s);
    }
  }

  // ── seed FAQ ───────────────────────────────────────────────────────────────
  const faqCount = await get(`SELECT COUNT(*) as count FROM faq`);
  if (!faqCount || faqCount.count === 0) {
    const faqs = [
      ["What is the fee for CSE?", "The annual fee for CSE is approximately ₹1,50,000 per year including tuition and lab fees.", "Fees"],
      ["What is the hostel facility?", "Sastra provides separate hostels for boys and girls with AC and non-AC rooms. Mess facility is available 24/7.", "Hostel"],
      ["What is the placement record?", "Sastra has 95%+ placement record. Top recruiters include TCS, Infosys, Wipro, Amazon, and Google.", "Placement"],
      ["What is the minimum marks for admission?", "CSE requires 85%, AI & Data Science and Mechanical require 80%, ECE requires 75%, Civil and Biotechnology require 70%.", "Admission"],
      ["When does admission start?", "Admissions open in June every year. Counseling slots are available in July.", "Admission"],
      ["What documents are required?", "You need 10th marksheet, 12th marksheet, transfer certificate, and ID proof (Aadhar/Passport).", "Documents"],
      ["Is there a scholarship?", "Yes, merit scholarships are available for students scoring above 90% in 12th boards.", "Fees"],
      ["What is the college location?", "Sastra Deemed University is located in Thanjavur, Tamil Nadu, India.", "General"],
      ["How to contact the admission office?", "You can contact us at admissions@sastra.edu or call +91-4362-264101.", "Contact"],
      ["Is there a transport facility?", "Yes, college buses are available from major points in Thanjavur and nearby cities.", "General"],
    ];
    for (const f of faqs) {
      await run(`INSERT INTO faq (question, answer, category) VALUES (?, ?, ?)`, f);
    }
  }
}

module.exports = { db, run, get, all, initDb };
