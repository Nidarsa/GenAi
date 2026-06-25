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
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {
  await run(`PRAGMA foreign_keys = ON`);

  // ── users (students + admin) ──────────────────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── programs ──────────────────────────────────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      college_name TEXT NOT NULL,
      name TEXT NOT NULL UNIQUE,
      total_seats INTEGER NOT NULL DEFAULT 0,
      filled_seats INTEGER NOT NULL DEFAULT 0,
      min_score INTEGER NOT NULL DEFAULT 0
    )
  `);

  // ── seats grid ────────────────────────────────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS seats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id INTEGER NOT NULL,
      seat_number INTEGER NOT NULL,
      student_id INTEGER,
      status TEXT NOT NULL DEFAULT 'available',
      FOREIGN KEY(program_id) REFERENCES programs(id),
      FOREIGN KEY(student_id) REFERENCES users(id)
    )
  `);

  // ── slots ─────────────────────────────────────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      booked_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `);

  // ── students (legacy, kept for bookings) ─────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS students (
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
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // ── bookings ──────────────────────────────────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS bookings (
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
    )
  `);

  // ── migrations ────────────────────────────────────────────────────────────
  const studentCols = await all(`PRAGMA table_info(students)`);
  if (!studentCols.some((c) => c.name === "roll_no"))
    await run(`ALTER TABLE students ADD COLUMN roll_no TEXT NOT NULL DEFAULT ''`);
  if (!studentCols.some((c) => c.name === "marks_12"))
    await run(`ALTER TABLE students ADD COLUMN marks_12 REAL NOT NULL DEFAULT 0`);
  if (!studentCols.some((c) => c.name === "user_id"))
    await run(`ALTER TABLE students ADD COLUMN user_id INTEGER`);

  const bookingCols = await all(`PRAGMA table_info(bookings)`);
  if (!bookingCols.some((c) => c.name === "seat_id"))
    await run(`ALTER TABLE bookings ADD COLUMN seat_id INTEGER`);

  // ── seed admin ────────────────────────────────────────────────────────────
  const bcrypt = require("bcryptjs");
  const adminExists = await get(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (!adminExists) {
    const hash = await bcrypt.hash("admin123", 10);
    await run(
      `INSERT INTO users (full_name, email, password, role) VALUES (?, ?, ?, 'admin')`,
      ["Administrator", "admin@college.edu", hash]
    );
  }

  // ── seed programs ─────────────────────────────────────────────────────────
  const programCount = await get(`SELECT COUNT(*) as count FROM programs`);
  if (!programCount || programCount.count === 0) {
    const programs = [
      ["College", "CSE", 50, 0, 85],
      ["College", "AI & Data Science", 40, 0, 80],
      ["College", "Mechanical", 40, 0, 80],
      ["College", "ECE", 40, 0, 75],
      ["College", "Civil", 30, 0, 70],
      ["College", "Biotechnology", 30, 0, 70],
    ];
    for (const p of programs) {
      const result = await run(
        `INSERT INTO programs (college_name, name, total_seats, filled_seats, min_score) VALUES (?, ?, ?, ?, ?)`,
        p
      );
      // create seat rows
      for (let i = 1; i <= p[2]; i++) {
        await run(`INSERT INTO seats (program_id, seat_number, status) VALUES (?, ?, 'available')`, [
          result.lastID,
          i,
        ]);
      }
    }
  }

  // ── seed slots ────────────────────────────────────────────────────────────
  const slotCount = await get(`SELECT COUNT(*) as count FROM slots`);
  if (!slotCount || slotCount.count === 0) {
    const slots = [
      ["2026-07-10", "10:00 AM", 30, 0, 1],
      ["2026-07-10", "02:00 PM", 30, 0, 1],
      ["2026-07-11", "10:00 AM", 30, 0, 1],
      ["2026-07-11", "02:00 PM", 30, 0, 1],
    ];
    for (const s of slots) {
      await run(
        `INSERT INTO slots (slot_date, slot_time, capacity, booked_count, is_active) VALUES (?, ?, ?, ?, ?)`,
        s
      );
    }
  }
}

module.exports = { db, run, get, all, initDb };
