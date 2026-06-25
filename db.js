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

  await run(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      score INTEGER NOT NULL,
      interests TEXT NOT NULL,
      career_goal TEXT NOT NULL
    )
  `);

  const studentCols = await all(`PRAGMA table_info(students)`);
  if (!studentCols.some((c) => c.name === "roll_no")) {
    await run(`ALTER TABLE students ADD COLUMN roll_no TEXT NOT NULL DEFAULT ''`);
  }

  await run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id TEXT NOT NULL UNIQUE,
      student_id INTEGER NOT NULL,
      program_id INTEGER NOT NULL,
      slot_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      created_at TEXT NOT NULL,
      FOREIGN KEY(student_id) REFERENCES students(id),
      FOREIGN KEY(program_id) REFERENCES programs(id),
      FOREIGN KEY(slot_id) REFERENCES slots(id)
    )
  `);

  const programCount = await get(`SELECT COUNT(*) as count FROM programs`);
  if (!programCount || programCount.count === 0) {
    const programs = [
      ["Sastra Deemed University", "CSE", 120, 0, 70],
      ["Sastra Deemed University", "AI & Data Science", 90, 0, 75],
      ["Sastra Deemed University", "ECE", 100, 0, 65],
      ["Sastra Deemed University", "Mechanical", 80, 0, 55],
      ["Sastra Deemed University", "Civil", 70, 0, 50],
      ["Sastra Deemed University", "Biotechnology", 60, 0, 60],
    ];
    for (const p of programs) {
      await run(
        `INSERT INTO programs (college_name, name, total_seats, filled_seats, min_score) VALUES (?, ?, ?, ?, ?)`,
        p
      );
    }
  }

  const slotCount = await get(`SELECT COUNT(*) as count FROM slots`);
  if (!slotCount || slotCount.count === 0) {
    const slots = [
      ["2026-04-02", "10:00 AM", 25, 0, 1],
      ["2026-04-02", "02:00 PM", 25, 0, 1],
      ["2026-04-03", "10:00 AM", 25, 0, 1],
      ["2026-04-03", "02:00 PM", 25, 0, 1],
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
