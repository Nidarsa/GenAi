# 🎓 College Admission Portal

A full-stack admission system with student chatbot, seat allocation, and admin dashboard.

---

## ⚡ Quick Start (3 steps)

### Requirements
- [Node.js](https://nodejs.org/) v16 or above  
- npm (comes with Node.js)

### Steps

```bash
# 1. Go into the project folder
cd GenAi

# 2. Install all dependencies
npm install

# 3. Start the server
npm start
```

Then open your browser at → **http://localhost:3000**

---

## 🔐 Login Credentials

| Role    | Email                  | Password   |
|---------|------------------------|------------|
| Admin   | admin@college.edu      | admin123   |
| Student | Register at /register.html | your choice |

---

## 📁 Project Structure

```
GenAi/
├── server.js              ← Main Express server & all API routes
├── db.js                  ← SQLite database setup & seed data
├── documentQuestions.js   ← PDF/text analysis helper
├── package.json           ← Dependencies
├── .env                   ← Config (port, session secret, college name)
├── data.sqlite            ← Auto-created on first run (do NOT delete)
└── public/
    ├── login.html         ← Login page (Student + Admin tabs)
    ├── register.html      ← Student registration page
    ├── css/style.css      ← All styles
    ├── student/
    │   └── index.html     ← Student chatbot + booking page
    └── admin/
        └── index.html     ← Admin dashboard (4 sections)
```

---

## 🤖 How the Student Chatbot Works

1. Register → Login as Student
2. Click a program button (CSE, AI & DS, Mechanical…) or type **"I want CSE"**
3. Bot guides you step-by-step:
   - Asks your **Full Name**
   - Asks your **Roll Number**
   - Asks your **12th Marks** (enter as `88` or `440/500`)
   - Shows available **counseling slots**, you pick one
   - Shows a **summary** — type `confirm` to book
4. Seat is instantly reserved and your booking ID is shown

---

## 📊 Seat Allocation Algorithm

| Program          | Minimum Marks |
|------------------|---------------|
| CSE              | 85%           |
| AI & Data Science| 80%           |
| Mechanical       | 80%           |
| ECE              | 75%           |
| Civil            | 70%           |
| Biotechnology    | 70%           |

- Students **below** the cutoff are blocked from booking that program
- Admin can **change** cutoffs and seat counts anytime from the dashboard
- First available seat is auto-assigned in order

---

## 🛡️ Admin Dashboard

Access at `/admin` after logging in as admin.

| Section          | What you can do |
|------------------|-----------------|
| Overview         | Live stats: students, bookings, programs, available seats |
| Manage Courses   | Add / Edit / Delete programs, set seats & min marks |
| Seat Grid        | 🟢 Green = available, 🔴 Red = booked (hover = student name) |
| All Bookings     | Full table: student, marks, program, slot, booking ID |

---

## ⚙️ Configuration (.env)

| Key              | Default                    | Description              |
|------------------|----------------------------|--------------------------|
| PORT             | 3000                       | Server port              |
| SESSION_SECRET   | college_secret_2026        | Session encryption key   |
| COLLEGE_NAME     | Sastra Deemed University   | Shown throughout the UI  |
| OPENAI_API_KEY   | *(empty)*                  | Optional — enables AI replies in chat |

---

## 🔧 Troubleshooting

**`npm install` fails?**  
Make sure Node.js v16+ is installed: `node --version`

**Port 3000 already in use?**  
Change `PORT=3001` in `.env` and restart.

**`data.sqlite` error?**  
Delete `data.sqlite` and restart — it will be recreated fresh with seed data.

**Blank page / 404?**  
Make sure you're visiting `http://localhost:3000` (not opening the HTML file directly).
