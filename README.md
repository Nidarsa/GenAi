# Sastra Admission Chatbot

Chatbot-style web application to collect student details, suggest programs by interests, and automatically book admission slots for Sastra Deemed University.

## Features

- ChatGPT-like chat interface for admission queries.
- Program recommendation based on score and interests.
- Auto booking to first available slot.
- Seat and slot availability tracking in SQLite.
- Transaction-based booking flow to avoid overbooking.
- Basic admin endpoint to view bookings.

## Tech Stack

- Frontend: HTML, CSS, Vanilla JavaScript
- Backend: Node.js, Express
- Database: SQLite (`data.sqlite`)

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm start
```

3. Open:

`http://localhost:3000`

Optional (for AI-generated chatbot replies):

- Copy `.env.example` to `.env`
- Set `OPENAI_API_KEY=...`

## Main APIs

- `POST /api/chat` - basic chatbot intent replies.
- `POST /api/recommend` - suggest programs from score/interests.
- `POST /api/book` - finalize admission booking.
- `GET /api/programs` - list programs and available seats.
- `GET /api/slots` - list available slots.
- `GET /api/admin/bookings` - list all bookings.

## Chat Flow Input Format

For booking details, send in one message:

`Name, Email, Phone, Score, Interests, Career Goal`

Example:

`Arun Kumar, arun@mail.com, 9876543210, 86, coding ai data, software engineer`
